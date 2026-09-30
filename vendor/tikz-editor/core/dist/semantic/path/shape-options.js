import { parseLength, parseLengthWithInfo } from "../coords/parse-length.js";
import { expandPathMacroBindings } from "./macro-expansion.js";
export function extractEllipseRadii(item, pushDiagnostic, macroBindings, macroTraceCollector) {
    let rx = null;
    let ry = null;
    let radius = null;
    for (const entry of item.options.entries) {
        if (entry.kind !== "kv") {
            continue;
        }
        if (entry.key === "x radius") {
            const parsed = parseLengthWithInfo(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                rx = { value: parsed.value, applyFrameTransform: !parsed.hasExplicitUnit };
            }
        }
        else if (entry.key === "y radius") {
            const parsed = parseLengthWithInfo(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                ry = { value: parsed.value, applyFrameTransform: !parsed.hasExplicitUnit };
            }
        }
        else if (entry.key === "radius") {
            const parsed = parseLengthWithInfo(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                radius = { value: parsed.value, applyFrameTransform: !parsed.hasExplicitUnit };
            }
        }
    }
    if (radius != null) {
        return { rx: radius, ry: radius };
    }
    if (rx != null && ry != null) {
        return { rx, ry };
    }
    if (rx == null && ry == null) {
        return null;
    }
    pushDiagnostic("invalid-ellipse-radii", "Ellipse requires both x radius and y radius.", item.span.from, item.span.to);
    return null;
}
export function extractCircleShapeOptions(item, macroBindings, macroTraceCollector) {
    let radius;
    let rx;
    let ry;
    let rotation;
    for (const entry of item.options.entries) {
        if (entry.kind !== "kv") {
            continue;
        }
        if (entry.key === "radius") {
            const parsed = parseLengthWithInfo(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                radius = { value: parsed.value, applyFrameTransform: !parsed.hasExplicitUnit };
            }
        }
        else if (entry.key === "x radius") {
            const parsed = parseLengthWithInfo(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                rx = { value: parsed.value, applyFrameTransform: !parsed.hasExplicitUnit };
            }
        }
        else if (entry.key === "y radius") {
            const parsed = parseLengthWithInfo(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                ry = { value: parsed.value, applyFrameTransform: !parsed.hasExplicitUnit };
            }
        }
        else if (entry.key === "rotate") {
            const parsed = Number(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector));
            if (Number.isFinite(parsed)) {
                rotation = parsed;
            }
        }
    }
    return { radius, rx, ry, rotation };
}
export function extractRoundedCorners(options, current) {
    let next = current;
    let changed = false;
    for (const entry of options.entries) {
        if (entry.kind === "flag" && entry.key === "sharp corners") {
            next = null;
            changed = true;
            continue;
        }
        if (entry.kind === "flag" && entry.key === "rounded corners") {
            next = parseLength("4pt", "pt") ?? 4;
            changed = true;
            continue;
        }
        if (entry.kind === "kv" && entry.key === "rounded corners") {
            const parsed = parseLength(entry.valueRaw, "pt");
            if (parsed != null) {
                next = parsed;
                changed = true;
            }
        }
    }
    return changed ? next : undefined;
}
