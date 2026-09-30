import { type WorldPoint } from "../../coords/points.js";
import type { AdornmentOwnerGeometry, EdgeOperationItem, NodeItem, Span, ToOperationItem } from "../../ast/types.js";
import type { OptionListAst } from "../../options/types.js";
import { type NamedNodeGeometry, type NodeQuotesMode, type SemanticContext } from "../context.js";
type QuotesMode = NodeQuotesMode;
export type NodeAdornmentSpec = {
    kind: "label" | "pin";
    span: Span;
    valueSpan: Span;
    textSpan: Span;
    text: string;
    angleRaw: string;
    angleSpan?: Span;
    options: OptionListAst | undefined;
    distancePt: number;
    defaultDistancePt: number;
    distanceExplicit: boolean;
    pinEdgeRaw: string | null;
};
export type NodeAdornmentPlan = {
    mainOptions: OptionListAst | undefined;
    adornments: NodeAdornmentSpec[];
};
export type NodeAdornmentDefaults = {
    quoteMode: QuotesMode;
    labelPosition: string;
    pinPosition: string;
    labelDistancePt: number;
    pinDistancePt: number;
    pinEdgeRaw: string | null;
};
export type MaterializedNodeAdornment = {
    node: NodeItem;
    mainPoint: WorldPoint | null;
    mainGeometry: NamedNodeGeometry | null;
    mainNameRaw: string;
    pinEdgeOptions: OptionListAst | undefined;
};
export declare function makeNodeAdornmentTargetId(ownerNodeId: string, adornmentIndex: number, kind: "label" | "pin"): string;
export declare function extractNodeAdornmentPlan(options: OptionListAst | undefined, baseDefaults?: Partial<NodeAdornmentDefaults>): NodeAdornmentPlan;
export declare function materializeNodeAdornment(params: {
    spec: NodeAdornmentSpec;
    context: SemanticContext;
    mainNodeNameRaw: string;
    ownerId: string;
    adornmentIndex: number;
}): MaterializedNodeAdornment;
export declare function cloneAdornmentOwnerGeometry(geometry: NamedNodeGeometry | null | undefined): AdornmentOwnerGeometry | undefined;
export declare function stripAdornmentInternalStyleOptions(options: OptionListAst | undefined): OptionListAst | undefined;
export declare function extractToLikeOptionPlan<T extends ToOperationItem | EdgeOperationItem>(item: T): {
    item: T;
    generatedNodes: NodeItem[];
};
export {};
