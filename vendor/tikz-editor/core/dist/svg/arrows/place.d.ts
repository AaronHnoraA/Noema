import type { ScenePathCommand } from "../../semantic/types.js";
import type { Frame } from "./types.js";
import type { ArrowLocalPathCommand } from "./types.js";
export declare function placeLocalPathsRigid(localPaths: ArrowLocalPathCommand[][], frame: Frame, offset: number): ScenePathCommand[][];
export declare function placeLocalPathsBent(localPaths: ArrowLocalPathCommand[][], offset: number, frameAtOffset: (x: number) => Frame): ScenePathCommand[][];
