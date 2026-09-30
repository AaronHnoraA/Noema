export function walkStatements(statements, visitor) {
    for (const statement of statements) {
        visitor.onStatement?.(statement);
        if (statement.kind === "Path") {
            walkPathItems(statement.items, visitor);
            continue;
        }
        if (statement.kind === "Scope") {
            walkStatements(statement.body, visitor);
        }
    }
}
export function walkPathItems(items, visitor) {
    for (const item of items) {
        visitor.onPathItem?.(item);
        if (item.kind === "Node") {
            visitor.onNode?.(item);
            continue;
        }
        if (item.kind === "CoordinateOperation") {
            visitor.onCoordinateOperation?.(item);
            continue;
        }
        if ((item.kind === "ToOperation" || item.kind === "EdgeOperation" || item.kind === "EdgeFromParentOperation") && item.nodes) {
            for (const node of item.nodes) {
                visitor.onNode?.(node);
            }
            continue;
        }
        if (item.kind === "ChildOperation") {
            walkPathItems(item.body, visitor);
        }
    }
}
