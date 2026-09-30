export function parseEditableTargetId(id) {
    const trimmed = id.trim();
    const match = /^node-adornment:(.+):(label|pin):(\d+)$/.exec(trimmed);
    if (!match) {
        return {
            kind: "statement",
            id: trimmed
        };
    }
    return {
        kind: "node-adornment",
        id: trimmed,
        ownerNodeId: match[1],
        adornmentKind: match[2],
        adornmentIndex: Number.parseInt(match[3], 10)
    };
}
export function isAdornmentTargetId(id) {
    return parseEditableTargetId(id).kind === "node-adornment";
}
