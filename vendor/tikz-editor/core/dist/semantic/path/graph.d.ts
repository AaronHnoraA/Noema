import type { GraphOperationItem, Span } from "../../ast/types.js";
import type { OptionListAst } from "../../options/types.js";
import { type WorldPoint } from "../../coords/points.js";
declare const CONNECTOR_OPERATORS: readonly ["<->", "-!-", "->", "<-", "--"];
type ConnectorOperator = (typeof CONNECTOR_OPERATORS)[number];
type GraphPlacementMode = "none" | "cartesian" | "grid" | "circular";
type GraphVector2 = {
    x: number;
    y: number;
};
export type GraphPlacementHint = {
    mode: GraphPlacementMode;
    logicalWidth: number;
    logicalDepth: number;
    level: number;
    chainShift: GraphVector2;
    groupShift: GraphVector2;
    chainSepDistance: number | null;
    groupSepDistance: number | null;
};
export type GraphPlannedNode = {
    name: string;
    text: string;
    options?: OptionListAst;
    span: Span;
    defaultPoint: WorldPoint;
    placementHint?: GraphPlacementHint;
};
export type GraphPlannedEdgeNode = {
    text: string;
    options?: OptionListAst;
    span: Span;
};
export type GraphPlannedEdge = {
    from: string;
    to: string;
    fromAnchor?: string;
    toAnchor?: string;
    operator: ConnectorOperator;
    options?: OptionListAst;
    nodes?: GraphPlannedEdgeNode[];
    span: Span;
};
export type GraphPlan = {
    nodes: GraphPlannedNode[];
    edges: GraphPlannedEdge[];
    diagnostics: string[];
};
export declare function buildGraphPlan(operation: GraphOperationItem, existingNodeSets?: ReadonlyMap<string, ReadonlySet<string> | readonly string[]>): GraphPlan;
export {};
