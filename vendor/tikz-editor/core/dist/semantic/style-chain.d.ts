import type { WorldTransform } from "../coords/transforms.js";
import type { Span } from "../ast/types.js";
import type { OptionListAst } from "../options/types.js";
import type { GeneratedSourceRef, ResolvedStyle } from "./types.js";
import type { StyleDiagnostic } from "./style/diagnostics.js";
export type StyleChainKind = "global" | "named-style" | "every-node" | "every-shape" | "scope" | "command";
export type StyleSourceRef = {
    sourceId: string;
    sourceSpan?: Span;
    sourceKind: string;
    label?: string;
    identityRef?: GeneratedSourceRef;
};
type StyleChainEntryBase = {
    kind: StyleChainKind;
    sourceRef?: StyleSourceRef;
    rawOptions: OptionListAst[];
    before: ResolvedStyle;
    after: ResolvedStyle;
    resolvedContributions: Partial<ResolvedStyle>;
};
export type StyleChainEntry = (StyleChainEntryBase & {
    kind: "global" | "every-node" | "scope" | "command";
}) | (StyleChainEntryBase & {
    kind: "named-style";
    styleName: string;
}) | (StyleChainEntryBase & {
    kind: "every-shape";
    shape: string;
});
export type StyleTraceLayerInput = {
    kind: "global" | "every-node" | "scope" | "command";
    sourceRef?: StyleSourceRef;
    rawOptions: OptionListAst[];
} | {
    kind: "named-style";
    sourceRef?: StyleSourceRef;
    styleName: string;
    rawOptions: OptionListAst[];
} | {
    kind: "every-shape";
    sourceRef?: StyleSourceRef;
    shape: string;
    rawOptions: OptionListAst[];
};
export type ResolvedStyleTrace = {
    style: ResolvedStyle;
    transform: WorldTransform;
    diagnostics: StyleDiagnostic[];
    expandedOptionLists: OptionListAst[];
    chain: StyleChainEntry[];
};
export declare function cloneStyleSourceRef(sourceRef: StyleSourceRef | undefined): StyleSourceRef | undefined;
export declare function cloneStyleChain(chain: StyleChainEntry[]): StyleChainEntry[];
export declare function cloneStyleChainEntry(entry: StyleChainEntry): StyleChainEntry;
export declare function cloneResolvedStyle(style: ResolvedStyle): ResolvedStyle;
export declare function diffResolvedStyle(before: ResolvedStyle, after: ResolvedStyle): Partial<ResolvedStyle>;
export declare function resolvedStyleValueEquals(left: unknown, right: unknown): boolean;
export {};
