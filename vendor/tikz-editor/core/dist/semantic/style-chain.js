export function cloneStyleSourceRef(sourceRef) {
    if (!sourceRef) {
        return undefined;
    }
    return {
        sourceId: sourceRef.sourceId,
        sourceSpan: sourceRef.sourceSpan
            ? {
                from: sourceRef.sourceSpan.from,
                to: sourceRef.sourceSpan.to
            }
            : undefined,
        sourceKind: sourceRef.sourceKind,
        label: sourceRef.label,
        identityRef: sourceRef.identityRef
            ? {
                sourceId: sourceRef.identityRef.sourceId,
                sourceSpan: sourceRef.identityRef.sourceSpan
                    ? {
                        from: sourceRef.identityRef.sourceSpan.from,
                        to: sourceRef.identityRef.sourceSpan.to
                    }
                    : undefined,
                sourceKind: sourceRef.identityRef.sourceKind
            }
            : undefined
    };
}
export function cloneStyleChain(chain) {
    // Keep array isolation so callers can append safely, while sharing immutable entries.
    return chain.slice();
}
export function cloneStyleChainEntry(entry) {
    if (entry.kind === "named-style") {
        return {
            ...cloneStyleChainEntryBase(entry),
            kind: "named-style",
            styleName: entry.styleName
        };
    }
    if (entry.kind === "every-shape") {
        return {
            ...cloneStyleChainEntryBase(entry),
            kind: "every-shape",
            shape: entry.shape
        };
    }
    return {
        ...cloneStyleChainEntryBase(entry),
        kind: entry.kind
    };
}
function cloneStyleChainEntryBase(entry) {
    return {
        kind: entry.kind,
        sourceRef: cloneStyleSourceRef(entry.sourceRef),
        // Copy only the outer list; option AST nodes are treated as immutable.
        rawOptions: entry.rawOptions.slice(),
        before: cloneResolvedStyle(entry.before),
        after: cloneResolvedStyle(entry.after),
        resolvedContributions: cloneResolvedStyleContributions(entry.resolvedContributions)
    };
}
function cloneResolvedStyleContributions(contributions) {
    const cloned = {};
    const clonedRecord = cloned;
    for (const key of Object.keys(contributions)) {
        const value = contributions[key];
        if (value !== undefined) {
            clonedRecord[key] = value;
        }
    }
    return cloned;
}
export function cloneResolvedStyle(style) {
    // Resolved styles are immutable snapshots; sharing avoids repeated deep-clone churn.
    return style;
}
export function diffResolvedStyle(before, after) {
    const diff = {};
    const diffRecord = diff;
    for (const key of Object.keys(after)) {
        const nextValue = after[key];
        if (nextValue !== undefined && !resolvedStyleValueEquals(before[key], nextValue)) {
            diffRecord[key] = nextValue;
        }
    }
    return diff;
}
export function resolvedStyleValueEquals(left, right) {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right)) {
            return false;
        }
        if (left.length !== right.length) {
            return false;
        }
        for (let index = 0; index < left.length; index += 1) {
            if (!resolvedStyleValueEquals(left[index], right[index])) {
                return false;
            }
        }
        return true;
    }
    if (isPlainObject(left) || isPlainObject(right)) {
        if (!isPlainObject(left) || !isPlainObject(right)) {
            return false;
        }
        const leftKeys = Object.keys(left);
        const rightKeys = Object.keys(right);
        if (leftKeys.length !== rightKeys.length) {
            return false;
        }
        for (const key of leftKeys) {
            if (!(key in right)) {
                return false;
            }
            if (!resolvedStyleValueEquals(left[key], right[key])) {
                return false;
            }
        }
        return true;
    }
    return false;
}
function isPlainObject(value) {
    return value != null && typeof value === "object" && !Array.isArray(value);
}
