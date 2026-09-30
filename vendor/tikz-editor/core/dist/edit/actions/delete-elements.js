import { parseCoordinate } from "../../domains/coordinates/parse.js";
import { replaceSpan } from "../patch.js";
import { resolvePropertyTarget } from "../property-target.js";
import { parseTikzForEdit } from "../parse-options.js";
import { applyOptionMutationsToTarget, normalizeOptionKey } from "../option-mutations.js";
import { normalizeElementIds } from "../statement-find.js";
export function applyDeleteElementsAction(source, elementIds, parseOptions = {}) {
    const normalizedIds = normalizeElementIds(elementIds);
    if (normalizedIds.length === 0) {
        return { kind: "unsupported", reason: "No element ids were provided for deleteElements" };
    }
    const parsed = parseTikzForEdit(source, {
        ...parseOptions,
    });
    const targets = [];
    for (const elementId of normalizedIds) {
        const target = resolveDeleteTarget(parsed.figure.body, elementId);
        if (target) {
            targets.push(target);
        }
    }
    const collapsedTargets = collapseDeleteTargets(targets);
    if (collapsedTargets.length === 0) {
        return { kind: "unsupported", reason: "No deletable source span was found for the selected element(s)" };
    }
    const deletedNamedNodes = collectDeletedNamedNodes(parsed.figure.body, collapsedTargets);
    const sorted = [...collapsedTargets].sort((a, b) => {
        if (a.span.from !== b.span.from) {
            return b.span.from - a.span.from;
        }
        return b.span.to - a.span.to;
    });
    let currentSource = source;
    const patches = [];
    for (const target of sorted) {
        const span = normalizeDeleteSpan(currentSource, target.span, target.scope);
        const updated = replaceSpan(currentSource, span, "");
        patches.push({
            oldSpan: span,
            newSpan: updated.changedSpan,
            replacement: ""
        });
        currentSource = updated.source;
    }
    const fitPruneResult = pruneFitReferencesAfterDelete(currentSource, deletedNamedNodes, parseOptions);
    currentSource = fitPruneResult.source;
    patches.push(...fitPruneResult.patches);
    return {
        kind: "success",
        newSource: currentSource,
        patches,
        selectedSourceIds: [],
        changedSourceIds: fitPruneResult.changedSourceIds
    };
}
export function applyDeleteAdornmentAction(source, targetId, parseOptions = {}) {
    const resolved = resolvePropertyTarget(source, targetId, parseOptions);
    if (resolved.kind !== "found" || resolved.target.kind !== "node-adornment" || !resolved.target.optionSpan) {
        return { kind: "unsupported", reason: "Selected adornment could not be resolved for deletion." };
    }
    const deleteSpan = normalizeAdornmentDeleteSpan(source, resolved.target.optionSpan);
    const updated = replaceSpan(source, deleteSpan, "");
    return {
        kind: "success",
        newSource: updated.source,
        selectedSourceIds: [],
        patches: [
            {
                oldSpan: deleteSpan,
                newSpan: updated.changedSpan,
                replacement: ""
            }
        ],
        changedSourceIds: [resolved.target.ownerSourceId]
    };
}
function resolveDeleteTarget(statements, elementId) {
    for (const statement of statements) {
        if (statement.id === elementId) {
            return { span: statement.span, scope: "statement" };
        }
        if (statement.kind === "Path") {
            const itemTarget = resolveDeleteTargetInPath(statement.items, elementId);
            if (itemTarget) {
                const substantiveCount = statement.items.filter((item) => item.kind !== "PathComment").length;
                if (substantiveCount <= 1) {
                    return { span: statement.span, scope: "statement" };
                }
                return itemTarget;
            }
            continue;
        }
        if (statement.kind === "Scope") {
            const nested = resolveDeleteTarget(statement.body, elementId);
            if (nested) {
                return nested;
            }
        }
    }
    return null;
}
function resolveDeleteTargetInPath(items, elementId) {
    for (const item of items) {
        if (item.id === elementId) {
            return { span: item.span, scope: "path-item" };
        }
        if ((item.kind === "ToOperation" || item.kind === "EdgeOperation") && item.nodes) {
            for (const node of item.nodes) {
                if (node.id === elementId) {
                    return { span: node.span, scope: "path-item" };
                }
            }
        }
    }
    return null;
}
function collapseDeleteTargets(targets) {
    if (targets.length <= 1) {
        return targets;
    }
    const sorted = [...targets].sort((a, b) => {
        if (a.span.from !== b.span.from) {
            return a.span.from - b.span.from;
        }
        return b.span.to - a.span.to;
    });
    const collapsed = [];
    for (const target of sorted) {
        const contained = collapsed.some((existing) => target.span.from >= existing.span.from && target.span.to <= existing.span.to);
        if (contained) {
            continue;
        }
        collapsed.push(target);
    }
    return collapsed;
}
function normalizeDeleteSpan(source, span, scope) {
    let from = clampOffset(span.from, source.length);
    let to = clampOffset(span.to, source.length);
    if (scope === "path-item") {
        const hadTrailingWhitespace = to < source.length && (source[to] === " " || source[to] === "\t");
        while (to < source.length && (source[to] === " " || source[to] === "\t")) {
            to += 1;
        }
        if (!hadTrailingWhitespace) {
            while (from > 0 && (source[from - 1] === " " || source[from - 1] === "\t")) {
                from -= 1;
            }
        }
        return { from, to };
    }
    while (from > 0 && (source[from - 1] === " " || source[from - 1] === "\t")) {
        from -= 1;
    }
    while (to < source.length && (source[to] === " " || source[to] === "\t")) {
        to += 1;
    }
    if (to < source.length && source[to] === "\r") {
        to += 1;
    }
    if (to < source.length && source[to] === "\n") {
        to += 1;
    }
    else if (from > 0 && source[from - 1] === "\n") {
        from -= 1;
        if (from > 0 && source[from - 1] === "\r") {
            from -= 1;
        }
    }
    return { from, to };
}
function normalizeAdornmentDeleteSpan(source, span) {
    let from = span.from;
    let to = span.to;
    while (to < source.length && /\s/u.test(source[to] ?? "")) {
        to += 1;
    }
    if ((source[to] ?? "") === ",") {
        to += 1;
        while (to < source.length && /\s/u.test(source[to] ?? "")) {
            to += 1;
        }
        return { from, to };
    }
    while (from > 0 && /\s/u.test(source[from - 1] ?? "")) {
        from -= 1;
    }
    if ((source[from - 1] ?? "") === ",") {
        from -= 1;
        while (from > 0 && /\s/u.test(source[from - 1] ?? "")) {
            from -= 1;
        }
    }
    return { from, to };
}
function clampOffset(value, sourceLength) {
    return Math.max(0, Math.min(sourceLength, Math.trunc(value)));
}
function collectDeletedNamedNodes(statements, targets) {
    const names = new Set();
    const withinDeletedTarget = (span) => targets.some((target) => span.from >= target.span.from && span.to <= target.span.to);
    for (const node of collectNodeItems(statements)) {
        if (!withinDeletedTarget(node.span)) {
            continue;
        }
        if (node.name && node.name.trim().length > 0) {
            names.add(node.name.trim());
        }
        for (const alias of node.aliases ?? []) {
            if (alias.trim().length > 0) {
                names.add(alias.trim());
            }
        }
    }
    return names;
}
function pruneFitReferencesAfterDelete(source, deletedNodeNames, parseOptions) {
    if (deletedNodeNames.size === 0) {
        return { source, patches: [], changedSourceIds: [] };
    }
    const parsed = parseTikzForEdit(source, {
        ...parseOptions,
    });
    const fitNodeIds = new Set();
    for (const node of collectNodeItems(parsed.figure.body)) {
        if (!optionListHasFitEntry(node.options)) {
            continue;
        }
        fitNodeIds.add(node.id);
    }
    let currentSource = source;
    const patches = [];
    const changedSourceIds = new Set();
    for (const fitNodeId of fitNodeIds) {
        const resolved = resolvePropertyTarget(currentSource, fitNodeId, parseOptions);
        if (resolved.kind !== "found" || !resolved.target.options) {
            continue;
        }
        const fitEntry = resolved.target.options.entries.find((entry) => entry.kind === "kv" && normalizeOptionKey(entry.key) === "fit");
        if (!fitEntry) {
            continue;
        }
        const nextFitValue = pruneFitValueRaw(fitEntry.valueRaw, deletedNodeNames);
        if (nextFitValue.kind === "unchanged") {
            continue;
        }
        const mutations = new Map();
        if (nextFitValue.value == null) {
            mutations.set("fit", { kind: "remove" });
            mutations.set("rotate fit", { kind: "remove" });
        }
        else {
            mutations.set("fit", { kind: "set", value: nextFitValue.value });
        }
        const rewritten = applyOptionMutationsToTarget(currentSource, resolved.target, mutations);
        currentSource = rewritten.source;
        patches.push(rewritten.patch);
        changedSourceIds.add(fitNodeId);
    }
    return { source: currentSource, patches, changedSourceIds: [...changedSourceIds] };
}
function pruneFitValueRaw(valueRaw, deletedNodeNames) {
    const trimmed = valueRaw.trim();
    if (trimmed.length === 0) {
        return { kind: "unchanged" };
    }
    const wrapped = unwrapSingleBraceLayer(trimmed);
    const tokens = extractTopLevelCoordinateTokens(wrapped.content);
    if (tokens.length === 0) {
        return { kind: "unchanged" };
    }
    const kept = tokens.filter((token) => !fitTokenReferencesDeletedNode(token, deletedNodeNames));
    if (kept.length === tokens.length) {
        return { kind: "unchanged" };
    }
    if (kept.length === 0) {
        return { kind: "changed", value: null };
    }
    const compact = kept.join(" ");
    return {
        kind: "changed",
        value: wrapped.hadOuterBraces ? `{${compact}}` : compact
    };
}
function fitTokenReferencesDeletedNode(tokenRaw, deletedNodeNames) {
    const parsed = parseCoordinate(tokenRaw);
    if (parsed.form !== "named") {
        return false;
    }
    const maybeName = stripOuterBraces(parsed.x.trim());
    if (maybeName.length === 0) {
        return false;
    }
    const dot = maybeName.indexOf(".");
    const baseName = (dot >= 0 ? maybeName.slice(0, dot) : maybeName).trim();
    return baseName.length > 0 && deletedNodeNames.has(baseName);
}
function extractTopLevelCoordinateTokens(raw) {
    const tokens = [];
    let start = -1;
    let depth = 0;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "\\" && index + 1 < raw.length) {
            index += 1;
            continue;
        }
        if (char === "(") {
            if (depth === 0) {
                start = index;
            }
            depth += 1;
            continue;
        }
        if (char === ")") {
            if (depth === 0) {
                continue;
            }
            depth -= 1;
            if (depth === 0 && start >= 0) {
                tokens.push(raw.slice(start, index + 1));
                start = -1;
            }
        }
    }
    return tokens;
}
function optionListHasFitEntry(options) {
    if (!options) {
        return false;
    }
    return options.entries.some((entry) => (entry.kind === "flag" || entry.kind === "kv") && normalizeOptionKey(entry.key) === "fit");
}
function collectNodeItems(statements) {
    const nodes = [];
    const visitPathItems = (items) => {
        for (const item of items) {
            if (item.kind === "Node") {
                nodes.push(item);
                continue;
            }
            if (item.kind === "ChildOperation") {
                visitPathItems(item.body);
                continue;
            }
            if ((item.kind === "ToOperation" || item.kind === "EdgeOperation") && item.nodes) {
                for (const node of item.nodes) {
                    nodes.push(node);
                }
            }
        }
    };
    const visitStatements = (entries) => {
        for (const statement of entries) {
            if (statement.kind === "Path") {
                visitPathItems(statement.items);
                continue;
            }
            if (statement.kind === "Scope") {
                visitStatements(statement.body);
            }
        }
    };
    visitStatements(statements);
    return nodes;
}
function unwrapSingleBraceLayer(raw) {
    if (!raw.startsWith("{") || !raw.endsWith("}")) {
        return { content: raw, hadOuterBraces: false };
    }
    let depth = 0;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "\\" && index + 1 < raw.length) {
            index += 1;
            continue;
        }
        if (char === "{") {
            depth += 1;
            continue;
        }
        if (char === "}") {
            depth -= 1;
            if (depth === 0 && index !== raw.length - 1) {
                return { content: raw, hadOuterBraces: false };
            }
            if (depth < 0) {
                return { content: raw, hadOuterBraces: false };
            }
        }
    }
    return depth === 0
        ? { content: raw.slice(1, -1), hadOuterBraces: true }
        : { content: raw, hadOuterBraces: false };
}
function stripOuterBraces(raw) {
    const unwrapped = unwrapSingleBraceLayer(raw);
    return unwrapped.content.trim();
}
