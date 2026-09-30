const DELETED = Symbol("persistent-map-deleted");
export class PersistentMap {
    state;
    constructor(snapshot) {
        this.state = snapshot ?? createRootState();
    }
    get size() {
        return this.materialize().size;
    }
    has(key) {
        return this.findEntry(key).found;
    }
    get(key) {
        const found = this.findEntry(key);
        return found.found ? found.value : undefined;
    }
    set(key, value) {
        const writable = this.ensureWritable();
        writable.entries.set(key, value);
        writable.materialized = null;
        return this;
    }
    delete(key) {
        if (!this.has(key)) {
            return false;
        }
        const writable = this.ensureWritable();
        writable.entries.set(key, DELETED);
        writable.materialized = null;
        return true;
    }
    clear() {
        this.state = createRootState();
    }
    entries() {
        return this.materialize().entries();
    }
    keys() {
        return this.materialize().keys();
    }
    values() {
        return this.materialize().values();
    }
    [Symbol.iterator]() {
        return this.entries();
    }
    forEach(callbackfn, thisArg) {
        this.materialize().forEach((value, key) => {
            callbackfn.call(thisArg, value, key, this);
        });
    }
    snapshot() {
        this.state.sealed = true;
        return this.state;
    }
    restore(snapshot) {
        this.state = snapshot;
    }
    ensureWritable() {
        if (!this.state.sealed) {
            return this.state;
        }
        this.state = {
            parent: this.state,
            entries: new Map(),
            sealed: false,
            materialized: null
        };
        return this.state;
    }
    findEntry(key) {
        let state = this.state;
        while (state) {
            if (state.entries.has(key)) {
                const entry = state.entries.get(key);
                if (entry === DELETED) {
                    return { found: false };
                }
                return { found: true, value: entry };
            }
            state = state.parent;
        }
        return { found: false };
    }
    materialize() {
        return materializeState(this.state);
    }
}
function createRootState() {
    return {
        parent: null,
        entries: new Map(),
        sealed: false,
        materialized: new Map()
    };
}
function materializeState(state) {
    if (state.materialized) {
        return state.materialized;
    }
    const materialized = state.parent ? new Map(materializeState(state.parent)) : new Map();
    for (const [key, entry] of state.entries) {
        if (entry === DELETED) {
            materialized.delete(key);
        }
        else {
            materialized.set(key, entry);
        }
    }
    state.materialized = materialized;
    return materialized;
}
