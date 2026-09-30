import type { OptionListAst } from "../../options/types.js";
import { type SemanticContext } from "../context.js";
import { type WorldPoint } from "../../coords/points.js";
import type { WorldTransform } from "../../coords/transforms.js";
import type { NodeLayout, NodeShape } from "./types.js";
export declare function placeNodeCenter(target: WorldPoint, shape: NodeShape, layout: NodeLayout, anchor: string, options?: OptionListAst | undefined, nodeTransform?: WorldTransform): WorldPoint;
export declare function nodeAnchorOffset(shape: NodeShape, layout: NodeLayout, anchorRaw: string, options?: OptionListAst | undefined): WorldPoint;
export declare function registerNamedNodeAnchors(context: SemanticContext, name: string, center: WorldPoint, shape: NodeShape, layout: NodeLayout, options?: OptionListAst | undefined, nodeTransform?: WorldTransform, producerSourceId?: string): void;
