export type ScannedFigure = {
    span: {
        from: number;
        to: number;
    };
    beginSpan: {
        from: number;
        to: number;
    };
    endSpan: {
        from: number;
        to: number;
    };
    isTemplate: boolean;
};
export declare function scanTikzFigures(source: string): ScannedFigure[];
