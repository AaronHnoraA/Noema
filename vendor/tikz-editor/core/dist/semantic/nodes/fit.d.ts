import type { OptionListAst } from "../../options/types.js";
import { type SemanticContext } from "../context.js";
type FitDiagnostic = {
    code: string;
    message: string;
};
export type FitOverrideResolution = {
    hasFit: boolean;
    overrideOptions: OptionListAst | null;
    diagnostics: FitDiagnostic[];
};
export declare function resolveFitOverrides(options: OptionListAst | undefined, context: SemanticContext): FitOverrideResolution;
export {};
