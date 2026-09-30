import type { DiagnosticPushFn, FeatureMarkFn } from "../path/types.js";
import type { PgfRandom } from "../pgfmath/rng.js";
import type { ResolvedStyle, SceneElement } from "../types.js";
export declare function applyNodeDecorations(elements: SceneElement[], decoration: ResolvedStyle["decoration"], seedPrefix: string, rng: PgfRandom, markFeature: FeatureMarkFn, pushDiagnostic: DiagnosticPushFn): SceneElement[];
