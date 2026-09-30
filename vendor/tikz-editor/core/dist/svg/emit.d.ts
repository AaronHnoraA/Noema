import type { SceneFigure } from "../semantic/types.js";
import type { EmitSvgOptions, EmitSvgResult, SvgRenderModel } from "./types.js";
export declare function emitSvg(scene: SceneFigure, opts?: EmitSvgOptions): EmitSvgResult;
export declare function emitSvgModel(scene: SceneFigure, opts?: EmitSvgOptions): SvgRenderModel;
