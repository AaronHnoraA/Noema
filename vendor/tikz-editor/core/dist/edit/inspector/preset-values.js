import { stripEnclosingBraces } from "../../semantic/style/option-utils.js";
import { DASH_PATTERN_EPSILON, FILL_PATTERN_PRESET_BY_LOWER, LINE_WIDTH_PRESETS, META_FILL_PATTERN_PRESET_BY_KIND, META_FILL_PATTERN_PRESET_BY_LOWER } from "./presets.js";
export function fillShadingPresetFromStyleName(raw) {
    const normalized = stripEnclosingBraces(raw).trim().toLowerCase().replace(/\s+/g, " ");
    if (normalized === "axis") {
        return "axis";
    }
    if (normalized === "radial") {
        return "radial";
    }
    if (normalized === "ball") {
        return "ball";
    }
    return "custom";
}
export function fillPatternPresetFromResolvedPattern(pattern) {
    if (!pattern) {
        return "dots";
    }
    if (pattern.kind === "legacy") {
        const resolved = FILL_PATTERN_PRESET_BY_LOWER.get(pattern.name.toLowerCase());
        return resolved ?? "custom";
    }
    return META_FILL_PATTERN_PRESET_BY_KIND[pattern.kind] ?? "custom";
}
export function fillPatternPresetFromRaw(raw) {
    const name = extractPatternName(raw);
    if (!name) {
        return "dots";
    }
    const metaMatch = META_FILL_PATTERN_PRESET_BY_LOWER.get(name.toLowerCase()) ?? null;
    if (metaMatch) {
        return metaMatch;
    }
    const match = FILL_PATTERN_PRESET_BY_LOWER.get(name.toLowerCase());
    return match ?? "custom";
}
function extractPatternName(raw) {
    const normalized = stripEnclosingBraces(raw).trim();
    if (normalized.length === 0) {
        return null;
    }
    const bracketIndex = findTopLevelOpenBracket(normalized);
    const name = bracketIndex >= 0 ? normalized.slice(0, bracketIndex).trim() : normalized;
    return name.length > 0 ? name : null;
}
function findTopLevelOpenBracket(input) {
    let parenDepth = 0;
    let braceDepth = 0;
    let bracketDepth = 0;
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === "(") {
            parenDepth += 1;
            continue;
        }
        if (char === ")") {
            parenDepth = Math.max(0, parenDepth - 1);
            continue;
        }
        if (char === "{") {
            braceDepth += 1;
            continue;
        }
        if (char === "}") {
            braceDepth = Math.max(0, braceDepth - 1);
            continue;
        }
        if (char === "[") {
            if (parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
                return index;
            }
            bracketDepth += 1;
            continue;
        }
        if (char === "]") {
            bracketDepth = Math.max(0, bracketDepth - 1);
        }
    }
    return -1;
}
export function lineWidthPresetLabel(value) {
    for (const preset of LINE_WIDTH_PRESETS) {
        if (Math.abs(preset.value - value) <= 0.02) {
            return preset.label;
        }
    }
    return null;
}
export function dashStylePresetFromStyle(dashArray, lineWidth) {
    if (!dashArray || dashArray.length === 0) {
        return "solid";
    }
    if (dashArray.length !== 2) {
        return "custom";
    }
    const first = dashArray[0];
    const second = dashArray[1];
    if (closeEnough(first, 3) && closeEnough(second, 3)) {
        return "dashed";
    }
    if (closeEnough(first, 4) && closeEnough(second, 2)) {
        return "densely dashed";
    }
    if (closeEnough(first, 6) && closeEnough(second, 4)) {
        return "loosely dashed";
    }
    if (closeEnough(first, lineWidth) && closeEnough(second, 2)) {
        return "dotted";
    }
    if (closeEnough(first, lineWidth) && closeEnough(second, 1)) {
        return "densely dotted";
    }
    if (closeEnough(first, lineWidth) && closeEnough(second, 4)) {
        return "loosely dotted";
    }
    return "custom";
}
function closeEnough(a, b) {
    return Math.abs(a - b) <= DASH_PATTERN_EPSILON;
}
export function lineCapPresetFromStyle(value) {
    if (value === "butt" || value === "round" || value === "square") {
        return value;
    }
    return "custom";
}
export function lineJoinPresetFromStyle(value) {
    if (value === "miter" || value === "round" || value === "bevel") {
        return value;
    }
    return "custom";
}
