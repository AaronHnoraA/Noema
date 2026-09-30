import type { WorldBounds, WorldPoint } from "../coords/points.js";
export type AlignMode = "left" | "center" | "right" | "top" | "middle" | "bottom";
export type DistributeAxis = "horizontal" | "vertical";
export type SourceBounds = WorldBounds & {
    sourceId: string;
};
export type ArrangePlanResult = {
    kind: "success";
    deltas: Map<string, WorldPoint>;
} | {
    kind: "unsupported";
    reason: string;
};
export declare function planAlignDeltas(boundsBySource: ReadonlyMap<string, WorldBounds>, selectedSourceIds: readonly string[], mode: AlignMode, epsilon?: number): ArrangePlanResult;
export declare function planDistributeDeltas(boundsBySource: ReadonlyMap<string, WorldBounds>, selectedSourceIds: readonly string[], axis: DistributeAxis, epsilon?: number): ArrangePlanResult;
