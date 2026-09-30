import type { PathStatement, Statement } from "../ast/types.js";
export declare function findPathStatementById(statements: readonly Statement[], sourceId: string): PathStatement | null;
export declare function normalizeNonEmptyUniqueStrings(values: readonly unknown[]): string[];
export declare const normalizeElementIds: typeof normalizeNonEmptyUniqueStrings;
export declare const uniqueStrings: typeof normalizeNonEmptyUniqueStrings;
