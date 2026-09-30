export function styleDiagnosticCode(diagnostic) {
    return typeof diagnostic === "string" ? diagnostic : diagnostic.code;
}
export function normalizeStyleDiagnostic(diagnostic, fallbackSpan) {
    if (typeof diagnostic === "string") {
        return fallbackSpan ? { code: diagnostic, span: cloneSpan(fallbackSpan) } : { code: diagnostic };
    }
    const span = diagnostic.span ? cloneSpan(diagnostic.span) : fallbackSpan ? cloneSpan(fallbackSpan) : undefined;
    if (!span) {
        return { code: diagnostic.code };
    }
    return {
        code: diagnostic.code,
        span
    };
}
export function styleDiagnosticSpan(diagnostic, fallbackSpan) {
    return diagnostic.span ?? fallbackSpan;
}
function cloneSpan(span) {
    return { from: span.from, to: span.to };
}
