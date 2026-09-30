import type { Tree } from "@lezer/common";
export type DocHoverTargetKind = "option-key" | "option-value" | "command" | "keyword" | "operator";
export type DocHoverTarget = {
    kind: DocHoverTargetKind;
    from: number;
    to: number;
    query: string;
    candidates: string[];
};
export type ResolveDocHoverTargetInput = {
    source: string;
    tree: Tree;
    pos: number;
};
export declare function resolveDocHoverTarget(input: ResolveDocHoverTargetInput): DocHoverTarget | null;
