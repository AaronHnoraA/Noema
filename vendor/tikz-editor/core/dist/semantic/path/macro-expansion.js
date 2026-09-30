import { expandMacroBindings } from "../../macros/index.js";
export function expandPathMacroBindings(raw, macroBindings, macroTraceCollector) {
    if (!macroBindings || macroBindings.size === 0) {
        return raw;
    }
    return expandMacroBindings(raw, macroBindings, { trace: macroTraceCollector });
}
