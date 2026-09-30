const ROUNDED_CORNERS_DEFAULT_RADIUS = 4;
const ROUNDED_CORNERS_FALLBACK_MAX = 24;
const ROUNDED_CORNERS_MIN = 0.1;
export function computePathRoundedCornersMax(commands) {
    const lineBased = computeLineBasedPathRoundedCornersMax(commands);
    if (lineBased != null) {
        return lineBased;
    }
    return computeGenericPathRoundedCornersMax(commands);
}
export function pathHasRoundableCorner(commands) {
    const subpaths = extractCornerSubpaths(commands);
    for (const subpath of subpaths) {
        const segments = subpath.segments;
        if (segments.length < 2) {
            continue;
        }
        for (let index = 0; index < segments.length - 1; index += 1) {
            if (joinProducesCorner(segments[index], segments[index + 1])) {
                return true;
            }
        }
        if (subpath.closed && joinProducesCorner(segments[segments.length - 1], segments[0])) {
            return true;
        }
    }
    return false;
}
export function computeLineBasedPathRoundedCornersMax(commands) {
    const EPSILON = 1e-9;
    const subpaths = [];
    let current = null;
    let segments = [];
    const flushSubpath = (closed, closingIndex) => {
        if (segments.length === 0) {
            segments = [];
            current = null;
            return;
        }
        if (closed && closingIndex != null) {
            const first = segments[0];
            if (first) {
                const startOffset = estimateClosingCornerStartOffset(commands, closingIndex, first.start, first.end);
                if (startOffset > EPSILON && first.startOffset <= EPSILON) {
                    first.startOffset = startOffset;
                    first.length = pointDistance(first.start, first.end) + first.startOffset + first.endOffset;
                }
            }
        }
        const lengths = segments
            .map((segment) => segment.length)
            .filter((length) => Number.isFinite(length) && length > EPSILON);
        if (lengths.length > 0) {
            subpaths.push({ lengths, closed });
        }
        segments = [];
        current = null;
    };
    for (let index = 0; index < commands.length; index += 1) {
        const command = commands[index];
        if (command.kind === "M") {
            flushSubpath(false);
            current = command.to;
            continue;
        }
        if (command.kind === "L") {
            if (!current) {
                current = command.to;
                continue;
            }
            const measured = pointDistance(current, command.to);
            const previous = commands[index - 1];
            const next = index + 1 < commands.length ? commands[index + 1] : undefined;
            const startOffset = estimateSegmentStartRoundedOffset(previous, current, command.to);
            const endOffset = estimateSegmentEndRoundedOffset(next, current, command.to);
            const length = measured + startOffset + endOffset;
            if (Number.isFinite(length) && length > EPSILON) {
                segments.push({
                    start: current,
                    end: command.to,
                    length,
                    startOffset,
                    endOffset
                });
            }
            current = command.to;
            continue;
        }
        if (command.kind === "C" || command.kind === "A") {
            current = command.to;
            continue;
        }
        if (command.kind === "Z") {
            flushSubpath(true, index);
        }
    }
    flushSubpath(false);
    let globalMax = null;
    for (const subpath of subpaths) {
        const candidate = maxRoundedCornersForSubpath(subpath.lengths, subpath.closed);
        if (candidate == null) {
            continue;
        }
        globalMax = globalMax == null ? candidate : Math.min(globalMax, candidate);
    }
    return globalMax;
}
export function computeGenericPathRoundedCornersMax(commands) {
    const subpaths = [];
    const EPSILON = 1e-9;
    let start = null;
    let current = null;
    let lengths = [];
    const flushOpenSubpath = () => {
        if (lengths.length > 0) {
            subpaths.push({ lengths, closed: false });
        }
        lengths = [];
        start = null;
        current = null;
    };
    for (const command of commands) {
        if (command.kind === "M") {
            flushOpenSubpath();
            start = command.to;
            current = command.to;
            continue;
        }
        if (command.kind === "L" || command.kind === "C" || command.kind === "A") {
            if (current) {
                const length = pointDistance(current, command.to);
                if (Number.isFinite(length) && length > EPSILON) {
                    lengths.push(length);
                }
            }
            current = command.to;
            continue;
        }
        if (command.kind === "Z") {
            if (current && start) {
                const closingLength = pointDistance(current, start);
                if (Number.isFinite(closingLength) && closingLength > EPSILON) {
                    lengths.push(closingLength);
                }
            }
            if (lengths.length > 0) {
                subpaths.push({ lengths, closed: true });
            }
            lengths = [];
            start = null;
            current = null;
        }
    }
    flushOpenSubpath();
    let globalMax = null;
    for (const subpath of subpaths) {
        const candidate = maxRoundedCornersForSubpath(subpath.lengths, subpath.closed);
        if (candidate == null) {
            continue;
        }
        globalMax = globalMax == null ? candidate : Math.min(globalMax, candidate);
    }
    return globalMax;
}
export function estimateSegmentStartRoundedOffset(previous, start, end) {
    if (previous?.kind !== "C") {
        return 0;
    }
    const direction = normalizeVector({ x: end.x - start.x, y: end.y - start.y });
    if (!direction) {
        return 0;
    }
    return estimateRoundedOffsetAlongDirection({
        x: start.x - previous.c2.x,
        y: start.y - previous.c2.y
    }, direction);
}
export function estimateSegmentEndRoundedOffset(next, start, end) {
    if (next?.kind !== "C") {
        return 0;
    }
    const direction = normalizeVector({ x: end.x - start.x, y: end.y - start.y });
    if (!direction) {
        return 0;
    }
    return estimateRoundedOffsetAlongDirection({
        x: next.c1.x - end.x,
        y: next.c1.y - end.y
    }, direction);
}
export function estimateClosingCornerStartOffset(commands, closingIndex, start, end) {
    const previous = closingIndex > 0 ? commands[closingIndex - 1] : undefined;
    if (previous?.kind !== "C") {
        return 0;
    }
    if (pointDistance(previous.to, start) > 1e-6) {
        return 0;
    }
    return estimateSegmentStartRoundedOffset(previous, start, end);
}
export function estimateRoundedOffsetAlongDirection(vector, direction) {
    const KAPPA = 0.5522847;
    const EPSILON = 1e-9;
    const vectorLength = Math.hypot(vector.x, vector.y);
    if (!Number.isFinite(vectorLength) || vectorLength <= EPSILON) {
        return 0;
    }
    const parallel = vector.x * direction.x + vector.y * direction.y;
    if (!Number.isFinite(parallel) || parallel <= EPSILON) {
        return 0;
    }
    const alignment = parallel / vectorLength;
    if (!Number.isFinite(alignment) || alignment < 0.9) {
        return 0;
    }
    return parallel / KAPPA;
}
export function normalizeVector(vector) {
    const length = Math.hypot(vector.x, vector.y);
    if (!Number.isFinite(length) || length <= 1e-9) {
        return null;
    }
    return { x: vector.x / length, y: vector.y / length };
}
export function maxRoundedCornersForSubpath(lengths, closed) {
    if (lengths.length < 2) {
        return null;
    }
    let max = Number.POSITIVE_INFINITY;
    for (let index = 0; index < lengths.length; index += 1) {
        const length = lengths[index];
        if (!Number.isFinite(length) || length <= 1e-9) {
            continue;
        }
        const hasCornersOnBothEnds = closed || (index > 0 && index < lengths.length - 1);
        const limit = hasCornersOnBothEnds ? length / 2 : length;
        max = Math.min(max, limit);
    }
    if (!Number.isFinite(max) || max <= 1e-9) {
        return null;
    }
    return max;
}
export function pointDistance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
}
function extractCornerSubpaths(commands) {
    const EPSILON = 1e-9;
    const subpaths = [];
    let start = null;
    let current = null;
    let segments = [];
    const flushSubpath = (closed) => {
        if (segments.length > 0) {
            subpaths.push({ segments, closed });
        }
        segments = [];
        start = null;
        current = null;
    };
    for (const command of commands) {
        if (command.kind === "M") {
            flushSubpath(false);
            start = command.to;
            current = command.to;
            continue;
        }
        if (command.kind === "L") {
            if (current) {
                const length = pointDistance(current, command.to);
                if (length > EPSILON) {
                    segments.push({ kind: "L", from: current, to: command.to });
                }
            }
            current = command.to;
            continue;
        }
        if (command.kind === "C") {
            if (current) {
                const length = pointDistance(current, command.to);
                if (length > EPSILON) {
                    segments.push({
                        kind: "C",
                        from: current,
                        c1: command.c1,
                        c2: command.c2,
                        to: command.to
                    });
                }
            }
            current = command.to;
            continue;
        }
        if (command.kind === "A") {
            if (current) {
                const length = pointDistance(current, command.to);
                if (length > EPSILON) {
                    segments.push({
                        kind: "A",
                        from: current,
                        rx: command.rx,
                        ry: command.ry,
                        xAxisRotation: command.xAxisRotation,
                        largeArc: command.largeArc,
                        sweep: command.sweep,
                        to: command.to
                    });
                }
            }
            current = command.to;
            continue;
        }
        if (command.kind === "Z") {
            if (current && start) {
                const closingLength = pointDistance(current, start);
                if (closingLength > EPSILON) {
                    segments.push({ kind: "L", from: current, to: start });
                }
            }
            flushSubpath(true);
        }
    }
    flushSubpath(false);
    return subpaths;
}
function joinProducesCorner(left, right) {
    const incoming = segmentIncomingDirection(left);
    const outgoing = segmentOutgoingDirection(right);
    if (!incoming || !outgoing) {
        return false;
    }
    const dot = incoming.x * outgoing.x + incoming.y * outgoing.y;
    if (!Number.isFinite(dot)) {
        return false;
    }
    return dot < 1 - 1e-6;
}
function segmentIncomingDirection(segment) {
    if (segment.kind === "L") {
        return normalizeVector({ x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y });
    }
    if (segment.kind === "C") {
        return (normalizeVector({ x: segment.to.x - segment.c2.x, y: segment.to.y - segment.c2.y }) ??
            normalizeVector({ x: segment.to.x - segment.c1.x, y: segment.to.y - segment.c1.y }) ??
            normalizeVector({ x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y }));
    }
    return arcEndpointTangent(segment, "end");
}
function segmentOutgoingDirection(segment) {
    if (segment.kind === "L") {
        return normalizeVector({ x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y });
    }
    if (segment.kind === "C") {
        return (normalizeVector({ x: segment.c1.x - segment.from.x, y: segment.c1.y - segment.from.y }) ??
            normalizeVector({ x: segment.c2.x - segment.from.x, y: segment.c2.y - segment.from.y }) ??
            normalizeVector({ x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y }));
    }
    return arcEndpointTangent(segment, "start");
}
function arcEndpointTangent(segment, endpoint) {
    const tangents = computeArcEndpointTangents(segment.from, segment.to, segment.rx, segment.ry, segment.xAxisRotation, segment.largeArc, segment.sweep);
    if (!tangents) {
        return normalizeVector({ x: segment.to.x - segment.from.x, y: segment.to.y - segment.from.y });
    }
    return endpoint === "start" ? tangents.start : tangents.end;
}
function computeArcEndpointTangents(start, end, rxRaw, ryRaw, xAxisRotation, largeArc, sweep) {
    const EPSILON = 1e-9;
    let rx = Math.abs(rxRaw);
    let ry = Math.abs(ryRaw);
    const chord = { x: end.x - start.x, y: end.y - start.y };
    if (pointDistance(start, end) <= EPSILON) {
        return null;
    }
    if (!Number.isFinite(rx) || !Number.isFinite(ry) || rx <= EPSILON || ry <= EPSILON) {
        const direction = normalizeVector(chord);
        if (!direction) {
            return null;
        }
        return { start: direction, end: direction };
    }
    const phi = (xAxisRotation * Math.PI) / 180;
    const cosPhi = Math.cos(phi);
    const sinPhi = Math.sin(phi);
    const dx2 = (start.x - end.x) / 2;
    const dy2 = (start.y - end.y) / 2;
    const x1p = cosPhi * dx2 + sinPhi * dy2;
    const y1p = -sinPhi * dx2 + cosPhi * dy2;
    const x1p2 = x1p * x1p;
    const y1p2 = y1p * y1p;
    const lambda = x1p2 / (rx * rx) + y1p2 / (ry * ry);
    if (!Number.isFinite(lambda)) {
        return null;
    }
    if (lambda > 1) {
        const scale = Math.sqrt(lambda);
        rx *= scale;
        ry *= scale;
    }
    const rx2 = rx * rx;
    const ry2 = ry * ry;
    const denominator = rx2 * y1p2 + ry2 * x1p2;
    if (!Number.isFinite(denominator) || denominator <= EPSILON) {
        const direction = normalizeVector(chord);
        return direction ? { start: direction, end: direction } : null;
    }
    const numerator = Math.max(0, rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2);
    let coefficient = Math.sqrt(numerator / denominator);
    if (largeArc === sweep) {
        coefficient = -coefficient;
    }
    const cxp = coefficient * ((rx * y1p) / ry);
    const cyp = coefficient * (-(ry * x1p) / rx);
    const ux = (x1p - cxp) / rx;
    const uy = (y1p - cyp) / ry;
    const vx = (-x1p - cxp) / rx;
    const vy = (-y1p - cyp) / ry;
    const startAngle = Math.atan2(uy, ux);
    let deltaAngle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && deltaAngle > 0) {
        deltaAngle -= 2 * Math.PI;
    }
    if (sweep && deltaAngle < 0) {
        deltaAngle += 2 * Math.PI;
    }
    if (!Number.isFinite(deltaAngle) || Math.abs(deltaAngle) <= EPSILON) {
        const fallback = normalizeVector(chord);
        return fallback ? { start: fallback, end: fallback } : null;
    }
    const endAngle = startAngle + deltaAngle;
    const orientation = deltaAngle >= 0 ? 1 : -1;
    const startDerivative = rotateVector({ x: -rx * Math.sin(startAngle) * orientation, y: ry * Math.cos(startAngle) * orientation }, phi);
    const endDerivative = rotateVector({ x: -rx * Math.sin(endAngle) * orientation, y: ry * Math.cos(endAngle) * orientation }, phi);
    const startTangent = normalizeVector(startDerivative);
    const endTangent = normalizeVector(endDerivative);
    if (!startTangent || !endTangent) {
        return null;
    }
    return { start: startTangent, end: endTangent };
}
function rotateVector(vector, radians) {
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return {
        x: cos * vector.x - sin * vector.y,
        y: sin * vector.x + cos * vector.y
    };
}
export function normalizeRoundedCornersMax(value) {
    if (!Number.isFinite(value) || value == null) {
        return ROUNDED_CORNERS_FALLBACK_MAX;
    }
    return Math.max(ROUNDED_CORNERS_MIN, Math.round(value * 100) / 100);
}
export function clampRoundedCornersRadius(value, max) {
    if (!Number.isFinite(value)) {
        return Math.min(ROUNDED_CORNERS_DEFAULT_RADIUS, max);
    }
    return Math.max(ROUNDED_CORNERS_MIN, Math.min(max, value));
}
