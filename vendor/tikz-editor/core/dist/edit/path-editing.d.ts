import type { CoordinateItem, PathStatement } from "../ast/types.js";
import type { EditHandle } from "../semantic/types.js";
import { type EditParseOptions } from "./parse-options.js";
export type PathPointKind = "corner" | "smooth";
type ExplicitPathSegmentBase = {
    startAnchorIndex: number;
    endAnchorIndex: number;
    operatorIndex: number;
    targetIndex: number;
    raw: string;
    closesPath: boolean;
};
export type ExplicitPathSegment = (ExplicitPathSegmentBase & {
    kind: "line";
}) | (ExplicitPathSegmentBase & {
    kind: "cubic";
    control1Index: number;
    control2Index: number;
    usedAnd: boolean;
});
export type ExplicitPathAnchor = {
    index: number;
    coordinateIndex: number;
    item: CoordinateItem;
    raw: string;
};
export type ExplicitPathAnalysis = {
    statement: PathStatement;
    prefix: string;
    suffix: string;
    anchors: ExplicitPathAnchor[];
    segments: ExplicitPathSegment[];
    closed: boolean;
    closureKind: "line-cycle" | "curve-cycle" | null;
};
export type PathEditEligibility = {
    kind: "eligible";
    analysis: ExplicitPathAnalysis;
} | {
    kind: "ineligible";
    reason: string;
};
export type PathHandleResolution = {
    kind: "found";
    handle: EditHandle;
    anchorIndex: number;
} | {
    kind: "missing";
    reason: string;
};
export declare function resolveEligibleExplicitPath(source: string, elementId: string, parseOptions?: EditParseOptions): PathEditEligibility;
export declare function resolveActivePathPointHandle(editHandles: readonly EditHandle[], analysis: ExplicitPathAnalysis, handleId: string | null | undefined, source: string): PathHandleResolution;
export declare function resolvePathControlHandle(editHandles: readonly EditHandle[], sourceId: string, coordinate: CoordinateItem, source: string): EditHandle | null;
export declare function buildStatementText(source: string, analysis: ExplicitPathAnalysis, body: string): string;
export declare function buildPathBodyFromSegments(analysis: ExplicitPathAnalysis, source: string, startAnchorIndex: number, segmentIndices: readonly number[]): string;
export declare function analyzeExplicitPathStatement(source: string, statement: PathStatement): PathEditEligibility;
export {};
