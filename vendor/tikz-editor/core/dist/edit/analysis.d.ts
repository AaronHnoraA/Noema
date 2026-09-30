import type { PathStatement } from "../ast/types.js";
import { type ParseTikzResult } from "../parser/index.js";
import { type PropertyTargetResolution } from "./property-target.js";
import { type StatementSnapshot } from "./statement-ops.js";
export type EditAnalysisOptions = {
    activeFigureId?: string | null;
};
export type EditAnalysisView = {
    source: string;
    activeFigureId: string | null | undefined;
    parseResult: ParseTikzResult;
    statementSnapshot: StatementSnapshot;
    resolvePropertyTarget: (elementId: string) => PropertyTargetResolution;
    resolveFigurePropertyTarget: () => PropertyTargetResolution;
    findPathStatement: (sourceId: string) => PathStatement | null;
};
export type EditAnalysisSession = {
    primeFromParse: (parse: ParseTikzResult, source: string, options?: EditAnalysisOptions) => EditAnalysisView;
    ensure: (source: string, options?: EditAnalysisOptions) => EditAnalysisView;
    reset: () => void;
};
export declare function createEditAnalysisSession(): EditAnalysisSession;
