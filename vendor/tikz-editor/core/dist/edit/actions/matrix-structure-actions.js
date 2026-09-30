import { replaceSpan } from "../patch.js";
import { resolvePropertyTarget } from "../property-target.js";
import { parseMatrixRowsForEdit, resolveMatrixMode } from "../../semantic/nodes/matrix.js";
export function applyAddMatrixRowAction(source, action, parseOptions = {}) {
    const target = resolveMatrixStructureTarget(source, action.matrixSourceId, parseOptions);
    if (target.kind !== "ok") {
        return target;
    }
    const { rows, rowCount, colCount } = parseMatrixGrid(target.value);
    if (!Number.isInteger(action.rowIndex) || action.rowIndex < 1 || action.rowIndex > rowCount + 1) {
        return { kind: "unsupported", reason: `addMatrixRow rowIndex must be in 1..${rowCount + 1}.` };
    }
    rows.splice(action.rowIndex - 1, 0, Array.from({ length: colCount }).fill(""));
    return rewriteMatrixText(source, target.value.matrixTextSpan, serializeMatrixRows(rows, target.value.cellSeparator), [
        action.matrixSourceId
    ]);
}
export function applyRemoveMatrixRowAction(source, action, parseOptions = {}) {
    const target = resolveMatrixStructureTarget(source, action.matrixSourceId, parseOptions);
    if (target.kind !== "ok") {
        return target;
    }
    const { rows, rowCount } = parseMatrixGrid(target.value);
    if (rowCount <= 1) {
        return { kind: "unsupported", reason: "Cannot remove the last matrix row." };
    }
    if (!Number.isInteger(action.rowIndex) || action.rowIndex < 1 || action.rowIndex > rowCount) {
        return { kind: "unsupported", reason: `removeMatrixRow rowIndex must be in 1..${rowCount}.` };
    }
    rows.splice(action.rowIndex - 1, 1);
    return rewriteMatrixText(source, target.value.matrixTextSpan, serializeMatrixRows(rows, target.value.cellSeparator), [
        action.matrixSourceId
    ]);
}
export function applyAddMatrixColumnAction(source, action, parseOptions = {}) {
    const target = resolveMatrixStructureTarget(source, action.matrixSourceId, parseOptions);
    if (target.kind !== "ok") {
        return target;
    }
    const { rows, colCount } = parseMatrixGrid(target.value);
    if (!Number.isInteger(action.columnIndex) || action.columnIndex < 1 || action.columnIndex > colCount + 1) {
        return { kind: "unsupported", reason: `addMatrixColumn columnIndex must be in 1..${colCount + 1}.` };
    }
    for (const row of rows) {
        row.splice(action.columnIndex - 1, 0, "");
    }
    return rewriteMatrixText(source, target.value.matrixTextSpan, serializeMatrixRows(rows, target.value.cellSeparator), [
        action.matrixSourceId
    ]);
}
export function applyRemoveMatrixColumnAction(source, action, parseOptions = {}) {
    const target = resolveMatrixStructureTarget(source, action.matrixSourceId, parseOptions);
    if (target.kind !== "ok") {
        return target;
    }
    const { rows, colCount } = parseMatrixGrid(target.value);
    if (colCount <= 1) {
        return { kind: "unsupported", reason: "Cannot remove the last matrix column." };
    }
    if (!Number.isInteger(action.columnIndex) || action.columnIndex < 1 || action.columnIndex > colCount) {
        return { kind: "unsupported", reason: `removeMatrixColumn columnIndex must be in 1..${colCount}.` };
    }
    for (const row of rows) {
        row.splice(action.columnIndex - 1, 1);
    }
    return rewriteMatrixText(source, target.value.matrixTextSpan, serializeMatrixRows(rows, target.value.cellSeparator), [
        action.matrixSourceId
    ]);
}
export function applyTransposeMatrixAction(source, action, parseOptions = {}) {
    const target = resolveMatrixStructureTarget(source, action.matrixSourceId, parseOptions);
    if (target.kind !== "ok") {
        return target;
    }
    const { rows, rowCount, colCount } = parseMatrixGrid(target.value);
    const transposed = [];
    for (let column = 0; column < colCount; column += 1) {
        const nextRow = [];
        for (let row = 0; row < rowCount; row += 1) {
            nextRow.push(rows[row][column]);
        }
        transposed.push(trimTrailingEmptyCells(nextRow));
    }
    return rewriteMatrixText(source, target.value.matrixTextSpan, serializeMatrixRows(transposed, target.value.cellSeparator), [
        action.matrixSourceId
    ]);
}
function resolveMatrixStructureTarget(source, matrixSourceId, parseOptions) {
    const resolved = resolvePropertyTarget(source, matrixSourceId, parseOptions);
    if (resolved.kind === "not-found" || resolved.target.kind !== "matrix-statement") {
        return { kind: "unsupported", reason: `Could not resolve matrix statement ${matrixSourceId}.` };
    }
    const matrixTextSpan = resolved.target.matrixTextSpan;
    if (!matrixTextSpan || matrixTextSpan.to <= matrixTextSpan.from) {
        return { kind: "unsupported", reason: "Matrix text span is unavailable for structural editing." };
    }
    const mode = resolveMatrixMode(resolved.target.options);
    if (!mode.enabled) {
        return { kind: "unsupported", reason: "Matrix structural actions require a matrix statement target." };
    }
    return {
        kind: "ok",
        value: {
            matrixSourceId,
            matrixText: source.slice(matrixTextSpan.from, matrixTextSpan.to),
            matrixTextSpan,
            cellSeparator: mode.cellSeparator
        }
    };
}
function parseMatrixGrid(target) {
    const parsed = parseMatrixRowsForEdit(target.matrixText, target.cellSeparator, target.matrixTextSpan.from);
    const rowCount = Math.max(1, parsed.rows.length);
    const colCount = Math.max(1, parsed.rows.reduce((max, row) => Math.max(max, row.cells.length), 0));
    const rows = parsed.rows.map((row) => {
        const values = row.cells.map((cell) => cell.raw);
        while (values.length < colCount) {
            values.push("");
        }
        return values;
    });
    while (rows.length < rowCount) {
        rows.push(Array.from({ length: colCount }).fill(""));
    }
    return { rows, rowCount, colCount };
}
function trimTrailingEmptyCells(row) {
    let lastNonEmpty = -1;
    for (let index = row.length - 1; index >= 0; index -= 1) {
        if ((row[index] ?? "").trim().length > 0) {
            lastNonEmpty = index;
            break;
        }
    }
    if (lastNonEmpty < 0) {
        return [""];
    }
    return row.slice(0, lastNonEmpty + 1);
}
function serializeMatrixRows(rows, separator) {
    const joiner = ` ${separator} `;
    return rows
        .map((row) => [...row].join(joiner))
        .join(" \\\\\n");
}
function rewriteMatrixText(source, matrixTextSpan, replacement, changedSourceIds) {
    const updated = replaceSpan(source, matrixTextSpan, replacement);
    if (updated.source === source) {
        return { kind: "unsupported", reason: "Matrix structural edit would not change the source." };
    }
    return {
        kind: "success",
        newSource: updated.source,
        patches: [
            {
                oldSpan: matrixTextSpan,
                newSpan: updated.changedSpan,
                replacement
            }
        ],
        changedSourceIds
    };
}
