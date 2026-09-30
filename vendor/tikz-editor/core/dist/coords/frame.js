import { frameLocalPoint, frameLocalVector, worldPoint, worldVector } from "./points.js";
import { worldToFrameTransform } from "./transforms.js";
import { scalarValue, pt } from "./scalars.js";
export function applyFrameToWorldPoint(transform, point) {
    return worldPoint(pt((transform.a * scalarValue(point.x) + transform.c * scalarValue(point.y) + transform.e)), pt((transform.b * scalarValue(point.x) + transform.d * scalarValue(point.y) + transform.f)));
}
export function applyFrameToWorldVector(transform, vector) {
    return worldVector(pt((transform.a * scalarValue(vector.x) + transform.c * scalarValue(vector.y))), pt((transform.b * scalarValue(vector.x) + transform.d * scalarValue(vector.y))));
}
export function invertFrameToWorldTransform(transform) {
    const det = transform.a * transform.d - transform.b * transform.c;
    if (!Number.isFinite(det) || Math.abs(det) <= 1e-12) {
        return null;
    }
    return worldToFrameTransform(transform.d / det, -transform.b / det, -transform.c / det, transform.a / det, (transform.c * transform.f - transform.d * transform.e) / det, (transform.b * transform.e - transform.a * transform.f) / det);
}
export function applyWorldToFramePoint(transform, point) {
    return frameLocalPoint(pt((transform.a * scalarValue(point.x) + transform.c * scalarValue(point.y) + transform.e)), pt((transform.b * scalarValue(point.x) + transform.d * scalarValue(point.y) + transform.f)));
}
export function applyWorldToFrameVector(transform, vector) {
    return frameLocalVector(pt((transform.a * scalarValue(vector.x) + transform.c * scalarValue(vector.y))), pt((transform.b * scalarValue(vector.x) + transform.d * scalarValue(vector.y))));
}
export function worldToFrameLocal(point, transform) {
    const inverse = invertFrameToWorldTransform(transform);
    if (!inverse) {
        return null;
    }
    return applyWorldToFramePoint(inverse, point);
}
export function worldVectorToFrameLocal(vector, transform) {
    const inverse = invertFrameToWorldTransform(transform);
    if (!inverse) {
        return null;
    }
    return applyWorldToFrameVector(inverse, vector);
}
export const applyFrameTransform = applyFrameToWorldPoint;
export const applyFrameVector = applyFrameToWorldVector;
export const invertFrameTransform = invertFrameToWorldTransform;
