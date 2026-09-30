import type { WorldTransform } from "../../coords/transforms.js";
import type { WorldPoint } from "../../coords/points.js";
import type { OptionListAst } from "../../options/types.js";
import type { PathOptionItem } from "../../ast/types.js";
import type { ResolvedStyle, ScenePath } from "../types.js";
import type { DiagnosticPushFn } from "./types.js";
import type { StyleChainEntry } from "../style-chain.js";
import type { MacroBinding } from "../../macros/index.js";
export declare function extractGridSteps(item: PathOptionItem, pushDiagnostic: DiagnosticPushFn, macroBindings: ReadonlyMap<string, MacroBinding>, transform: WorldTransform): {
    stepX?: number;
    stepY?: number;
} | null;
export declare function extractGridStepsFromOptionList(options: OptionListAst, pushDiagnostic: DiagnosticPushFn, macroBindings: ReadonlyMap<string, MacroBinding>, transform: WorldTransform): {
    stepX?: number;
    stepY?: number;
} | null;
export declare function extractGridStepsFromOptionLists(optionLists: readonly OptionListAst[], pushDiagnostic: DiagnosticPushFn, macroBindings: ReadonlyMap<string, MacroBinding>, transform: WorldTransform): {
    stepX?: number;
    stepY?: number;
} | null;
export declare function makeGridElements(sourceId: string, itemId: string, from: WorldPoint, to: WorldPoint, stepX: number, stepY: number, style: ResolvedStyle, styleChain: StyleChainEntry[], span: {
    from: number;
    to: number;
}, transform?: WorldTransform): ScenePath[];
