import type { SvgDiffHints, SvgPatchOp, SvgRenderModel } from "./types.js";
export declare function diffSvgModels(previous: SvgRenderModel | null, next: SvgRenderModel, hints?: SvgDiffHints): SvgPatchOp[];
