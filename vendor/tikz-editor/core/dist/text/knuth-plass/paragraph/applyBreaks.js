import { TEX_INTERWORD_SPACE_EM } from '../alignment.js';
const MTEXT_INDENT_PATCHED = Symbol('kp-mtext-indent-patched');
const MTEXT_INDENT_PATCH_ORIGINAL = Symbol('kp-mtext-indent-original');
function alignmentToHorizontalAlign(alignment) {
    if (alignment === 'ragged-left') {
        return 'right';
    }
    if (alignment === 'center') {
        return 'center';
    }
    return 'left';
}
function safeInvalidate(wrapper) {
    if (wrapper && typeof wrapper.invalidateBBox === 'function') {
        wrapper.invalidateBBox();
    }
}
function isTextChild(child) {
    return !!child?.node?.isKind?.('text');
}
function getTextChildren(wrapper) {
    return Array.isArray(wrapper?.childNodes) ? wrapper.childNodes : [];
}
function normalizeSplitMutations(values) {
    const byOffset = new Map();
    for (const value of values) {
        const existing = byOffset.get(value.splitOffset);
        if (!existing) {
            byOffset.set(value.splitOffset, value);
            continue;
        }
        if (existing.insertKind === 'space' && value.insertKind === 'hyphen') {
            byOffset.set(value.splitOffset, value);
        }
    }
    return [...byOffset.values()].sort((a, b) => a.splitOffset - b.splitOffset);
}
function restoreMtextWrapper(wrapper, originalMap) {
    if (!wrapper || typeof wrapper !== 'object')
        return;
    if (!originalMap)
        return;
    const snapshot = originalMap.get(wrapper);
    if (!snapshot)
        return;
    const children = getTextChildren(wrapper);
    for (let i = 0; i < children.length; i++) {
        const child = children.at(i);
        if (!isTextChild(child))
            continue;
        const text = snapshot.at(i);
        if (text === undefined)
            continue;
        if (typeof child.node.setText === 'function') {
            child.node.setText(text);
            safeInvalidate(child);
        }
    }
    if (typeof wrapper.clearBreakPoints === 'function') {
        wrapper.clearBreakPoints();
    }
    safeInvalidate(wrapper);
}
function formatEmLength(value) {
    return `${Number(value.toFixed(6))}em`;
}
function restoreMspaceWrapper(wrapper, originalMap) {
    if (!wrapper || typeof wrapper !== 'object')
        return;
    if (!originalMap)
        return;
    const attrs = wrapper.node?.attributes;
    if (!attrs || typeof attrs.set !== 'function')
        return;
    const originalWidth = originalMap.get(wrapper);
    attrs.set('width', originalWidth ?? '');
    if (typeof wrapper.setBreakStyle === 'function') {
        wrapper.setBreakStyle('');
    }
    safeInvalidate(wrapper);
}
function readMspaceWidth(wrapper) {
    if (!wrapper || typeof wrapper !== 'object') {
        return 0;
    }
    const bbox = typeof wrapper.getBBox === 'function'
        ? wrapper.getBBox()
        : typeof wrapper.getOuterBBox === 'function'
            ? wrapper.getOuterBBox()
            : null;
    const width = Number(bbox?.w);
    return Number.isFinite(width) ? width : 0;
}
function setMspaceWidth(wrapper, width) {
    if (!wrapper || typeof wrapper !== 'object') {
        return;
    }
    const attrs = wrapper.node?.attributes;
    if (!attrs || typeof attrs.set !== 'function') {
        return;
    }
    attrs.set('width', formatEmLength(Math.max(0, width)));
    safeInvalidate(wrapper);
}
function formatGapWidthEm(widthEm) {
    return `${Number(widthEm.toFixed(6))}em`;
}
function applyWrappedTextGapWidths(runs, wrappedTextGaps) {
    const gapBySourceStart = new Map();
    for (const gap of wrappedTextGaps ?? []) {
        if (Number.isFinite(gap.widthEm) && gap.widthEm >= 0) {
            gapBySourceStart.set(gap.sourceStart, gap);
        }
    }
    for (const run of runs) {
        if (!isAdjustableMspaceRun(run)) {
            continue;
        }
        const gap = gapBySourceStart.get(run.sourceStart);
        const widthEm = gap?.widthEm ?? TEX_INTERWORD_SPACE_EM;
        run.texGlue = {
            width: widthEm,
            stretch: gap?.stretchEm ?? 0,
            shrink: gap?.shrinkEm ?? 0,
            spaceFactor: gap?.spaceFactor,
        };
        const wrapper = run.breakRef.wrapper;
        if (!wrapper) {
            continue;
        }
        const attrs = wrapper.node?.attributes;
        if (!attrs || typeof attrs.set !== 'function') {
            continue;
        }
        attrs.set('width', formatGapWidthEm(widthEm));
        if (typeof wrapper.setBreakStyle === 'function') {
            wrapper.setBreakStyle('');
        }
        safeInvalidate(wrapper);
    }
}
function isAdjustableMspaceRun(run) {
    return (!!run &&
        run.kind === 'space' &&
        run.breakRef.kind === 'mspace' &&
        !run.breakRef.isForcedLineBreak);
}
function ensureWrapperPlan(plans, wrapper) {
    let plan = plans.get(wrapper);
    if (!plan) {
        plan = {
            childWordSplits: new Map(),
            wordPrefixTrim: new Map(),
        };
        plans.set(wrapper, plan);
    }
    return plan;
}
function pushSplit(plans, wrapper, childIndex, wordIndex, splitOffset, insertKind) {
    const plan = ensureWrapperPlan(plans, wrapper);
    let wordMap = plan.childWordSplits.get(childIndex);
    if (!wordMap) {
        wordMap = new Map();
        plan.childWordSplits.set(childIndex, wordMap);
    }
    const current = wordMap.get(wordIndex) ?? [];
    current.push({ splitOffset, insertKind });
    wordMap.set(wordIndex, current);
}
function pushWordPrefixTrim(plans, wrapper, childIndex, wordIndex, consumed) {
    if (!Number.isFinite(consumed) || consumed <= 0) {
        return;
    }
    const plan = ensureWrapperPlan(plans, wrapper);
    let childMap = plan.wordPrefixTrim.get(childIndex);
    if (!childMap) {
        childMap = new Map();
        plan.wordPrefixTrim.set(childIndex, childMap);
    }
    const prior = childMap.get(wordIndex) ?? 0;
    childMap.set(wordIndex, Math.max(prior, Math.floor(consumed)));
}
function normalizePlans(plans) {
    for (const plan of plans.values()) {
        for (const [childIndex, wordSplits] of plan.childWordSplits.entries()) {
            for (const [wordIndex, splits] of wordSplits.entries()) {
                wordSplits.set(wordIndex, normalizeSplitMutations(splits));
            }
            plan.childWordSplits.set(childIndex, wordSplits);
        }
    }
}
function patchMtextIndentBehavior(wrapper) {
    if (!wrapper || typeof wrapper !== 'object') {
        return;
    }
    if (wrapper[MTEXT_INDENT_PATCHED]) {
        return;
    }
    if (typeof wrapper.computeLineBBox !== 'function') {
        return;
    }
    const original = wrapper.computeLineBBox.bind(wrapper);
    wrapper[MTEXT_INDENT_PATCH_ORIGINAL] = original;
    wrapper[MTEXT_INDENT_PATCHED] = true;
    wrapper.computeLineBBox = function patchedComputeLineBBox(i) {
        const bbox = original(i);
        if (bbox &&
            typeof bbox.getIndentData === 'function' &&
            this.node?.attributes) {
            bbox.getIndentData(this.node);
        }
        return bbox;
    };
}
function applyMtextAlignment(wrapper, alignment) {
    if (!wrapper.node?.attributes || typeof wrapper.node.attributes.set !== 'function') {
        return;
    }
    const align = alignmentToHorizontalAlign(alignment);
    wrapper.node.attributes.set('indentalign', align);
    wrapper.node.attributes.set('indentalignfirst', align);
    wrapper.node.attributes.set('indentalignlast', align);
    wrapper.node.attributes.set('indentshift', '0');
    wrapper.node.attributes.set('indentshiftfirst', '0');
    wrapper.node.attributes.set('indentshiftlast', '0');
}
function countSplitsBeforeWord(wordSplits, wordIndex) {
    let total = 0;
    for (const [index, splits] of wordSplits.entries()) {
        if (index < wordIndex) {
            total += splits.length;
        }
    }
    return total;
}
function tokenizeForMutation(text) {
    const tokens = text.match(/\s+|[^\s]+/g) ?? [];
    return tokens.map((token) => ({
        kind: /^\s+$/.test(token) ? 'space' : 'word',
        text: token,
    }));
}
function wordTokenIndices(tokens) {
    const indices = [];
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].kind === 'word') {
            indices.push(i);
        }
    }
    return indices;
}
function normalizeWhitespaceToken(text) {
    return /^[\t\n\r\f ]+$/.test(text) ? ' ' : text;
}
function mutateWrapperText(wrapper, plan, errors) {
    const children = getTextChildren(wrapper);
    const allChildIndices = new Set([
        ...plan.childWordSplits.keys(),
        ...plan.wordPrefixTrim.keys(),
    ]);
    for (const childIndex of allChildIndices) {
        const wordSplits = plan.childWordSplits.get(childIndex) ?? new Map();
        const wordPrefixTrim = plan.wordPrefixTrim.get(childIndex) ?? new Map();
        const child = children.at(childIndex);
        if (!child || !isTextChild(child)) {
            errors.push(`Mutation failed: mtext child ${childIndex} is missing or not text.`);
            return false;
        }
        if (typeof child.node.getText !== 'function') {
            errors.push(`Mutation failed: child ${childIndex} does not expose getText().`);
            return false;
        }
        if (typeof child.node.setText !== 'function') {
            errors.push(`Mutation failed: child ${childIndex} does not expose setText().`);
            return false;
        }
        const originalText = String(child.node.getText());
        const tokens = tokenizeForMutation(originalText);
        const wordIndices = wordTokenIndices(tokens);
        for (const [wordIndex, consumed] of wordPrefixTrim.entries()) {
            if (wordIndex < 0 || wordIndex >= wordIndices.length) {
                errors.push(`Mutation failed: line-leading trim wordIndex ${wordIndex} out of range for child ${childIndex}.`);
                return false;
            }
            const tokenIndex = wordIndices[wordIndex];
            const word = tokens[tokenIndex].text;
            if (consumed > word.length) {
                errors.push(`Mutation failed: line-leading trim length ${consumed} exceeds word '${word}'.`);
                return false;
            }
            tokens[tokenIndex].text = word.slice(consumed);
        }
        for (const [wordIndex, splitsAscending] of wordSplits.entries()) {
            if (wordIndex < 0 || wordIndex >= wordIndices.length) {
                errors.push(`Mutation failed: wordIndex ${wordIndex} out of range for child ${childIndex}.`);
                return false;
            }
            const tokenIndex = wordIndices[wordIndex];
            let word = tokens[tokenIndex].text;
            const splitsDescending = [...splitsAscending].sort((a, b) => b.splitOffset - a.splitOffset);
            for (const mutation of splitsDescending) {
                const split = mutation.splitOffset;
                if (split <= 0 || split >= word.length) {
                    errors.push(`Mutation failed: splitOffset ${split} invalid for word '${word}'.`);
                    return false;
                }
                const insertion = mutation.insertKind === 'hyphen' ? '- ' : ' ';
                word = `${word.slice(0, split)}${insertion}${word.slice(split)}`;
            }
            tokens[tokenIndex].text = word;
        }
        child.node.setText(tokens
            .map((token) => token.kind === 'space' ? normalizeWhitespaceToken(token.text) : token.text)
            .join(''));
        safeInvalidate(child);
    }
    if (typeof wrapper.clearBreakPoints === 'function') {
        wrapper.clearBreakPoints();
    }
    safeInvalidate(wrapper);
    return true;
}
function mappedIndexForSpace(wordSplits, wordIndex) {
    return wordIndex + countSplitsBeforeWord(wordSplits, wordIndex);
}
function mappedIndexForHyphen(wordSplits, wordIndex, splitOffset) {
    const splits = wordSplits.get(wordIndex) ?? [];
    const rank = splits.findIndex((split) => split.splitOffset === splitOffset);
    if (rank < 0) {
        return null;
    }
    return wordIndex + countSplitsBeforeWord(wordSplits, wordIndex) + rank + 1;
}
function clearExistingBreakStyles(runs, touchedMtextWrappers, touchedMspaceWrappers, originalMspaceWidthByWrapper) {
    for (const run of runs) {
        if (run.kind === 'text') {
            touchedMtextWrappers.add(run.wrapper);
            continue;
        }
        if (run.kind === 'space') {
            if (run.breakRef.kind === 'mtext-space') {
                touchedMtextWrappers.add(run.breakRef.wrapper);
            }
            else {
                touchedMspaceWrappers.add(run.breakRef.wrapper);
            }
        }
    }
    for (const wrapper of touchedMtextWrappers) {
        if (!wrapper) {
            continue;
        }
        if (typeof wrapper.clearBreakPoints === 'function') {
            wrapper.clearBreakPoints();
            safeInvalidate(wrapper);
        }
    }
    for (const wrapper of touchedMspaceWrappers) {
        restoreMspaceWrapper(wrapper, originalMspaceWidthByWrapper);
    }
}
function applyParagraphAlignment(paragraphWrapper, alignment, paragraphId) {
    const parentNode = paragraphWrapper.parent?.node;
    const attrs = parentNode?.attributes;
    if (!attrs || typeof attrs.set !== 'function') {
        return;
    }
    const align = alignmentToHorizontalAlign(alignment);
    attrs.set('data-align', align);
    attrs.set('indentalign', align);
    attrs.set('indentalignfirst', align);
    attrs.set('indentalignlast', align);
    attrs.set('indentshift', '0');
    attrs.set('indentshiftfirst', '0');
    attrs.set('indentshiftlast', '0');
    if (paragraphId) {
        attrs.set('data-paragraph-id', paragraphId);
    }
}
export function applyBreaks(paragraphWrapper, runs, lines, options = {}) {
    const errors = [];
    const appliedBreaks = [];
    const alignment = options.alignment ?? 'ragged-right';
    applyParagraphAlignment(paragraphWrapper, alignment, options.paragraphId);
    const touchedMtextWrappers = new Set();
    const touchedMspaceWrappers = new Set();
    clearExistingBreakStyles(runs, touchedMtextWrappers, touchedMspaceWrappers, options.originalMspaceWidthByWrapper);
    applyWrappedTextGapWidths(runs, options.wrappedTextGaps);
    for (const wrapper of touchedMtextWrappers) {
        if (!wrapper) {
            continue;
        }
        patchMtextIndentBehavior(wrapper);
        applyMtextAlignment(wrapper, alignment);
    }
    const plans = new Map();
    const mtextActionsInLineOrder = [];
    const justifiedSpaceWidths = new Map();
    if (alignment === 'justified') {
        for (const line of lines) {
            const delta = Number(line.spaceDeltaPerGap ?? 0);
            if (!Number.isFinite(delta) || delta === 0) {
                continue;
            }
            for (let runIndex = line.startRun; runIndex <= line.endRun; runIndex++) {
                const run = runs.at(runIndex);
                if (run?.kind !== 'space' ||
                    run.breakRef.kind !== 'mspace' ||
                    run.breakRef.isForcedLineBreak) {
                    continue;
                }
                justifiedSpaceWidths.set(runIndex, Math.max(0, readMspaceWidth(run.breakRef.wrapper) + delta));
            }
        }
    }
    for (const [runIndex, width] of justifiedSpaceWidths.entries()) {
        const run = runs.at(runIndex);
        if (run?.kind === 'space' && run.breakRef.kind === 'mspace') {
            setMspaceWidth(run.breakRef.wrapper, width);
        }
    }
    for (const line of lines) {
        if (!line.break)
            continue;
        const breakDecision = line.break;
        if (breakDecision.kind === 'hyphen') {
            const run = runs.at(breakDecision.runIndex);
            if (run?.kind !== 'text') {
                errors.push(`Hyphen break points to non-text run index ${breakDecision.runIndex}.`);
                continue;
            }
            if (typeof breakDecision.splitOffset !== 'number') {
                errors.push(`Hyphen break at run ${breakDecision.runIndex} is missing splitOffset.`);
                continue;
            }
            pushSplit(plans, run.wrapper, run.childIndex, run.wordIndex, breakDecision.splitOffset, breakDecision.visibleHyphen ? 'hyphen' : 'space');
            mtextActionsInLineOrder.push({
                lineIndex: line.lineIndex,
                kind: 'hyphen',
                runIndex: breakDecision.runIndex,
                sourceOffset: breakDecision.sourceOffset,
                visibleHyphen: breakDecision.visibleHyphen,
                wrapper: run.wrapper,
                childIndex: run.childIndex,
                wordIndex: run.wordIndex,
                splitOffset: breakDecision.splitOffset,
            });
            continue;
        }
        const run = runs.at(breakDecision.runIndex);
        if (run?.kind !== 'space') {
            appliedBreaks.push({
                lineIndex: line.lineIndex,
                kind: 'forced',
                runIndex: breakDecision.runIndex,
                sourceOffset: breakDecision.sourceOffset,
                visibleHyphen: false,
                lineLeading: breakDecision.lineLeading,
            });
            continue;
        }
        if (run.breakRef.kind === 'mtext-space') {
            mtextActionsInLineOrder.push({
                lineIndex: line.lineIndex,
                kind: 'space',
                runIndex: run.runIndex,
                sourceOffset: run.sourceEnd,
                visibleHyphen: false,
                wrapper: run.breakRef.wrapper,
                childIndex: run.breakRef.childIndex,
                wordIndex: run.breakRef.wordIndex,
            });
            continue;
        }
        if (!run.breakRef.isForcedLineBreak && !run.breakRef.lineLeading) {
            setMspaceWidth(run.breakRef.wrapper, 0);
        }
        if (run.breakRef.lineLeading) {
            if (typeof run.breakRef.wrapper.node?.attributes?.set === 'function') {
                run.breakRef.wrapper.node.attributes.set('data-lineleading', run.breakRef.lineLeading);
            }
        }
        if (run.breakRef.lineLeadingTrim) {
            pushWordPrefixTrim(plans, run.breakRef.lineLeadingTrim.wrapper, run.breakRef.lineLeadingTrim.childIndex, run.breakRef.lineLeadingTrim.wordIndex, run.breakRef.lineLeadingTrim.consumed);
        }
        if (typeof run.breakRef.wrapper.setBreakStyle === 'function') {
            run.breakRef.wrapper.setBreakStyle('before');
            safeInvalidate(run.breakRef.wrapper);
        }
        const appliedKind = breakDecision.kind === 'forced' ? 'forced' : 'space';
        appliedBreaks.push({
            lineIndex: line.lineIndex,
            kind: appliedKind,
            runIndex: run.runIndex,
            sourceOffset: run.sourceEnd,
            visibleHyphen: false,
            lineLeading: run.breakRef.lineLeading,
        });
    }
    normalizePlans(plans);
    const mutatedWrappers = new Set();
    let canProceed = errors.length === 0;
    if (canProceed) {
        for (const [wrapper, plan] of plans.entries()) {
            const ok = mutateWrapperText(wrapper, plan, errors);
            if (!ok) {
                canProceed = false;
                break;
            }
            mutatedWrappers.add(wrapper);
        }
    }
    if (canProceed) {
        for (const action of mtextActionsInLineOrder) {
            const plan = plans.get(action.wrapper);
            const childSplits = plan?.childWordSplits.get(action.childIndex) ??
                new Map();
            const mutatedWordIndex = action.kind === 'space'
                ? mappedIndexForSpace(childSplits, action.wordIndex)
                : mappedIndexForHyphen(childSplits, action.wordIndex, action.splitOffset);
            if (mutatedWordIndex === null) {
                errors.push(`Failed to map mutated break index for line ${action.lineIndex}, run ${action.runIndex}.`);
                canProceed = false;
                break;
            }
            if (typeof action.wrapper.setBreakAt !== 'function') {
                errors.push('Target mtext wrapper does not expose setBreakAt().');
                canProceed = false;
                break;
            }
            action.wrapper.setBreakAt([action.childIndex, mutatedWordIndex]);
            safeInvalidate(action.wrapper);
            appliedBreaks.push({
                lineIndex: action.lineIndex,
                kind: action.kind,
                runIndex: action.runIndex,
                sourceOffset: action.sourceOffset,
                visibleHyphen: action.visibleHyphen,
                splitOffset: action.splitOffset,
            });
        }
    }
    if (!canProceed) {
        const wrappersToRestore = new Set(mutatedWrappers);
        for (const wrapper of plans.keys()) {
            wrappersToRestore.add(wrapper);
        }
        for (const wrapper of wrappersToRestore) {
            restoreMtextWrapper(wrapper, options.originalMtextTextByWrapper);
        }
        for (const wrapper of touchedMspaceWrappers) {
            restoreMspaceWrapper(wrapper, options.originalMspaceWidthByWrapper);
        }
    }
    safeInvalidate(paragraphWrapper);
    return {
        appliedBreaks: canProceed ? appliedBreaks : [],
        canProceed,
        errors,
    };
}
