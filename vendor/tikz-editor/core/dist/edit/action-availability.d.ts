import type { EditHandle, SceneFigure } from "../semantic/types.js";
import type { EditParseOptions } from "./parse-options.js";
export declare const EDIT_ACTION_IDS: readonly ["cut", "copy", "paste", "duplicate", "repeat", "delete", "group", "ungroup", "transform-rotateLeft90", "transform-rotateRight90", "transform-flipHorizontal", "transform-flipVertical", "reorder-sendToBack", "reorder-sendBackward", "reorder-bringForward", "reorder-bringToFront", "align-left", "align-center", "align-right", "align-top", "align-middle", "align-bottom", "distribute-horizontal", "distribute-vertical", "path-split", "path-join", "path-reverse", "path-close", "path-open", "path-delete-point", "path-point-corner", "path-point-smooth"];
export type EditActionId = (typeof EDIT_ACTION_IDS)[number];
export type ActionAvailability = {
    enabled: boolean;
    reason: string | null;
};
export type EditActionAvailability = Record<EditActionId, ActionAvailability>;
export type GetEditActionAvailabilityInput = {
    source: string;
    activeFigureId?: string | null;
    parseOptions?: EditParseOptions;
    snapshotSource: string | null;
    selectedSourceIds: readonly string[];
    scene: SceneFigure | null;
    editHandles: readonly EditHandle[];
    activeHandleId?: string | null;
    hasClipboardContent?: boolean;
};
export declare function getEditActionAvailability(input: GetEditActionAvailabilityInput, actionIds?: readonly EditActionId[]): EditActionAvailability;
