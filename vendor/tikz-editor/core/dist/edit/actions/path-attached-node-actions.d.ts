import type { EditActionResultLike } from "../result-types.js";
import { type DragFormatPrecision } from "../format.js";
import type { EditParseOptions } from "../parse-options.js";
import type { WorldPoint } from "../../coords/points.js";
import type { PathAttachedNodePlacementRegime } from "../../semantic/types.js";
export declare const PATH_ATTACHED_NODE_EDIT_NOOP_REASON = "Path-attached node edit would not change the source.";
export type MovePathAttachedNodeAction = {
    kind: "movePathAttachedNode";
    nodeId: string;
    hostPathSourceId: string;
    segmentLocator?: string;
    pos: number;
    preserveRegime: true;
    sideUpdate?: {
        kind: "explicit-direction";
        direction: string;
    } | {
        kind: "auto-side";
        side: "left" | "right";
    };
    distanceUpdatePt?: number;
    formatPrecision?: DragFormatPrecision;
};
type PathAttachedNodeInspectorAction = {
    elementId: string;
    key: string;
    value: string;
};
export declare function applyMovePathAttachedNodeAction(source: string, action: MovePathAttachedNodeAction, parseOptions?: EditParseOptions): EditActionResultLike;
export declare function applyPathAttachedNodeInspectorAction(source: string, action: PathAttachedNodeInspectorAction, parseOptions?: EditParseOptions): EditActionResultLike | null;
export declare function resolveDraggedPathAttachedNodeDirection(anchorWorldPoint: WorldPoint, desiredCenter: WorldPoint, regime: Extract<PathAttachedNodePlacementRegime, {
    kind: "explicit-direction";
}>): string;
export {};
