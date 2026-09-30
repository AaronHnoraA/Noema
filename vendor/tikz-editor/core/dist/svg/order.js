export function upsertPartOrder(currentOrder, partId, afterPartId) {
    const withoutPart = currentOrder.filter((id) => id !== partId);
    const insertionIndex = afterPartId == null
        ? 0
        : (() => {
            const anchorIndex = withoutPart.indexOf(afterPartId);
            return anchorIndex >= 0 ? anchorIndex + 1 : withoutPart.length;
        })();
    const nextOrder = [...withoutPart];
    nextOrder.splice(insertionIndex, 0, partId);
    return nextOrder;
}
export function removePartOrder(currentOrder, partId) {
    return currentOrder.filter((id) => id !== partId);
}
export function nextPartIdInOrder(order, partId) {
    const index = order.indexOf(partId);
    if (index < 0 || index + 1 >= order.length) {
        return null;
    }
    return order[index + 1] ?? null;
}
