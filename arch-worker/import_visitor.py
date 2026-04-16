"""Extract import edges from AST nodes for cycle detection.

Supports Python, JavaScript, and TypeScript.
"""


def import_visitor(node, module_name: str, graph) -> None:
    """Walk a Tree-sitter AST and add (module_name → imported) edges to graph."""
    _visit(node, module_name, graph)


def _visit(node, module_name: str, graph) -> None:
    _extract_python(node, module_name, graph)
    _extract_js_ts(node, module_name, graph)
    for child in node.children:
        _visit(child, module_name, graph)


def _extract_python(node, module_name: str, graph) -> None:
    """Python: import foo  /  from foo.bar import baz"""
    if node.type == 'import_statement':
        for child in node.named_children:
            if child.type in ('dotted_name', 'identifier'):
                imported = child.text.decode().split('.')[0]
                graph.add_edge(module_name, imported)

    elif node.type == 'import_from_statement':
        for child in node.named_children:
            if child.type == 'dotted_name':
                imported = child.text.decode().split('.')[0]
                graph.add_edge(module_name, imported)
                break  # first dotted_name is the source module


def _extract_js_ts(node, module_name: str, graph) -> None:
    """JS/TS: import ... from 'module'  /  require('module')  /  export ... from 'module'"""
    if node.type in ('import_statement', 'export_statement'):
        # Tree-sitter JS/TS: string node holds the module specifier
        for child in node.children:
            if child.type == 'string':
                specifier = child.text.decode().strip('"\'` ')
                if specifier and not specifier.startswith('.'):
                    # External package — use top-level package name
                    imported = specifier.lstrip('@').split('/')[0]
                elif specifier.startswith('.'):
                    # Relative import — normalise to bare filename
                    imported = specifier.split('/')[-1].split('.')[0] or specifier
                else:
                    continue
                graph.add_edge(module_name, imported)

    elif node.type == 'call_expression':
        # require('module') pattern
        fn = node.child_by_field_name('function')
        args = node.child_by_field_name('arguments')
        if fn and fn.text == b'require' and args:
            for arg in args.named_children:
                if arg.type == 'string':
                    specifier = arg.text.decode().strip('"\'` ')
                    if not specifier:
                        continue
                    if specifier.startswith('.'):
                        imported = specifier.split('/')[-1].split('.')[0] or specifier
                    else:
                        imported = specifier.lstrip('@').split('/')[0]
                    graph.add_edge(module_name, imported)
