import { worldPoint } from "../../coords/points.js";
import { pt } from "../../coords/scalars.js";
import { parseOptionListRaw } from "../../options/parse.js";
import { evaluateRawCoordinate } from "../coords/evaluate.js";
import { maybeResolveNamedCoordinateBorderPointFromRaw } from "../nodes/evaluate.js";
export function collectTreeChildCluster(items, startIndex) {
    const children = [];
    let cursor = startIndex;
    while (cursor < items.length) {
        const item = items[cursor];
        if (!item) {
            break;
        }
        if (item.kind === "PathComment") {
            cursor += 1;
            continue;
        }
        if (item.kind === "ChildOperation") {
            children.push(item);
            cursor += 1;
            continue;
        }
        break;
    }
    return {
        children,
        consumed: cursor - startIndex
    };
}
export function makeTreeAutoName(parentNameRaw, statementId, childItemId, childIndex, level) {
    const normalizedParentName = parentNameRaw?.trim() ?? "";
    if (normalizedParentName.length > 0) {
        return `${normalizedParentName}-${childIndex}`;
    }
    const sanitizedParent = sanitizeNameSegment(parentNameRaw ?? "root");
    const sanitizedStatement = sanitizeNameSegment(statementId);
    const sanitizedItem = sanitizeNameSegment(childItemId);
    return `__tree_auto_${sanitizedStatement}_${sanitizedParent}_${sanitizedItem}_${level}_${childIndex}`;
}
export function prepareChildBodyWithRoot(child, generatedRootName) {
    const body = [...child.body];
    const rootIndex = body.findIndex((item) => item.kind !== "PathComment" && item.kind !== "PathOption");
    if (rootIndex >= 0) {
        const root = body[rootIndex];
        if (root?.kind === "Node") {
            const trimmedRootName = root.name?.trim();
            const rootNameRaw = trimmedRootName === undefined || trimmedRootName.length === 0 ? generatedRootName : trimmedRootName;
            if (!root.name || root.name.trim().length === 0) {
                const patchedRoot = {
                    ...root,
                    name: rootNameRaw
                };
                body[rootIndex] = patchedRoot;
            }
            return {
                body,
                rootNameRaw,
                rootSpan: root.span
            };
        }
    }
    const syntheticOptions = parseOptionListRaw("[coordinate]", child.span.from);
    const syntheticRoot = {
        kind: "Node",
        id: `${child.id}:implicit-root`,
        span: { from: child.span.from, to: child.span.from },
        raw: "",
        templateRaw: "",
        name: generatedRootName,
        optionsSpan: syntheticOptions.span,
        options: syntheticOptions,
        textSource: "group",
        textSpan: { from: child.span.from, to: child.span.from },
        text: ""
    };
    return {
        body: [syntheticRoot, ...body],
        rootNameRaw: generatedRootName,
        rootSpan: child.span
    };
}
export function resolveTreeLevelStyleLayers(frame, level) {
    const levelStyles = [];
    for (const templateLayer of frame.treeLevelStyleTemplateLayers) {
        levelStyles.push({
            options: substituteLevelPlaceholder(templateLayer.options, level),
            sourceRef: {
                ...templateLayer.sourceRef,
                label: templateLayer.sourceRef.label != null
                    ? `${templateLayer.sourceRef.label} (level ${level})`
                    : `level ${level}`
            }
        });
    }
    for (const bucket of frame.treeLevelStyleLayers) {
        if (bucket.level !== level) {
            continue;
        }
        levelStyles.push(...bucket.layers);
    }
    return levelStyles;
}
export function computeTreeChildOrigin(parentOrigin, levelDistancePt, siblingDistancePt, childIndexOneBased, childCount, growDirectionDegrees, growReverse) {
    const radians = (growDirectionDegrees * Math.PI) / 180;
    const forward = { x: Math.cos(radians), y: Math.sin(radians) };
    const perpendicular = { x: -forward.y, y: forward.x };
    const centeredIndex = childIndexOneBased - (childCount + 1) / 2;
    const orderSign = growReverse ? -1 : 1;
    const offset = centeredIndex * siblingDistancePt * orderSign;
    return worldPoint(pt(parentOrigin.x + forward.x * levelDistancePt + perpendicular.x * offset), pt(parentOrigin.y + forward.y * levelDistancePt + perpendicular.y * offset));
}
export function resolveNamedTreeAnchorPoint(context, nameRaw, anchorRaw, fallbackPoint, towardPoint) {
    const normalizedAnchor = normalizeAnchor(anchorRaw);
    const coordinateRaw = `(${nameRaw})`;
    if (normalizedAnchor === "center") {
        const evaluated = evaluateRawCoordinate(coordinateRaw, context);
        return evaluated.world ?? fallbackPoint;
    }
    if (normalizedAnchor === "border") {
        return maybeResolveNamedCoordinateBorderPointFromRaw(coordinateRaw, fallbackPoint, towardPoint, context);
    }
    const anchorCoordinate = `(${nameRaw}.${normalizedAnchor})`;
    const evaluated = evaluateRawCoordinate(anchorCoordinate, context);
    return evaluated.world ?? fallbackPoint;
}
export function collectDeferredTreeHookDiagnostics(frame, span) {
    const diagnostics = [];
    if (frame.treeDeferredGrowthFunction) {
        diagnostics.push({
            code: "unsupported-tree-growth-function",
            message: "Tree `growth function` hooks are parsed but currently use the default growth function fallback.",
            span
        });
    }
    if (frame.treeDeferredEdgeFromParentPath) {
        diagnostics.push({
            code: "unsupported-tree-edge-from-parent-path",
            message: "Tree `edge from parent path` hooks are parsed but currently use the default edge-from-parent fallback.",
            span
        });
    }
    if (frame.treeDeferredEdgeFromParentMacro) {
        diagnostics.push({
            code: "unsupported-tree-edge-from-parent-macro",
            message: "Tree `edge from parent macro` hooks are parsed but currently use the default edge-from-parent fallback.",
            span
        });
    }
    return diagnostics;
}
function substituteLevelPlaceholder(optionList, level) {
    const replacement = String(level);
    return {
        span: {
            from: optionList.span.from,
            to: optionList.span.to
        },
        raw: optionList.raw.replace(/#1/g, replacement),
        entries: optionList.entries.map((entry) => {
            if (entry.kind === "kv") {
                return {
                    ...entry,
                    key: entry.key.replace(/#1/g, replacement),
                    valueRaw: entry.valueRaw.replace(/#1/g, replacement),
                    raw: entry.raw.replace(/#1/g, replacement),
                    span: {
                        from: entry.span.from,
                        to: entry.span.to
                    }
                };
            }
            if (entry.kind === "flag") {
                return {
                    ...entry,
                    key: entry.key.replace(/#1/g, replacement),
                    raw: entry.raw.replace(/#1/g, replacement),
                    span: {
                        from: entry.span.from,
                        to: entry.span.to
                    }
                };
            }
            return {
                ...entry,
                raw: entry.raw.replace(/#1/g, replacement),
                span: {
                    from: entry.span.from,
                    to: entry.span.to
                }
            };
        })
    };
}
function normalizeAnchor(raw) {
    return raw.trim().toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ");
}
function sanitizeNameSegment(raw) {
    return raw.replace(/[^A-Za-z0-9_]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80) || "id";
}
