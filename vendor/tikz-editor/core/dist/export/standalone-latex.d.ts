export declare const STANDALONE_LATEX_EXPORT_MIME_TYPE = "application/x-tex;charset=utf-8";
export declare const DEFAULT_STANDALONE_LATEX_EXPORT_FILE_NAME = "tikz-export.tex";
export type StandaloneExportDiagnostic = {
    code: string;
    message: string;
    severity: "warning" | "error";
    span?: {
        from: number;
        to: number;
    };
    symbolKind?: "macro" | "color" | "style" | "key" | "library";
    symbolName?: string;
};
export type StandaloneLatexExportArtifact = {
    fileName: string;
    mimeType: "application/x-tex;charset=utf-8";
    text: string;
    complete: boolean;
    diagnostics: StandaloneExportDiagnostic[];
};
export type MinimalTikzSourceArtifact = {
    text: string;
    complete: boolean;
    diagnostics: StandaloneExportDiagnostic[];
    definitionCount: number;
    activeFigureSource: string;
};
export type CreateStandaloneLatexExportArtifactOptions = {
    source: string;
    activeFigureId: string | null;
    fileName?: string;
    documentClassOptions?: readonly string[];
};
export type CreateMinimalTikzSourceArtifactOptions = {
    source: string;
    activeFigureId: string | null;
};
export declare function normalizeStandaloneLatexExportFileName(fileName?: string): string;
export declare function createMinimalTikzSourceArtifact(options: CreateMinimalTikzSourceArtifactOptions): MinimalTikzSourceArtifact;
export declare function createStandaloneLatexExportArtifact(options: CreateStandaloneLatexExportArtifactOptions): StandaloneLatexExportArtifact;
