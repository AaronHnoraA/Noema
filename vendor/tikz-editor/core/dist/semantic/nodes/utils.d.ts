import type { ArcParameters } from "../path/types.js";
import type { WorldPoint } from "../../coords/points.js";
import { normalizeOptionValue, isWrappedBySingleBracePair } from "../shared/option-value.js";
export { normalizeOptionValue, isWrappedBySingleBracePair };
export declare function clamp(value: number, min: number, max: number): number;
export declare function interpolate(from: WorldPoint, to: WorldPoint, t: number): WorldPoint;
export declare function toRadians(degrees: number): number;
export declare function arcCenter(from: WorldPoint, params: ArcParameters): WorldPoint;
