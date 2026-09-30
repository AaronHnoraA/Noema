import type { SyntaxNode } from "@lezer/common";
import type { PathKeywordItem } from "../../ast/types.js";
export declare function maybeMapPathKeywordItem(node: SyntaxNode, source: string, statementIndex: number, itemIndex: number): PathKeywordItem | null;
