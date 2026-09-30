import { resolvePropertyTarget } from "../property-target.js";
export function createInspectorTargetResolver(source, parseOptions = {}) {
    const cache = new Map();
    return (targetId) => {
        const cached = cache.get(targetId);
        if (cached) {
            return cached;
        }
        const resolved = resolvePropertyTarget(source, targetId, parseOptions);
        cache.set(targetId, resolved);
        return resolved;
    };
}
