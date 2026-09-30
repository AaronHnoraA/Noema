declare const DELETED: unique symbol;
type EntryValue<V> = V | typeof DELETED;
type PersistentMapState<K, V> = {
    parent: PersistentMapState<K, V> | null;
    entries: Map<K, EntryValue<V>>;
    sealed: boolean;
    materialized: Map<K, V> | null;
};
export type PersistentMapSnapshot<K, V> = PersistentMapState<K, V>;
export declare class PersistentMap<K, V> implements ReadonlyMap<K, V> {
    private state;
    constructor(snapshot?: PersistentMapSnapshot<K, V>);
    get size(): number;
    has(key: K): boolean;
    get(key: K): V | undefined;
    set(key: K, value: V): this;
    delete(key: K): boolean;
    clear(): void;
    entries(): MapIterator<[K, V]>;
    keys(): MapIterator<K>;
    values(): MapIterator<V>;
    [Symbol.iterator](): MapIterator<[K, V]>;
    forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void;
    snapshot(): PersistentMapSnapshot<K, V>;
    restore(snapshot: PersistentMapSnapshot<K, V>): void;
    private ensureWritable;
    private findEntry;
    private materialize;
}
export {};
