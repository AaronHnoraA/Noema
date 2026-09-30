import type { PgfRandom } from "../pgfmath/rng.js";
import type { ResolvedStyle, SceneElement } from "../types.js";
import type { DiagnosticPushFn, FeatureMarkFn } from "./types.js";
export declare function decoratePathElements(elements: SceneElement[], decoration: ResolvedStyle["decoration"], mode: "replace" | "collect", statementId: string, rng: PgfRandom, markFeature: FeatureMarkFn, pushDiagnostic: DiagnosticPushFn): SceneElement[];
export declare function markDecorationFeature(nameRaw: string, status: "supported" | "unsupported", markFeature: FeatureMarkFn): void;
