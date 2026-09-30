import { type ParseTikzResult } from "../parser/index.js";
import type { EditAnalysisSession, EditAnalysisView } from "./analysis.js";
export type EditParseOptions = {
    activeFigureId?: string | null;
    analysisSession?: EditAnalysisSession | null;
    analysisView?: EditAnalysisView | null;
    colorAliases?: ReadonlyMap<string, string> | null;
    indentSize?: 2 | 4;
    propertyWriteMode?: PropertyWriteInteractionMode;
    sourceFingerprint?: string;
};
export type PropertyWriteInteractionMode = "commit" | "preview" | "drag-frame" | "drag-end";
export declare function parseTikzForEdit(source: string, options?: EditParseOptions): ParseTikzResult;
export declare function sourceFingerprintForEdit(source: string, options?: EditParseOptions): string;
