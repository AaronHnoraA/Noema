export function pathStatementId(statementIndex) {
    return `path:${statementIndex}`;
}
export function scopeStatementId(statementIndex) {
    return `scope:${statementIndex}`;
}
export function foreachStatementId(statementIndex) {
    return `foreach:${statementIndex}`;
}
export function macroDefinitionStatementId(statementIndex) {
    return `macro-definition:${statementIndex}`;
}
export function macroAliasStatementId(statementIndex) {
    return `macro-alias:${statementIndex}`;
}
export function macroCommandDefinitionStatementId(statementIndex) {
    return `macro-command-definition:${statementIndex}`;
}
export function pgfMathStatementId(statementIndex) {
    return `pgfmath:${statementIndex}`;
}
export function tikzSetStatementId(statementIndex) {
    return `tikz-set:${statementIndex}`;
}
export function tikzStyleStatementId(statementIndex) {
    return `tikz-style:${statementIndex}`;
}
export function pgfkeysStatementId(statementIndex) {
    return `pgfkeys:${statementIndex}`;
}
export function tikzLibraryStatementId(statementIndex) {
    return `tikz-library:${statementIndex}`;
}
export function colorletStatementId(statementIndex) {
    return `colorlet:${statementIndex}`;
}
export function defineColorStatementId(statementIndex) {
    return `definecolor:${statementIndex}`;
}
export function unknownStatementId(statementIndex) {
    return `unknown-statement:${statementIndex}`;
}
export function coordinateItemId(statementIndex, itemIndex) {
    return `coordinate:${statementIndex}:${itemIndex}`;
}
export function nodeItemId(statementIndex, itemIndex) {
    return `node:${statementIndex}:${itemIndex}`;
}
export function nodeForeachClauseId(statementIndex, itemIndex, clauseIndex) {
    return `node-foreach-clause:${statementIndex}:${itemIndex}:${clauseIndex}`;
}
export function pathOptionItemId(statementIndex, itemIndex) {
    return `path-option:${statementIndex}:${itemIndex}`;
}
export function pathCommentItemId(statementIndex, itemIndex) {
    return `path-comment:${statementIndex}:${itemIndex}`;
}
export function pathKeywordItemId(statementIndex, itemIndex) {
    return `path-keyword:${statementIndex}:${itemIndex}`;
}
export function graphOperationItemId(statementIndex, itemIndex) {
    return `graph-operation:${statementIndex}:${itemIndex}`;
}
export function plotOperationItemId(statementIndex, itemIndex) {
    return `plot-operation:${statementIndex}:${itemIndex}`;
}
export function pathForeachItemId(statementIndex, itemIndex) {
    return `path-foreach:${statementIndex}:${itemIndex}`;
}
export function picOperationItemId(statementIndex, itemIndex) {
    return `pic-operation:${statementIndex}:${itemIndex}`;
}
export function picForeachClauseId(statementIndex, itemIndex, clauseIndex) {
    return `pic-foreach-clause:${statementIndex}:${itemIndex}:${clauseIndex}`;
}
export function toOperationItemId(statementIndex, itemIndex) {
    return `to-operation:${statementIndex}:${itemIndex}`;
}
export function edgeOperationItemId(statementIndex, itemIndex) {
    return `edge-operation:${statementIndex}:${itemIndex}`;
}
export function childOperationItemId(statementIndex, itemIndex) {
    return `child-operation:${statementIndex}:${itemIndex}`;
}
export function edgeFromParentOperationItemId(statementIndex, itemIndex) {
    return `edge-from-parent-operation:${statementIndex}:${itemIndex}`;
}
export function childForeachClauseId(statementIndex, itemIndex, clauseIndex) {
    return `child-foreach-clause:${statementIndex}:${itemIndex}:${clauseIndex}`;
}
export function svgOperationItemId(statementIndex, itemIndex) {
    return `svg-operation:${statementIndex}:${itemIndex}`;
}
export function letOperationItemId(statementIndex, itemIndex) {
    return `let-operation:${statementIndex}:${itemIndex}`;
}
export function decorateOperationItemId(statementIndex, itemIndex) {
    return `decorate-operation:${statementIndex}:${itemIndex}`;
}
export function coordinateOperationItemId(statementIndex, itemIndex) {
    return `coordinate-operation:${statementIndex}:${itemIndex}`;
}
export function unknownPathItemId(statementIndex, itemIndex) {
    return `unknown-path-item:${statementIndex}:${itemIndex}`;
}
