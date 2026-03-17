import asyncio
from git_client import clone_repository, cleanup_repository

async def run_arch_snapshot(ctx, repo_id: str, owner: str, name: str, github_token: str, branch: str = "main"):
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
        
        violations = []
        import_graph = nx.DiGraph()
        lang_stats = {}
        
        for root, dirs, files in os.walk(repo_dir):
            root_path = Path(root)
            for file in files:
                file_path = root_path / file
                ext = file_path.suffix.lower()
                if ext in LANGUAGES:
                    lang = LANGUAGES[ext]
                    parser = Parser()
                    parser.set_language(lang)
                    
                    try:
                        with open(file_path, 'rb') as f:
                            code = f.read()
                        tree = parser.parse(code)
                        
                        # Simple metrics
                        node_count = len(list(tree.root_node.children))
                        func_count = len(tree.root_node.named_children)  # approx
                        
                        lang_stats[file_path.name] = {
                            'node_count': node_count,
                            'func_count': func_count,
                            'loc': len(code.decode().splitlines())
                        }
                        
                        if func_count == 0 and node_count > 500:
                            violations.append({
                                'file': str(file_path.relative_to(repo_dir)),
                                'type': 'god_class',
                                'severity': 'high',
                                'msg': f'No functions but {node_count} nodes (potential config/data file violation)'
                            })
                        
                        # Extract imports for cycle detection (python example)
                        if ext == '.py':
                            import_visitor(tree.root_node, file_path.name, import_graph)
                            
                    except Exception as e:
                        print(f"Parse error {file_path}: {e}")
        
        # Cycle detection
        cycles = list(nx.simple_cycles(import_graph)) if import_graph.number_of_nodes() > 0 else []
        cycle_violations = [{'cycle': list(c)} for c in cycles[:10]]  # top 10
        
        # OPA-like policy evaluation (simple rules)
        total_files = len([f for ext in LANGUAGES for f in lang_stats if f.endswith(ext)])
        if total_files > 1000:
            violations.append({'type': 'monolith_size', 'severity': 'medium', 'msg': f'{total_files} files - potential monolith'})
        
        print(f"Found {len(violations)} violations, {len(cycle_violations)} cycles")
        
        # 3. Send results to API
        analysis_data = {
            'violations': violations,
            'import_cycles': cycle_violations,
            'stats': lang_stats
        }
        
        async with httpx.AsyncClient() as client:
            resp = await client.post("http://api:8000/internal/arch_complete", json={
                'repo_id': repo_id,
                'data': analysis_data
            })
            print(f"API response: {resp.status_code}")
        
    except Exception as e:
        print(f"Arch Snapshot failed: {e}")
    finally:
        # Always clean up the large filesystem footprint
        if repo_dir:
            await loop.run_in_executor(None, cleanup_repository, repo_dir)

    print(f"Arch Snapshot complete for {owner}/{name}.")
    return True

import os
from arq.connections import RedisSettings

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
