import { colorletStatementId, defineColorStatementId, macroAliasStatementId, macroCommandDefinitionStatementId, macroDefinitionStatementId } from "../ast/ids.js";
import { mapBodyStatements, mapStatementNode, unwrapStatementLikeNode } from "../domains/statements/parse.js";
import { parseOptionListRaw } from "../options/parse.js";
import { findFirstChildByName, findFirstNodeByName, forEachChild, walk } from "../syntax/cursor.js";
import { parseSyntax } from "@tikz-editor/lezer-tikz";
import { collectParseErrorDiagnostics, collectStructuralDiagnostics } from "../diagnostics/collect.js";
import { buildLineStarts, lineForOffset } from "../text/line-map.js";
import { scanTikzFigures } from "../parser/figure-scan.js";
export function fromCst(tree, source, opts = {}) {
    const diagnostics = [];
    collectParseErrorDiagnostics(tree.topNode, source, diagnostics);
    const figureEntries = collectFigureNodes(tree, source, opts.scannedFigures);
    const activeFigureEntry = resolveActiveFigureEntry(figureEntries, opts.activeFigureId);
    if (figureEntries.length === 0) {
        const inlineNode = findFirstNodeByName(tree.topNode, "TikzInline");
        if (inlineNode) {
            const state = { nextStatementIndex: 0 };
            const inlineBody = mapBodyStatements(inlineNode, source, state);
            const optionsNode = findFirstChildByName(inlineNode, "OptionList");
            return {
                figure: {
                    kind: "Figure",
                    span: { from: inlineNode.from, to: inlineNode.to },
                    options: optionsNode
                        ? parseOptionListRaw(source.slice(optionsNode.from, optionsNode.to), optionsNode.from)
                        : recoverInlineTikzOptions(inlineNode, source),
                    body: inlineBody
                },
                figures: [],
                activeFigureId: null,
                diagnostics
            };
        }
    }
    if (!activeFigureEntry) {
        if (figureEntries.length === 0 && source.trim().length > 0) {
            diagnostics.push({
                severity: "warning",
                message: "No tikzpicture environment found; wrap the code in `\\begin{tikzpicture}` ... `\\end{tikzpicture}`.",
                span: { from: 0, to: source.length },
                code: "missing-tikzpicture"
            });
        }
        return {
            figure: {
                kind: "Figure",
                span: { from: 0, to: source.length },
                body: []
            },
            figures: figureEntries.map((entry) => entry.inventory),
            activeFigureId: null,
            diagnostics
        };
    }
    const activeSyntax = resolveActiveSyntaxNode(source, activeFigureEntry);
    if (!activeSyntax) {
        return {
            figure: {
                kind: "Figure",
                span: activeFigureEntry.inventory.span,
                body: []
            },
            figures: figureEntries.map((entry) => entry.inventory),
            activeFigureId: activeFigureEntry.id,
            diagnostics
        };
    }
    const activeState = { nextStatementIndex: 0 };
    const priorDefinitions = opts.includeContextDefinitions
        ? (opts.contextDefinitions ?? collectPriorDefinitions(tree, source, activeFigureEntry.inventory.span.from, { nextStatementIndex: 0 }))
        : [];
    if (opts.includeContextDefinitions) {
        activeState.nextStatementIndex = priorDefinitions.filter((statement) => !isMacroContextStatement(statement)).length;
    }
    const activeBody = mapBodyStatements(activeSyntax.node, activeSyntax.parseSource, activeState);
    const body = [...priorDefinitions, ...activeBody];
    const optionsNode = findFirstChildByName(activeSyntax.node, "OptionList");
    const structuralDiagnostics = [];
    collectStructuralDiagnostics(activeSyntax.node, activeSyntax.parseSource, structuralDiagnostics);
    diagnostics.push(...structuralDiagnostics);
    return {
        figure: {
            kind: "Figure",
            span: activeFigureEntry.inventory.span,
            options: optionsNode
                ? parseOptionListRaw(activeSyntax.parseSource.slice(optionsNode.from, optionsNode.to), optionsNode.from)
                : undefined,
            body
        },
        figures: figureEntries.map((entry) => entry.inventory),
        activeFigureId: activeFigureEntry.id,
        diagnostics
    };
}
function recoverInlineTikzOptions(node, source) {
    const commandNode = findFirstChildByName(node, "InlineTikzCmd");
    if (!commandNode) {
        return;
    }
    const commandRaw = source.slice(commandNode.from, commandNode.to);
    if (!commandRaw.endsWith("[")) {
        return;
    }
    const optionStart = commandNode.to - 1;
    const optionEnd = findMatchingInlineOptionBracket(source, optionStart);
    if (optionEnd < 0) {
        return;
    }
    return parseOptionListRaw(source.slice(optionStart, optionEnd + 1), optionStart);
}
function findMatchingInlineOptionBracket(source, from) {
    let depth = 0;
    for (let index = from; index < source.length; index += 1) {
        const char = source[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === "[") {
            depth += 1;
            continue;
        }
        if (char === "]") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}
function collectFigureNodes(tree, source, scannedFigures) {
    const nodes = [];
    const scanned = scanFigureInventories(source, scannedFigures);
    if (scanned.length === 0) {
        return nodes;
    }
    const parsedNodesBySpan = collectParsedFigureNodesBySpan(tree);
    for (let index = 0; index < scanned.length; index += 1) {
        const inventory = scanned[index];
        const id = `figure:${index}`;
        const parsedNode = parsedNodesBySpan.get(spanKey(inventory.span)) ?? null;
        nodes.push({
            id,
            node: parsedNode,
            inventory: {
                id,
                span: inventory.span,
                beginSpan: inventory.beginSpan,
                endSpan: inventory.endSpan,
                optionsSpan: inventory.optionsSpan,
                startLine: inventory.startLine,
                endLine: inventory.endLine
            }
        });
    }
    nodes.sort((left, right) => left.inventory.span.from - right.inventory.span.from);
    return nodes;
}
function resolveActiveFigureEntry(entries, requestedId) {
    if (entries.length === 0) {
        return null;
    }
    if (requestedId === null) {
        return null;
    }
    if (requestedId === undefined || requestedId.length === 0) {
        return entries[0];
    }
    const directMatch = entries.find((entry) => entry.id === requestedId);
    if (directMatch) {
        return directMatch;
    }
    const requestedIndex = parseFigureIndexFromId(requestedId);
    if (requestedIndex == null || requestedIndex < 0 || requestedIndex >= entries.length) {
        return entries[0];
    }
    return entries[requestedIndex];
}
function parseFigureIndexFromId(figureId) {
    const match = /^figure:(\d+)(?::|$)/u.exec(figureId.trim());
    if (!match?.[1]) {
        return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) ? parsed : null;
}
function collectPriorDefinitions(tree, source, activeFrom, state) {
    const defs = [];
    const beginDocumentOffset = findBeginDocumentOffset(source);
    forEachChild(tree.topNode, (child) => {
        if (child.from >= activeFrom) {
            return;
        }
        if (child.type.name === "TikzEnvironment") {
            defs.push(...collectRelevantStatementsFromNode(child, source, state));
            return;
        }
        if (child.type.name === "TikzInline") {
            return;
        }
        if (child.to <= beginDocumentOffset || child.from < activeFrom) {
            const unwrapped = unwrapStatementLikeNode(child);
            if (!isRelevantDefinitionNode(unwrapped)) {
                return;
            }
            const mapped = mapStatementNode(unwrapped, source, state);
            if (mapped) {
                defs.push(mapped);
            }
        }
    });
    return defs;
}
export function collectContextDefinitions(source) {
    if (source.length === 0) {
        return [];
    }
    const tree = parseSyntax(source);
    const state = { nextStatementIndex: 0 };
    const collected = collectPriorDefinitions(tree, source, source.length, state);
    const parserMacros = collected.filter(isMacroContextStatement);
    const parserColorDefs = collected.filter(isColorContextStatement);
    const parserNonMacros = collected.filter((statement) => !isMacroContextStatement(statement) && !isColorContextStatement(statement));
    const scopedMacros = collectScopedMacroDefinitionsFromStream(source, parserMacros);
    const scopedColorDefs = collectScopedColorDefinitionsFromStream(source, parserColorDefs);
    const merged = [...parserNonMacros, ...scopedMacros, ...scopedColorDefs];
    const deduped = new Map();
    for (const statement of merged) {
        deduped.set(`${statement.span.from}:${statement.span.to}:${statement.kind}`, statement);
    }
    const dedupedValues = [...deduped.values()];
    dedupedValues.sort((left, right) => {
        if (left.span.from !== right.span.from) {
            return left.span.from - right.span.from;
        }
        return left.span.to - right.span.to;
    });
    return dedupedValues;
}
function collectParsedFigureNodesBySpan(tree) {
    const nodes = new Map();
    walk(tree.topNode, (node) => {
        if (node.type.name === "TikzEnvironment") {
            nodes.set(spanKey(node), node);
        }
    });
    return nodes;
}
function spanKey(span) {
    return `${span.from}:${span.to}`;
}
function resolveActiveSyntaxNode(source, activeFigureEntry) {
    if (activeFigureEntry.node) {
        return { node: activeFigureEntry.node, parseSource: source };
    }
    const maskedSource = maskSourceToFigure(source, activeFigureEntry.inventory.span.from, activeFigureEntry.inventory.span.to);
    const tree = parseSyntax(maskedSource);
    const node = findFirstNodeByName(tree.topNode, "TikzEnvironment");
    if (!node) {
        return null;
    }
    return {
        node,
        parseSource: maskedSource
    };
}
function maskSourceToFigure(source, from, to) {
    const safeFrom = Math.max(0, Math.min(source.length, from));
    const safeTo = Math.max(safeFrom, Math.min(source.length, to));
    const prefix = source
        .slice(0, safeFrom)
        .replace(/[^\n]/g, " ");
    const figure = source.slice(safeFrom, safeTo);
    return `${prefix}${figure}`;
}
function scanFigureInventories(source, scannedFigures) {
    const figures = [];
    const scanned = scannedFigures ?? scanTikzFigures(source);
    let lineStarts = null;
    for (const figure of scanned) {
        if (figure.isTemplate) {
            continue;
        }
        lineStarts ??= buildLineStarts(source);
        const beginFrom = figure.beginSpan.from;
        const beginTo = figure.beginSpan.to;
        const endFrom = figure.endSpan.from;
        const endTo = figure.endSpan.to;
        const optionsSpan = scanFigureOptionsSpan(source, beginTo, endFrom);
        figures.push({
            span: { from: beginFrom, to: endTo },
            beginSpan: { from: beginFrom, to: beginTo },
            endSpan: { from: endFrom, to: endTo },
            optionsSpan,
            startLine: lineForOffset(beginFrom, lineStarts),
            endLine: lineForOffset(Math.max(beginFrom, endTo - 1), lineStarts)
        });
    }
    return figures;
}
function scanFigureOptionsSpan(source, cursor, figureEnd) {
    let index = cursor;
    while (index < figureEnd && /\s/u.test(source[index] ?? "")) {
        index += 1;
    }
    if ((source[index] ?? "") !== "[") {
        return undefined;
    }
    let depth = 0;
    for (let i = index; i < figureEnd; i += 1) {
        const ch = source[i] ?? "";
        if (ch === "[") {
            depth += 1;
            continue;
        }
        if (ch === "]") {
            depth -= 1;
            if (depth === 0) {
                return { from: index, to: i + 1 };
            }
        }
    }
    return undefined;
}
function collectRelevantStatementsFromNode(node, source, state) {
    const statements = [];
    forEachChild(node, (child) => {
        const unwrapped = unwrapStatementLikeNode(child);
        if (!isRelevantDefinitionNode(unwrapped)) {
            return;
        }
        const mapped = mapStatementNode(unwrapped, source, state);
        if (mapped) {
            statements.push(mapped);
        }
    });
    return statements;
}
function isRelevantDefinitionNode(node) {
    const typeName = node.type.name;
    if (typeName === "MacroDefinitionStatement" ||
        typeName === "MacroAliasStatement" ||
        typeName === "MacroCommandDefinitionStatement" ||
        typeName === "PgfMathStatement" ||
        typeName === "StyleDefinitionStatement" ||
        typeName === "TikzSetStatement" ||
        typeName === "TikzStyleStatement" ||
        typeName === "PgfkeysStatement" ||
        typeName === "TikzLibraryStatement" ||
        typeName === "ColorletStatement" ||
        typeName === "DefineColorStatement" ||
        typeName === "FontSizeStatement") {
        return true;
    }
    return false;
}
function findBeginDocumentOffset(source) {
    const match = /\\begin\s*\{\s*document\s*\}/.exec(source);
    if (!match) {
        return source.length;
    }
    return match.index;
}
function isMacroContextStatement(statement) {
    return (statement.kind === "MacroDefinition" ||
        statement.kind === "MacroAlias" ||
        statement.kind === "MacroCommandDefinition");
}
function isColorContextStatement(statement) {
    return statement.kind === "Colorlet" || statement.kind === "DefineColor";
}
function collectScopedMacroDefinitionsFromStream(source, parserMacros) {
    const parserBySpan = new Map();
    for (const statement of parserMacros) {
        parserBySpan.set(`${statement.span.from}:${statement.span.to}`, statement);
    }
    const scopes = [{ statements: [] }];
    let nextStatementIndex = parserMacros.length;
    let cursor = 0;
    while (cursor < source.length) {
        const char = source[cursor] ?? "";
        if (char === "%") {
            cursor = skipComment(source, cursor);
            continue;
        }
        if (char === "\\") {
            const command = readControlSequence(source, cursor);
            if (!command) {
                cursor += 1;
                continue;
            }
            cursor = command.to;
            const commandName = command.raw;
            if (commandName === "\\begingroup" || commandName === "\\bgroup") {
                scopes.push({ statements: [] });
                continue;
            }
            if (commandName === "\\endgroup" || commandName === "\\egroup") {
                if (scopes.length > 1) {
                    scopes.pop();
                }
                continue;
            }
            if (commandName === "\\begin" || commandName === "\\end") {
                const argCursor = skipWhitespaceAndComments(source, cursor);
                const envGroup = readBalancedDelimited(source, argCursor, "{", "}");
                if (envGroup) {
                    cursor = envGroup.to;
                    if (commandName === "\\begin") {
                        scopes.push({ statements: [] });
                    }
                    else if (scopes.length > 1) {
                        scopes.pop();
                    }
                }
                continue;
            }
            if (commandName === "\\def") {
                const parsed = tryParseDefStatement(source, command.from, cursor, nextStatementIndex);
                if (parsed) {
                    cursor = parsed.to;
                    nextStatementIndex += 1;
                    const key = `${parsed.statement.span.from}:${parsed.statement.span.to}`;
                    scopes[scopes.length - 1]?.statements.push(parserBySpan.get(key) ?? parsed.statement);
                }
                continue;
            }
            if (commandName === "\\let") {
                const parsed = tryParseLetStatement(source, command.from, cursor, nextStatementIndex);
                if (parsed) {
                    cursor = parsed.to;
                    nextStatementIndex += 1;
                    const key = `${parsed.statement.span.from}:${parsed.statement.span.to}`;
                    scopes[scopes.length - 1]?.statements.push(parserBySpan.get(key) ?? parsed.statement);
                }
                continue;
            }
            if (isMacroCommandDefinitionName(commandName)) {
                const parsed = tryParseNewCommandStatement(source, commandName, command.from, cursor, nextStatementIndex);
                if (parsed) {
                    cursor = parsed.to;
                    nextStatementIndex += 1;
                    const key = `${parsed.statement.span.from}:${parsed.statement.span.to}`;
                    scopes[scopes.length - 1]?.statements.push(parserBySpan.get(key) ?? parsed.statement);
                }
                continue;
            }
            continue;
        }
        if (char === "{") {
            scopes.push({ statements: [] });
            cursor += 1;
            continue;
        }
        if (char === "}") {
            if (scopes.length > 1) {
                scopes.pop();
            }
            cursor += 1;
            continue;
        }
        cursor += 1;
    }
    const visible = [];
    for (const scope of scopes) {
        visible.push(...scope.statements);
    }
    visible.sort((left, right) => {
        if (left.span.from !== right.span.from) {
            return left.span.from - right.span.from;
        }
        return left.span.to - right.span.to;
    });
    return visible;
}
function tryParseDefStatement(source, commandFrom, fromCursor, statementIndex) {
    let cursor = skipWhitespaceAndComments(source, fromCursor);
    const nameToken = readControlSequence(source, cursor);
    if (!nameToken) {
        return null;
    }
    cursor = skipWhitespaceAndComments(source, nameToken.to);
    const valueGroup = readBalancedDelimited(source, cursor, "{", "}");
    if (!valueGroup) {
        return null;
    }
    const spanTo = valueGroup.to;
    return {
        statement: {
            kind: "MacroDefinition",
            id: macroDefinitionStatementId(statementIndex),
            span: { from: commandFrom, to: spanTo },
            raw: source.slice(commandFrom, spanTo),
            commandRaw: "\\def",
            nameRaw: nameToken.raw,
            nameSpan: { from: nameToken.from, to: nameToken.to },
            valueRaw: valueGroup.content,
            valueSpan: { from: valueGroup.from + 1, to: valueGroup.to - 1 }
        },
        to: spanTo
    };
}
function tryParseLetStatement(source, commandFrom, fromCursor, statementIndex) {
    let cursor = skipWhitespaceAndComments(source, fromCursor);
    const nameToken = readControlSequence(source, cursor);
    if (!nameToken) {
        return null;
    }
    cursor = skipWhitespaceAndComments(source, nameToken.to);
    if ((source[cursor] ?? "") === "=") {
        cursor += 1;
    }
    cursor = skipWhitespaceAndComments(source, cursor);
    let targetSpan;
    const targetControl = readControlSequence(source, cursor);
    let targetRaw;
    if (targetControl) {
        targetRaw = targetControl.raw;
        targetSpan = { from: targetControl.from, to: targetControl.to };
        cursor = targetControl.to;
    }
    else {
        const targetGroup = readBalancedDelimited(source, cursor, "{", "}");
        if (!targetGroup) {
            return null;
        }
        targetRaw = targetGroup.content;
        targetSpan = { from: targetGroup.from + 1, to: targetGroup.to - 1 };
        cursor = targetGroup.to;
    }
    return {
        statement: {
            kind: "MacroAlias",
            id: macroAliasStatementId(statementIndex),
            span: { from: commandFrom, to: cursor },
            raw: source.slice(commandFrom, cursor),
            commandRaw: "\\let",
            nameRaw: nameToken.raw,
            nameSpan: { from: nameToken.from, to: nameToken.to },
            targetRaw,
            targetSpan
        },
        to: cursor
    };
}
function tryParseNewCommandStatement(source, commandRaw, commandFrom, fromCursor, statementIndex) {
    let cursor = skipWhitespaceAndComments(source, fromCursor);
    let starred = false;
    if ((source[cursor] ?? "") === "*") {
        starred = true;
        cursor += 1;
    }
    cursor = skipWhitespaceAndComments(source, cursor);
    let nameSpan;
    const directName = readControlSequence(source, cursor);
    let nameRaw;
    if (directName) {
        nameRaw = directName.raw;
        nameSpan = { from: directName.from, to: directName.to };
        cursor = directName.to;
    }
    else {
        const nameGroup = readBalancedDelimited(source, cursor, "{", "}");
        if (!nameGroup) {
            return null;
        }
        const parsedName = /\\(?:[A-Za-z@]+|.)/u.exec(nameGroup.content);
        if (!parsedName) {
            return null;
        }
        const nameFrom = (nameGroup.from + 1) + (parsedName.index ?? 0);
        nameRaw = parsedName[0];
        nameSpan = { from: nameFrom, to: nameFrom + nameRaw.length };
        cursor = nameGroup.to;
    }
    let arity = 0;
    let aritySpan;
    let optionalDefaultRaw;
    let optionalDefaultSpan;
    if (commandRaw !== "\\DeclareMathOperator") {
        cursor = skipWhitespaceAndComments(source, cursor);
        const arityGroup = readBalancedDelimited(source, cursor, "[", "]");
        if (arityGroup && /^\d+$/u.test(arityGroup.content.trim())) {
            arity = Number.parseInt(arityGroup.content.trim(), 10);
            aritySpan = { from: arityGroup.from + 1, to: arityGroup.to - 1 };
            cursor = arityGroup.to;
        }
        cursor = skipWhitespaceAndComments(source, cursor);
        const optionalGroup = readBalancedDelimited(source, cursor, "[", "]");
        if (optionalGroup) {
            optionalDefaultRaw = optionalGroup.content;
            optionalDefaultSpan = { from: optionalGroup.from + 1, to: optionalGroup.to - 1 };
            cursor = optionalGroup.to;
        }
    }
    cursor = skipWhitespaceAndComments(source, cursor);
    const bodyGroup = readBalancedDelimited(source, cursor, "{", "}");
    if (!bodyGroup) {
        return null;
    }
    cursor = bodyGroup.to;
    return {
        statement: {
            kind: "MacroCommandDefinition",
            id: macroCommandDefinitionStatementId(statementIndex),
            span: { from: commandFrom, to: cursor },
            raw: source.slice(commandFrom, cursor),
            commandRaw,
            nameRaw,
            nameSpan,
            arity,
            aritySpan,
            optionalDefaultRaw,
            optionalDefaultSpan,
            bodyRaw: commandRaw === "\\DeclareMathOperator"
                ? `${starred ? "\\operatorname*" : "\\operatorname"}{${bodyGroup.content}}`
                : bodyGroup.content,
            bodySpan: { from: bodyGroup.from + 1, to: bodyGroup.to - 1 },
            starred
        },
        to: cursor
    };
}
function isMacroCommandDefinitionName(commandName) {
    return (commandName === "\\newcommand" ||
        commandName === "\\renewcommand" ||
        commandName === "\\providecommand" ||
        commandName === "\\DeclareRobustCommand" ||
        commandName === "\\DeclareMathOperator");
}
function collectScopedColorDefinitionsFromStream(source, parserColorDefs) {
    const parserBySpan = new Map();
    for (const statement of parserColorDefs) {
        parserBySpan.set(`${statement.span.from}:${statement.span.to}`, statement);
    }
    const scopes = [{ statements: [] }];
    let nextStatementIndex = parserColorDefs.length;
    let cursor = 0;
    while (cursor < source.length) {
        const char = source[cursor] ?? "";
        if (char === "%") {
            cursor = skipComment(source, cursor);
            continue;
        }
        if (char === "\\") {
            const command = readControlSequence(source, cursor);
            if (!command) {
                cursor += 1;
                continue;
            }
            cursor = command.to;
            const commandName = command.raw;
            if (commandName === "\\begingroup" || commandName === "\\bgroup") {
                scopes.push({ statements: [] });
                continue;
            }
            if (commandName === "\\endgroup" || commandName === "\\egroup") {
                if (scopes.length > 1) {
                    scopes.pop();
                }
                continue;
            }
            if (commandName === "\\begin" || commandName === "\\end") {
                const argCursor = skipWhitespaceAndComments(source, cursor);
                const envGroup = readBalancedDelimited(source, argCursor, "{", "}");
                if (envGroup) {
                    cursor = envGroup.to;
                    if (commandName === "\\begin") {
                        scopes.push({ statements: [] });
                    }
                    else if (scopes.length > 1) {
                        scopes.pop();
                    }
                }
                continue;
            }
            if (commandName === "\\colorlet") {
                const parsed = tryParseColorletStatement(source, command.from, cursor, nextStatementIndex);
                if (parsed) {
                    cursor = parsed.to;
                    nextStatementIndex += 1;
                    const key = `${parsed.statement.span.from}:${parsed.statement.span.to}`;
                    scopes[scopes.length - 1]?.statements.push(parserBySpan.get(key) ?? parsed.statement);
                }
                continue;
            }
            if (commandName === "\\definecolor") {
                const parsed = tryParseDefineColorStatement(source, command.from, cursor, nextStatementIndex);
                if (parsed) {
                    cursor = parsed.to;
                    nextStatementIndex += 1;
                    const key = `${parsed.statement.span.from}:${parsed.statement.span.to}`;
                    scopes[scopes.length - 1]?.statements.push(parserBySpan.get(key) ?? parsed.statement);
                }
                continue;
            }
            continue;
        }
        if (char === "{") {
            scopes.push({ statements: [] });
            cursor += 1;
            continue;
        }
        if (char === "}") {
            if (scopes.length > 1) {
                scopes.pop();
            }
            cursor += 1;
            continue;
        }
        cursor += 1;
    }
    const visible = [];
    for (const scope of scopes) {
        visible.push(...scope.statements);
    }
    visible.sort((left, right) => {
        if (left.span.from !== right.span.from) {
            return left.span.from - right.span.from;
        }
        return left.span.to - right.span.to;
    });
    return visible;
}
function tryParseColorletStatement(source, commandFrom, fromCursor, statementIndex) {
    let cursor = skipWhitespaceAndComments(source, fromCursor);
    const nameGroup = readBalancedDelimited(source, cursor, "{", "}");
    if (!nameGroup) {
        return null;
    }
    cursor = skipWhitespaceAndComments(source, nameGroup.to);
    const valueGroup = readBalancedDelimited(source, cursor, "{", "}");
    if (!valueGroup) {
        return null;
    }
    cursor = valueGroup.to;
    return {
        statement: {
            kind: "Colorlet",
            id: colorletStatementId(statementIndex),
            span: { from: commandFrom, to: cursor },
            raw: source.slice(commandFrom, cursor),
            commandRaw: "\\colorlet",
            nameRaw: nameGroup.content,
            nameSpan: { from: nameGroup.from + 1, to: nameGroup.to - 1 },
            valueRaw: valueGroup.content,
            valueSpan: { from: valueGroup.from + 1, to: valueGroup.to - 1 }
        },
        to: cursor
    };
}
function tryParseDefineColorStatement(source, commandFrom, fromCursor, statementIndex) {
    let cursor = skipWhitespaceAndComments(source, fromCursor);
    const nameGroup = readBalancedDelimited(source, cursor, "{", "}");
    if (!nameGroup) {
        return null;
    }
    cursor = skipWhitespaceAndComments(source, nameGroup.to);
    const modelGroup = readBalancedDelimited(source, cursor, "{", "}");
    if (!modelGroup) {
        return null;
    }
    cursor = skipWhitespaceAndComments(source, modelGroup.to);
    const specificationGroup = readBalancedDelimited(source, cursor, "{", "}");
    if (!specificationGroup) {
        return null;
    }
    cursor = specificationGroup.to;
    return {
        statement: {
            kind: "DefineColor",
            id: defineColorStatementId(statementIndex),
            span: { from: commandFrom, to: cursor },
            raw: source.slice(commandFrom, cursor),
            commandRaw: "\\definecolor",
            nameRaw: nameGroup.content,
            nameSpan: { from: nameGroup.from + 1, to: nameGroup.to - 1 },
            modelRaw: modelGroup.content,
            modelSpan: { from: modelGroup.from + 1, to: modelGroup.to - 1 },
            specificationRaw: specificationGroup.content,
            specificationSpan: { from: specificationGroup.from + 1, to: specificationGroup.to - 1 }
        },
        to: cursor
    };
}
function skipWhitespaceAndComments(source, from) {
    let cursor = from;
    while (cursor < source.length) {
        const char = source[cursor] ?? "";
        if (/\s/u.test(char)) {
            cursor += 1;
            continue;
        }
        if (char === "%") {
            cursor = skipComment(source, cursor);
            continue;
        }
        break;
    }
    return cursor;
}
function skipComment(source, from) {
    let cursor = from;
    while (cursor < source.length) {
        const char = source[cursor] ?? "";
        cursor += 1;
        if (char === "\n" || char === "\r") {
            break;
        }
    }
    return cursor;
}
function readControlSequence(source, from) {
    if ((source[from] ?? "") !== "\\") {
        return null;
    }
    let cursor = from + 1;
    while (cursor < source.length && /[A-Za-z@]/u.test(source[cursor] ?? "")) {
        cursor += 1;
    }
    if (cursor === from + 1) {
        cursor = Math.min(source.length, from + 2);
    }
    return {
        from,
        to: cursor,
        raw: source.slice(from, cursor)
    };
}
function readBalancedDelimited(source, from, openChar, closeChar) {
    if ((source[from] ?? "") !== openChar) {
        return null;
    }
    let depth = 0;
    let cursor = from;
    while (cursor < source.length) {
        const char = source[cursor] ?? "";
        if (char === "%") {
            cursor = skipComment(source, cursor);
            continue;
        }
        if (char === "\\") {
            cursor += 2;
            continue;
        }
        if (char === openChar) {
            depth += 1;
            cursor += 1;
            continue;
        }
        if (char === closeChar) {
            depth -= 1;
            cursor += 1;
            if (depth === 0) {
                return {
                    from,
                    to: cursor,
                    content: source.slice(from + 1, cursor - 1)
                };
            }
            continue;
        }
        cursor += 1;
    }
    return null;
}
