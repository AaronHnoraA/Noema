export function replaceSpan(source, span, replacement) {
    const next = `${source.slice(0, span.from)}${replacement}${source.slice(span.to)}`;
    return {
        source: next,
        changedSpan: {
            from: span.from,
            to: span.from + replacement.length
        }
    };
}
