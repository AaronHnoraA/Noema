/**
 * The styling Noema manages around a formula: colour, highlight, math alphabet
 * and size are kept as an outer shell of LaTeX commands, so the Formula options
 * dialog can read them back and change one without disturbing the body.
 */

export type ManagedFormulaStyle = {
  body: string;
  color: string;
  background: string;
  variant: string;
  size: string;
};

const formulaVariantCommands = new Set(["mathbf", "mathrm", "mathsf", "mathtt", "mathcal", "mathbb", "mathfrak"]);
const formulaSizeCommands = new Set(["small", "normalsize", "large", "Large", "LARGE", "huge"]);

function readBracedFormulaArgument(source: string, from: number): { value: string; end: number } | null {
  let start = from;
  while (/\s/.test(source[start] ?? "")) start++;
  if (source[start] !== "{") return null;
  let depth = 1;
  for (let index = start + 1; index < source.length; index++) {
    if (source[index] === "\\") {
      index++;
      continue;
    }
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) {
      return { value: source.slice(start + 1, index), end: index + 1 };
    }
  }
  return null;
}

function outerFormulaCommand(source: string, command: string, argumentCount: number): string[] | null {
  const prefix = `\\${command}`;
  if (!source.startsWith(prefix)) return null;
  const args: string[] = [];
  let offset = prefix.length;
  for (let index = 0; index < argumentCount; index++) {
    const argument = readBracedFormulaArgument(source, offset);
    if (!argument) return null;
    args.push(argument.value);
    offset = argument.end;
  }
  return source.slice(offset).trim() ? null : args;
}

export function managedFormulaStyle(tex: string): ManagedFormulaStyle {
  const style: ManagedFormulaStyle = { body: tex.trim(), color: "", background: "", variant: "", size: "" };
  for (;;) {
    const before = style.body;
    const color = outerFormulaCommand(style.body, "textcolor", 2);
    if (color) {
      style.color = color[0]!.trim();
      style.body = color[1]!.trim();
      continue;
    }
    const background = outerFormulaCommand(style.body, "colorbox", 2);
    if (background) {
      style.background = background[0]!.trim();
      style.body = background[1]!.trim();
      continue;
    }
    const variant = style.body.match(/^\\([A-Za-z]+)\b/)?.[1] ?? "";
    if (formulaVariantCommands.has(variant)) {
      const args = outerFormulaCommand(style.body, variant, 1);
      if (args) {
        style.variant = variant;
        style.body = args[0]!.trim();
        continue;
      }
    }
    // The braces must be one group: `{\large a} + {b}` also starts and ends
    // with a brace, and unwrapping it would leave `a} + {b`.
    if (readBracedFormulaArgument(style.body, 0)?.end === style.body.length) {
      const inner = style.body.slice(1, -1).trim();
      const size = inner.match(/^\\([A-Za-z]+)\s+/)?.[1] ?? "";
      if (formulaSizeCommands.has(size)) {
        style.size = size === "normalsize" ? "" : size;
        style.body = inner.replace(/^\\[A-Za-z]+\s+/, "").trim();
        continue;
      }
    }
    if (style.body === before) return style;
  }
}

export function wrapManagedFormulaStyle(body: string, style: Omit<ManagedFormulaStyle, "body">): string {
  let result = body.trim();
  if (style.variant) result = `\\${style.variant}{${result}}`;
  if (style.size) result = `{\\${style.size} ${result}}`;
  if (style.background) result = `\\colorbox{${style.background}}{${result}}`;
  if (style.color) result = `\\textcolor{${style.color}}{${result}}`;
  return result;
}
