import type { DecorationStyle, SceneElement, ScenePath } from "../types.js";
import type { PgfRandom } from "../pgfmath/rng.js";
export type DecorationApplyResult = {
    kind: "decorated";
    elements: SceneElement[];
} | {
    kind: "unsupported";
    reason: "deferred" | "unknown";
    name: string;
    elements: SceneElement[];
};
export declare function applyDecorationToPath(path: ScenePath, decoration: DecorationStyle, seedRaw: string, rng?: PgfRandom): DecorationApplyResult;
export declare function isDecorationDeferred(name: string): boolean;
