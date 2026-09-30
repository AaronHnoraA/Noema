export declare function upsertPartOrder(currentOrder: readonly string[], partId: string, afterPartId: string | null): string[];
export declare function removePartOrder(currentOrder: readonly string[], partId: string): string[];
export declare function nextPartIdInOrder(order: readonly string[], partId: string): string | null;
