export function pt(value) {
    return value;
}
export function cm(value) {
    return value;
}
export function px(value) {
    return value;
}
export function deg(value) {
    return value;
}
export function scalarValue(value) {
    return value;
}
export function addScalar(left, right) {
    return (scalarValue(left) + scalarValue(right));
}
export function subScalar(left, right) {
    return (scalarValue(left) - scalarValue(right));
}
export function scaleScalar(value, factor) {
    return (scalarValue(value) * factor);
}
export function divScalar(value, divisor) {
    return (scalarValue(value) / divisor);
}
export function absScalar(value) {
    return Math.abs(scalarValue(value));
}
export function minScalar(left, right) {
    return (Math.min(scalarValue(left), scalarValue(right)));
}
export function maxScalar(left, right) {
    return (Math.max(scalarValue(left), scalarValue(right)));
}
export function clampScalar(value, min, max) {
    return (Math.min(Math.max(scalarValue(value), scalarValue(min)), scalarValue(max)));
}
export function negScalar(value) {
    return (-scalarValue(value));
}
