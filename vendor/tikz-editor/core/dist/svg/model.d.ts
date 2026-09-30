import type { SvgRenderModel, SvgRenderPart, SvgViewBox } from "./types.js";
export type SerializeSvgModelAsyncOptions = {
    includeXmlns?: boolean;
    pretty?: boolean;
    indentation?: string;
    collapseContent?: boolean;
    lineSeparator?: string;
};
export type SvgModelPartInput = {
    basePartId: string;
    sourceId: string;
    elementId: string | null;
    markup: string;
};
export type SvgModelBuilder = {
    addPart: (input: SvgModelPartInput) => SvgRenderPart;
    addExistingPart: (part: SvgRenderPart) => SvgRenderPart;
    build: (input: {
        viewBox: SvgViewBox;
        defs: string[];
        diagnostics: Array<{
            code: string;
            message: string;
        }>;
    }) => SvgRenderModel;
};
export declare function createSvgModelBuilder(): SvgModelBuilder;
export declare function serializeSvgModel(model: SvgRenderModel, includeXmlns?: boolean): string;
export declare function serializeSvgModelAsync(model: SvgRenderModel, options?: SerializeSvgModelAsyncOptions): Promise<string>;
export declare function fingerprintDefs(defs: readonly string[]): string;
