import { svgBounds, svgPoint, worldPoint } from "./points.js";
import { pt, scalarValue } from "./scalars.js";
import { worldToSvgTransform as createWorldToSvgTransform } from "./transforms.js";
export function worldToSvgY(worldY, viewBox) {
    return pt(viewBox.y + viewBox.height - (scalarValue(worldY) - viewBox.y));
}
export function worldToSvgPoint(point, viewBox) {
    return svgPoint(pt(point.x), pt(worldToSvgY(point.y, viewBox)));
}
export function svgToWorldPoint(point, viewBox) {
    return worldPoint(pt(point.x), pt(viewBox.y + viewBox.height - (scalarValue(point.y) - viewBox.y)));
}
export function worldToSvgBounds(bounds, viewBox) {
    const topLeft = worldToSvgPoint(worldPoint(pt(bounds.minX), pt(bounds.maxY)), viewBox);
    const bottomRight = worldToSvgPoint(worldPoint(pt(bounds.maxX), pt(bounds.minY)), viewBox);
    return svgBounds(pt(topLeft.x), pt(topLeft.y), pt(bottomRight.x), pt(bottomRight.y));
}
export function mapWorldTransformToSvgTransform(matrix, viewBox) {
    const k = 2 * viewBox.y + viewBox.height;
    const flip = createWorldToSvgTransform(1, 0, 0, -1, 0, k);
    return multiplyAffine(multiplyAffine(flip, createWorldToSvgTransform(matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f)), flip);
}
function multiplyAffine(left, right) {
    return createWorldToSvgTransform(left.a * right.a + left.c * right.b, left.b * right.a + left.d * right.b, left.a * right.c + left.c * right.d, left.b * right.c + left.d * right.d, left.a * right.e + left.c * right.f + left.e, left.b * right.e + left.d * right.f + left.f);
}
