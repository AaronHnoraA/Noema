import { parser } from "./grammar/tikz-parser.js";
export function parseSyntax(source) {
    return parser.parse(source);
}
export { parser };
