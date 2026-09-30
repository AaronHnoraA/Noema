import { pathOptionItemId } from "../../ast/ids.js";
import { parseOptionListRaw } from "../../options/parse.js";
export function mapPathOptionItem(node, source, statementIndex, itemIndex) {
    return {
        kind: "PathOption",
        id: pathOptionItemId(statementIndex, itemIndex),
        span: { from: node.from, to: node.to },
        raw: source.slice(node.from, node.to),
        options: parseOptionListRaw(source.slice(node.from, node.to), node.from)
    };
}
