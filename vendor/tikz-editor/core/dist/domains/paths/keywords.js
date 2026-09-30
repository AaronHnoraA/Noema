import { pathKeywordItemId } from "../../ast/ids.js";
import { classifyPathKeyword } from "../../syntax/tokens.js";
export function maybeMapPathKeywordItem(node, source, statementIndex, itemIndex) {
    const keyword = classifyPathKeyword(node, source);
    if (!keyword) {
        return null;
    }
    return {
        kind: "PathKeyword",
        id: pathKeywordItemId(statementIndex, itemIndex),
        span: { from: node.from, to: node.to },
        keyword
    };
}
