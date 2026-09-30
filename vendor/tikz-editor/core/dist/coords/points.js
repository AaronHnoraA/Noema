function createPoint(x, y, brand) {
    void brand;
    return { x, y };
}
function createVector(x, y, brand) {
    void brand;
    return { x, y };
}
function createBounds(minX, minY, maxX, maxY, brand) {
    void brand;
    return { minX, minY, maxX, maxY };
}
export function sourceCmPoint(x, y) {
    return createPoint(x, y, "point:source-cm");
}
export function frameLocalPoint(x, y) {
    return createPoint(x, y, "point:frame-local");
}
export function worldPoint(x, y) {
    return createPoint(x, y, "point:world");
}
export function anchorLocalPoint(x, y) {
    return createPoint(x, y, "point:anchor-local");
}
export function arrowLocalPoint(x, y) {
    return createPoint(x, y, "point:arrow-local");
}
export function svgPoint(x, y) {
    return createPoint(x, y, "point:svg");
}
export function viewportPoint(x, y) {
    return createPoint(x, y, "point:viewport");
}
export function clientPoint(x, y) {
    return createPoint(x, y, "point:client");
}
export function textRectLocalPoint(x, y) {
    return createPoint(x, y, "point:text-rect-local");
}
export function textareaLocalPoint(x, y) {
    return createPoint(x, y, "point:textarea-local");
}
export function frameLocalVector(x, y) {
    return createVector(x, y, "vector:frame-local");
}
export function worldVector(x, y) {
    return createVector(x, y, "vector:world");
}
export function svgVector(x, y) {
    return createVector(x, y, "vector:svg");
}
export function viewportVector(x, y) {
    return createVector(x, y, "vector:viewport");
}
export function clientVector(x, y) {
    return createVector(x, y, "vector:client");
}
export function worldBounds(minX, minY, maxX, maxY) {
    return createBounds(minX, minY, maxX, maxY, "bounds:world");
}
export function svgBounds(minX, minY, maxX, maxY) {
    return createBounds(minX, minY, maxX, maxY, "bounds:svg");
}
export function viewportBounds(minX, minY, maxX, maxY) {
    return createBounds(minX, minY, maxX, maxY, "bounds:viewport");
}
export function clientBounds(minX, minY, maxX, maxY) {
    return createBounds(minX, minY, maxX, maxY, "bounds:client");
}
