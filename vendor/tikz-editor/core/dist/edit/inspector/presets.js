export const LINE_WIDTH_PRESETS = [
    { label: "ultra thin", value: 0.1 },
    { label: "very thin", value: 0.2 },
    { label: "thin", value: 0.4 },
    { label: "semithick", value: 0.6 },
    { label: "thick", value: 0.8 },
    { label: "very thick", value: 1.2 },
    { label: "ultra thick", value: 1.6 }
];
export const ARROW_OPTION_KEY = "arrows";
const ARROW_SHORTHAND_KEYS = ["-", "->", "<-", "<->"];
export const ARROW_DEFAULT_CLEAR_KEYS = [ARROW_OPTION_KEY, ...ARROW_SHORTHAND_KEYS];
export const DASH_STYLE_PRESET_CLEAR_KEYS = [
    "solid",
    "dashed",
    "densely dashed",
    "loosely dashed",
    "dotted",
    "densely dotted",
    "loosely dotted",
    "dash pattern",
    "dash phase",
    "dash"
];
export const DASH_PATTERN_EPSILON = 1e-3;
export const ARROW_TIP_OPTIONS = [
    { value: "none", label: "None" },
    { value: "arrow", label: "Arrow" },
    { value: "stealth", label: "Stealth" },
    { value: "latex", label: "Latex" },
    { value: "triangle", label: "Triangle" },
    { value: "circle", label: "Circle" },
    { value: "square", label: "Square" },
    { value: "kite", label: "Diamond" },
    { value: "bar", label: "Bar" },
    { value: "hooks", label: "Hooks" }
];
export const DASH_STYLE_OPTIONS = [
    { value: "solid", label: "Solid" },
    { value: "dashed", label: "Dashed" },
    { value: "densely dashed", label: "Densely dashed" },
    { value: "loosely dashed", label: "Loosely dashed" },
    { value: "dotted", label: "Dotted" },
    { value: "densely dotted", label: "Densely dotted" },
    { value: "loosely dotted", label: "Loosely dotted" }
];
export const LINE_CAP_OPTIONS = [
    { value: "butt", label: "Butt" },
    { value: "round", label: "Round" },
    { value: "square", label: "Square" }
];
export const LINE_JOIN_OPTIONS = [
    { value: "miter", label: "Miter" },
    { value: "round", label: "Round" },
    { value: "bevel", label: "Bevel" }
];
export const PATH_MORPHING_DECORATION_OPTIONS = [
    { value: "none", label: "None" },
    { value: "zigzag", label: "Zigzag" },
    { value: "straight zigzag", label: "Straight zigzag" },
    { value: "random steps", label: "Random steps" },
    { value: "saw", label: "Saw" },
    { value: "bent", label: "Bent" },
    { value: "bumps", label: "Bumps" },
    { value: "coil", label: "Coil" },
    { value: "snake", label: "Snake" }
];
export const PATH_MORPHING_DECORATION_SUBOPTION_SPECS = {
    "segment length": {
        id: "path-morphing-segment-length",
        label: "Segment length",
        decorationKey: "segment length",
        writeKey: "/pgf/decoration/segment length",
        step: 0.1,
        unit: "pt",
        defaultValue: 10,
        clearKeys: ["segment length", "/pgf/decoration/segment length", "/pgf/decorations/segment length"]
    },
    amplitude: {
        id: "path-morphing-amplitude",
        label: "Amplitude",
        decorationKey: "amplitude",
        writeKey: "/pgf/decoration/amplitude",
        step: 0.1,
        unit: "pt",
        defaultValue: 2.5,
        clearKeys: ["amplitude", "/pgf/decoration/amplitude", "/pgf/decorations/amplitude"]
    },
    aspect: {
        id: "path-morphing-aspect",
        label: "Aspect",
        decorationKey: "aspect",
        writeKey: "/pgf/decoration/aspect",
        step: 0.05,
        defaultValue: 0.5,
        clearKeys: ["aspect", "/pgf/decoration/aspect", "/pgf/decorations/aspect"]
    }
};
export const PATH_MORPHING_DECORATION_SUBOPTIONS_BY_PRESET = {
    zigzag: ["segment length", "amplitude"],
    "straight zigzag": ["segment length", "amplitude"],
    "random steps": ["segment length", "amplitude"],
    saw: ["segment length", "amplitude"],
    bent: ["amplitude", "aspect"],
    bumps: ["segment length", "amplitude"],
    coil: ["segment length", "amplitude"],
    snake: ["segment length", "amplitude"]
};
export const FILL_MODE_OPTIONS = [
    { value: "solid", label: "Solid" },
    { value: "gradient", label: "Gradient" },
    { value: "pattern", label: "Pattern" }
];
export const FILL_SHADING_OPTIONS = [
    { value: "axis", label: "Axis" },
    { value: "radial", label: "Radial" },
    { value: "ball", label: "Ball" }
];
export const FILL_PATTERN_OPTIONS = [
    { value: "horizontal lines", label: "horizontal lines" },
    { value: "vertical lines", label: "vertical lines" },
    { value: "north east lines", label: "north east lines" },
    { value: "north west lines", label: "north west lines" },
    { value: "grid", label: "grid" },
    { value: "crosshatch", label: "crosshatch" },
    { value: "dots", label: "dots" },
    { value: "crosshatch dots", label: "crosshatch dots" },
    { value: "fivepointed stars", label: "fivepointed stars" },
    { value: "sixpointed stars", label: "sixpointed stars" },
    { value: "bricks", label: "bricks" },
    { value: "checkerboard", label: "checkerboard" },
    { value: "checkerboard light gray", label: "checkerboard light gray" },
    { value: "horizontal lines light gray", label: "horizontal lines light gray" },
    { value: "horizontal lines gray", label: "horizontal lines gray" },
    { value: "horizontal lines dark gray", label: "horizontal lines dark gray" },
    { value: "horizontal lines light blue", label: "horizontal lines light blue" },
    { value: "horizontal lines dark blue", label: "horizontal lines dark blue" },
    { value: "crosshatch dots gray", label: "crosshatch dots gray" },
    { value: "crosshatch dots light steel blue", label: "crosshatch dots light steel blue" },
    { value: "Lines", label: "Lines" },
    { value: "Hatch", label: "Hatch" },
    { value: "Dots", label: "Dots" },
    { value: "Stars", label: "Stars" }
];
export const NODE_SHAPE_OPTIONS = [
    { value: "rectangle", label: "Rectangle" },
    { value: "circle", label: "Circle" },
    { value: "ellipse", label: "Ellipse" },
    { value: "diamond", label: "Diamond" },
    { value: "trapezium", label: "Trapezium" },
    { value: "semicircle", label: "Semicircle" },
    { value: "regular polygon", label: "Regular polygon" },
    { value: "star", label: "Star" },
    { value: "isosceles triangle", label: "Isosceles triangle" },
    { value: "kite", label: "Kite" },
    { value: "dart", label: "Dart" },
    { value: "circular sector", label: "Circular sector" },
    { value: "cylinder", label: "Cylinder" },
    { value: "cloud", label: "Cloud" },
    { value: "starburst", label: "Starburst" },
    { value: "signal", label: "Signal" },
    { value: "tape", label: "Tape" },
    { value: "rectangle callout", label: "Rectangle callout" },
    { value: "ellipse callout", label: "Ellipse callout" },
    { value: "cloud callout", label: "Cloud callout" },
    { value: "single arrow", label: "Single arrow" },
    { value: "double arrow", label: "Double arrow" }
];
export const NODE_SHAPE_KEY = "shape";
export const NODE_SHAPE_KNOWN_KEYS = [
    "rectangle",
    "circle",
    "ellipse",
    "diamond",
    "trapezium",
    "semicircle",
    "regular polygon",
    "star",
    "isosceles triangle",
    "kite",
    "dart",
    "circular sector",
    "cylinder",
    "cloud",
    "starburst",
    "signal",
    "tape",
    "rectangle callout",
    "ellipse callout",
    "cloud callout",
    "single arrow",
    "double arrow",
    "coordinate"
];
export const CURATED_NODE_SHAPE_SET = new Set(NODE_SHAPE_OPTIONS.map((option) => option.value));
export const NODE_SHAPE_KNOWN_SET = new Set(NODE_SHAPE_KNOWN_KEYS);
export const NODE_SHAPE_CUSTOM_NOTE = "Custom node shape detected. Picking a preset shape will replace non-preset shape keys.";
export const NODE_INNER_SEP_DEFAULT = 3.333;
export const NODE_INNER_SEP_CLEAR_KEYS = ["inner xsep", "inner ysep"];
export const NODE_INNER_SEP_CONFLICT_NOTE = "inner xsep/inner ysep detected. Editing Inner sep will replace axis-specific padding.";
export const NODE_MINIMUM_DIMENSION_DEFAULT = 1;
export const NODE_MINIMUM_DIMENSION_CLEAR_KEYS = ["minimum size"];
export const NODE_MINIMUM_DIMENSION_CONFLICT_NOTE = "minimum size detected. Editing Minimum width/height will replace shared sizing with axis-specific values.";
export const NODE_FONT_KEYS = ["font", "node font"];
export const NODE_FONT_CUSTOM_NOTE = "Custom font command detected. Editing in the toolbar will replace unsupported font tokens.";
export const NODE_FONT_SIZE_PRESETS = [
    { value: "tiny", label: "tiny", command: "\\tiny", scale: 0.5 },
    { value: "scriptsize", label: "scriptsize", command: "\\scriptsize", scale: 0.7 },
    { value: "footnotesize", label: "footnotesize", command: "\\footnotesize", scale: 0.8 },
    { value: "small", label: "small", command: "\\small", scale: 0.9 },
    { value: "normalsize", label: "normalsize", command: "\\normalsize", scale: 1 },
    { value: "large", label: "large", command: "\\large", scale: 1.2 },
    { value: "Large", label: "Large", command: "\\Large", scale: 1.44 },
    { value: "LARGE", label: "LARGE", command: "\\LARGE", scale: 1.728 },
    { value: "huge", label: "huge", command: "\\huge", scale: 2.074 },
    { value: "Huge", label: "Huge", command: "\\Huge", scale: 2.488 }
];
export const NODE_FONT_PRESET_BY_ID = new Map(NODE_FONT_SIZE_PRESETS.map((preset) => [preset.value, preset]));
export const NODE_FONT_FAMILY_COMMAND = {
    serif: "\\rmfamily",
    sans: "\\sffamily",
    monospace: "\\ttfamily"
};
export const NODE_FONT_WEIGHT_COMMAND = {
    normal: "\\mdseries",
    bold: "\\bfseries"
};
export const NODE_FONT_STYLE_COMMAND = {
    normal: "\\upshape",
    italic: "\\itshape"
};
export const NODE_FONT_SIZE_EPSILON = 0.02;
export const META_FILL_PATTERN_PRESETS = {
    lines: "Lines",
    hatch: "Hatch",
    dots: "Dots",
    stars: "Stars"
};
export const DEFAULT_META_PATTERN_DISTANCE = 3;
export const DEFAULT_META_PATTERN_STARS_DISTANCE = 8.5358;
export const DEFAULT_META_PATTERN_RADIUS = 0.5;
export const DEFAULT_META_PATTERN_STARS_RADIUS = 2.8453;
const META_FILL_PATTERN_VALUE_SET = new Set(Object.values(META_FILL_PATTERN_PRESETS));
export const META_FILL_PATTERN_PRESET_BY_LOWER = new Map(Object.values(META_FILL_PATTERN_PRESETS).map((value) => [value.toLowerCase(), value]));
export const FILL_PATTERN_PRESET_BY_LOWER = new Map(FILL_PATTERN_OPTIONS.filter((option) => !META_FILL_PATTERN_VALUE_SET.has(option.value))
    .map((option) => [option.value.toLowerCase(), option.value]));
