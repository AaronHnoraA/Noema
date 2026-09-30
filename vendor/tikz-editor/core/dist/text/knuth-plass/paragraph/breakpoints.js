export function collectBreakablePenalties(items) {
    return items.filter((item) => item.kind === 'penalty' && item.penalty < 10_000);
}
export function collectSpaceBreakpoints(items) {
    return collectBreakablePenalties(items).map((item) => item.payload.runIndex);
}
