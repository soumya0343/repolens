import asyncio
import os
from pathlib import Path
from typing import Optional

from arq.connections import RedisSettings
import networkx as nx
from tree_sitter import Parser
import httpx

INTERNAL_API_KEY = os.getenv("REPOLENS_API_KEY", "internal_key")

# Tree-sitter queries to count real functions per language
FUNC_QUERIES = {
    '.py': '(function_definition) @fn',
    '.js': '[(function_declaration) (method_definition) (arrow_function)] @fn',
    '.ts': '[(function_declaration) (method_definition) (arrow_function)] @fn',
    '.java': '(method_declaration) @fn',
    '.go': '(function_declaration) @fn',
}

def get_lang(ext):
    from tree_sitter_language_pack import get_language
    lang_map = {
        '.py': 'python',
        '.js': 'javascript',
        '.ts': 'typescript',
        '.java': 'java',
        '.go': 'go',
    }
    return get_language(lang_map.get(ext, 'python'))

LANGUAGES = {
    '.py': lambda: get_lang('.py'),
    '.js': lambda: get_lang('.js'),
    '.ts': lambda: get_lang('.ts'),
    '.java': lambda: get_lang('.java'),
    '.go': lambda: get_lang('.go'),
}

from git_client import clone_repository, cleanup_repository
from import_visitor import import_visitor

SECRET_SCAN_SKIP_DIRS = {'.git', 'node_modules', 'venv', '.venv', 'dist', 'build', 'coverage', '__pycache__'}
SECRET_SCAN_SKIP_SUFFIXES = {
    '.lock', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
    '.gz', '.tar', '.pyc', '.woff', '.woff2', 'package-lock.json',
    'pnpm-lock.yaml', 'poetry.lock', 'cargo.lock'
}
SECRET_SCAN_MAX_FILE_BYTES = 512 * 1024
SECRET_SCAN_BATCH_SIZE = 40


def _is_text_bytes(data: bytes) -> bool:
    if b'\x00' in data[:2048]:
        return False
    try:
        data[:4096].decode('utf-8')
        return True
    except UnicodeDecodeError:
        return False


def _should_secret_scan(path: Path, repo_dir: str) -> bool:
    rel = path.relative_to(repo_dir)
    parts = set(rel.parts)
    if parts & SECRET_SCAN_SKIP_DIRS:
        return False
    lower_name = path.name.lower()
    return not any(lower_name.endswith(suffix) for suffix in SECRET_SCAN_SKIP_SUFFIXES)


async def _send_secret_scan_batch(client: httpx.AsyncClient, repo_id: str, files: list):
    if not files:
        return
    try:
        resp = await client.post(
            "http://api:8000/internal/security/baseline_scan",
            json={"repo_id": repo_id, "files": files},
            headers={"X-Internal-Key": INTERNAL_API_KEY},
            timeout=30.0,
        )
        print(f"Secret scan batch response: {resp.status_code}")
    except Exception as e:
        print(f"Secret scan batch failed: {e}")


async def _run_baseline_secret_scan(repo_id: str, repo_dir: str):
    print("Phase 2a: Running SecretSentinel baseline scan...")
    batch = []
    async with httpx.AsyncClient() as client:
        for root, dirs, files in os.walk(repo_dir):
            dirs[:] = [d for d in dirs if d not in SECRET_SCAN_SKIP_DIRS]
            root_path = Path(root)
            for file in files:
                file_path = root_path / file
                if not _should_secret_scan(file_path, repo_dir):
                    continue
                try:
                    data = file_path.read_bytes()
                    if len(data) > SECRET_SCAN_MAX_FILE_BYTES or not _is_text_bytes(data):
                        continue
                    batch.append({
                        "path": str(file_path.relative_to(repo_dir)),
                        "content": data.decode('utf-8', errors='replace'),
                    })
                    if len(batch) >= SECRET_SCAN_BATCH_SIZE:
                        await _send_secret_scan_batch(client, repo_id, batch)
                        batch = []
                except Exception as e:
                    print(f"Secret scan skipped {file_path}: {e}")
        await _send_secret_scan_batch(client, repo_id, batch)

def _detect_layer_violations(import_graph, layer_map: dict, repo_dir: str) -> list:
    """Flag imports that cross forbidden layer boundaries.

    layer_map: {"domain": ["src/domain"], "infra": ["src/db"]}
    Allowed direction: anything → infra. Forbidden: infra → domain, domain → presentation, etc.
    The user defines forbidden pairs via repo config; default: infra must not import domain.
    """
    violations = []
    if not layer_map:
        return violations

    # Build file → layer mapping (match by path prefix)
    def file_layer(filename: str) -> Optional[str]:
        for layer, prefixes in layer_map.items():
            for prefix in prefixes:
                if filename.startswith(prefix.rstrip('/') + '/') or filename == prefix:
                    return layer
        return None

    # Forbidden: higher-abstraction layers importing lower-abstraction layers
    # Convention: infra should not import domain (infra is a dependency, not the other way)
    # User can extend via config; here we flag infra → domain as the default rule.
    forbidden_pairs = [("infra", "domain")]
    for src_file, dst_file in import_graph.edges():
        src_layer = file_layer(src_file)
        dst_layer = file_layer(dst_file)
        if src_layer and dst_layer and src_layer != dst_layer:
            if (src_layer, dst_layer) in forbidden_pairs:
                violations.append({
                    'file': src_file,
                    'line': 1,
                    'type': 'layer_violation',
                    'severity': 'high',
                    'msg': f'Layer boundary violation: {src_layer} → {dst_layer} (import of {dst_file})',
                })
    return violations


