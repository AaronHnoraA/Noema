import type { SyntaxNode } from "@lezer/common";
import type { UnknownPathItem, UnknownStatement } from "../ast/types.js";
export declare function mapUnknownPathItem(node: SyntaxNode, source: string, statementIndex: number, itemIndex: number): UnknownPathItem;
export declare function mapUnknownStatement(node: SyntaxNode, source: string, statementIndex: number): UnknownStatement;
