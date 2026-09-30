import { parseTikz } from "../parser/index.js";
import { isWrappedBySingleBracePair } from "../utils/braces.js";
export function parseStatementsFromBody(bodyRaw) {
    const parsed = parseStatementsFromBodyWithMapping(bodyRaw, { from: 0, to: bodyRaw.length });
    return {
        value: parsed.parseResult.figure.body,
        hasParseError: parsed.hasParseError
    };
}
export function parseStatementsFromBodyWithMapping(bodyRaw, bodySpan) {
    const prepared = prepareForeachBodySnippet(bodyRaw, bodySpan);
    const parseResult = parseTikz(prepared.syntheticSource, { recover: true });
    const hasParseError = parseResult.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    return {
        parseResult,
        hasParseError,
        sourceMapper: {
            mapSpan: (span) => mapSyntheticSpanToOriginal(span, prepared),
            mapOffset: (offset) => mapSyntheticOffsetToOriginal(offset, prepared)
        }
    };
}
export function parsePathItemsFromFragment(pathFragmentRaw) {
    const parsed = parsePathItemsFromFragmentWithMapping(pathFragmentRaw, { from: 0, to: pathFragmentRaw.length });
    return {
        value: parsed.value,
        hasParseError: parsed.hasParseError
    };
}
export function parsePathItemsFromFragmentWithMapping(pathFragmentRaw, fragmentSpan) {
    const parsed = parsePathItemsFromFragmentWithSyntheticMapping(pathFragmentRaw, fragmentSpan);
    return {
        value: remapSpansInPathItems(parsed.value, parsed.sourceMapper),
        hasParseError: parsed.hasParseError,
        sourceMapper: parsed.sourceMapper
    };
}
export function parsePathItemsFromFragmentWithSyntheticMapping(pathFragmentRaw, fragmentSpan) {
    const prepared = preparePathFragmentSnippet(pathFragmentRaw, fragmentSpan);
    const parsed = parseTikz(prepared.syntheticSource, { recover: true });
    const statement = parsed.figure.body.find((entry) => entry.kind === "Path");
    const hasParseError = parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    const sourceMapper = {
        mapSpan: (span) => mapSyntheticSpanToOriginal(span, prepared),
        mapOffset: (offset) => mapSyntheticOffsetToOriginal(offset, prepared)
    };
    if (statement?.kind !== "Path") {
        return {
            value: [],
            hasParseError: true,
            sourceMapper
        };
    }
    return {
        value: statement.items,
        hasParseError,
        sourceMapper
    };
}
export function parseNodeItemsFromTemplate(nodeTemplateRaw) {
    const source = `\\begin{tikzpicture}\n\\path ${nodeTemplateRaw};\n\\end{tikzpicture}`;
    const parsed = parseTikz(source, { recover: true });
    const statement = parsed.figure.body.find((entry) => entry.kind === "Path");
    const hasParseError = parsed.diagnostics.some((diagnostic) => diagnostic.severity === "error");
    if (statement?.kind !== "Path") {
        return {
            value: [],
            hasParseError: true
        };
    }
    return {
        value: statement.items,
        hasParseError
    };
}
function prepareForeachBodySnippet(bodyRaw, bodySpan) {
    const leftTrimmed = bodyRaw.trimStart();
    const leftTrim = bodyRaw.length - leftTrimmed.length;
    const rightTrimmed = leftTrimmed.trimEnd();
    const rightTrim = leftTrimmed.length - rightTrimmed.length;
    let working = rightTrimmed;
    let openingTrim = 0;
    let closingTrim = 0;
    if (working.startsWith("{") && working.endsWith("}") && isWrappedBySingleBracePair(working)) {
        working = working.slice(1, -1);
        openingTrim = 1;
        closingTrim = 1;
    }
    const contentLeftTrimmed = working.trimStart();
    const contentLeftTrim = working.length - contentLeftTrimmed.length;
    const content = contentLeftTrimmed.trimEnd();
    const contentRightTrim = contentLeftTrimmed.length - content.length;
    const syntheticPrefix = "\\begin{tikzpicture}\n";
    const syntheticSuffix = "\n\\end{tikzpicture}";
    return {
        syntheticSource: `${syntheticPrefix}${content}${syntheticSuffix}`,
        syntheticContentFrom: syntheticPrefix.length,
        syntheticContentTo: syntheticPrefix.length + content.length,
        originalContentFrom: bodySpan.from + leftTrim + openingTrim + contentLeftTrim,
        originalContentTo: bodySpan.to - rightTrim - closingTrim - contentRightTrim
    };
}
function mapSyntheticOffsetToOriginal(offset, prepared) {
    if (offset < prepared.syntheticContentFrom || offset > prepared.syntheticContentTo) {
        return null;
    }
    return prepared.originalContentFrom + (offset - prepared.syntheticContentFrom);
}
function mapSyntheticSpanToOriginal(span, prepared) {
    const from = mapSyntheticOffsetToOriginal(span.from, prepared);
    const to = mapSyntheticOffsetToOriginal(span.to, prepared);
    if (from == null || to == null || from > to) {
        return null;
    }
    return { from, to };
}
function preparePathFragmentSnippet(pathFragmentRaw, fragmentSpan) {
    let contentFrom = fragmentSpan.from;
    let contentTo = fragmentSpan.to;
    let working = pathFragmentRaw;
    const leftTrimmed = working.trimStart();
    contentFrom += working.length - leftTrimmed.length;
    working = leftTrimmed;
    const rightTrimmed = working.trimEnd();
    contentTo -= working.length - rightTrimmed.length;
    working = rightTrimmed;
    if (working.startsWith("{") && working.endsWith("}") && isWrappedBySingleBracePair(working)) {
        working = working.slice(1, -1);
        contentFrom += 1;
        contentTo -= 1;
    }
    const contentLeftTrimmed = working.trimStart();
    contentFrom += working.length - contentLeftTrimmed.length;
    working = contentLeftTrimmed;
    const contentRightTrimmed = working.trimEnd();
    contentTo -= working.length - contentRightTrimmed.length;
    const content = contentRightTrimmed;
    const syntheticPrefix = "\\begin{tikzpicture}\n\\path ";
    const syntheticSuffix = ";\n\\end{tikzpicture}";
    return {
        syntheticSource: `${syntheticPrefix}${content}${syntheticSuffix}`,
        syntheticContentFrom: syntheticPrefix.length,
        syntheticContentTo: syntheticPrefix.length + content.length,
        originalContentFrom: contentFrom,
        originalContentTo: contentTo
    };
}
function remapSpansInPathItems(items, sourceMapper) {
    return remapSpansDeep(items, sourceMapper.mapOffset);
}
function remapSpansDeep(value, mapOffset) {
    if (Array.isArray(value)) {
        return value.map((entry) => remapSpansDeep(entry, mapOffset));
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const record = value;
    let nextRecord = null;
    const fromCandidate = record.from;
    const toCandidate = record.to;
    if (typeof fromCandidate === "number" && typeof toCandidate === "number") {
        const mappedFrom = mapOffset(fromCandidate);
        const mappedTo = mapOffset(toCandidate);
        if (mappedFrom != null && mappedTo != null) {
            nextRecord = {
                ...record,
                from: mappedFrom,
                to: mappedTo
            };
        }
    }
    const sourceRecord = nextRecord ?? record;
    for (const [key, nested] of Object.entries(sourceRecord)) {
        const mapped = remapSpansDeep(nested, mapOffset);
        if (mapped !== nested) {
            nextRecord ??= { ...sourceRecord };
            nextRecord[key] = mapped;
        }
    }
    return nextRecord ?? value;
}
