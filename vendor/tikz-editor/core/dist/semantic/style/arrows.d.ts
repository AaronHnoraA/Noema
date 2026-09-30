import type { ArrowMarker, ArrowTipKind, ResolvedStyle, TipsMode } from "../types.js";
export declare function parseTipsMode(raw: string): TipsMode | null;
export declare function parseArrowSpecification(raw: string, style: ResolvedStyle): {
    start: ArrowMarker | null;
    end: ArrowMarker | null;
} | null;
export declare function parseArrowSideSpecification(raw: string, side: "start" | "end", style: ResolvedStyle): ArrowMarker | null;
export declare function makeDefaultArrowMarker(kind: ArrowTipKind, lineWidth?: number): ArrowMarker;
export declare function cloneArrowMarker(marker: ArrowMarker): ArrowMarker;
