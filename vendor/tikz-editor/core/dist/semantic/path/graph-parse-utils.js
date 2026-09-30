export function splitTopLevel(raw, separators, from) {
    const parts = [];
    let partStart = 0;
    let depthBrace = 0;
    let depthSquare = 0;
    let depthParen = 0;
    let inQuote = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "\\" && index + 1 < raw.length) {
            index += 1;
            continue;
        }
        if (char === '"' && raw[index - 1] !== "\\") {
            if (inQuote && raw[index + 1] === '"') {
                index += 1;
                continue;
            }
            inQuote = !inQuote;
            continue;
        }
        if (inQuote) {
            continue;
        }
        if (isCommentStart(raw, index)) {
            while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
                index += 1;
            }
            continue;
        }
        if (char === "{") {
            depthBrace += 1;
            continue;
        }
        if (char === "}") {
            depthBrace = Math.max(0, depthBrace - 1);
            continue;
        }
        if (char === "[") {
            depthSquare += 1;
            continue;
        }
        if (char === "]") {
            depthSquare = Math.max(0, depthSquare - 1);
            continue;
        }
        if (char === "(") {
            depthParen += 1;
            continue;
        }
        if (char === ")") {
            depthParen = Math.max(0, depthParen - 1);
            continue;
        }
        if (depthBrace === 0 && depthSquare === 0 && depthParen === 0 && separators.includes(char)) {
            parts.push({
                raw: raw.slice(partStart, index),
                from: from + partStart
            });
            partStart = index + 1;
        }
    }
    parts.push({
        raw: raw.slice(partStart),
        from: from + partStart
    });
    return parts;
}
export function readConnector(raw, start, operators) {
    for (const operator of operators) {
        if (raw.startsWith(operator, start)) {
            return {
                operator,
                index: start,
                next: start + operator.length
            };
        }
    }
    return null;
}
export function findNextConnector(raw, start, operators) {
    let depthBrace = 0;
    let depthSquare = 0;
    let depthParen = 0;
    let inQuote = false;
    for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "\\" && index + 1 < raw.length) {
            index += 1;
            continue;
        }
        if (char === '"' && raw[index - 1] !== "\\") {
            if (inQuote && raw[index + 1] === '"') {
                index += 1;
                continue;
            }
            inQuote = !inQuote;
            continue;
        }
        if (inQuote) {
            continue;
        }
        if (isCommentStart(raw, index)) {
            while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
                index += 1;
            }
            continue;
        }
        if (char === "{") {
            depthBrace += 1;
            continue;
        }
        if (char === "}") {
            depthBrace = Math.max(0, depthBrace - 1);
            continue;
        }
        if (char === "[") {
            depthSquare += 1;
            continue;
        }
        if (char === "]") {
            depthSquare = Math.max(0, depthSquare - 1);
            continue;
        }
        if (char === "(") {
            depthParen += 1;
            continue;
        }
        if (char === ")") {
            depthParen = Math.max(0, depthParen - 1);
            continue;
        }
        if (depthBrace === 0 && depthSquare === 0 && depthParen === 0) {
            for (const operator of operators) {
                if (raw.startsWith(operator, index)) {
                    return { operator, index };
                }
            }
        }
    }
    return null;
}
export function readBalancedSegment(raw, start, open, close) {
    if (raw[start] !== open) {
        return null;
    }
    let depth = 0;
    let inQuote = false;
    for (let index = start; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "\\" && index + 1 < raw.length) {
            index += 1;
            continue;
        }
        if (char === '"' && raw[index - 1] !== "\\") {
            if (inQuote && raw[index + 1] === '"') {
                index += 1;
                continue;
            }
            inQuote = !inQuote;
            continue;
        }
        if (inQuote) {
            continue;
        }
        if (isCommentStart(raw, index)) {
            while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
                index += 1;
            }
            continue;
        }
        if (char === open) {
            depth += 1;
            continue;
        }
        if (char === close) {
            depth -= 1;
            if (depth === 0) {
                return {
                    raw: raw.slice(start, index + 1),
                    next: index + 1
                };
            }
        }
    }
    return null;
}
export function findTopLevelChar(raw, needle) {
    let depthBrace = 0;
    let depthSquare = 0;
    let depthParen = 0;
    let inQuote = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (char === "\\" && index + 1 < raw.length) {
            index += 1;
            continue;
        }
        if (char === '"' && raw[index - 1] !== "\\") {
            if (inQuote && raw[index + 1] === '"') {
                index += 1;
                continue;
            }
            inQuote = !inQuote;
            continue;
        }
        if (inQuote) {
            continue;
        }
        if (isCommentStart(raw, index)) {
            while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
                index += 1;
            }
            continue;
        }
        if (char === "{") {
            depthBrace += 1;
            continue;
        }
        if (char === "}") {
            depthBrace = Math.max(0, depthBrace - 1);
            continue;
        }
        if (char === "[") {
            depthSquare += 1;
            continue;
        }
        if (char === "]") {
            depthSquare = Math.max(0, depthSquare - 1);
            continue;
        }
        if (char === "(") {
            depthParen += 1;
            continue;
        }
        if (char === ")") {
            depthParen = Math.max(0, depthParen - 1);
            continue;
        }
        if (depthBrace === 0 && depthSquare === 0 && depthParen === 0 && char === needle) {
            return index;
        }
    }
    return -1;
}
export function mergeOptionLists(optionLists) {
    if (optionLists.length === 0) {
        return undefined;
    }
    if (optionLists.length === 1) {
        return optionLists[0];
    }
    const first = optionLists[0];
    const last = optionLists[optionLists.length - 1];
    return {
        span: {
            from: first.span.from,
            to: last.span.to
        },
        raw: `[${optionLists.map((entry) => stripOptionListBrackets(entry.raw)).join(",")}]`,
        entries: optionLists.flatMap((entry) => entry.entries)
    };
}
export function optionListIfPresent(optionList) {
    return optionList ? [optionList] : [];
}
export function optionListFromEntries(entries, base) {
    if (entries.length === 0) {
        return undefined;
    }
    return {
        span: base.span,
        raw: `[${entries.map((entry) => entry.raw).join(",")}]`,
        entries
    };
}
export function stripOptionListBrackets(raw) {
    const trimmed = raw.trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]") && trimmed.length >= 2) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}
export function trimRightIndex(raw) {
    for (let index = raw.length - 1; index >= 0; index -= 1) {
        if (!/\s/.test(raw[index])) {
            return index;
        }
    }
    return -1;
}
export function skipWhitespace(raw, cursor) {
    let index = cursor;
    while (index < raw.length) {
        const char = raw[index];
        if (/\s/.test(char)) {
            index += 1;
            continue;
        }
        if (isCommentStart(raw, index)) {
            while (index < raw.length && raw[index] !== "\n" && raw[index] !== "\r") {
                index += 1;
            }
            continue;
        }
        break;
    }
    return index;
}
function isCommentStart(raw, index) {
    if (raw[index] !== "%") {
        return false;
    }
    if (index > 0 && raw[index - 1] === "\\") {
        return false;
    }
    return true;
}
