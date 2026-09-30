import type { ResolvedPattern } from "../../semantic/types.js";
export type ArrowTipPresetId = "none" | "arrow" | "stealth" | "latex" | "triangle" | "circle" | "square" | "kite" | "bar" | "hooks" | "custom";
export type DashStylePresetId = "solid" | "dashed" | "densely dashed" | "loosely dashed" | "dotted" | "densely dotted" | "loosely dotted" | "custom";
export type LineCapPresetId = "butt" | "round" | "square" | "custom";
export type LineJoinPresetId = "miter" | "round" | "bevel" | "custom";
export type PathMorphingDecorationPresetId = "none" | "zigzag" | "straight zigzag" | "random steps" | "saw" | "bent" | "bumps" | "coil" | "snake" | "custom";
export type FillModePresetId = "solid" | "gradient" | "pattern" | "custom";
export type FillShadingPresetId = "axis" | "radial" | "ball" | "custom";
export type FillPatternPresetId = "horizontal lines" | "vertical lines" | "north east lines" | "north west lines" | "grid" | "crosshatch" | "dots" | "crosshatch dots" | "fivepointed stars" | "sixpointed stars" | "bricks" | "checkerboard" | "checkerboard light gray" | "horizontal lines light gray" | "horizontal lines gray" | "horizontal lines dark gray" | "horizontal lines light blue" | "horizontal lines dark blue" | "crosshatch dots gray" | "crosshatch dots light steel blue" | "Lines" | "Hatch" | "Dots" | "Stars" | "custom";
export type FillPatternMetaFamilyId = "Lines" | "Hatch" | "Dots" | "Stars";
export type FillPatternMetaOptionKey = "angle" | "distance" | "xshift" | "yshift" | "line width" | "radius" | "points";
export type FillPatternMetaValues = {
    angle: number;
    distance: number;
    xshift: number;
    yshift: number;
    lineWidth: number;
    radius: number;
    points: number;
};
export type ArrowTipSide = "start" | "end";
export type ArrowTipPresetOption = {
    value: Exclude<ArrowTipPresetId, "custom">;
    label: string;
};
export type DashStylePresetOption = {
    value: Exclude<DashStylePresetId, "custom">;
    label: string;
};
export type LineCapPresetOption = {
    value: Exclude<LineCapPresetId, "custom">;
    label: string;
};
export type LineJoinPresetOption = {
    value: Exclude<LineJoinPresetId, "custom">;
    label: string;
};
export type PathMorphingDecorationPresetOption = {
    value: Exclude<PathMorphingDecorationPresetId, "custom">;
    label: string;
};
export type FillModePresetOption = {
    value: Exclude<FillModePresetId, "custom">;
    label: string;
};
export type FillShadingPresetOption = {
    value: Exclude<FillShadingPresetId, "custom">;
    label: string;
};
export type FillPatternPresetOption = {
    value: Exclude<FillPatternPresetId, "custom">;
    label: string;
};
export type NodeShapePresetId = "rectangle" | "circle" | "ellipse" | "diamond" | "trapezium" | "semicircle" | "regular polygon" | "star" | "isosceles triangle" | "kite" | "dart" | "circular sector" | "cylinder" | "cloud" | "starburst" | "signal" | "tape" | "rectangle callout" | "ellipse callout" | "cloud callout" | "single arrow" | "double arrow" | "custom";
export type NodeShapePresetOption = {
    value: Exclude<NodeShapePresetId, "custom">;
    label: string;
};
export type NodeFontFamilyId = "serif" | "sans" | "monospace";
export type NodeFontSizePresetId = "tiny" | "scriptsize" | "footnotesize" | "small" | "normalsize" | "large" | "Large" | "LARGE" | "huge" | "Huge" | "custom";
export type NodeFontSizePresetOption = {
    value: Exclude<NodeFontSizePresetId, "custom">;
    label: string;
};
export type CuratedPathMorphingDecorationPresetId = Exclude<PathMorphingDecorationPresetId, "none" | "custom">;
export type PathMorphingDecorationSuboptionKey = "segment length" | "amplitude" | "aspect";
export type PathMorphingDecorationSuboptionSpec = {
    id: string;
    label: string;
    decorationKey: PathMorphingDecorationSuboptionKey;
    writeKey: string;
    step: number;
    unit?: "pt";
    defaultValue: number;
    clearKeys: readonly string[];
};
export declare const LINE_WIDTH_PRESETS: Array<{
    label: string;
    value: number;
}>;
export declare const ARROW_OPTION_KEY = "arrows";
export declare const ARROW_DEFAULT_CLEAR_KEYS: readonly ["arrows", "-", "->", "<-", "<->"];
export declare const DASH_STYLE_PRESET_CLEAR_KEYS: readonly ["solid", "dashed", "densely dashed", "loosely dashed", "dotted", "densely dotted", "loosely dotted", "dash pattern", "dash phase", "dash"];
export declare const DASH_PATTERN_EPSILON = 0.001;
export declare const ARROW_TIP_OPTIONS: ArrowTipPresetOption[];
export declare const DASH_STYLE_OPTIONS: DashStylePresetOption[];
export declare const LINE_CAP_OPTIONS: LineCapPresetOption[];
export declare const LINE_JOIN_OPTIONS: LineJoinPresetOption[];
export declare const PATH_MORPHING_DECORATION_OPTIONS: PathMorphingDecorationPresetOption[];
export declare const PATH_MORPHING_DECORATION_SUBOPTION_SPECS: Record<PathMorphingDecorationSuboptionKey, PathMorphingDecorationSuboptionSpec>;
export declare const PATH_MORPHING_DECORATION_SUBOPTIONS_BY_PRESET: Partial<Record<CuratedPathMorphingDecorationPresetId, readonly PathMorphingDecorationSuboptionKey[]>>;
export declare const FILL_MODE_OPTIONS: FillModePresetOption[];
export declare const FILL_SHADING_OPTIONS: FillShadingPresetOption[];
export declare const FILL_PATTERN_OPTIONS: FillPatternPresetOption[];
export declare const NODE_SHAPE_OPTIONS: NodeShapePresetOption[];
export declare const NODE_SHAPE_KEY = "shape";
export declare const NODE_SHAPE_KNOWN_KEYS: readonly ["rectangle", "circle", "ellipse", "diamond", "trapezium", "semicircle", "regular polygon", "star", "isosceles triangle", "kite", "dart", "circular sector", "cylinder", "cloud", "starburst", "signal", "tape", "rectangle callout", "ellipse callout", "cloud callout", "single arrow", "double arrow", "coordinate"];
export declare const CURATED_NODE_SHAPE_SET: Set<"rectangle" | "circle" | "ellipse" | "diamond" | "trapezium" | "semicircle" | "regular polygon" | "star" | "isosceles triangle" | "kite" | "dart" | "circular sector" | "cylinder" | "cloud" | "starburst" | "signal" | "tape" | "rectangle callout" | "ellipse callout" | "cloud callout" | "single arrow" | "double arrow">;
export declare const NODE_SHAPE_KNOWN_SET: Set<string>;
export declare const NODE_SHAPE_CUSTOM_NOTE = "Custom node shape detected. Picking a preset shape will replace non-preset shape keys.";
export declare const NODE_INNER_SEP_DEFAULT = 3.333;
export declare const NODE_INNER_SEP_CLEAR_KEYS: readonly ["inner xsep", "inner ysep"];
export declare const NODE_INNER_SEP_CONFLICT_NOTE = "inner xsep/inner ysep detected. Editing Inner sep will replace axis-specific padding.";
export declare const NODE_MINIMUM_DIMENSION_DEFAULT = 1;
export declare const NODE_MINIMUM_DIMENSION_CLEAR_KEYS: readonly ["minimum size"];
export declare const NODE_MINIMUM_DIMENSION_CONFLICT_NOTE = "minimum size detected. Editing Minimum width/height will replace shared sizing with axis-specific values.";
export declare const NODE_FONT_KEYS: readonly ["font", "node font"];
export declare const NODE_FONT_CUSTOM_NOTE = "Custom font command detected. Editing in the toolbar will replace unsupported font tokens.";
export declare const NODE_FONT_SIZE_PRESETS: Array<{
    value: Exclude<NodeFontSizePresetId, "custom">;
    label: string;
    command: string;
    scale: number;
}>;
export declare const NODE_FONT_PRESET_BY_ID: Map<"small" | "tiny" | "scriptsize" | "footnotesize" | "normalsize" | "large" | "Large" | "LARGE" | "huge" | "Huge", {
    value: Exclude<NodeFontSizePresetId, "custom">;
    label: string;
    command: string;
    scale: number;
}>;
export declare const NODE_FONT_FAMILY_COMMAND: Record<NodeFontFamilyId, string>;
export declare const NODE_FONT_WEIGHT_COMMAND: Record<"normal" | "bold", string>;
export declare const NODE_FONT_STYLE_COMMAND: Record<"normal" | "italic", string>;
export declare const NODE_FONT_SIZE_EPSILON = 0.02;
export declare const META_FILL_PATTERN_PRESETS: {
    readonly lines: "Lines";
    readonly hatch: "Hatch";
    readonly dots: "Dots";
    readonly stars: "Stars";
};
export declare const DEFAULT_META_PATTERN_DISTANCE = 3;
export declare const DEFAULT_META_PATTERN_STARS_DISTANCE = 8.5358;
export declare const DEFAULT_META_PATTERN_RADIUS = 0.5;
export declare const DEFAULT_META_PATTERN_STARS_RADIUS = 2.8453;
export declare const META_FILL_PATTERN_PRESET_BY_LOWER: Map<string, "grid" | "horizontal lines" | "vertical lines" | "north east lines" | "north west lines" | "crosshatch" | "dots" | "crosshatch dots" | "fivepointed stars" | "sixpointed stars" | "bricks" | "checkerboard" | "checkerboard light gray" | "horizontal lines light gray" | "horizontal lines gray" | "horizontal lines dark gray" | "horizontal lines light blue" | "horizontal lines dark blue" | "crosshatch dots gray" | "crosshatch dots light steel blue" | "Lines" | "Hatch" | "Dots" | "Stars">;
export declare const FILL_PATTERN_PRESET_BY_LOWER: Map<string, "grid" | "horizontal lines" | "vertical lines" | "north east lines" | "north west lines" | "crosshatch" | "dots" | "crosshatch dots" | "fivepointed stars" | "sixpointed stars" | "bricks" | "checkerboard" | "checkerboard light gray" | "horizontal lines light gray" | "horizontal lines gray" | "horizontal lines dark gray" | "horizontal lines light blue" | "horizontal lines dark blue" | "crosshatch dots gray" | "crosshatch dots light steel blue" | "Lines" | "Hatch" | "Dots" | "Stars">;
export declare const META_FILL_PATTERN_PRESET_BY_KIND: Record<ResolvedPattern["kind"], Exclude<FillPatternPresetId, "custom"> | null>;
export declare const FILL_STYLE_CUSTOM_NOTE = "Custom fill style detected. Picking a curated value will replace custom keys.";
export declare const PATH_MORPHING_DECORATION_CLEAR_KEYS: readonly ["decorate", "/tikz/decorate", "decoration", "/pgf/decoration", "/pgf/decoration/name", "/pgf/decorations/name", "name", "mirror", "raise", "transform", "pre", "pre length", "post", "post length", "path has corners", "reverse path", "segment length", "/pgf/decoration/segment length", "/pgf/decorations/segment length", "amplitude", "/pgf/decoration/amplitude", "/pgf/decorations/amplitude", "aspect", "/pgf/decoration/aspect", "/pgf/decorations/aspect", "start radius", "shape size", "shape width", "shape start width", "shape height", "shape start height", "shape sep", "text", "text color", "text align", "text align/align", "text align/left indent", "text align/right indent"];
export declare const ROUNDED_CORNERS_CLEAR_KEYS: readonly ["rounded corners", "sharp corners"];
export declare const FILL_PATTERN_CLEAR_KEYS: readonly ["pattern", "/tikz/pattern", "pattern color", "/tikz/pattern color"];
export declare const FILL_SHADING_CLEAR_KEYS: readonly ["shade", "/tikz/shade", "shading", "/tikz/shading", "shading angle", "/tikz/shading angle", "top color", "/tikz/top color", "middle color", "/tikz/middle color", "bottom color", "/tikz/bottom color", "left color", "/tikz/left color", "right color", "/tikz/right color", "inner color", "/tikz/inner color", "outer color", "/tikz/outer color", "ball color", "/tikz/ball color", "lower left", "/tikz/lower left", "lower right", "/tikz/lower right", "upper left", "/tikz/upper left", "upper right", "/tikz/upper right"];
export declare const AXIS_SHADING_CONFLICT_CLEAR_KEYS: readonly ["inner color", "/tikz/inner color", "outer color", "/tikz/outer color", "ball color", "/tikz/ball color", "lower left", "/tikz/lower left", "lower right", "/tikz/lower right", "upper left", "/tikz/upper left", "upper right", "/tikz/upper right"];
export declare const RADIAL_SHADING_CONFLICT_CLEAR_KEYS: readonly ["shading angle", "/tikz/shading angle", "top color", "/tikz/top color", "middle color", "/tikz/middle color", "bottom color", "/tikz/bottom color", "left color", "/tikz/left color", "right color", "/tikz/right color", "ball color", "/tikz/ball color", "lower left", "/tikz/lower left", "lower right", "/tikz/lower right", "upper left", "/tikz/upper left", "upper right", "/tikz/upper right"];
export declare const BALL_SHADING_CONFLICT_CLEAR_KEYS: readonly ["shading angle", "/tikz/shading angle", "top color", "/tikz/top color", "middle color", "/tikz/middle color", "bottom color", "/tikz/bottom color", "left color", "/tikz/left color", "right color", "/tikz/right color", "inner color", "/tikz/inner color", "outer color", "/tikz/outer color", "lower left", "/tikz/lower left", "lower right", "/tikz/lower right", "upper left", "/tikz/upper left", "upper right", "/tikz/upper right"];
export declare const SHADING_ACTIVATION_KEYS: Set<string>;
export declare const ROUNDED_CORNERS_DEFAULT_RADIUS = 4;
export type ShadowPresetId = "none" | "drop-shadow" | "copy-shadow" | "circular-drop-shadow" | "circular-glow";
export type ShadowPresetOption = {
    value: Exclude<ShadowPresetId, "none">;
    label: string;
};
export declare const SHADOW_PRESET_OPTIONS: ShadowPresetOption[];
export declare const SHADOW_PRESET_TIKZ_KEY: Record<Exclude<ShadowPresetId, "none">, string>;
export declare const SHADOW_ALL_KEYS: readonly ["drop shadow", "copy shadow", "circular drop shadow", "circular glow", "general shadow", "double copy shadow"];
export type ShadowPresetDefaults = {
    xshiftPt: number;
    yshiftPt: number;
    scale: number;
    /** null means opacity is not written by this preset */
    opacity: number | null;
    /** null means fill is not written by this preset (uses path's own color) */
    color: string | null;
};
export declare const SHADOW_PRESET_DEFAULTS: Record<Exclude<ShadowPresetId, "none">, ShadowPresetDefaults>;
