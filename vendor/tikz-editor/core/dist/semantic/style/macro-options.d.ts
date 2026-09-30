import type { MacroBinding, MacroExpansionTraceEvent } from "../../macros/index.js";
import type { OptionListAst } from "../../options/types.js";
export declare function expandOptionListMacros(optionLists: OptionListAst[], macroBindings: ReadonlyMap<string, MacroBinding>, trace: MacroExpansionTraceEvent[] | undefined): OptionListAst[];
