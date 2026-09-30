import { isWrappedBySingleBracePair, stripWrappingBraces } from "../../utils/braces.js";
export function normalizeOptionValue(raw) {
    return stripWrappingBraces(raw);
}
export { isWrappedBySingleBracePair };
