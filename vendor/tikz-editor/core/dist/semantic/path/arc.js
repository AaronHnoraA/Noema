import { worldPoint, worldVector } from "../../coords/points.js";
import { pt } from "../../coords/scalars.js";
import { splitAllAtTopLevel } from "../../domains/coordinates/parse.js";
import { coordinateInner, toRadians } from "./shared.js";
import { parseLength } from "../coords/parse-length.js";
import { applyMatrixToVector } from "../transform.js";
import { expandPathMacroBindings } from "./macro-expansion.js";
function wp(x, y) {
    return worldPoint(pt(x), pt(y));
}
export function extractArcParameters(item, pushDiagnostic, style, macroBindings, macroTraceCollector) {
    let startAngle = null;
    let endAngle = null;
    let deltaAngle = null;
    let rx = style.xRadius ?? style.radius;
    let ry = style.yRadius ?? style.radius;
    for (const entry of item.options.entries) {
        if (entry.kind !== "kv") {
            continue;
        }
        if (entry.key === "start angle") {
            const parsed = Number(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector));
            if (Number.isFinite(parsed)) {
                startAngle = parsed;
            }
        }
        else if (entry.key === "end angle") {
            const parsed = Number(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector));
            if (Number.isFinite(parsed)) {
                endAngle = parsed;
            }
        }
        else if (entry.key === "delta angle") {
            const parsed = Number(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector));
            if (Number.isFinite(parsed)) {
                deltaAngle = parsed;
            }
        }
        else if (entry.key === "radius") {
            const parsed = parseLength(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                rx = parsed;
                ry = parsed;
            }
        }
        else if (entry.key === "x radius") {
            const parsed = parseLength(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                rx = parsed;
            }
        }
        else if (entry.key === "y radius") {
            const parsed = parseLength(expandPathMacroBindings(entry.valueRaw, macroBindings, macroTraceCollector), "cm");
            if (parsed != null) {
                ry = parsed;
            }
        }
    }
    if (startAngle == null) {
        pushDiagnostic("invalid-arc-parameters", "Arc requires a start angle.", item.span.from, item.span.to);
        return null;
    }
    const resolvedEndAngle = endAngle ?? (deltaAngle != null ? startAngle + deltaAngle : null);
    if (resolvedEndAngle == null) {
        pushDiagnostic("invalid-arc-parameters", "Arc requires an end angle or delta angle.", item.span.from, item.span.to);
        return null;
    }
    if (rx != null && ry != null) {
        return {
            startAngle,
            endAngle: resolvedEndAngle,
            rx,
            ry
        };
    }
    pushDiagnostic("invalid-arc-parameters", "Arc requires `radius` or both `x radius` and `y radius`.", item.span.from, item.span.to);
    return null;
}
export function parseArcShorthand(raw) {
    const inner = coordinateInner(raw);
    if (!inner) {
        return null;
    }
    const parts = splitAllAtTopLevel(inner, ":").map((part) => part.trim()).filter((part) => part.length > 0);
    if (parts.length !== 3) {
        return null;
    }
    const startAngle = Number(parts[0]);
    const endAngle = Number(parts[1]);
    if (!Number.isFinite(startAngle) || !Number.isFinite(endAngle)) {
        return null;
    }
    const radiiSpec = parts[2];
    const elliptical = radiiSpec.match(/^(.+?)\s+and\s+(.+)$/i);
    if (elliptical) {
        const rx = parseLength(elliptical[1].trim(), "cm");
        const ry = parseLength(elliptical[2].trim(), "cm");
        if (rx == null || ry == null) {
            return null;
        }
        return { startAngle, endAngle, rx, ry };
    }
    const radius = parseLength(radiiSpec, "cm");
    if (radius == null) {
        return null;
    }
    return { startAngle, endAngle, rx: radius, ry: radius };
}
export function appendArcCommand(commands, from, params, transform = { a: 1, b: 0, c: 0, d: 1 }) {
    const geometry = computeArcGeometry(from, params, transform);
    commands.push({
        kind: "A",
        rx: geometry.rx,
        ry: geometry.ry,
        xAxisRotation: geometry.xAxisRotation,
        largeArc: Math.abs(params.endAngle - params.startAngle) > 180,
        sweep: geometry.sweep,
        to: geometry.endpoint
    });
    return {
        endpoint: geometry.endpoint,
        segment: {
            kind: "arc",
            from,
            to: geometry.endpoint,
            params
        }
    };
}
function computeArcGeometry(from, params, transform) {
    const startRadians = toRadians(params.startAngle);
    const endRadians = toRadians(params.endAngle);
    const localStart = worldVector(pt(params.rx * Math.cos(startRadians)), pt(params.ry * Math.sin(startRadians)));
    const localEnd = worldVector(pt(params.rx * Math.cos(endRadians)), pt(params.ry * Math.sin(endRadians)));
    const transformedStart = applyMatrixToVector(transform, localStart);
    const transformedEnd = applyMatrixToVector(transform, localEnd);
    const center = wp(from.x - transformedStart.x, from.y - transformedStart.y);
    const endpoint = wp(center.x + transformedEnd.x, center.y + transformedEnd.y);
    const basisX = applyMatrixToVector(transform, worldVector(pt(params.rx), pt(0)));
    const basisY = applyMatrixToVector(transform, worldVector(pt(0), pt(params.ry)));
    const ellipse = ellipseGeometryFromBasis(basisX, basisY);
    const delta = params.endAngle - params.startAngle;
    const baseSweep = delta >= 0;
    const determinant = transform.a * transform.d - transform.b * transform.c;
    return {
        endpoint,
        rx: ellipse.rx,
        ry: ellipse.ry,
        xAxisRotation: ellipse.rotation,
        sweep: determinant < 0 ? !baseSweep : baseSweep
    };
}
function ellipseGeometryFromBasis(basisX, basisY) {
    const s11 = basisX.x * basisX.x + basisY.x * basisY.x;
    const s12 = basisX.x * basisX.y + basisY.x * basisY.y;
    const s22 = basisX.y * basisX.y + basisY.y * basisY.y;
    const traceHalf = (s11 + s22) / 2;
    const discriminant = Math.sqrt(Math.max(0, traceHalf * traceHalf - (s11 * s22 - s12 * s12)));
    const lambda1 = Math.max(0, traceHalf + discriminant);
    const lambda2 = Math.max(0, traceHalf - discriminant);
    const major = Math.sqrt(lambda1);
    const minor = Math.sqrt(lambda2);
    const rotationRadians = Math.abs(lambda1 - lambda2) <= 1e-9 ? 0 : 0.5 * Math.atan2(2 * s12, s11 - s22);
    return {
        rx: Number.isFinite(major) && major > 1e-9 ? major : Math.hypot(basisX.x, basisX.y),
        ry: Number.isFinite(minor) && minor > 1e-9 ? minor : Math.hypot(basisY.x, basisY.y),
        rotation: normalizeDegrees((rotationRadians * 180) / Math.PI)
    };
}
function normalizeDegrees(degrees) {
    let normalized = degrees % 360;
    if (normalized <= -180) {
        normalized += 360;
    }
    else if (normalized > 180) {
        normalized -= 360;
    }
    return Math.abs(normalized) <= 1e-9 ? 0 : normalized;
}
