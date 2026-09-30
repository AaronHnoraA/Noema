import { normalizeOptionKey } from "./option-key.js";
import { resolvePropertyTargetFromParseResult } from "./property-target.js";
import { findPathStatementById } from "./statement-find.js";
export const FIT_DIRECT_MANIPULATION_BLOCK_REASON = "This node uses fit; drag move/resize/rotate is disabled. Edit fit=(...) targets instead.";
export function optionListUsesFit(options) {
    if (!options) {
        return false;
    }
    return options.entries.some((entry) => (entry.kind === "flag" || entry.kind === "kv") && normalizeOptionKey(entry.key) === "fit");
}
export function propertyTargetUsesFit(target) {
    return optionListUsesFit(target.options);
}
export function sourceUsesFitNodeFromParseResult(source, parseResult, sourceId) {
    if (!parseResult || sourceId.trim().length === 0) {
        return false;
    }
    const statement = findPathStatementById(parseResult.figure.body, sourceId);
    if (statement && pathStatementUsesFit(statement)) {
        return true;
    }
    const resolved = resolvePropertyTargetFromParseResult(source, parseResult, sourceId);
    return resolved.kind === "found" && propertyTargetUsesFit(resolved.target);
}
function pathStatementUsesFit(statement) {
    return statement.items.some((item) => item.kind === "Node" && optionListUsesFit(item.options));
}
