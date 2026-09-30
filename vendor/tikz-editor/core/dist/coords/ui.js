import { pt, scalarValue } from "./scalars.js";
export function pxToPt(value, zoom) {
    return pt(scalarValue(value) / Math.max(zoom, 1e-6));
}
