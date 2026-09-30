import { worldPoint } from "../../coords/points.js";
import { pt } from "../../coords/scalars.js";
import { evaluateTikzFigure } from "../../semantic/evaluate.js";
import { applyTextReplacements, buildStatementSnapshotFromStatements, formatSnippetsForInsertion, groupStatementRefsByParent, lineIndentAtOffset, parseStatementSnapshot, resolveRootInsertionPoint, resolveStatementRefs, shiftSpansAfterReplacement, statementSnippet } from "../statement-ops.js";
import { renameSnippetDeclaredNames } from "../name-conflicts.js";
import { parseTikzForEdit } from "../parse-options.js";
export function applyPasteStatementsAction(source, action, deps, parseOptions = {}) {
    const caches = createPasteDuplicateCaches();
    const snippets = action.snippets
        .map((snippet) => snippet.replace(/\r\n?/g, "\n").trimEnd())
        .filter((snippet) => snippet.trim().length > 0);
    if (snippets.length === 0) {
        return { kind: "unsupported", reason: "No snippets were provided for pasteStatements." };
    }
    const delta = normalizeDuplicateDelta(action.delta, deps.defaultDuplicateOffsetPt);
    const shifted = offsetSnippetsByDelta(snippets, delta, deps, parseOptions, caches);
    const renamedSnippets = renameSnippetDeclaredNames(source, shifted.snippets, parseOptions);
    const snapshot = getStatementSnapshot(source, parseOptions, caches);
    const anchorId = action.anchorElementId?.trim();
    const anchorRef = anchorId ? snapshot.byId.get(anchorId) : undefined;
    const insertionWorldPoint = anchorRef
        ? {
            offset: anchorRef.span.to,
            indent: lineIndentAtOffset(source, anchorRef.span.from)
        }
        : resolveRootInsertionPoint(source);
    const insertion = formatSnippetsForInsertion(renamedSnippets, insertionWorldPoint.indent, {
        trailingNewline: !anchorRef,
        newline: detectPreferredNewline(source, insertionWorldPoint.offset)
    });
    const applied = applyTextReplacements(source, [
        {
            span: { from: insertionWorldPoint.offset, to: insertionWorldPoint.offset },
            text: insertion.text
        }
    ]);
    const appliedInsertion = applied.applied[0];
    const insertedSpans = insertion.snippetSpans.map((span) => ({
        from: appliedInsertion.newSpan.from + span.from,
        to: appliedInsertion.newSpan.from + span.to
    }));
    const selectedSourceIds = mapSpansToStatementIdsWithSnapshot(getStatementSnapshot(applied.source, parseOptions, caches), insertedSpans);
    const changedSourceIds = selectedSourceIds.length > 0 ? selectedSourceIds : undefined;
    if (shifted.partialReason) {
        return {
            kind: "partial",
            newSource: applied.source,
            patches: applied.patches,
            skippedHandles: shifted.skippedHandles,
            reason: shifted.partialReason,
            selectedSourceIds: changedSourceIds,
            changedSourceIds
        };
    }
    return {
        kind: "success",
        newSource: applied.source,
        patches: applied.patches,
        selectedSourceIds: changedSourceIds,
        changedSourceIds
    };
}
export function applyDuplicateElementsAction(source, action, deps, parseOptions = {}) {
    const caches = createPasteDuplicateCaches();
    const normalizedIds = deps.normalizeElementIds(action.elementIds);
    if (normalizedIds.length === 0) {
        return { kind: "unsupported", reason: "No element ids were provided for duplicateElements." };
    }
    const initialSnapshot = getStatementSnapshot(source, parseOptions, caches);
    const initialRefs = resolveStatementRefs(initialSnapshot, normalizedIds);
    if (initialRefs.length === 0) {
        return { kind: "unsupported", reason: "No duplicable statements were found for the selected element ids." };
    }
    const groups = groupStatementRefsByParent(initialRefs);
    let currentSource = source;
    const patches = [];
    let insertedSpans = [];
    const partialReasons = [];
    const partialSkippedHandles = [];
    const delta = normalizeDuplicateDelta(action.delta, deps.defaultDuplicateOffsetPt);
    for (const group of groups) {
        const snapshot = getStatementSnapshot(currentSource, parseOptions, caches);
        const currentRefs = resolveStatementRefs(snapshot, group.refs.map((ref) => ref.id));
        const resolvedGroups = groupStatementRefsByParent(currentRefs);
        for (const resolvedGroup of resolvedGroups) {
            const orderedRefs = [...resolvedGroup.refs].sort((left, right) => left.index - right.index);
            const snippets = orderedRefs.map((ref) => statementSnippet(currentSource, ref));
            const shifted = offsetSnippetsByDelta(snippets, delta, deps, parseOptions, caches);
            const renamedSnippets = renameSnippetDeclaredNames(currentSource, shifted.snippets, parseOptions);
            if (shifted.partialReason) {
                partialReasons.push(shifted.partialReason);
                partialSkippedHandles.push(...shifted.skippedHandles);
            }
            const anchor = orderedRefs[orderedRefs.length - 1];
            const insertion = formatSnippetsForInsertion(renamedSnippets, lineIndentAtOffset(currentSource, anchor.span.from));
            const applied = applyTextReplacements(currentSource, [
                {
                    span: { from: anchor.span.to, to: anchor.span.to },
                    text: insertion.text
                }
            ]);
            const appliedInsertion = applied.applied[0];
            patches.push(...applied.patches);
            currentSource = applied.source;
            insertedSpans = shiftSpansAfterReplacement(insertedSpans, appliedInsertion.oldSpan, appliedInsertion.newSpan);
            insertedSpans.push(...insertion.snippetSpans.map((span) => ({
                from: appliedInsertion.newSpan.from + span.from,
                to: appliedInsertion.newSpan.from + span.to
            })));
        }
    }
    const selectedSourceIds = mapSpansToStatementIdsWithSnapshot(getStatementSnapshot(currentSource, parseOptions, caches), insertedSpans);
    const changedSourceIds = selectedSourceIds.length > 0 ? selectedSourceIds : undefined;
    if (partialReasons.length > 0) {
        return {
            kind: "partial",
            newSource: currentSource,
            patches,
            skippedHandles: deps.uniqueStrings(partialSkippedHandles),
            reason: deps.uniqueStrings(partialReasons).join(" "),
            selectedSourceIds: changedSourceIds,
            changedSourceIds
        };
    }
    return {
        kind: "success",
        newSource: currentSource,
        patches,
        selectedSourceIds: changedSourceIds,
        changedSourceIds
    };
}
function offsetSnippetsByDelta(snippets, delta, deps, parseOptions, caches) {
    const normalized = snippets
        .map((snippet) => snippet.replace(/\r\n?/g, "\n").trimEnd())
        .filter((snippet) => snippet.trim().length > 0);
    if (Math.abs(delta.x) <= 1e-9 && Math.abs(delta.y) <= 1e-9) {
        return { snippets: normalized, skippedHandles: [] };
    }
    const preparation = getOffsetPreparation(normalized, parseOptions, caches);
    if (preparation.rootIds.length === 0) {
        return { snippets: normalized, skippedHandles: [] };
    }
    const moved = deps.applyMoveElements(preparation.wrappedSource, preparation.editHandles, preparation.rootIds, delta, parseOptions);
    if (moved.kind !== "success" && moved.kind !== "partial") {
        return {
            snippets: normalized,
            skippedHandles: [],
            partialReason: moved.kind === "unsupported"
                ? `Could not offset all pasted/duplicated statements: ${moved.reason}`
                : `Could not offset all pasted/duplicated statements: ${moved.message}`
        };
    }
    const movedSnapshot = getStatementSnapshot(moved.newSource, parseOptions, caches);
    const movedRootRefs = movedSnapshot.byParentKey.get("root") ?? [];
    const movedSnippets = movedRootRefs.map((ref) => statementSnippet(moved.newSource, ref));
    if (movedSnippets.length !== normalized.length) {
        return {
            snippets: normalized,
            skippedHandles: moved.kind === "partial" ? moved.skippedHandles : [],
            partialReason: moved.kind === "partial"
                ? `Some pasted/duplicated coordinates could not be offset: ${moved.reason}`
                : "Some pasted/duplicated statements could not be offset."
        };
    }
    if (moved.kind === "partial") {
        return {
            snippets: movedSnippets,
            partialReason: `Some pasted/duplicated coordinates could not be offset: ${moved.reason}`,
            skippedHandles: moved.skippedHandles
        };
    }
    return {
        snippets: movedSnippets,
        skippedHandles: []
    };
}
function wrapSnippetsInFigure(snippets) {
    const body = snippets.map((snippet) => `  ${snippet}`).join("\n");
    return `\\begin{tikzpicture}\n${body}\n\\end{tikzpicture}`;
}
function createPasteDuplicateCaches() {
    return {
        snapshots: new Map(),
        offsetPreparations: new Map()
    };
}
function getStatementSnapshot(source, parseOptions, caches) {
    const cached = caches.snapshots.get(source);
    if (cached) {
        return cached;
    }
    const snapshot = parseStatementSnapshot(source, parseOptions);
    caches.snapshots.set(source, snapshot);
    return snapshot;
}
function getOffsetPreparation(snippets, parseOptions, caches) {
    const wrappedSource = wrapSnippetsInFigure(snippets);
    const cached = caches.offsetPreparations.get(wrappedSource);
    if (cached) {
        return cached;
    }
    const parsed = parseTikzForEdit(wrappedSource, {
        ...parseOptions
    });
    const snapshot = buildStatementSnapshotFromStatements(wrappedSource, parsed.figure.body);
    caches.snapshots.set(wrappedSource, snapshot);
    const semantic = evaluateTikzFigure(parsed.figure, wrappedSource);
    const preparation = {
        wrappedSource,
        rootIds: (snapshot.byParentKey.get("root") ?? []).map((ref) => ref.id),
        editHandles: semantic.editHandles
    };
    caches.offsetPreparations.set(wrappedSource, preparation);
    return preparation;
}
function mapSpansToStatementIdsWithSnapshot(snapshot, spans) {
    if (spans.length === 0) {
        return [];
    }
    const seen = new Set();
    const ids = [];
    for (const span of spans) {
        let bestOverlap = null;
        for (const ref of snapshot.all) {
            const overlap = Math.max(0, Math.min(span.to, ref.span.to) - Math.max(span.from, ref.span.from));
            if (overlap <= 0) {
                continue;
            }
            if (!bestOverlap || overlap > bestOverlap.overlap) {
                bestOverlap = { id: ref.id, overlap };
            }
        }
        if (bestOverlap && !seen.has(bestOverlap.id)) {
            seen.add(bestOverlap.id);
            ids.push(bestOverlap.id);
        }
    }
    return ids;
}
function normalizeDuplicateDelta(delta, defaultDuplicateOffsetPt) {
    if (!delta) {
        return worldPoint(pt(defaultDuplicateOffsetPt), pt(-defaultDuplicateOffsetPt));
    }
    return worldPoint(pt(Number.isFinite(delta.x) ? delta.x : defaultDuplicateOffsetPt), pt(Number.isFinite(delta.y) ? delta.y : -defaultDuplicateOffsetPt));
}
function detectPreferredNewline(source, aroundOffset) {
    const windowStart = Math.max(0, aroundOffset - 256);
    const windowEnd = Math.min(source.length, aroundOffset + 256);
    const window = source.slice(windowStart, windowEnd);
    if (window.includes("\r\n")) {
        return "\r\n";
    }
    return "\n";
}
