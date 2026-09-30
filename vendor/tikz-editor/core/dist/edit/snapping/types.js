import { px } from "../../coords/scalars.js";
export const GRID_MINOR_TARGET_PX = 22;
export const DEFAULT_SNAP_SETTINGS = {
    thresholdPx: px(8),
    grid: {
        enabled: true,
        minorTargetPx: px(GRID_MINOR_TARGET_PX)
    },
    points: {
        enabled: true
    },
    gaps: {
        enabled: true,
        maxPairsPerAxis: 100000
    },
    bypassWithCtrlOrMeta: true,
    viewportPaddingPx: px(12)
};
