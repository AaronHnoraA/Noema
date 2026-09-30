import type { SyntaxNode } from "@lezer/common";
import type { Statement } from "../../ast/types.js";
export type StatementMappingState = {
    nextStatementIndex: number;
};
export declare function mapBodyStatements(node: SyntaxNode, source: string, state: StatementMappingState): Statement[];
export declare function unwrapStatementLikeNode(node: SyntaxNode): SyntaxNode;
export declare function mapStatementNode(node: SyntaxNode, source: string, state: StatementMappingState): Statement | null;
