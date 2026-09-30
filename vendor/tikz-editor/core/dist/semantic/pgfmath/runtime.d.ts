import type { PgfRandom } from "./rng.js";
export type PgfMathRuntime = {
    rng: PgfRandom;
};
export declare function withPgfMathRuntime<T>(runtime: PgfMathRuntime | null, fn: () => T): T;
export declare function getCurrentPgfMathRuntime(): PgfMathRuntime | null;
