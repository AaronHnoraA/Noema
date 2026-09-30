export type EditableTargetKind = "statement" | "node-adornment";
export type ParsedEditableTargetId = {
    kind: "statement";
    id: string;
} | {
    kind: "node-adornment";
    id: string;
    ownerNodeId: string;
    adornmentKind: "label" | "pin";
    adornmentIndex: number;
};
export declare function parseEditableTargetId(id: string): ParsedEditableTargetId;
export declare function isAdornmentTargetId(id: string): boolean;
