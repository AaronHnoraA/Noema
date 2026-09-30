import type { EditHandle, EvaluateOptions } from "../semantic/types.js";
import type { WorldPoint, WorldBounds } from "../coords/points.js";
import type { SourcePatch } from "./types.js";
import { type DragFormatPrecision } from "./format.js";
import { type ElementTemplate } from "./element-templates.js";
import type { AlignMode, DistributeAxis } from "./arrange.js";
import type { PathPointKind } from "./path-editing.js";
import { type MovePathAttachedNodeAction } from "./actions/path-attached-node-actions.js";
import { type RotateElementAction } from "./actions/rotate-element.js";
import { PROPERTY_WRITE_CLEANUP_NOOP_REASON } from "./property-write-planner.js";
import { type ConvertNodePositionToAbsoluteAction, type PositionNodeRelativeToPreflight, type PositionNodeRelativeToAction } from "./actions/node-positioning-actions.js";
import { type EditParseOptions } from "./parse-options.js";
import type { SemanticPropertyId } from "./property-registry.js";
import { type FlattenForeachTarget } from "../foreach/flatten.js";
import { type SetFigureBoundsAction } from "./figure-bounds.js";
export type ResizeRole = "top-left" | "top-right" | "bottom-left" | "bottom-right" | "top" | "bottom" | "left" | "right";
export type StyleLevel = "command" | "scope" | "named-style" | "preamble";
export type { ElementTemplate } from "./element-templates.js";
export type ReorderDirection = "sendToBack" | "sendBackward" | "bringForward" | "bringToFront";
export { ADORNMENT_EDIT_NOOP_REASON } from "./actions/adornment-set-property.js";
export { PATH_ATTACHED_NODE_EDIT_NOOP_REASON } from "./actions/path-attached-node-actions.js";
export { PROPERTY_WRITE_CLEANUP_NOOP_REASON };
export type EditAction = {
    kind: "moveElement";
    elementId: string;
    delta: WorldPoint;
    formatPrecision?: DragFormatPrecision;
} | {
    kind: "moveElements";
    elementIds: string[];
    delta: WorldPoint;
    formatPrecision?: DragFormatPrecision;
} | {
    kind: "alignElements";
    elementIds: string[];
    mode: AlignMode;
} | {
    kind: "distributeElements";
    elementIds: string[];
    axis: DistributeAxis;
} | {
    kind: "moveHandle";
    handleId: string;
    newWorld: WorldPoint;
} | {
    kind: "connectHandle";
    handleId: string;
    nodeName: string;
    nodeSourceId?: string;
    anchor: string;
} | {
    kind: "splitPath";
    elementId: string;
    handleId: string;
} | {
    kind: "joinPaths";
    elementIds: [string, string];
} | {
    kind: "reversePath";
    elementId: string;
} | {
    kind: "toggleClosedPath";
    elementId: string;
    closed: boolean;
} | {
    kind: "deletePathPoint";
    elementId: string;
    handleId: string;
} | {
    kind: "setPathPointKind";
    elementId: string;
    handleId: string;
    pointKind: PathPointKind;
} | {
    kind: "appendToPath";
    elementId: string;
    end: "start" | "end";
    segmentSource: string;
} | {
    kind: "insertPathPoint";
    elementId: string;
    segmentIndex: number;
    point: WorldPoint;
} | {
    kind: "setProperty";
    elementId: string;
    level: StyleLevel;
    key: string;
    value: string;
    propertyId?: SemanticPropertyId;
    clearKeys?: string[];
    commentMode?: "disable" | "enable";
    commentSourceText?: string;
} | RotateElementAction | {
    kind: "updateNodeText";
    elementId: string;
    text: string;
} | SetFigureBoundsAction | {
    kind: "cleanupPropertyWrites";
    elementIds?: string[];
} | {
    kind: "addElement";
    template: ElementTemplate;
    at: WorldPoint;
} | {
    kind: "deleteElement";
    elementId: string;
} | {
    kind: "deleteElements";
    elementIds: string[];
} | {
    kind: "deleteAdornment";
    targetId: string;
} | {
    kind: "pasteStatements";
    snippets: string[];
    anchorElementId?: string;
    delta?: WorldPoint;
} | {
    kind: "duplicateElements";
    elementIds: string[];
    delta?: WorldPoint;
} | {
    kind: "duplicateAdornment";
    targetId: string;
} | {
    kind: "moveAdornment";
    targetId: string;
    ownerPoint: WorldPoint;
    newWorld: WorldPoint;
    angleRaw?: string;
    distancePt?: number;
    formatPrecision?: DragFormatPrecision;
} | MovePathAttachedNodeAction | {
    kind: "addNodeAdornment";
    nodeId: string;
    adornmentKind: "label" | "pin";
    angle: string;
    text: string;
} | PositionNodeRelativeToAction | ConvertNodePositionToAbsoluteAction | {
    kind: "reorderElements";
    elementIds: string[];
    direction: ReorderDirection;
} | {
    kind: "groupElements";
    elementIds: string[];
} | {
    kind: "ungroupElements";
    elementIds: string[];
} | {
    kind: "repeatElements";
    elementIds: string[];
    columns: number;
    rows: number;
    horizontalStep: number;
    verticalStep: number;
} | {
    kind: "flattenForeach";
    target: FlattenForeachTarget;
    recursive?: boolean;
    maxExpansions?: number;
} | {
    kind: "addTreeChild";
    parentSourceId: string;
    afterChildIndex?: number;
} | {
    kind: "removeTreeChild";
    childSourceId: string;
} | {
    kind: "addTreeSibling";
    siblingSourceId: string;
    position: "before" | "after";
} | {
    kind: "addMatrixRow";
    matrixSourceId: string;
    rowIndex: number;
} | {
    kind: "removeMatrixRow";
    matrixSourceId: string;
    rowIndex: number;
} | {
    kind: "addMatrixColumn";
    matrixSourceId: string;
    columnIndex: number;
} | {
    kind: "removeMatrixColumn";
    matrixSourceId: string;
    columnIndex: number;
} | {
    kind: "transposeMatrix";
    matrixSourceId: string;
} | {
    kind: "resizeElement";
    elementId: string;
    role: ResizeRole;
    newWorld: WorldPoint;
    preserveAspect?: boolean;
    preserveAspectRatio?: number;
    formatPrecision?: DragFormatPrecision;
    referenceBounds?: WorldBounds;
    referenceScopeTransform?: {
        xscale: number;
        yscale: number;
        xshift: number;
        yshift: number;
    };
};
export type EditActionResult = {
    kind: "success";
    newSource: string;
    patches: SourcePatch[];
    selectedSourceIds?: string[];
    changedSourceIds?: string[];
} | {
    kind: "partial";
    newSource: string;
    patches: SourcePatch[];
    skippedHandles: string[];
    reason: string;
    selectedSourceIds?: string[];
    changedSourceIds?: string[];
} | {
    kind: "unsupported";
    reason: string;
} | {
    kind: "error";
    message: string;
};
export type EditActionApplyOptions = {
    evaluateOptions?: EvaluateOptions;
    parseOptions?: EditParseOptions;
};
export declare function preflightPositionNodeRelativeToAction(source: string, action: PositionNodeRelativeToAction, options?: EditActionApplyOptions): PositionNodeRelativeToPreflight;
export declare function applyEditAction(source: string, editHandles: EditHandle[], action: EditAction, options?: EditActionApplyOptions): EditActionResult;
