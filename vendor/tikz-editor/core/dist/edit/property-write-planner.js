import { renderTikzToSvg } from "../render/index.js";
import { normalizeColor } from "../semantic/style/colors.js";
import { replaceSpan } from "./patch.js";
import { parseTikzForEdit } from "./parse-options.js";
import { resolvePropertyTarget } from "./property-target.js";
import { normalizeOptionKey } from "./option-key.js";
import { applySetPropertyActionRaw } from "./actions/set-property.js";
import { propertyCleanupKinds, propertyIdForWriteKey, shouldOmitDefaultWhenEquivalent } from "./property-registry.js";
export function applyPlannedSetPropertyAction(source, action, parseOptions = {}) {
    return withChangedSourceId(planPropertyWrite({ source, action, parseOptions }).selected, action.elementId);
}
export const PROPERTY_WRITE_CLEANUP_NOOP_REASON = "Property write cleanup would not change the source.";
const LARGE_DRAG_END_CLEANUP_SOURCE_LENGTH = 100_000;
export function cleanupIdiomaticPropertyWrites(source, parseOptions = {}, elementIds) {
    if (shouldSkipLargeDragEndPaintCleanup(source, parseOptions)) {
        return { kind: "unsupported", reason: PROPERTY_WRITE_CLEANUP_NOOP_REASON };
    }
    let current = source;
    const certificationCache = new Map();
    const requestedElementIds = normalizeCleanupElementIds(elementIds);
    const pathIds = requestedElementIds ?? collectPathStatementIds(parseTikzForEdit(source, parseOptions).figure.body);
    for (const elementId of pathIds) {
        const candidates = buildPaintCommandCleanupCandidates(current, {
            elementId,
            key: "draw",
            value: "true"
        }, parseOptions);
        for (const candidate of candidates) {
            if (certifyEquivalentSource(current, candidate.source, parseOptions, certificationCache) && sourceLooksCleaner(candidate.source, current)) {
                current = candidate.source;
                break;
            }
        }
    }
    if (current === source) {
        return { kind: "unsupported", reason: PROPERTY_WRITE_CLEANUP_NOOP_REASON };
    }
    return {
        kind: "success",
        newSource: current,
        patches: deriveSingleSourcePatch(source, current),
        changedSourceIds: requestedElementIds && requestedElementIds.length > 0 ? requestedElementIds : undefined
    };
}
function withChangedSourceId(result, sourceId) {
    if (result.kind !== "success" && result.kind !== "partial") {
        return result;
    }
    if (result.changedSourceIds !== undefined) {
        return result;
    }
    const normalized = sourceId.trim();
    return {
        ...result,
        changedSourceIds: [normalized]
    };
}
function shouldSkipLargeDragEndPaintCleanup(source, parseOptions) {
    return (parseOptions.propertyWriteMode === "drag-end" &&
        source.length > LARGE_DRAG_END_CLEANUP_SOURCE_LENGTH &&
        !hasConservativePaintCleanupToken(source));
}
function hasConservativePaintCleanupToken(source) {
    return (source.includes("draw=none") ||
        source.includes("fill=none") ||
        source.includes("decorate=false") ||
        source.includes("sharp corners"));
}
function normalizeCleanupElementIds(elementIds) {
    if (!elementIds) {
        return null;
    }
    return elementIds.map((id) => id.trim()).filter((id) => id.length > 0);
}
export function planPropertyWrite(request) {
    const parseOptions = request.parseOptions ?? {};
    const mode = request.mode ?? parseOptions.propertyWriteMode ?? "commit";
    const conservative = applySetPropertyActionRaw(request.source, request.action, parseOptions);
    if (conservative.kind !== "success" && conservative.kind !== "partial") {
        return { conservative, selected: conservative, certificates: [] };
    }
    if (mode === "preview" || mode === "drag-frame" || request.action.commentMode) {
        return { conservative, selected: conservative, certificates: [] };
    }
    if (hasParseErrors(conservative.newSource, parseOptions)) {
        return { conservative, selected: conservative, certificates: [] };
    }
    const candidates = buildCleanupCandidates(request.source, conservative.newSource, request.action, parseOptions);
    if (candidates.length === 0) {
        return { conservative, selected: conservative, certificates: [] };
    }
    const certificationCache = new Map();
    const certificates = [];
    let selectedSource = conservative.newSource;
    let selectedReason = null;
    for (const candidate of candidates) {
        const accepted = certifyEquivalentSource(conservative.newSource, candidate.source, parseOptions, certificationCache);
        certificates.push({
            accepted,
            reason: accepted ? candidate.reason : "candidate changed semantic render output",
            candidate: candidate.source
        });
        if (accepted && sourceLooksCleaner(candidate.source, selectedSource)) {
            selectedSource = candidate.source;
            selectedReason = candidate.reason;
        }
    }
    if (!selectedReason || selectedSource === conservative.newSource) {
        return { conservative, selected: conservative, certificates };
    }
    return {
        conservative,
        selected: {
            ...conservative,
            newSource: selectedSource,
            patches: deriveSingleSourcePatch(request.source, selectedSource)
        },
        certificates
    };
}
function buildCleanupCandidates(originalSource, conservativeSource, action, parseOptions) {
    const candidates = [];
    const removal = buildDefaultOmissionCandidate(conservativeSource, action, parseOptions);
    if (removal && removal !== conservativeSource && removal !== originalSource) {
        candidates.push({ source: removal, reason: "remove default-equivalent local property" });
    }
    for (const candidate of buildPaintCommandCleanupCandidates(conservativeSource, action, parseOptions)) {
        if (candidate.source !== conservativeSource && candidate.source !== originalSource) {
            candidates.push(candidate);
        }
    }
    return dedupeCandidates(candidates);
}
function collectPathStatementIds(statements) {
    const ids = [];
    for (const statement of statements) {
        if (statement.kind === "Path") {
            ids.push(statement.id);
        }
        else if (statement.kind === "Scope") {
            ids.push(...collectPathStatementIds(statement.body));
        }
    }
    return ids;
}
function hasParseErrors(source, parseOptions) {
    return parseTikzForEdit(source, parseOptions).diagnostics.some((diagnostic) => diagnostic.severity === "error");
}
function buildDefaultOmissionCandidate(source, action, parseOptions) {
    if (action.value.trim().length === 0 || !shouldOmitDefaultWhenEquivalent(action.propertyId ?? propertyIdForWriteKey(action.key))) {
        return null;
    }
    const result = applySetPropertyActionRaw(source, {
        ...action,
        value: "",
        clearKeys: undefined
    }, parseOptions);
    return result.kind === "success" || result.kind === "partial" ? result.newSource : null;
}
function buildPaintCommandCleanupCandidates(source, action, parseOptions) {
    if (!propertyCleanupKinds(action.propertyId ?? propertyIdForWriteKey(action.key)).includes("paint-command")) {
        return [];
    }
    const resolved = resolvePropertyTarget(source, action.elementId, parseOptions);
    if (resolved.kind !== "found" || resolved.target.kind !== "path-statement") {
        return [];
    }
    const command = normalizedPaintCommand(resolved.target.pathCommand);
    if (!command) {
        return [];
    }
    const paint = resolvePaintOptions(source, action.elementId, parseOptions);
    const shouldPreserveInheritedDrawSuppression = paint.drawDisabled
        && hasInheritedRenderableDrawBeforeCommand(source, action.elementId, parseOptions);
    const commands = chooseCandidateCommands(paint);
    const candidates = [];
    for (const nextCommand of commands) {
        if (shouldPreserveInheritedDrawSuppression && commandRemovesExplicitDrawSuppression(nextCommand)) {
            continue;
        }
        const candidate = rewritePaintCommand(source, action.elementId, nextCommand, paint, parseOptions);
        if (candidate && candidate !== source) {
            candidates.push({
                source: candidate,
                reason: `rewrite paint command to \\\\${nextCommand}`
            });
        }
    }
    return candidates;
}
function chooseCandidateCommands(paint) {
    const drawEnabled = paint.draw != null && !paint.drawDisabled;
    const fillEnabled = paint.fill != null && !paint.fillDisabled;
    const candidates = [];
    if (!drawEnabled && !fillEnabled) {
        candidates.push("path");
    }
    if (fillEnabled && !drawEnabled) {
        candidates.push("fill");
    }
    if (drawEnabled) {
        candidates.push("draw");
    }
    return candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
}
function commandRemovesExplicitDrawSuppression(command) {
    return command === "path" || command === "fill";
}
function normalizedPaintCommand(command) {
    const normalized = command?.trim().toLowerCase();
    return normalized === "path" || normalized === "draw" || normalized === "fill" || normalized === "filldraw"
        ? normalized
        : null;
}
function rewritePaintCommand(source, elementId, nextCommand, paint, parseOptions) {
    let current = rewritePathCommandToken(source, elementId, nextCommand, parseOptions);
    if (!current) {
        return null;
    }
    if (nextCommand === "path") {
        if (paint.drawDisabled) {
            current = applyOptionalPropertyMutation(current, elementId, "draw", "", parseOptions) ?? current;
        }
        if (paint.fillDisabled) {
            current = applyOptionalPropertyMutation(current, elementId, "fill", "", parseOptions) ?? current;
        }
        return current;
    }
    if (nextCommand === "fill") {
        if (paint.fill && !paint.fillDisabled) {
            current = applyOptionalPropertyMutation(current, elementId, "fill", paint.fill, parseOptions) ?? current;
        }
        if (paint.drawDisabled) {
            current = applyOptionalPropertyMutation(current, elementId, "draw", "", parseOptions) ?? current;
        }
        return current;
    }
    if (paint.draw && !paint.drawDisabled) {
        current = applyOptionalPropertyMutation(current, elementId, "draw", paint.draw, parseOptions) ?? current;
    }
    if (paint.fillDisabled) {
        current = applyOptionalPropertyMutation(current, elementId, "fill", "", parseOptions) ?? current;
    }
    return current;
}
function applyOptionalPropertyMutation(source, elementId, key, value, parseOptions) {
    const result = applySetPropertyActionRaw(source, {
        elementId,
        key,
        value
    }, parseOptions);
    return result.kind === "success" || result.kind === "partial" ? result.newSource : null;
}
function rewritePathCommandToken(source, elementId, nextCommand, parseOptions) {
    const resolved = resolvePropertyTarget(source, elementId, parseOptions);
    if (resolved.kind !== "found" || resolved.target.kind !== "path-statement" || !resolved.target.pathCommand) {
        return null;
    }
    const commandSpan = findPathCommandTokenSpan(source, resolved.target.span, resolved.target.pathCommand);
    if (!commandSpan) {
        return null;
    }
    return replaceSpan(source, commandSpan, `\\${nextCommand}`).source;
}
function findPathCommandTokenSpan(source, statementSpan, command) {
    const pattern = new RegExp(String.raw `\\?${escapeRegex(command)}\b`, "u");
    const statementSource = source.slice(statementSpan.from, statementSpan.to);
    const match = pattern.exec(statementSource);
    if (!match) {
        return null;
    }
    return {
        from: statementSpan.from + match.index,
        to: statementSpan.from + match.index + match[0].length
    };
}
function resolvePaintOptions(source, elementId, parseOptions) {
    const resolved = resolvePropertyTarget(source, elementId, parseOptions);
    if (resolved.kind !== "found" || !resolved.target.options) {
        return {
            draw: null,
            fill: null,
            drawDisabled: false,
            fillDisabled: false
        };
    }
    let draw = null;
    let fill = null;
    for (const entry of resolved.target.options.entries) {
        if (entry.kind === "kv") {
            const key = normalizeOptionKey(entry.key);
            if (key === "draw" || key === "color") {
                draw = normalizeOptionValue(entry.valueRaw);
            }
            if (key === "fill") {
                fill = normalizeOptionValue(entry.valueRaw);
            }
            continue;
        }
        if (entry.kind === "flag") {
            const key = normalizeOptionKey(entry.key);
            if (key === "draw") {
                draw = "true";
            }
            else if (key === "fill") {
                fill = "true";
            }
        }
    }
    return {
        draw,
        fill,
        drawDisabled: isDisabledPaintValue(draw),
        fillDisabled: isDisabledPaintValue(fill)
    };
}
function normalizeOptionValue(value) {
    return value.trim().replace(/^\{|\}$/gu, "").trim();
}
function isDisabledPaintValue(value) {
    const normalized = value?.trim().toLowerCase() ?? "";
    return normalized === "none" || normalized === "false";
}
function hasInheritedRenderableDrawBeforeCommand(source, elementId, parseOptions) {
    try {
        const rendered = renderTikzToSvg(source, {
            parse: {
                recover: true,
                activeFigureId: parseOptions.activeFigureId,
                includeContextDefinitions: true
            }
        });
        const element = rendered.semantic.scene.elements.find((candidate) => sceneElementMatchesSourceId(candidate, elementId));
        const commandDefault = element?.styleChain.find((entry) => entry.sourceRef?.sourceKind === "command-default" && styleSourceRefMatches(entry.sourceRef.sourceId, elementId));
        return commandDefault?.before.drawExplicit === true
            && hasRenderableStroke(commandDefault.before);
    }
    catch {
        return false;
    }
}
function sceneElementMatchesSourceId(element, sourceId) {
    return element.sourceRef.sourceId === sourceId || element.identityRef?.sourceId === sourceId;
}
function styleSourceRefMatches(sourceId, targetSourceId) {
    return sourceId === targetSourceId;
}
function certifyEquivalentSource(leftSource, rightSource, parseOptions, cache) {
    const left = renderForCertification(leftSource, parseOptions, cache);
    const right = renderForCertification(rightSource, parseOptions, cache);
    if (!left || !right) {
        return false;
    }
    return (diagnosticsSignature(left.parse.diagnostics) === diagnosticsSignature(right.parse.diagnostics) &&
        semanticSignature(left.semantic.scene.elements) === semanticSignature(right.semantic.scene.elements) &&
        svgSignature(left.svg.svg) === svgSignature(right.svg.svg));
}
function renderForCertification(source, parseOptions, cache) {
    if (cache?.has(source)) {
        return cache.get(source) ?? null;
    }
    try {
        const rendered = renderTikzToSvg(source, {
            parse: {
                recover: true,
                activeFigureId: parseOptions.activeFigureId,
                includeContextDefinitions: true
            }
        });
        cache?.set(source, rendered);
        return rendered;
    }
    catch {
        cache?.set(source, null);
        return null;
    }
}
function semanticSignature(value) {
    return JSON.stringify(sanitizeSemanticValue(value));
}
function sanitizeSemanticValue(value, geometricStyle = false) {
    if (Array.isArray(value)) {
        return value.filter((entry) => !isInvisibleSceneElement(entry)).map((entry) => sanitizeSemanticValue(entry));
    }
    if (typeof value === "number") {
        return normalizeSignatureNumber(value);
    }
    if (!value || typeof value !== "object") {
        return value;
    }
    const input = value;
    const output = {};
    const isGeometricElement = input.kind === "Path" || input.kind === "Circle" || input.kind === "Ellipse";
    for (const [key, entryValue] of Object.entries(input)) {
        if (key === "span" ||
            key === "id" ||
            key === "runtimeId" ||
            key === "sourceSpan" ||
            key === "textSourceSpan" ||
            key === "sourceFingerprint" ||
            key === "styleChain" ||
            key === "rawOptions" ||
            (geometricStyle && key === "textColor")) {
            continue;
        }
        output[key] = sanitizeStyleValueForSignature(key, entryValue, geometricStyle);
        if (output[key] === entryValue) {
            output[key] = sanitizeSemanticValue(entryValue, isGeometricElement && key === "style");
        }
    }
    return output;
}
function sanitizeStyleValueForSignature(key, value, geometricStyle) {
    if (!geometricStyle) {
        return value;
    }
    if (key === "stroke" || key === "fill") {
        return normalizePaintColorForSignature(value);
    }
    return value;
}
function normalizePaintColorForSignature(value) {
    if (value == null) {
        return null;
    }
    if (typeof value !== "string") {
        return value;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.toLowerCase() === "none") {
        return null;
    }
    return normalizeColor(trimmed);
}
function svgSignature(svg) {
    return svg.replace(/\b(stroke|fill|stop-color)="([^"]*)"/gu, (_match, attribute, value) => `${attribute}="${normalizeSvgPaintForSignature(value)}"`);
}
function normalizeSvgPaintForSignature(value) {
    const trimmed = value.trim();
    if (/^url\(/iu.test(trimmed)) {
        return value;
    }
    if (trimmed.length === 0 || trimmed.toLowerCase() === "none") {
        return "none";
    }
    return normalizeColor(trimmed);
}
function normalizeSignatureNumber(value) {
    if (!Number.isFinite(value)) {
        return value;
    }
    const rounded = Math.round(value * 1e9) / 1e9;
    return Math.abs(rounded) < 1e-12 ? 0 : rounded;
}
function isInvisibleSceneElement(value) {
    if (!value || typeof value !== "object") {
        return false;
    }
    const element = value;
    if (element.kind !== "Path" && element.kind !== "Circle" && element.kind !== "Ellipse") {
        return false;
    }
    const style = element.style;
    if (!style || typeof style !== "object") {
        return false;
    }
    const styleRecord = style;
    return (!hasRenderableStroke(styleRecord) &&
        !hasRenderableFill(styleRecord) &&
        !hasRenderableEffect(styleRecord));
}
function hasRenderableStroke(style) {
    return (isRenderableColor(style.stroke) &&
        numericStyleValue(style.opacity, 1) > 0 &&
        numericStyleValue(style.strokeOpacity, 1) > 0 &&
        numericStyleValue(style.lineWidth, 0.4) > 0);
}
function hasRenderableFill(style) {
    return ((isRenderableColor(style.fill) || style.fillPattern != null || style.shadeEnabled === true) &&
        numericStyleValue(style.opacity, 1) > 0 &&
        numericStyleValue(style.fillOpacity, 1) > 0);
}
function hasRenderableEffect(style) {
    return (style.clip === true ||
        style.useAsBoundingBox === true ||
        style.doubleStroke === true ||
        style.markerStart != null ||
        style.markerEnd != null ||
        hasEnabledDecoration(style.decoration) ||
        hasNonEmptyArray(style.decorationPreActions) ||
        hasNonEmptyArray(style.decorationPostActions) ||
        hasNonEmptyArray(style.shadowLayers));
}
function isRenderableColor(value) {
    return typeof value === "string" && value.trim().length > 0 && value.trim().toLowerCase() !== "none";
}
function numericStyleValue(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
function hasEnabledDecoration(value) {
    return Boolean(value && typeof value === "object" && value.enabled === true);
}
function hasNonEmptyArray(value) {
    return Array.isArray(value) && value.length > 0;
}
function diagnosticsSignature(diagnostics) {
    return diagnostics.map((diagnostic) => `${diagnostic.severity}:${diagnostic.message}`).join("\n");
}
function sourceLooksCleaner(candidate, current) {
    if (candidate.length !== current.length) {
        return candidate.length < current.length;
    }
    return sourceNoiseScore(candidate) < sourceNoiseScore(current);
}
function sourceNoiseScore(source) {
    return countOccurrences(source, "draw=none")
        + countOccurrences(source, "fill=none")
        + countOccurrences(source, "decorate=false")
        + countOccurrences(source, "sharp corners");
}
function countOccurrences(source, needle) {
    let count = 0;
    let index = source.indexOf(needle);
    while (index >= 0) {
        count += 1;
        index = source.indexOf(needle, index + needle.length);
    }
    return count;
}
function deriveSingleSourcePatch(previous, next) {
    let prefix = 0;
    while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) {
        prefix += 1;
    }
    let previousSuffix = previous.length;
    let nextSuffix = next.length;
    while (previousSuffix > prefix &&
        nextSuffix > prefix &&
        previous[previousSuffix - 1] === next[nextSuffix - 1]) {
        previousSuffix -= 1;
        nextSuffix -= 1;
    }
    return [
        {
            oldSpan: { from: prefix, to: previousSuffix },
            newSpan: { from: prefix, to: nextSuffix },
            replacement: next.slice(prefix, nextSuffix)
        }
    ];
}
function dedupeCandidates(candidates) {
    const seen = new Set();
    const unique = [];
    for (const candidate of candidates) {
        if (seen.has(candidate.source)) {
            continue;
        }
        seen.add(candidate.source);
        unique.push(candidate);
    }
    return unique;
}
function escapeRegex(input) {
    return input.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
