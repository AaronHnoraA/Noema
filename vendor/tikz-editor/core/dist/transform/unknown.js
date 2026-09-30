import { unknownPathItemId, unknownStatementId } from "../ast/ids.js";
export function mapUnknownPathItem(node, source, statementIndex, itemIndex) {
    return {
        kind: "UnknownPathItem",
        id: unknownPathItemId(statementIndex, itemIndex),
        span: { from: node.from, to: node.to },
        raw: source.slice(node.from, node.to)
    };
}
export function mapUnknownStatement(node, source, statementIndex) {
    return {
        kind: "UnknownStatement",
        id: unknownStatementId(statementIndex),
        span: { from: node.from, to: node.to },
        raw: source.slice(node.from, node.to)
    };
}
