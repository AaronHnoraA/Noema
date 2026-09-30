import { formatSvgNumber as fmt } from "./format.js";
let xmlFormatterPromise = null;
export function createSvgModelBuilder() {
    const parts = [];
    const baseIdCounts = new Map();
    const usedPartIds = new Set();
    const addPartWithId = (partId, input) => {
        if (usedPartIds.has(partId)) {
            throw new Error(`Duplicate svg part id generated: ${partId}`);
        }
        usedPartIds.add(partId);
        const part = {
            partId,
            sourceId: input.sourceId,
            elementId: input.elementId,
            order: parts.length,
            markup: input.markup,
            fingerprint: input.fingerprint
        };
        parts.push(part);
        return part;
    };
    const addPart = (input) => {
        const base = sanitizePartIdBase(input.basePartId);
        let seenCount = baseIdCounts.get(base) ?? 0;
        let partId = seenCount === 0 ? base : `${base}#${seenCount + 1}`;
        while (usedPartIds.has(partId)) {
            seenCount += 1;
            partId = `${base}#${seenCount + 1}`;
        }
        baseIdCounts.set(base, seenCount + 1);
        return addPartWithId(partId, {
            sourceId: input.sourceId,
            elementId: input.elementId,
            markup: input.markup,
            fingerprint: input.markup
        });
    };
    const addExistingPart = (part) => {
        return addPartWithId(part.partId, {
            sourceId: part.sourceId,
            elementId: part.elementId,
            markup: part.markup,
            fingerprint: part.fingerprint
        });
    };
    const build = (input) => {
        return {
            viewBox: input.viewBox,
            defs: [...input.defs],
            defsFingerprint: fingerprintDefs(input.defs),
            parts: [...parts],
            diagnostics: [...input.diagnostics]
        };
    };
    return {
        addPart,
        addExistingPart,
        build
    };
}
export function serializeSvgModel(model, includeXmlns = true) {
    return serializeSvgModelCompact(model, includeXmlns);
}
export async function serializeSvgModelAsync(model, options = {}) {
    const includeXmlns = options.includeXmlns ?? true;
    const compact = serializeSvgModelCompact(model, includeXmlns);
    if (!options.pretty) {
        return compact;
    }
    const xmlFormatter = await getXmlFormatter();
    return xmlFormatter(compact, {
        indentation: options.indentation ?? "  ",
        collapseContent: options.collapseContent ?? true,
        lineSeparator: options.lineSeparator ?? "\n"
    });
}
function serializeSvgModelCompact(model, includeXmlns) {
    const xmlns = includeXmlns ? ` xmlns="http://www.w3.org/2000/svg"` : "";
    const defs = model.defs.length > 0 ? `<defs>${model.defs.join("")}</defs>` : "";
    const body = model.parts.map((part) => part.markup).join("");
    return (`<svg${xmlns} viewBox="${fmt(model.viewBox.x)} ${fmt(model.viewBox.y)} ${fmt(model.viewBox.width)} ${fmt(model.viewBox.height)}" role="img" aria-label="TikZ SVG preview">` +
        defs +
        body +
        `</svg>`);
}
export function fingerprintDefs(defs) {
    return defs.join("");
}
async function getXmlFormatter() {
    xmlFormatterPromise ??= import("xml-formatter").then((mod) => {
        const formatter = mod.default;
        if (typeof formatter !== "function") {
            throw new Error("xml-formatter default export is not a function.");
        }
        return formatter;
    });
    return xmlFormatterPromise;
}
function sanitizePartIdBase(base) {
    const trimmed = base.trim();
    if (trimmed.length === 0) {
        return "part";
    }
    return trimmed.replace(/\s+/g, "_");
}
