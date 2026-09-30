import type { PgfRandom } from "./rng.js";
export type PgfMathQuantity = {
    kind: "scalar" | "length";
    value: number;
};
export type PgfMathEvalErrorCode = "empty" | "token" | "unexpected-token" | "unsupported-syntax" | "division-by-zero" | "invalid-arity" | "invalid-domain" | "unknown-function" | "unsupported-random" | "invalid-operation";
export type PgfMathEvalResult = {
    ok: true;
    quantity: PgfMathQuantity;
} | {
    ok: false;
    code: PgfMathEvalErrorCode;
    message: string;
};
export type EvaluatePgfMathOptions = {
    rng?: PgfRandom;
};
export declare function evaluatePgfMathExpression(input: string, options?: EvaluatePgfMathOptions): PgfMathEvalResult;
export declare function convertQuantityToLength(quantity: PgfMathQuantity, defaultUnit: "cm" | "pt"): number | null;
export declare function formatPgfMathNumber(value: number): string;
