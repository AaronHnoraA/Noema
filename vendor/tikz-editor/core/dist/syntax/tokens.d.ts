import type { SyntaxNode } from "@lezer/common";
export declare const PATH_KEYWORDS: Set<string>;
export declare function classifyPathKeyword(node: SyntaxNode, source: string): string | null;
