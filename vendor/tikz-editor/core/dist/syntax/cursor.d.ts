import type { SyntaxNode } from "@lezer/common";
export declare function forEachChild(node: SyntaxNode, fn: (child: SyntaxNode) => void): void;
export declare function walk(node: SyntaxNode, fn: (node: SyntaxNode) => void): void;
export declare function findFirstNodeByName(root: SyntaxNode, name: string): SyntaxNode | null;
export declare function findFirstChildByName(node: SyntaxNode, name: string): SyntaxNode | null;
export declare function firstNamedChild(node: SyntaxNode): SyntaxNode | null;
