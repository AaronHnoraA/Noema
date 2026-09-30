import type { PathCommand } from "../../ast/types.js";
import type { ResolvedStyle } from "../types.js";
import { DEFAULT_TEXT_FONT_SIZE } from "./constants.js";
export declare function defaultStyle(): ResolvedStyle;
export declare function commandDefaultStyle(command: PathCommand, inheritedStyle: ResolvedStyle): Partial<ResolvedStyle>;
export { DEFAULT_TEXT_FONT_SIZE };
