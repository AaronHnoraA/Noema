import { splitAllAtTopLevel } from "../domains/coordinates/parse.js";
import { parseCoordinateLike, parseLength } from "../semantic/coords/parse-length.js";
import { stripEnclosingBraces } from "../semantic/style/option-utils.js";
import { SHADOW_INHERIT_FILL, SHADOW_INHERIT_STROKE } from "../semantic/types.js";
import { resolvePropertyTarget } from "./property-target.js";
import { formatNumber } from "./format.js";
import { normalizeOptionKey } from "./option-key.js";
import { uniqueStrings } from "./statement-find.js";
import { ARROW_DEFAULT_CLEAR_KEYS, ARROW_OPTION_KEY, AXIS_SHADING_CONFLICT_CLEAR_KEYS, BALL_SHADING_CONFLICT_CLEAR_KEYS, DASH_STYLE_PRESET_CLEAR_KEYS, FILL_PATTERN_CLEAR_KEYS, FILL_SHADING_CLEAR_KEYS, LINE_WIDTH_PRESETS, NODE_FONT_FAMILY_COMMAND, NODE_FONT_PRESET_BY_ID, NODE_FONT_STYLE_COMMAND, NODE_FONT_WEIGHT_COMMAND, NODE_INNER_SEP_CLEAR_KEYS, NODE_INNER_SEP_DEFAULT, NODE_MINIMUM_DIMENSION_CLEAR_KEYS, NODE_MINIMUM_DIMENSION_DEFAULT, NODE_SHAPE_KEY, NODE_SHAPE_KNOWN_KEYS, PATH_MORPHING_DECORATION_CLEAR_KEYS, RADIAL_SHADING_CONFLICT_CLEAR_KEYS, ROUNDED_CORNERS_CLEAR_KEYS, ROUNDED_CORNERS_DEFAULT_RADIUS, SHADOW_ALL_KEYS, SHADOW_PRESET_DEFAULTS, SHADOW_PRESET_TIKZ_KEY } from "./inspector/presets.js";
export const DEFAULT_TRANSFORM_INSPECTOR_VALUES = {
    xshift: 0,
    yshift: 0,
    xscale: 1,
    yscale: 1,
    rotate: 0,
    rotateAround: null
};
export const SHIFT_CLEAR_KEYS = ["shift", "/tikz/shift"];
export const SCALE_CLEAR_KEYS = ["scale", "/tikz/scale"];
export const ROTATE_CLEAR_KEYS = ["/tikz/rotate", "rotate around", "/tikz/rotate around"];
export const LINE_WIDTH_NUMERIC_KEY = "line width";
export const LINE_WIDTH_PRESET_KEYS = LINE_WIDTH_PRESETS.map((preset) => preset.label);
export const LINE_WIDTH_ALL_OPTION_KEYS = [LINE_WIDTH_NUMERIC_KEY, ...LINE_WIDTH_PRESET_KEYS];
export const TRANSFORM_KEY_ALIAS_CLEAR_KEYS = {
    xshift: ["/tikz/xshift"],
    yshift: ["/tikz/yshift"],
    xscale: ["/tikz/xscale"],
    yscale: ["/tikz/yscale"],
    rotate: ["/tikz/rotate"]
};
export function buildArrowTipSetPropertyMutation(context, side, value) {
    const nextStartRaw = side === "start" ? arrowPresetSideRaw(value, "start") : context.startRaw;
    const nextEndRaw = side === "end" ? arrowPresetSideRaw(value, "end") : context.endRaw;
    const serialized = serializeArrowSides(nextStartRaw, nextEndRaw);
    return {
        key: serialized.key,
        value: serialized.value,
        clearKeys: uniqueStrings([...ARROW_DEFAULT_CLEAR_KEYS, ...context.clearKeys])
    };
}
export function buildDashStyleSetPropertyMutation(value) {
    return {
        key: value,
        value: "true",
        clearKeys: uniqueStrings(DASH_STYLE_PRESET_CLEAR_KEYS)
    };
}
export function buildLineCapSetPropertyMutation(value) {
    return {
        key: "line cap",
        value: value === "square" ? "projecting" : value,
        clearKeys: []
    };
}
export function buildLineJoinSetPropertyMutation(value) {
    return {
        key: "line join",
        value,
        clearKeys: []
    };
}
export function buildLineWidthPresetSetPropertyMutation(presetKey) {
    return {
        key: presetKey,
        value: "true",
        clearKeys: LINE_WIDTH_ALL_OPTION_KEYS.filter((key) => key !== presetKey)
    };
}
export function buildLineWidthValueSetPropertyMutation(value) {
    return {
        key: LINE_WIDTH_NUMERIC_KEY,
        value,
        clearKeys: LINE_WIDTH_PRESET_KEYS
    };
}
export function buildFillModeSetPropertyMutations(value, context = {}) {
    const fillColor = normalizeFillMutationColor(context.fillColor, "black");
    const patternColor = normalizeFillMutationColor(context.patternColor, "black");
    const nextShading = selectCuratedShadingPreset(context.shading);
    const nextPattern = selectCuratedPatternPreset(context.pattern);
    if (value === "solid") {
        return [
            {
                key: "fill",
                value: fillColor,
                clearKeys: uniqueStrings([...FILL_PATTERN_CLEAR_KEYS, ...FILL_SHADING_CLEAR_KEYS])
            }
        ];
    }
    if (value === "gradient") {
        const clearKeys = uniqueStrings(FILL_PATTERN_CLEAR_KEYS);
        return [
            {
                key: "shade",
                value: "true",
                clearKeys
            },
            {
                key: "shading",
                value: nextShading,
                clearKeys
            }
        ];
    }
    const clearKeys = uniqueStrings(FILL_SHADING_CLEAR_KEYS);
    return [
        {
            key: "pattern",
            value: nextPattern,
            clearKeys
        },
        {
            key: "pattern color",
            value: patternColor,
            clearKeys
        }
    ];
}
export function buildFillShadingSetPropertyMutations(value) {
    const conflictClearKeys = uniqueStrings(value === "axis"
        ? AXIS_SHADING_CONFLICT_CLEAR_KEYS
        : value === "radial"
            ? RADIAL_SHADING_CONFLICT_CLEAR_KEYS
            : BALL_SHADING_CONFLICT_CLEAR_KEYS);
    return [
        {
            key: "shade",
            value: "true",
            clearKeys: []
        },
        {
            key: "shading",
            value,
            clearKeys: conflictClearKeys
        }
    ];
}
export function buildFillPatternSetPropertyMutation(value) {
    return {
        key: "pattern",
        value,
        clearKeys: []
    };
}
export function buildFillPatternOptionSetPropertyMutation(context, option, value) {
    const nextValues = {
        ...context.values,
        [fillPatternMetaValueKey(option)]: sanitizeFillPatternMetaOptionValue(option, value, context.values)
    };
    return {
        key: "pattern",
        value: serializeFillPatternMetaPattern(context.family, nextValues),
        clearKeys: []
    };
}
export function buildPathMorphingDecorationSetPropertyMutations(value) {
    const clearKeys = uniqueStrings(PATH_MORPHING_DECORATION_CLEAR_KEYS);
    const clearKeysWithoutDecorate = clearKeys.filter((key) => key !== "decorate");
    if (value === "none") {
        return [
            {
                key: "decorate",
                value: "false",
                clearKeys: clearKeysWithoutDecorate
            }
        ];
    }
    return [
        {
            key: "decorate",
            value: "true",
            clearKeys: clearKeysWithoutDecorate
        },
        {
            key: "decoration",
            value,
            clearKeys: clearKeysWithoutDecorate
        }
    ];
}
export function buildRoundedCornersSetPropertyMutation(enabled, radius = ROUNDED_CORNERS_DEFAULT_RADIUS, disableRequiresSharpCorners = true) {
    const safeRadius = Number.isFinite(radius) && radius > 0 ? radius : ROUNDED_CORNERS_DEFAULT_RADIUS;
    const clearKeys = uniqueStrings(ROUNDED_CORNERS_CLEAR_KEYS);
    if (!enabled) {
        if (!disableRequiresSharpCorners) {
            return {
                key: "rounded corners",
                value: "",
                clearKeys
            };
        }
        return {
            key: "sharp corners",
            value: "true",
            clearKeys: clearKeys.filter((key) => key !== "sharp corners")
        };
    }
    return {
        key: "rounded corners",
        value: Math.abs(safeRadius - ROUNDED_CORNERS_DEFAULT_RADIUS) <= 1e-6
            ? "true"
            : `${formatInspectorLength(safeRadius)}pt`,
        clearKeys: clearKeys.filter((key) => key !== "rounded corners")
    };
}
export function buildNodeShapeSetPropertyMutation(value) {
    return {
        key: NODE_SHAPE_KEY,
        value,
        clearKeys: uniqueStrings([...NODE_SHAPE_KNOWN_KEYS])
    };
}
export function buildNodeInnerSepSetPropertyMutation(value) {
    const safe = Number.isFinite(value) && value >= 0 ? value : NODE_INNER_SEP_DEFAULT;
    const formatted = Math.abs(safe - NODE_INNER_SEP_DEFAULT) <= 1e-6
        ? ".3333em"
        : `${formatInspectorLength(safe)}pt`;
    return {
        key: "inner sep",
        value: formatted,
        clearKeys: uniqueStrings([...NODE_INNER_SEP_CLEAR_KEYS])
    };
}
export function buildNodeMinimumDimensionSetPropertyMutations(context, editedKey, nextValue) {
    if (!Number.isFinite(nextValue)) {
        return [];
    }
    const safeWidth = Number.isFinite(context.minimumWidth) && context.minimumWidth >= 0
        ? context.minimumWidth
        : NODE_MINIMUM_DIMENSION_DEFAULT;
    const safeHeight = Number.isFinite(context.minimumHeight) && context.minimumHeight >= 0
        ? context.minimumHeight
        : NODE_MINIMUM_DIMENSION_DEFAULT;
    const safeNextValue = Math.max(0, normalizeTinyNumber(nextValue));
    const nextDimensions = {
        minimumWidth: safeWidth,
        minimumHeight: safeHeight
    };
    if (editedKey === "minimum width") {
        nextDimensions.minimumWidth = safeNextValue;
    }
    else {
        nextDimensions.minimumHeight = safeNextValue;
    }
    const companionKey = editedKey === "minimum width" ? "minimum height" : "minimum width";
    const companionValue = companionKey === "minimum width" ? nextDimensions.minimumWidth : nextDimensions.minimumHeight;
    const mutations = [
        {
            key: editedKey,
            value: `${formatInspectorLength(safeNextValue)}pt`,
            clearKeys: uniqueStrings([...NODE_MINIMUM_DIMENSION_CLEAR_KEYS])
        }
    ];
    if (Math.abs(companionValue - NODE_MINIMUM_DIMENSION_DEFAULT) > 1e-6) {
        mutations.push({
            key: companionKey,
            value: `${formatInspectorLength(companionValue)}pt`,
            clearKeys: uniqueStrings([...NODE_MINIMUM_DIMENSION_CLEAR_KEYS])
        });
    }
    return mutations;
}
export function buildNodeFontSetPropertyMutation(context, values) {
    const preset = values.sizePreset === "custom" ? null : NODE_FONT_PRESET_BY_ID.get(values.sizePreset);
    const safeCustomSize = Number.isFinite(values.customSizePt) && (values.customSizePt ?? 0) > 0
        ? values.customSizePt
        : context.fallbackCustomSizePt;
    const commandParts = [];
    if (preset != null) {
        if (preset.value !== "normalsize") {
            commandParts.push(preset.command);
        }
    }
    else {
        commandParts.push(`\\fontsize{${formatInspectorLength(safeCustomSize)}pt}{${formatInspectorLength(safeCustomSize * 1.2)}pt}\\selectfont`);
    }
    if (values.family !== "serif") {
        commandParts.push(NODE_FONT_FAMILY_COMMAND[values.family]);
    }
    if (values.weight !== "normal") {
        commandParts.push(NODE_FONT_WEIGHT_COMMAND[values.weight]);
    }
    if (values.style !== "normal") {
        commandParts.push(NODE_FONT_STYLE_COMMAND[values.style]);
    }
    return {
        key: context.key,
        value: commandParts.join(""),
        clearKeys: uniqueStrings(context.clearKeys)
    };
}
export function resolveTransformInspectorMutationContext(source, targetId, parseOptions = {}, resolveTarget = createPropertyTargetResolver(source, parseOptions)) {
    if (!targetId) {
        return resolveTransformInspectorMutationContextFromOptionEntries(null);
    }
    const resolved = resolveTarget(targetId);
    if (resolved.kind === "not-found" || !resolved.target.options) {
        return resolveTransformInspectorMutationContextFromOptionEntries(null);
    }
    return resolveTransformInspectorMutationContextFromOptionEntries(resolved.target.options.entries);
}
export function resolveTransformInspectorMutationContextFromOptionEntries(entries) {
    const values = cloneTransformInspectorValues(DEFAULT_TRANSFORM_INSPECTOR_VALUES);
    const presence = createEmptyTransformInspectorPresence();
    for (const entry of entries ?? []) {
        if (entry.kind !== "kv") {
            continue;
        }
        const key = normalizeOptionKey(entry.key);
        if (key === "scale" || key === "/tikz/scale") {
            presence.scale = true;
            const parsed = parseTransformScalar(entry.valueRaw);
            if (parsed != null) {
                values.xscale = parsed;
                values.yscale = parsed;
            }
            continue;
        }
        if (key === "xscale" || key === "/tikz/xscale") {
            presence.xscale = true;
            const parsed = parseTransformScalar(entry.valueRaw);
            if (parsed != null) {
                values.xscale = parsed;
            }
            continue;
        }
        if (key === "yscale" || key === "/tikz/yscale") {
            presence.yscale = true;
            const parsed = parseTransformScalar(entry.valueRaw);
            if (parsed != null) {
                values.yscale = parsed;
            }
            continue;
        }
        if (key === "shift" || key === "/tikz/shift") {
            presence.shift = true;
            const parsed = parseShiftTransformValue(entry.valueRaw);
            if (parsed) {
                values.xshift = parsed.x;
                values.yshift = parsed.y;
            }
            continue;
        }
        if (key === "xshift" || key === "/tikz/xshift") {
            presence.xshift = true;
            const parsed = parseLength(entry.valueRaw, "pt");
            if (parsed != null) {
                values.xshift = parsed;
            }
            continue;
        }
        if (key === "yshift" || key === "/tikz/yshift") {
            presence.yshift = true;
            const parsed = parseLength(entry.valueRaw, "pt");
            if (parsed != null) {
                values.yshift = parsed;
            }
            continue;
        }
        if (key === "rotate" || key === "/tikz/rotate") {
            presence.rotate = true;
            const parsed = parseTransformScalar(entry.valueRaw);
            if (parsed != null) {
                values.rotate = parsed;
                values.rotateAround = null;
            }
            continue;
        }
        if (key === "rotate around" || key === "/tikz/rotate around") {
            presence.rotateAround = true;
            const parsed = parseRotateAroundTransformValue(entry.valueRaw);
            if (parsed) {
                values.rotate = parsed.angleDeg;
                values.rotateAround = {
                    pivotRaw: parsed.pivotRaw,
                    pivotLabel: parsed.pivotLabel
                };
            }
        }
    }
    return { values, presence };
}
export function resolveTransformInspectorValues(source, targetId, parseOptions = {}, resolveTarget = createPropertyTargetResolver(source, parseOptions)) {
    return resolveTransformInspectorMutationContext(source, targetId, parseOptions, resolveTarget).values;
}
export function buildTransformSetPropertyMutations(current, editedKey, nextValue) {
    if (!Number.isFinite(nextValue)) {
        return [];
    }
    const mutationContext = coerceTransformInspectorMutationContext(current);
    const currentValues = mutationContext.values;
    const sanitizedCurrent = sanitizeTransformInspectorValues(currentValues);
    const safeNextValue = normalizeTinyNumber(nextValue);
    if (editedKey === "xshift" || editedKey === "yshift") {
        const nextValues = {
            ...sanitizedCurrent,
            [editedKey]: safeNextValue
        };
        const companionKey = editedKey === "xshift" ? "yshift" : "xshift";
        const mutations = [
            buildTransformMutation(editedKey, nextValues[editedKey], DEFAULT_TRANSFORM_INSPECTOR_VALUES[editedKey], [...SHIFT_CLEAR_KEYS, ...TRANSFORM_KEY_ALIAS_CLEAR_KEYS[editedKey]])
        ];
        const companionValue = nextValues[companionKey];
        const companionDefault = DEFAULT_TRANSFORM_INSPECTOR_VALUES[companionKey];
        if (shouldSetTransformCompanion(mutationContext, companionKey, companionValue, companionDefault, "shift")) {
            mutations.push(buildTransformMutation(companionKey, companionValue, companionDefault, TRANSFORM_KEY_ALIAS_CLEAR_KEYS[companionKey]));
        }
        else if (shouldClearTransformCompanion(mutationContext, companionKey, companionDefault)) {
            mutations.push(buildTransformMutation(companionKey, companionDefault, companionDefault, TRANSFORM_KEY_ALIAS_CLEAR_KEYS[companionKey]));
        }
        return mutations;
    }
    if (editedKey === "xscale" || editedKey === "yscale") {
        const nextValues = {
            ...sanitizedCurrent,
            [editedKey]: safeNextValue
        };
        const companionKey = editedKey === "xscale" ? "yscale" : "xscale";
        const mutations = [
            buildTransformMutation(editedKey, nextValues[editedKey], DEFAULT_TRANSFORM_INSPECTOR_VALUES[editedKey], [...SCALE_CLEAR_KEYS, ...TRANSFORM_KEY_ALIAS_CLEAR_KEYS[editedKey]])
        ];
        const companionValue = nextValues[companionKey];
        const companionDefault = DEFAULT_TRANSFORM_INSPECTOR_VALUES[companionKey];
        if (shouldSetTransformCompanion(mutationContext, companionKey, companionValue, companionDefault, "scale")) {
            mutations.push(buildTransformMutation(companionKey, companionValue, companionDefault, TRANSFORM_KEY_ALIAS_CLEAR_KEYS[companionKey]));
        }
        else if (shouldClearTransformCompanion(mutationContext, companionKey, companionDefault)) {
            mutations.push(buildTransformMutation(companionKey, companionDefault, companionDefault, TRANSFORM_KEY_ALIAS_CLEAR_KEYS[companionKey]));
        }
        return mutations;
    }
    return [buildRotateTransformMutation(sanitizedCurrent.rotateAround ?? null, safeNextValue)];
}
export function buildShadowMutationContextForPreset(preset) {
    if (preset === "none") {
        return {
            preset,
            xshiftPt: 0,
            yshiftPt: 0,
            scale: 1,
            opacity: 1,
            color: null
        };
    }
    const defaults = SHADOW_PRESET_DEFAULTS[preset];
    return {
        preset,
        xshiftPt: defaults.xshiftPt,
        yshiftPt: defaults.yshiftPt,
        scale: defaults.scale,
        opacity: defaults.opacity ?? 1,
        color: defaults.color
    };
}
export function buildShadowSetPropertyMutations(nextContext) {
    const allKeys = [...SHADOW_ALL_KEYS];
    if (nextContext.preset === "none") {
        return [{ key: allKeys[0], value: "", clearKeys: allKeys }];
    }
    const tikzKey = SHADOW_PRESET_TIKZ_KEY[nextContext.preset];
    const defaults = SHADOW_PRESET_DEFAULTS[nextContext.preset];
    const defaultOpacity = defaults.opacity ?? 1;
    const otherClearKeys = allKeys.filter((k) => k !== tikzKey);
    const sanitizedColor = nextContext.color === SHADOW_INHERIT_FILL || nextContext.color === SHADOW_INHERIT_STROKE
        ? defaults.color
        : nextContext.color;
    const opts = [];
    if (Math.abs(nextContext.xshiftPt - defaults.xshiftPt) > SHADOW_EPS) {
        opts.push(`shadow xshift=${formatNumber(nextContext.xshiftPt)}pt`);
    }
    if (Math.abs(nextContext.yshiftPt - defaults.yshiftPt) > SHADOW_EPS) {
        opts.push(`shadow yshift=${formatNumber(nextContext.yshiftPt)}pt`);
    }
    if (Math.abs(nextContext.scale - defaults.scale) > SHADOW_EPS) {
        opts.push(`shadow scale=${formatNumber(nextContext.scale)}`);
    }
    if (Math.abs(nextContext.opacity - defaultOpacity) > SHADOW_EPS) {
        opts.push(`opacity=${formatNumber(nextContext.opacity)}`);
    }
    if (defaults.color !== null && sanitizedColor !== null && sanitizedColor !== defaults.color) {
        opts.push(`fill=${sanitizedColor}`);
    }
    return [{ key: tikzKey, value: opts.length === 0 ? "true" : `{${opts.join(",")}}`, clearKeys: otherClearKeys }];
}
export function cloneTransformInspectorValues(values) {
    return {
        xshift: values.xshift,
        yshift: values.yshift,
        xscale: values.xscale,
        yscale: values.yscale,
        rotate: values.rotate,
        rotateAround: cloneTransformRotateAroundContext(values.rotateAround)
    };
}
export function transformRotateInspectorLabel(context) {
    const values = "values" in context ? context.values : context;
    return values.rotateAround ? `Rotate around ${values.rotateAround.pivotLabel}` : "Rotate";
}
export function transformPropertyCandidateKeys(key) {
    if (key === "xshift" || key === "yshift") {
        return uniqueStrings([key, ...SHIFT_CLEAR_KEYS, ...TRANSFORM_KEY_ALIAS_CLEAR_KEYS[key]]);
    }
    if (key === "xscale" || key === "yscale") {
        return uniqueStrings([key, ...SCALE_CLEAR_KEYS, ...TRANSFORM_KEY_ALIAS_CLEAR_KEYS[key]]);
    }
    return uniqueStrings([key, ...ROTATE_CLEAR_KEYS]);
}
export { uniqueStrings } from "./statement-find.js";
function createPropertyTargetResolver(source, parseOptions = {}) {
    const cache = new Map();
    return (targetId) => {
        const cached = cache.get(targetId);
        if (cached) {
            return cached;
        }
        const resolved = resolvePropertyTarget(source, targetId, parseOptions);
        cache.set(targetId, resolved);
        return resolved;
    };
}
function normalizeFillMutationColor(value, fallback) {
    const normalized = value?.trim();
    return normalized && normalized.length > 0 ? normalized : fallback;
}
function selectCuratedShadingPreset(value) {
    return value === "axis" || value === "radial" || value === "ball" ? value : "axis";
}
function selectCuratedPatternPreset(value) {
    return value && value !== "custom" ? value : "dots";
}
function fillPatternMetaValueKey(option) {
    if (option === "line width") {
        return "lineWidth";
    }
    return option;
}
function sanitizeFillPatternMetaOptionValue(option, value, fallbackValues) {
    if (!Number.isFinite(value)) {
        return fallbackValues[fillPatternMetaValueKey(option)];
    }
    if (option === "points") {
        return Math.max(2, Math.round(value));
    }
    if (option === "distance" || option === "line width" || option === "radius") {
        return Math.max(0, normalizeTinyNumber(value));
    }
    return normalizeTinyNumber(value);
}
function serializeFillPatternMetaPattern(family, values) {
    const options = [
        `angle=${formatInspectorLength(values.angle)}`,
        `distance=${formatInspectorLength(values.distance)}pt`,
        `xshift=${formatInspectorLength(values.xshift)}pt`,
        `yshift=${formatInspectorLength(values.yshift)}pt`
    ];
    if (family === "Lines" || family === "Hatch") {
        options.push(`line width=${formatInspectorLength(values.lineWidth)}pt`);
    }
    else {
        options.push(`radius=${formatInspectorLength(values.radius)}pt`);
        if (family === "Stars") {
            options.push(`points=${Math.max(2, Math.round(values.points))}`);
        }
    }
    return `{${family}[${options.join(",")}]}`;
}
function serializeArrowSides(startRaw, endRaw) {
    const normalizedStart = startRaw.trim();
    const normalizedEnd = endRaw.trim();
    if (normalizedStart.length === 0 && normalizedEnd.length === 0) {
        return { key: "-", value: "true" };
    }
    if (normalizedStart.length === 0 && normalizedEnd === ">") {
        return { key: "->", value: "true" };
    }
    if (normalizedStart === "<" && normalizedEnd.length === 0) {
        return { key: "<-", value: "true" };
    }
    if (normalizedStart === "<" && normalizedEnd === ">") {
        return { key: "<->", value: "true" };
    }
    return {
        key: ARROW_OPTION_KEY,
        value: `${startRaw}-${endRaw}`
    };
}
function arrowPresetSideRaw(preset, side) {
    if (preset === "none") {
        return "";
    }
    if (preset === "arrow") {
        return side === "start" ? "<" : ">";
    }
    if (preset === "stealth") {
        return "Stealth";
    }
    if (preset === "latex") {
        return "Latex";
    }
    if (preset === "triangle") {
        return "Triangle";
    }
    if (preset === "circle") {
        return "Circle";
    }
    if (preset === "square") {
        return "Square";
    }
    if (preset === "kite") {
        return "Kite";
    }
    if (preset === "bar") {
        return "|";
    }
    if (preset === "hooks") {
        return side === "start" ? "Hooks[left]" : "Hooks[right]";
    }
    return "";
}
function parseRotateAroundTransformValue(raw) {
    const normalized = stripEnclosingBraces(raw).trim();
    if (normalized.length === 0) {
        return null;
    }
    const parts = splitAllAtTopLevel(normalized, ":").map((part) => part.trim());
    if (parts.length < 2) {
        return null;
    }
    const angleRaw = parts[0] ?? "";
    const pivotRaw = parts.slice(1).join(":").trim();
    if (angleRaw.length === 0 || pivotRaw.length === 0) {
        return null;
    }
    const angleDeg = parseTransformScalar(angleRaw);
    if (angleDeg == null) {
        return null;
    }
    return {
        angleDeg,
        pivotRaw,
        pivotLabel: formatRotateAroundPivotLabel(pivotRaw)
    };
}
function formatRotateAroundPivotLabel(raw) {
    const trimmed = raw.trim();
    const coordinate = parseCoordinateLike(trimmed);
    if (!coordinate) {
        return trimmed;
    }
    return `(${coordinate.x.trim()}, ${coordinate.y.trim()})`;
}
function parseTransformScalar(raw) {
    const parsed = Number(stripEnclosingBraces(raw).trim());
    if (!Number.isFinite(parsed)) {
        return null;
    }
    return normalizeTinyNumber(parsed);
}
function parseShiftTransformValue(raw) {
    const normalized = stripEnclosingBraces(raw).trim();
    const coordinate = parseCoordinateLike(normalized);
    if (!coordinate) {
        return null;
    }
    const x = parseLength(coordinate.x, "cm");
    const y = parseLength(coordinate.y, "cm");
    if (x == null || y == null) {
        return null;
    }
    return {
        x: normalizeTinyNumber(x),
        y: normalizeTinyNumber(y)
    };
}
function cloneTransformRotateAroundContext(context) {
    return context ? { ...context } : null;
}
function createEmptyTransformInspectorPresence() {
    return {
        shift: false,
        scale: false,
        xshift: false,
        yshift: false,
        xscale: false,
        yscale: false,
        rotate: false,
        rotateAround: false
    };
}
function coerceTransformInspectorMutationContext(current) {
    if ("values" in current) {
        return {
            values: cloneTransformInspectorValues(current.values),
            presence: current.presence ? { ...current.presence } : createEmptyTransformInspectorPresence()
        };
    }
    return {
        values: cloneTransformInspectorValues(current),
        presence: createEmptyTransformInspectorPresence()
    };
}
function shouldSetTransformCompanion(context, companionKey, companionValue, companionDefault, shorthandKey) {
    if (Math.abs(companionValue - companionDefault) <= 1e-6) {
        return false;
    }
    const presence = context.presence ?? createEmptyTransformInspectorPresence();
    return presence[shorthandKey] || !presence[companionKey];
}
function shouldClearTransformCompanion(context, companionKey, companionDefault) {
    const presence = context.presence ?? createEmptyTransformInspectorPresence();
    if (!presence[companionKey]) {
        return false;
    }
    return Math.abs(context.values[companionKey] - companionDefault) <= 1e-6;
}
function sanitizeTransformInspectorValues(values) {
    return {
        xshift: Number.isFinite(values.xshift) ? normalizeTinyNumber(values.xshift) : DEFAULT_TRANSFORM_INSPECTOR_VALUES.xshift,
        yshift: Number.isFinite(values.yshift) ? normalizeTinyNumber(values.yshift) : DEFAULT_TRANSFORM_INSPECTOR_VALUES.yshift,
        xscale: Number.isFinite(values.xscale) ? normalizeTinyNumber(values.xscale) : DEFAULT_TRANSFORM_INSPECTOR_VALUES.xscale,
        yscale: Number.isFinite(values.yscale) ? normalizeTinyNumber(values.yscale) : DEFAULT_TRANSFORM_INSPECTOR_VALUES.yscale,
        rotate: Number.isFinite(values.rotate) ? normalizeTinyNumber(values.rotate) : DEFAULT_TRANSFORM_INSPECTOR_VALUES.rotate,
        rotateAround: cloneTransformRotateAroundContext(values.rotateAround)
    };
}
function normalizeTinyNumber(value) {
    return Math.abs(value) <= 1e-9 ? 0 : value;
}
function buildTransformMutation(key, value, defaultValue, clearKeys) {
    const normalizedValue = normalizeTinyNumber(value);
    const isDefault = Math.abs(normalizedValue - defaultValue) <= 1e-6;
    return {
        key,
        value: isDefault ? "" : formatInspectorLength(normalizedValue) + (key === "xshift" || key === "yshift" ? "pt" : ""),
        clearKeys: uniqueStrings(isDefault ? [key, ...clearKeys] : clearKeys)
    };
}
function buildRotateTransformMutation(rotateAround, value) {
    const normalizedValue = normalizeTinyNumber(value);
    const isDefault = Math.abs(normalizedValue - DEFAULT_TRANSFORM_INSPECTOR_VALUES.rotate) <= 1e-6;
    if (rotateAround) {
        const key = "rotate around";
        return {
            key,
            value: isDefault ? "" : `{${formatInspectorLength(normalizedValue)}:${rotateAround.pivotRaw}}`,
            clearKeys: uniqueStrings(isDefault ? [key, ...ROTATE_CLEAR_KEYS] : ["rotate", ...ROTATE_CLEAR_KEYS])
        };
    }
    return buildTransformMutation("rotate", normalizedValue, DEFAULT_TRANSFORM_INSPECTOR_VALUES.rotate, ROTATE_CLEAR_KEYS);
}
function formatInspectorLength(value) {
    const rounded = Math.round(value * 100) / 100;
    const normalized = Math.abs(rounded) < 1e-9 ? 0 : rounded;
    return Number(normalized.toFixed(2)).toString();
}
const SHADOW_EPS = 0.001;
