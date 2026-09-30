export const SHADOW_INHERIT_STROKE = "__tikz-shadow-inherit-stroke__";
export const SHADOW_INHERIT_FILL = "__tikz-shadow-inherit-fill__";
export const MAIN_SCENE_LAYER = "main";
export const BACKGROUND_SCENE_LAYER = "background";
export function isCoordinateEditHandle(handle) {
    return handle.handleType === "coordinate";
}
export function isFrameLocalCoordinateEditHandle(handle) {
    return handle.handleType === "coordinate" && handle.coordinateSpace === "frame-local";
}
export function isRelativeCoordinateEditHandle(handle) {
    return handle.handleType === "coordinate" && handle.rewriteMode === "delta";
}
