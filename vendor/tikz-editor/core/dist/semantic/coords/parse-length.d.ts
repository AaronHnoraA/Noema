import { type PgfMathQuantity } from "../pgfmath/evaluator.js";
export type ParsedQuantity = PgfMathQuantity;
export type ParsedLength = {
    value: number;
    hasExplicitUnit: boolean;
};
export declare function parseLength(input: string, defaultUnit: "cm" | "pt"): number | null;
export declare function parseLengthWithInfo(input: string, defaultUnit: "cm" | "pt"): ParsedLength | null;
export declare function parseQuantityExpression(input: string): ParsedQuantity | null;
export declare function parseCoordinateLike(raw: string): {
    x: string;
    y: string;
} | null;
