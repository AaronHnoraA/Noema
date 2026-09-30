export const SVG_EXPORT_MIME_TYPE = "image/svg+xml;charset=utf-8";
export const DEFAULT_SVG_EXPORT_FILE_NAME = "tikz-export.svg";
export function normalizeSvgExportFileName(fileName) {
    const candidate = fileName?.trim() ?? "";
    if (candidate.length === 0) {
        return DEFAULT_SVG_EXPORT_FILE_NAME;
    }
    if (/\.svg$/i.test(candidate)) {
        return candidate;
    }
    return `${candidate}.svg`;
}
export function createSvgExportArtifact(options) {
    return {
        fileName: normalizeSvgExportFileName(options.fileName),
        mimeType: SVG_EXPORT_MIME_TYPE,
        text: options.svg
    };
}
