import type { OptionListAst } from "../../options/types.js";
import type { WorldPoint } from "../../coords/points.js";
import type { WorldTransform } from "../../coords/transforms.js";
import type { ResolvedStyle } from "../types.js";
type TransformAxisVector = Readonly<{
    x: number;
    y: number;
}>;
export declare function parseStyleValueAsOptionList(valueRaw: string, absoluteFrom?: number): OptionListAst | null;
export declare function parseFontStyle(raw: string): Partial<Pick<ResolvedStyle, "fontStyle" | "fontWeight" | "fontFamily" | "fontSize">> | null;
export declare function parseAxisVector(raw: string, axis: "x" | "y"): TransformAxisVector | null;
export declare function parseCmTransformValue(raw: string, resolveCoordinate?: (raw: string) => WorldPoint | null): WorldTransform | null;
export declare function parseRotateAroundValue(raw: string, resolveCoordinate?: (raw: string) => WorldPoint | null): {
    angleDeg: number;
    pivot: WorldPoint;
} | null;
export declare function normalizeOptionValue(raw: string): string;
export declare function stripEnclosingBraces(raw: string): string;
export declare function readOptionalBracketOptions(input: string, startIndex: number): {
    optionsRaw: string | null;
    nextIndex: number;
};
export declare function readBalancedBlock(input: string, startIndex: number, open: string, close: string): {
    content: string;
    nextIndex: number;
} | null;
export declare function findTopLevelCharacter(input: string, character: string): number;
export {};
