export type ParsedLengthWithTransform = {
    value: number;
    applyFrameTransform: boolean;
};
export declare function parseCoordinateOperation(raw: string): {
    name: string;
} | null;
export declare function parseCircleRadiusFromCoordinateRaw(raw: string): ParsedLengthWithTransform | null;
export declare function parseEllipseRadiiFromCoordinateRaw(raw: string): {
    rx: ParsedLengthWithTransform;
    ry: ParsedLengthWithTransform;
} | null;
