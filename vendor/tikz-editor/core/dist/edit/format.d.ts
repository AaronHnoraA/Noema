export declare const PT_PER_CM = 28.4527559055;
export declare const CM_PER_PT: number;
export type NumberFormatOptions = {
    fractionDigits?: number;
};
export type DragFormatPrecision = "default" | "fine";
export declare const NUMBER_FORMAT_PRESETS: {
    readonly pointDimension: {
        readonly fractionDigits: 0;
    };
    readonly pointDimensionFine: {
        readonly fractionDigits: 1;
    };
    readonly pointDistance: {
        readonly fractionDigits: 0;
    };
    readonly pointDistanceFine: {
        readonly fractionDigits: 1;
    };
};
export declare function pointDimensionFormatOptions(precision: DragFormatPrecision | undefined): NumberFormatOptions;
export declare function pointDistanceFormatOptions(precision: DragFormatPrecision | undefined): NumberFormatOptions;
export declare function formatNumber(value: number, options?: NumberFormatOptions): string;
