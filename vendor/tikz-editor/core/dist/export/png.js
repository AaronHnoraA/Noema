export const PNG_EXPORT_MIME_TYPE = "image/png";
export const DEFAULT_PNG_EXPORT_FILE_NAME = "tikz-export.png";
export function normalizePngExportFileName(fileName) {
    const candidate = fileName?.trim() ?? "";
    if (candidate.length === 0) {
        return DEFAULT_PNG_EXPORT_FILE_NAME;
    }
    if (/\.png$/i.test(candidate)) {
        return candidate;
    }
    return `${candidate}.png`;
}
export function createPngExportArtifact(options = {}) {
    return {
        fileName: normalizePngExportFileName(options.fileName),
        mimeType: PNG_EXPORT_MIME_TYPE
    };
}
