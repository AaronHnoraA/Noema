import { parseTikz } from "../parser/index.js";
import { evaluateTikzFigure } from "../semantic/evaluate.js";
export const STANDALONE_LATEX_EXPORT_MIME_TYPE = "application/x-tex;charset=utf-8";
export const DEFAULT_STANDALONE_LATEX_EXPORT_FILE_NAME = "tikz-export.tex";
function normalizeDocumentClassOptions(options = []) {
    const unique = new Set();
    for (const option of options) {
        const normalized = option.trim();
        if (normalized.length > 0) {
            unique.add(normalized);
        }
    }
    return [...unique];
}
export function normalizeStandaloneLatexExportFileName(fileName) {
    const candidate = fileName?.trim();
    if (!candidate) {
        return DEFAULT_STANDALONE_LATEX_EXPORT_FILE_NAME;
    }
    if (/\.tex$/i.test(candidate)) {
        return candidate;
    }
    return `${candidate}.tex`;
}
function isDefinitionStatement(statement) {
    return (statement.kind === "MacroDefinition" ||
        statement.kind === "MacroAlias" ||
        statement.kind === "MacroCommandDefinition" ||
        statement.kind === "Colorlet" ||
        statement.kind === "DefineColor" ||
        statement.kind === "TikzSet" ||
        statement.kind === "TikzStyle" ||
        statement.kind === "Pgfkeys" ||
        statement.kind === "TikzLibrary");
}
function collectStatementById(statements) {
    const byId = new Map();
    const visit = (entries) => {
        for (const statement of entries) {
            byId.set(statement.id, statement);
            if (statement.kind === "Scope") {
                visit(statement.body);
            }
        }
    };
    visit(statements);
    return byId;
}
function collectUsedSourceIds(semantic) {
    const used = new Set();
    for (const element of semantic.scene.elements) {
        used.add(element.sourceRef.sourceId);
        if (element.origin?.macroStack) {
            for (const macroOrigin of element.origin.macroStack) {
                used.add(macroOrigin.definitionId);
            }
        }
        for (const styleLayer of element.styleChain) {
            if (styleLayer.sourceRef?.sourceId) {
                used.add(styleLayer.sourceRef.sourceId);
            }
        }
    }
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of semantic.symbolDependencyEdges) {
            if (!used.has(edge.consumerStatementId)) {
                continue;
            }
            if (used.has(edge.providerStatementId)) {
                continue;
            }
            used.add(edge.providerStatementId);
            changed = true;
        }
    }
    return used;
}
function collectDefinitionSpans(source, statements, usedIds) {
    const defs = [];
    for (const id of usedIds) {
        const statement = statements.get(id);
        if (!statement || !isDefinitionStatement(statement)) {
            continue;
        }
        defs.push({ from: statement.span.from, to: statement.span.to });
    }
    defs.sort((left, right) => (left.from !== right.from ? left.from - right.from : left.to - right.to));
    const chunks = [];
    for (const span of defs) {
        const raw = source.slice(span.from, span.to).trim();
        if (raw.length === 0) {
            continue;
        }
        chunks.push(raw);
    }
    return chunks;
}
function collectMacroDefinitionClosure(figureSource, statements) {
    const byName = new Map();
    for (const statement of statements.values()) {
        if (statement.kind === "MacroDefinition" || statement.kind === "MacroAlias" || statement.kind === "MacroCommandDefinition") {
            const name = statement.nameRaw.trim();
            if (name.length > 0) {
                byName.set(name, statement);
            }
        }
    }
    const ids = new Set();
    const queue = [];
    const seenNames = new Set();
    const tokenRegex = /\\[A-Za-z@]+/g;
    const enqueueFromText = (raw) => {
        tokenRegex.lastIndex = 0;
        let match = tokenRegex.exec(raw);
        while (match) {
            queue.push(match[0]);
            match = tokenRegex.exec(raw);
        }
    };
    enqueueFromText(figureSource);
    while (queue.length > 0) {
        const name = queue.shift();
        if (!name || seenNames.has(name)) {
            continue;
        }
        seenNames.add(name);
        const statement = byName.get(name);
        if (!statement) {
            continue;
        }
        ids.add(statement.id);
        if (statement.kind === "MacroDefinition") {
            enqueueFromText(statement.valueRaw);
            continue;
        }
        if (statement.kind === "MacroAlias") {
            enqueueFromText(statement.targetRaw);
            continue;
        }
        enqueueFromText(statement.bodyRaw);
        if (statement.optionalDefaultRaw) {
            enqueueFromText(statement.optionalDefaultRaw);
        }
    }
    return ids;
}
function pickActiveFigureSource(source, parseResult) {
    if (!parseResult.activeFigureId) {
        return source.trim();
    }
    const entry = parseResult.figures.find((figure) => figure.id === parseResult.activeFigureId);
    if (!entry) {
        return source.trim();
    }
    return source.slice(entry.span.from, entry.span.to).trim();
}
function renderDiagnosticsCommentBlock(diagnostics) {
    if (diagnostics.length === 0) {
        return "";
    }
    const lines = ["% tikz-editor standalone export diagnostics:"];
    for (const diagnostic of diagnostics) {
        const symbolSuffix = diagnostic.symbolKind && diagnostic.symbolName
            ? ` [${diagnostic.symbolKind}:${diagnostic.symbolName}]`
            : "";
        lines.push(`% - (${diagnostic.severity}) ${diagnostic.code}: ${diagnostic.message}${symbolSuffix}`);
    }
    return `${lines.join("\n")}\n`;
}
function analyzeMinimalFigureDependencies(options) {
    const parseResult = parseTikz(options.source, {
        recover: true,
        activeFigureId: options.activeFigureId,
        includeContextDefinitions: true
    });
    const semanticResult = evaluateTikzFigure(parseResult.figure, parseResult.source);
    const diagnostics = [];
    for (const diagnostic of parseResult.diagnostics) {
        diagnostics.push({
            code: diagnostic.code ?? "parse-diagnostic",
            message: diagnostic.message,
            severity: diagnostic.severity,
            span: diagnostic.span
        });
    }
    for (const diagnostic of semanticResult.diagnostics) {
        diagnostics.push({
            code: diagnostic.code ?? "semantic-diagnostic",
            message: diagnostic.message,
            severity: diagnostic.severity,
            span: diagnostic.span
        });
    }
    for (const unresolved of semanticResult.unresolvedSymbols) {
        diagnostics.push({
            code: "unresolved-symbol",
            message: `Could not resolve ${unresolved.kind} '${unresolved.name}'.`,
            severity: "error",
            symbolKind: unresolved.kind,
            symbolName: unresolved.name
        });
    }
    const statementById = collectStatementById(parseResult.figure.body);
    const usedIds = collectUsedSourceIds(semanticResult);
    const figureSource = pickActiveFigureSource(options.source, parseResult);
    const macroClosure = collectMacroDefinitionClosure(figureSource, statementById);
    for (const id of macroClosure) {
        usedIds.add(id);
    }
    const definitionChunks = collectDefinitionSpans(options.source, statementById, usedIds);
    return {
        diagnostics,
        complete: !diagnostics.some((diagnostic) => diagnostic.severity === "error"),
        definitionChunks,
        figureSource,
        requiredLibraries: semanticResult.scene.requiredTikzLibraries
    };
}
function mergeDefinitionChunksWithInferredLibraries(definitionChunks, requiredLibraries) {
    if (requiredLibraries.length === 0) {
        return [...definitionChunks];
    }
    return [`\\usetikzlibrary{${requiredLibraries.join(",")}}`, ...definitionChunks];
}
export function createMinimalTikzSourceArtifact(options) {
    const analysis = analyzeMinimalFigureDependencies(options);
    const definitionChunks = mergeDefinitionChunksWithInferredLibraries(analysis.definitionChunks, analysis.requiredLibraries);
    const chunks = [...definitionChunks, analysis.figureSource].filter((chunk) => chunk.trim().length > 0);
    return {
        text: `${chunks.join("\n")}\n`,
        complete: analysis.complete,
        diagnostics: analysis.diagnostics,
        definitionCount: definitionChunks.length,
        activeFigureSource: analysis.figureSource
    };
}
export function createStandaloneLatexExportArtifact(options) {
    const analysis = analyzeMinimalFigureDependencies(options);
    const definitionChunks = analysis.definitionChunks;
    const classOptions = normalizeDocumentClassOptions(options.documentClassOptions);
    const classOptionsText = classOptions.length > 0 ? `[${classOptions.join(",")}]` : "";
    const requiredLibraries = analysis.requiredLibraries;
    const lines = [];
    lines.push(`\\documentclass${classOptionsText}{standalone}`);
    lines.push("\\usepackage{tikz}");
    if (requiredLibraries.length > 0) {
        lines.push(`\\usetikzlibrary{${requiredLibraries.join(",")}}`);
    }
    lines.push("\\begin{document}");
    if (definitionChunks.length > 0) {
        lines.push(definitionChunks.join("\n"));
    }
    lines.push(analysis.figureSource);
    lines.push("\\end{document}");
    const diagnosticsComment = renderDiagnosticsCommentBlock(analysis.diagnostics);
    const text = `${diagnosticsComment}${lines.join("\n")}\n`;
    return {
        fileName: normalizeStandaloneLatexExportFileName(options.fileName),
        mimeType: STANDALONE_LATEX_EXPORT_MIME_TYPE,
        text,
        complete: analysis.complete,
        diagnostics: analysis.diagnostics
    };
}
