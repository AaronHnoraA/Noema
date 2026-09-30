import type { PathStatement } from "../../ast/types.js";
import { type SemanticContext } from "../context.js";
import type { ResolvedStyle, SceneElement } from "../types.js";
import type { DiagnosticPushFn, FeatureMarkFn, PathEvaluationOptions } from "./types.js";
export declare function evaluatePathStatement(statement: PathStatement, context: SemanticContext, style: ResolvedStyle, markFeature: FeatureMarkFn, pushDiagnostic: DiagnosticPushFn, options?: PathEvaluationOptions): SceneElement[];
