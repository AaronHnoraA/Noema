function createTransform(a, b, c, d, e, f, brand) {
    void brand;
    return { a, b, c, d, e, f };
}
export function frameToWorldTransform(a, b, c, d, e, f) {
    return createTransform(a, b, c, d, e, f, "transform:frame-to-world");
}
export const frameTransform = frameToWorldTransform;
export function worldToFrameTransform(a, b, c, d, e, f) {
    return createTransform(a, b, c, d, e, f, "transform:world-to-frame");
}
export function worldToSvgTransform(a, b, c, d, e, f) {
    return createTransform(a, b, c, d, e, f, "transform:world-to-svg");
}
export function svgToWorldTransform(a, b, c, d, e, f) {
    return createTransform(a, b, c, d, e, f, "transform:svg-to-world");
}
export function anchorToWorldTransform(a, b, c, d, e, f) {
    return createTransform(a, b, c, d, e, f, "transform:anchor-to-world");
}
export function worldTransform(a, b, c, d, e, f) {
    return createTransform(a, b, c, d, e, f, "transform:world-to-world");
}
