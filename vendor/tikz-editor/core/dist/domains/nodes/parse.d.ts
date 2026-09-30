import type { SyntaxNode } from "@lezer/common";
import type { NodeItem, Span } from "../../ast/types.js";
export declare function mapNodeItem(node: SyntaxNode, source: string, statementIndex: number, itemIndex: number): NodeItem;
export declare function mapSyntheticNodeItem(groupNode: SyntaxNode | null, optionsNodes: SyntaxNode[], source: string, statementIndex: number, itemIndex: number, opts?: {
    implicitFlags?: string[];
}): NodeItem;
export declare function mapGroupText(groupNode: SyntaxNode | null, source: string, fallbackOffset: number): {
    textSpan: Span;
    text: string;
};
