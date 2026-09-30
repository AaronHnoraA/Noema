import { parseOptionListRaw } from "../options/parse.js";
import { readBalancedBlock } from "../semantic/style/option-utils.js";
import { walkStatements } from "../ast/walk.js";
export function collectSymbols(snapshot) {
    const parseResult = snapshot.parseResult;
    if (!parseResult) {
        return {
            nodeNames: [],
            styleNames: [],
            coordinateNames: []
        };
    }
    const nodeNames = new Set();
    const coordinateNames = new Set();
    const styleNames = new Set();
    walkStatements(parseResult.figure.body, {
        onNode: (node) => {
            collectNodeIdentifiers(node, nodeNames);
        },
        onCoordinateOperation: (item) => {
            addTrimmedSymbol(coordinateNames, item.name);
        }
    });
    collectStandaloneNodeCommandNamesFromSource(parseResult.source, nodeNames);
    collectStyleSymbolsFromSource(parseResult.source, styleNames);
    return {
        nodeNames: [...nodeNames].sort(compareSymbolName),
        styleNames: [...styleNames].sort(compareSymbolName),
        coordinateNames: [...coordinateNames].sort(compareSymbolName)
    };
}
function collectNodeIdentifiers(node, nodeNames) {
    addTrimmedSymbol(nodeNames, node.name);
    if (!node.name) {
        const inferred = inferNodeNameFromTemplate(node.templateRaw, node.atRaw);
        addTrimmedSymbol(nodeNames, inferred);
    }
    for (const alias of node.aliases ?? []) {
        addTrimmedSymbol(nodeNames, alias);
    }
}
function collectStyleSymbolsFromSource(source, styleNames) {
    collectStyleSymbolsFromCommand(source, "\\tikzset", styleNames);
    collectStyleSymbolsFromCommand(source, "\\pgfkeys", styleNames);
    collectStyleSymbolsFromTikzstyle(source, styleNames);
}
function collectStandaloneNodeCommandNamesFromSource(source, nodeNames) {
    const command = "\\node";
    let cursor = 0;
    while (cursor < source.length) {
        const commandIndex = source.indexOf(command, cursor);
        if (commandIndex < 0) {
            return;
        }
        let index = skipWhitespace(source, commandIndex + command.length);
        const optionBlock = readBalancedBlock(source, index, "[", "]");
        if (optionBlock) {
            index = skipWhitespace(source, optionBlock.nextIndex);
        }
        const nameBlock = readBalancedBlock(source, index, "(", ")");
        if (nameBlock) {
            addTrimmedSymbol(nodeNames, normalizeSimpleSymbolName(nameBlock.content));
            cursor = nameBlock.nextIndex;
            continue;
        }
        cursor = commandIndex + command.length;
    }
}
function collectStyleSymbolsFromCommand(source, command, styleNames) {
    let cursor = 0;
    while (cursor < source.length) {
        const commandIndex = source.indexOf(command, cursor);
        if (commandIndex < 0) {
            return;
        }
        const openBraceIndex = skipWhitespace(source, commandIndex + command.length);
        const block = readBalancedBlock(source, openBraceIndex, "{", "}");
        if (!block) {
            cursor = commandIndex + command.length;
            continue;
        }
        const optionList = parseOptionListRaw(`[${block.content}]`, openBraceIndex);
        for (const entry of optionList.entries) {
            if (entry.kind !== "kv" && entry.kind !== "flag") {
                continue;
            }
            const styleName = styleNameFromOptionKey(entry.key);
            if (!styleName) {
                continue;
            }
            addTrimmedSymbol(styleNames, styleName);
        }
        cursor = block.nextIndex;
    }
}
function collectStyleSymbolsFromTikzstyle(source, styleNames) {
    const command = "\\tikzstyle";
    let cursor = 0;
    while (cursor < source.length) {
        const commandIndex = source.indexOf(command, cursor);
        if (commandIndex < 0) {
            return;
        }
        const openBraceIndex = skipWhitespace(source, commandIndex + command.length);
        const nameBlock = readBalancedBlock(source, openBraceIndex, "{", "}");
        if (!nameBlock) {
            cursor = commandIndex + command.length;
            continue;
        }
        addTrimmedSymbol(styleNames, normalizeStyleName(nameBlock.content));
        cursor = nameBlock.nextIndex;
    }
}
function styleNameFromOptionKey(key) {
    const normalizedKey = key.trim().toLowerCase();
    const styleMatch = normalizedKey.match(/^(.*?)\/\.(style|append style|prefix style)$/);
    if (!styleMatch) {
        return null;
    }
    return normalizeStyleName(styleMatch[1] ?? "");
}
function normalizeStyleName(value) {
    let normalized = value.trim().toLowerCase();
    if (normalized.startsWith("/tikz/")) {
        normalized = normalized.slice("/tikz/".length);
    }
    else if (normalized.startsWith("/pgf/")) {
        normalized = normalized.slice("/pgf/".length);
    }
    return normalized.trim();
}
function inferNodeNameFromTemplate(templateRaw, atRaw) {
    const match = templateRaw.match(/\(\s*([A-Za-z_][A-Za-z0-9:_-]*)\s*\)/);
    if (!match) {
        return null;
    }
    const inferred = match[1]?.trim() ?? "";
    if (inferred.length === 0) {
        return null;
    }
    if (atRaw?.replace(/\s+/g, "") === `(${inferred})`) {
        return null;
    }
    return inferred;
}
function normalizeSimpleSymbolName(raw) {
    const trimmed = raw.trim();
    if (/^[A-Za-z_][A-Za-z0-9:_-]*$/.test(trimmed)) {
        return trimmed;
    }
    return null;
}
function addTrimmedSymbol(target, value) {
    if (!value) {
        return;
    }
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return;
    }
    target.add(trimmed);
}
function skipWhitespace(input, index) {
    let cursor = index;
    while (cursor < input.length && /\s/.test(input[cursor] ?? "")) {
        cursor += 1;
    }
    return cursor;
}
function compareSymbolName(left, right) {
    return left.localeCompare(right, "en", { sensitivity: "base" });
}
export { resolveDocHoverTarget } from "./doc-hover.js";
