import type { ArrowTip } from "../../semantic/types.js";
export type ArrowTipPreviewPath = {
    d: string;
    stroke: string;
    fill: string;
    strokeWidth: number;
    lineCap: "butt" | "round" | "square";
    lineJoin: "miter" | "round" | "bevel";
};
export type ArrowTipPreviewRender = {
    paths: ArrowTipPreviewPath[];
    xBounds: {
        min: number;
        max: number;
    };
};
export declare function renderArrowTipPreviewPaths(tip: ArrowTip, contextLineWidth: number, markerColor?: string, options?: {
    anchor?: "line-end" | "back";
}): ArrowTipPreviewRender;
