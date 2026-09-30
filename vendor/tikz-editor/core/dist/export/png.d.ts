export declare const PNG_EXPORT_MIME_TYPE = "image/png";
export declare const DEFAULT_PNG_EXPORT_FILE_NAME = "tikz-export.png";
export type PngExportArtifact = {
    fileName: string;
    mimeType: "image/png";
};
export type CreatePngExportArtifactOptions = {
    fileName?: string;
};
export declare function normalizePngExportFileName(fileName?: string): string;
export declare function createPngExportArtifact(options?: CreatePngExportArtifactOptions): PngExportArtifact;
