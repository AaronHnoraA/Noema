import type { Tree } from "@lezer/common";
import { parser } from "./grammar/tikz-parser.js";
export declare function parseSyntax(source: string): Tree;
export { parser };
