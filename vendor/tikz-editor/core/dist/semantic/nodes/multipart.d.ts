import type { OptionListAst } from "../../options/types.js";
export type NodePartText = {
    name: string;
    text: string;
};
export declare function parseNodeParts(text: string): NodePartText[];
export declare function isMultipartShape(shape: string): boolean;
export declare function resolveRectangleSplitParts(options: OptionListAst | undefined): number;
export declare function resolveRectangleSplitHorizontal(options: OptionListAst | undefined): boolean;
export declare function resolveRectangleSplitIgnoreEmptyParts(options: OptionListAst | undefined): boolean;
export declare function resolveRectangleSplitPartTexts(parts: NodePartText[], partCount: number): string[];
