import type { PathOptionItem } from "../../ast/types.js";
import type { NodeTextEngine } from "../../text/types.js";
import type { ResolvedStyle } from "../types.js";
import type { NodeLayout, NodeShape } from "./types.js";
export declare function resolveNodeLayout(text: string, options: PathOptionItem["options"] | undefined, style: ResolvedStyle, _transformScale?: number, textEngine?: NodeTextEngine | null, textMode?: "text" | "math"): NodeLayout;
export declare function adjustNodeLayoutForShape(layout: NodeLayout, shape: NodeShape): NodeLayout;
