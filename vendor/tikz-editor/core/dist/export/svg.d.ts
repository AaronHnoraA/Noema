export declare const SVG_EXPORT_MIME_TYPE = "image/svg+xml;charset=utf-8";
export declare const DEFAULT_SVG_EXPORT_FILE_NAME = "tikz-export.svg";
export type SvgExportArtifact = {
    fileName: string;
    mimeType: "image/svg+xml;charset=utf-8";
    text: string;
};
export type CreateSvgExportArtifactOptions = {
    svg: string;
    fileName?: string;
};
export declare function normalizeSvgExportFileName(fileName?: string): string;
export declare function createSvgExportArtifact(options: CreateSvgExportArtifactOptions): SvgExportArtifact;
