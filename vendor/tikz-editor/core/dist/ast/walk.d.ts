import type { CoordinateOperationItem, NodeItem, PathItem, Statement } from "./types.js";
export type AstWalkVisitor = {
    onStatement?: (statement: Statement) => void;
    onPathItem?: (item: PathItem) => void;
    onNode?: (node: NodeItem) => void;
    onCoordinateOperation?: (item: CoordinateOperationItem) => void;
};
export declare function walkStatements(statements: readonly Statement[], visitor: AstWalkVisitor): void;
export declare function walkPathItems(items: readonly PathItem[], visitor: AstWalkVisitor): void;