async def run_arch_snapshot(ctx, repo_id: str, owner: str, name: str, github_token: str, branch: str = "main", layer_map: dict = None):
    """
    ARQ background task to execute the codebase snapshot and ArchSentinel evaluation.
    """
    print(f"Starting Arch Snapshot for: {owner}/{name}")
    
    repo_dir = None
    try:
        # 1. Clone the codebase
        # Git operations are blocking, so we run them in a thread pool executor
        loop = asyncio.get_event_loop()
        repo_dir = await loop.run_in_executor(
            None, 
            clone_repository, 
            github_token, owner, name, branch
        )
        
        # 2. Extract AST and evaluate rules
        print(f"Phase 2: Running Tree-sitter parsing on {repo_dir}...")

        # SecretSentinel runs independently from architecture parsing. Failure
        # should not prevent other analysis from completing.
        try:
            await _run_baseline_secret_scan(repo_id, repo_dir)
        except Exception as e:
            print(f"SecretSentinel baseline scan failed: {e}")
        
        violations = []
        import_graph = nx.DiGraph()
        lang_stats = {}
        
        for root, dirs, files in os.walk(repo_dir):
            root_path = Path(root)
            for file in files:
                file_path = root_path / file
                ext = file_path.suffix.lower()
                if ext in LANGUAGES:
                    lang = LANGUAGES[ext]()
                    parser = Parser(lang)
                    
                    try:
                        with open(file_path, 'rb') as f:
                            code = f.read()
                        tree = parser.parse(code)

                        # Count real functions via Tree-sitter query (not top-level AST children)
                        node_count = tree.root_node.descendant_count
                        func_count = 0
                        func_query_src = FUNC_QUERIES.get(ext)
                        if func_query_src:
                            try:
                                q = lang.query(func_query_src)
                                func_count = len(q.captures(tree.root_node))
                            except Exception:
                                func_count = 0

                        lang_stats[file_path.name] = {
                            'node_count': node_count,
                            'func_count': func_count,
                            'loc': len(code.decode().splitlines())
                        }

                        if func_count == 0 and node_count > 500:
                            # Include file content so LLMExplainer can give specific suggestions
                            try:
                                file_snippet = code.decode('utf-8', errors='replace')[:3000]
                            except Exception:
                                file_snippet = ""
                            violations.append({
                                'file': str(file_path.relative_to(repo_dir)),
                                'line': 1,
                                'type': 'god_class',
                                'severity': 'high',
                                'msg': f'No functions detected but {node_count} AST nodes — likely a large data/config file',
                                'file_content': file_snippet,
                            })
                        
                        # Extract imports for cycle detection — Python, JS, TS
                        if ext in ('.py', '.js', '.ts', '.tsx'):
                            import_visitor(tree.root_node, file_path.name, import_graph)
                            
                    except Exception as e:
                        print(f"Parse error {file_path}: {e}")
        
        # Cycle detection
        cycles = list(nx.simple_cycles(import_graph)) if import_graph.number_of_nodes() > 0 else []
        cycle_violations = [{'cycle': list(c)} for c in cycles[:10]]  # top 10

        # Layer boundary violations (if layer config provided)
        layer_violations = _detect_layer_violations(import_graph, layer_map or {}, str(repo_dir))
        violations.extend(layer_violations)

        # OPA-like policy evaluation (simple rules)
        total_files = len([f for ext in LANGUAGES for f in lang_stats if f.endswith(ext)])
        if total_files > 1000:
            violations.append({'type': 'monolith_size', 'line': 0, 'severity': 'medium', 'msg': f'{total_files} files — potential monolith'})
        
        print(f"Found {len(violations)} violations, {len(cycle_violations)} cycles")
        
        # 3. Send results to API
        analysis_data = {
            'violations': violations,
            'import_cycles': cycle_violations,
            'stats': lang_stats
        }
        
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                "http://api:8000/internal/arch_complete",
                json={'repo_id': repo_id, 'data': analysis_data},
                headers={"X-Internal-Key": INTERNAL_API_KEY},
            )
            print(f"API response: {resp.status_code}")
        
    except Exception as e:
        print(f"Arch Snapshot failed: {e}")
    finally:
        # Always clean up the large filesystem footprint
        if repo_dir:
            await loop.run_in_executor(None, cleanup_repository, repo_dir)

    print(f"Arch Snapshot complete for {owner}/{name}.")
    return True


async def startup(ctx):
    print("Arch Worker starting up...")

async def shutdown(ctx):
    print("Arch Worker shutting down...")

class WorkerSettings:
    functions = [run_arch_snapshot]
    on_startup = startup
    on_shutdown = shutdown
    queue_name = os.getenv('ARCH_QUEUE', 'arq:arch')
    redis_settings = RedisSettings(host=os.getenv('REDIS_HOST', 'localhost'))
