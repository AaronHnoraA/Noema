export declare const PDF_EXPORT_MIME_TYPE = "application/pdf";
export declare const DEFAULT_PDF_EXPORT_FILE_NAME = "tikz-export.pdf";
export type PdfExportArtifact = {
    fileName: string;
    mimeType: "application/pdf";
};
export type CreatePdfExportArtifactOptions = {
    fileName?: string;
};
export declare function normalizePdfExportFileName(fileName?: string): string;
export declare function createPdfExportArtifact(options?: CreatePdfExportArtifactOptions): PdfExportArtifact;
