import type { ArrowTip } from "../../semantic/types.js";
import type { ArrowShorteningResult, ArrowSide, ArrowTipMetrics, NormalizedArrowTip } from "./types.js";
export type LatexShapeParameters = {
    length: number;
    width: number;
    lineWidth: number;
    frontMiter: number;
    innerLength: number;
    halfBackWidth: number;
};
export type StealthShapeParameters = {
    length: number;
    width: number;
    lineWidth: number;
    inset: number;
    frontMiter: number;
    backMiter: number;
    topMiter: number;
    insetMiter: number;
    innerLength: number;
    innerHalfWidth: number;
};
type ArrowTipInput = Omit<ArrowTip, "afterLineEnd"> & {
    afterLineEnd?: boolean;
};
export declare function normalizeArrowTip(tip: ArrowTipInput, contextLineWidth: number, fallbackColor: string): NormalizedArrowTip;
export declare function computeArrowShortening(side: ArrowSide, tips: NormalizedArrowTip[], contextLineWidth: number): ArrowShorteningResult;
export declare function buildArrowTipMetrics(tip: NormalizedArrowTip, contextLineWidth: number): ArrowTipMetrics;
export declare function computeLatexShapeParameters(tip: NormalizedArrowTip): LatexShapeParameters;
export declare function computeStealthShapeParameters(tip: NormalizedArrowTip): StealthShapeParameters;
export {};
