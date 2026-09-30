import { type MacroBinding, type MacroExpansionTraceEvent } from "../../macros/index.js";
export declare function expandPathMacroBindings(raw: string, macroBindings?: ReadonlyMap<string, MacroBinding>, macroTraceCollector?: MacroExpansionTraceEvent[]): string;