export const META_FILL_PATTERN_PRESET_BY_KIND = {
    legacy: null,
    "meta-lines": "Lines",
    "meta-hatch": "Hatch",
    "meta-dots": "Dots",
    "meta-stars": "Stars"
};
export const FILL_STYLE_CUSTOM_NOTE = "Custom fill style detected. Picking a curated value will replace custom keys.";
export const PATH_MORPHING_DECORATION_CLEAR_KEYS = [
    "decorate",
    "/tikz/decorate",
    "decoration",
    "/pgf/decoration",
    "/pgf/decoration/name",
    "/pgf/decorations/name",
    "name",
    "mirror",
    "raise",
    "transform",
    "pre",
    "pre length",
    "post",
    "post length",
    "path has corners",
    "reverse path",
    "segment length",
    "/pgf/decoration/segment length",
    "/pgf/decorations/segment length",
    "amplitude",
    "/pgf/decoration/amplitude",
    "/pgf/decorations/amplitude",
    "aspect",
    "/pgf/decoration/aspect",
    "/pgf/decorations/aspect",
    "start radius",
    "shape size",
    "shape width",
    "shape start width",
    "shape height",
    "shape start height",
    "shape sep",
    "text",
    "text color",
    "text align",
    "text align/align",
    "text align/left indent",
    "text align/right indent"
];
export const ROUNDED_CORNERS_CLEAR_KEYS = ["rounded corners", "sharp corners"];
export const FILL_PATTERN_CLEAR_KEYS = [
    "pattern",
    "/tikz/pattern",
    "pattern color",
    "/tikz/pattern color"
];
export const FILL_SHADING_CLEAR_KEYS = [
    "shade",
    "/tikz/shade",
    "shading",
    "/tikz/shading",
    "shading angle",
    "/tikz/shading angle",
    "top color",
    "/tikz/top color",
    "middle color",
    "/tikz/middle color",
    "bottom color",
    "/tikz/bottom color",
    "left color",
    "/tikz/left color",
    "right color",
    "/tikz/right color",
    "inner color",
    "/tikz/inner color",
    "outer color",
    "/tikz/outer color",
    "ball color",
    "/tikz/ball color",
    "lower left",
    "/tikz/lower left",
    "lower right",
    "/tikz/lower right",
    "upper left",
    "/tikz/upper left",
    "upper right",
    "/tikz/upper right"
];
export const AXIS_SHADING_CONFLICT_CLEAR_KEYS = [
    "inner color",
    "/tikz/inner color",
    "outer color",
    "/tikz/outer color",
    "ball color",
    "/tikz/ball color",
    "lower left",
    "/tikz/lower left",
    "lower right",
    "/tikz/lower right",
    "upper left",
    "/tikz/upper left",
    "upper right",
    "/tikz/upper right"
];
export const RADIAL_SHADING_CONFLICT_CLEAR_KEYS = [
    "shading angle",
    "/tikz/shading angle",
    "top color",
    "/tikz/top color",
    "middle color",
    "/tikz/middle color",
    "bottom color",
    "/tikz/bottom color",
    "left color",
    "/tikz/left color",
    "right color",
    "/tikz/right color",
    "ball color",
    "/tikz/ball color",
    "lower left",
    "/tikz/lower left",
    "lower right",
    "/tikz/lower right",
    "upper left",
    "/tikz/upper left",
    "upper right",
    "/tikz/upper right"
];
export const BALL_SHADING_CONFLICT_CLEAR_KEYS = [
    "shading angle",
    "/tikz/shading angle",
    "top color",
    "/tikz/top color",
    "middle color",
    "/tikz/middle color",
    "bottom color",
    "/tikz/bottom color",
    "left color",
    "/tikz/left color",
    "right color",
    "/tikz/right color",
    "inner color",
    "/tikz/inner color",
    "outer color",
    "/tikz/outer color",
    "lower left",
    "/tikz/lower left",
    "lower right",
    "/tikz/lower right",
    "upper left",
    "/tikz/upper left",
    "upper right",
    "/tikz/upper right"
];
export const SHADING_ACTIVATION_KEYS = new Set([
    "shading",
    "/tikz/shading",
    "shading angle",
    "/tikz/shading angle",
    "top color",
    "/tikz/top color",
    "middle color",
    "/tikz/middle color",
    "bottom color",
    "/tikz/bottom color",
    "left color",
    "/tikz/left color",
    "right color",
    "/tikz/right color",
    "inner color",
    "/tikz/inner color",
    "outer color",
    "/tikz/outer color",
    "ball color",
    "/tikz/ball color",
    "lower left",
    "/tikz/lower left",
    "lower right",
    "/tikz/lower right",
    "upper left",
    "/tikz/upper left",
    "upper right",
    "/tikz/upper right"
]);
export const ROUNDED_CORNERS_DEFAULT_RADIUS = 4;
export const SHADOW_PRESET_OPTIONS = [
    { value: "drop-shadow", label: "Drop shadow" },
    { value: "copy-shadow", label: "Copy shadow" },
    { value: "circular-drop-shadow", label: "Circular drop shadow" },
    { value: "circular-glow", label: "Circular glow" }
];
export const SHADOW_PRESET_TIKZ_KEY = {
    "drop-shadow": "drop shadow",
    "copy-shadow": "copy shadow",
    "circular-drop-shadow": "circular drop shadow",
    "circular-glow": "circular glow"
};
export const SHADOW_ALL_KEYS = [
    "drop shadow",
    "copy shadow",
    "circular drop shadow",
    "circular glow",
    "general shadow",
    "double copy shadow"
];
// 1ex = 4.3pt (standard approximation used throughout this codebase)
const SHADOW_EX_IN_PT = 4.3;
export const SHADOW_PRESET_DEFAULTS = {
    "drop-shadow": {
        xshiftPt: 0.5 * SHADOW_EX_IN_PT,
        yshiftPt: -0.5 * SHADOW_EX_IN_PT,
        scale: 1,
        opacity: 0.5,
        color: "black!50"
    },
    "copy-shadow": {
        xshiftPt: 0.5 * SHADOW_EX_IN_PT,
        yshiftPt: -0.5 * SHADOW_EX_IN_PT,
        scale: 1,
        opacity: null,
        color: null
    },
    "circular-drop-shadow": {
        xshiftPt: 0.3 * SHADOW_EX_IN_PT,
        yshiftPt: -0.3 * SHADOW_EX_IN_PT,
        scale: 1.1,
        opacity: null,
        color: "black"
    },
    "circular-glow": {
        xshiftPt: 0,
        yshiftPt: 0,
        scale: 1.25,
        opacity: null,
        color: "black"
    }
};
