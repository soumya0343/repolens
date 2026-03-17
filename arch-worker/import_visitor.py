def import_visitor(node, module_name, graph):
    if node.type == 'import_statement' or node.type == 'import_from_statement':
        for child in node.named_children:
            if child.type == 'dotted_name' or child.type == 'identifier':
                imported = child.text.decode().split('.')[0]
                graph.add_edge(module_name, imported)
    
    for child in node.children:
        import_visitor(child, module_name, graph)
