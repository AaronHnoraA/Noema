export declare function lineBreakWidthAt(source: string, index: number): 0 | 1 | 2;
export declare function buildLineStarts(source: string): number[];
export declare function lineForOffset(offset: number, lineStarts: number[]): number;
export declare function findLineEndOffset(source: string, from: number): number;
