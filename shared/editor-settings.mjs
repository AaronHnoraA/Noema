// Registered Markdown editor settings shared by the host and every renderer.
// Adding a setting here gives it one default, validator and Configuration entry.
export const NOEMA_EDITOR_SETTINGS = Object.freeze([
  Object.freeze({
    id: "headingNumbering.enabled",
    path: Object.freeze(["headingNumbering", "enabled"]),
    title: "Show heading numbers",
    description: "Display generated numbers beside Markdown headings without changing the source.",
    type: "boolean",
    default: false,
  }),
  Object.freeze({
    id: "headingNumbering.format",
    path: Object.freeze(["headingNumbering", "format"]),
    title: "Heading number format",
    description: "Choose how generated heading numbers are displayed.",
    type: "enum",
    default: "decimal-hierarchical",
    choices: Object.freeze([
      Object.freeze({ value: "decimal-hierarchical", label: "1 · 1.1 · 1.1.1" }),
      Object.freeze({ value: "upper-alpha-hierarchical", label: "A · A.A · A.A.A" }),
      Object.freeze({ value: "lower-alpha-hierarchical", label: "a · a.a · a.a.a" }),
      Object.freeze({ value: "upper-roman-hierarchical", label: "I · I.I · I.I.I" }),
      Object.freeze({ value: "lower-roman-hierarchical", label: "i · i.i · i.i.i" }),
      Object.freeze({ value: "upper-greek-hierarchical", label: "Α · Α.Α · Α.Α.Α" }),
      Object.freeze({ value: "lower-greek-hierarchical", label: "α · α.α · α.α.α" }),
      Object.freeze({ value: "decimal-parenthesized", label: "1） · 2） · 3）" }),
      Object.freeze({ value: "chinese-document", label: "一、 · （一） · 1." }),
    ]),
  }),
]);

function valueAt(source, path) {
  return path.reduce((value, part) => value && typeof value === "object" ? value[part] : undefined, source);
}

function setAt(target, path, value) {
  let node = target;
  for (const part of path.slice(0, -1)) node = node[part] ||= {};
  node[path.at(-1)] = value;
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function noemaEditorDefaults() {
  const defaults = {};
  for (const setting of NOEMA_EDITOR_SETTINGS) setAt(defaults, setting.path, setting.default);
  return defaults;
}

export function normalizeNoemaEditorSettings(source, { strict = false, diagnostics = [] } = {}) {
  const normalized = noemaEditorDefaults();
  for (const setting of NOEMA_EDITOR_SETTINGS) {
    const value = valueAt(source, setting.path);
    if (value === undefined) continue;
    const valid = setting.type === "boolean"
      ? typeof value === "boolean"
      : setting.choices.some((choice) => choice.value === value);
    if (valid) {
      setAt(normalized, setting.path, value);
    } else if (strict) {
      throw Object.assign(new Error(`Invalid Noema editor setting ${setting.id}`), { statusCode: 400 });
    } else {
      diagnostics.push({
        code: "invalid-editor-setting",
        message: `Invalid Noema editor setting ${setting.id}; using its default`,
      });
    }
  }
  return normalized;
}

/** Apply a sparse editor patch using the registry as the only allowed path list. */
export function mergeNoemaEditorSettings(current, patch) {
  if (!plainObject(patch)) {
    throw Object.assign(new Error("Noema editor settings must be an object"), { statusCode: 400 });
  }
  const merged = normalizeNoemaEditorSettings(current);
  const allowed = new Set(NOEMA_EDITOR_SETTINGS.map((setting) => setting.id));
  const visit = (value, path = []) => {
    for (const [key, next] of Object.entries(value)) {
      const parts = [...path, key];
      const id = parts.join(".");
      if (allowed.has(id)) {
        setAt(merged, parts, next);
      } else if (plainObject(next) && [...allowed].some((setting) => setting.startsWith(`${id}.`))) {
        visit(next, parts);
      } else {
        throw Object.assign(new Error(`Unknown Noema editor setting ${id}`), { statusCode: 400 });
      }
    }
  };
  visit(patch);
  return normalizeNoemaEditorSettings(merged, { strict: true });
}
