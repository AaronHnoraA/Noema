export type ColorAliasResolver = (rawColorName: string) => string | null;
export declare function normalizeColor(raw: string, opts?: {
    currentColor?: string | null;
    resolveAlias?: ColorAliasResolver;
}): string;
export declare function resolveDefineColorModel(modelRaw: string, specificationRaw: string): string | null;
export declare function normalizeShadingName(raw: string): string;
export declare function mixNormalizedColors(first: string, second: string, ratio: number): string | null;
export declare function resolveColorToCss(raw: string, opts?: {
    currentColor?: string | null;
    resolveAlias?: ColorAliasResolver;
}): string | null;
export declare function clamp01(value: number): number;
