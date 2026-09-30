import type { OptionListAst } from "../options/types.js";
import type { ParseTikzResult } from "../parser/index.js";
import { type PropertyTarget } from "./property-target.js";
export declare const FIT_DIRECT_MANIPULATION_BLOCK_REASON = "This node uses fit; drag move/resize/rotate is disabled. Edit fit=(...) targets instead.";
export declare function optionListUsesFit(options: OptionListAst | undefined): boolean;
export declare function propertyTargetUsesFit(target: Pick<PropertyTarget, "options">): boolean;
export declare function sourceUsesFitNodeFromParseResult(source: string, parseResult: ParseTikzResult | null | undefined, sourceId: string): boolean;
