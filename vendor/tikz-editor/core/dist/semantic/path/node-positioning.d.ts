import { type WorldPoint } from "../../coords/points.js";
import type { Span } from "../../ast/types.js";
import type { OptionListAst } from "../../options/types.js";
import type { NodeDistanceSpec, SemanticContext } from "../context.js";
export type PositioningDirection = "above" | "below" | "left" | "right" | "above left" | "above right" | "below left" | "below right" | "base left" | "base right" | "mid left" | "mid right";
export type ParsedDirectionalKey = {
    direction: PositioningDirection;
    legacyOf: boolean;
};
export type NodePositioningResolution = {
    anchorPoint: WorldPoint;
    anchorOverride?: string;
    diagnostics: string[];
    relativePlacement?: {
        direction: PositioningDirection;
        targetNodeName: string;
        targetWorld: WorldPoint;
        targetCenter: WorldPoint;
        legacyOf: boolean;
        span: Span;
    };
};
export declare function parseDirectionalKey(key: string): ParsedDirectionalKey | null;
export declare function currentAnchorForDirection(direction: PositioningDirection): string;
export declare function targetAnchorForDirection(direction: PositioningDirection): string;
export declare function parseNodeDistance(raw: string, opts?: {
    allowNegative?: boolean;
}): NodeDistanceSpec | null;
export declare function resolveNodePositioningTarget(options: OptionListAst | undefined, context: SemanticContext, fallbackTarget: WorldPoint): NodePositioningResolution;
