import type { EditActionResultLike } from "../result-types.js";
import type { EditParseOptions } from "../parse-options.js";
export type AddMatrixRowAction = {
    matrixSourceId: string;
    rowIndex: number;
};
export type RemoveMatrixRowAction = {
    matrixSourceId: string;
    rowIndex: number;
};
export type AddMatrixColumnAction = {
    matrixSourceId: string;
    columnIndex: number;
};
export type RemoveMatrixColumnAction = {
    matrixSourceId: string;
    columnIndex: number;
};
export type TransposeMatrixAction = {
    matrixSourceId: string;
};
export declare function applyAddMatrixRowAction(source: string, action: AddMatrixRowAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyRemoveMatrixRowAction(source: string, action: RemoveMatrixRowAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyAddMatrixColumnAction(source: string, action: AddMatrixColumnAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyRemoveMatrixColumnAction(source: string, action: RemoveMatrixColumnAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyTransposeMatrixAction(source: string, action: TransposeMatrixAction, parseOptions?: EditParseOptions): EditActionResultLike;
