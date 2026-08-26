/**
 * Source-owned automatic heading-number model.
 *
 * The hierarchy/format semantics are adapted from SiYuan's AGPL-3.0
 * `kernel/model/heading_number.go`; the renderer-facing spacing and enabled
 * rules come from `app/src/protyle/util/headingNumberCore.ts`.  Noema keeps
 * the result ephemeral: numbers are CM6 decorations and never enter Markdown.
 */

export type HeadingNumberFormat =
  | "decimal-hierarchical"
  | "upper-alpha-hierarchical"
  | "lower-alpha-hierarchical"
  | "upper-roman-hierarchical"
  | "lower-roman-hierarchical"
  | "upper-greek-hierarchical"
  | "lower-greek-hierarchical"
  | "decimal-parenthesized"
  | "chinese-document";

export type HeadingNumberSource = {
  level: number;
};

export type HeadingNumberEntry<T extends HeadingNumberSource = HeadingNumberSource> = {
  heading: T;
  path: number[];
  label: string;
};

type CounterStyle = "decimal" | "upper-alpha" | "lower-alpha" | "upper-roman" | "lower-roman"
  | "upper-greek" | "lower-greek" | "chinese" | "circled";

type Preset = {
  styles: CounterStyle[];
  templates: string[];
};

const HIERARCHICAL_TEMPLATES = ["{1}", "{1}.{2}", "{1}.{2}.{3}", "{1}.{2}.{3}.{4}", "{1}.{2}.{3}.{4}.{5}", "{1}.{2}.{3}.{4}.{5}.{6}"];

export function resolveHeadingNumberEnabled(customValue: string | null | undefined, defaultEnabled: boolean): boolean {
  if (customValue === "true") return true;
  if (customValue === "false") return false;
  return defaultEnabled;
}

export function headingNumberNeedsSpacing(number: string): boolean {
  return !["、", "）"].some((suffix) => number.endsWith(suffix));
}

function repeatStyle(style: CounterStyle): CounterStyle[] {
  return Array<CounterStyle>(6).fill(style);
}

function presetFor(format: HeadingNumberFormat): Preset {
  switch (format) {
    case "upper-alpha-hierarchical": return { styles: repeatStyle("upper-alpha"), templates: HIERARCHICAL_TEMPLATES };
    case "lower-alpha-hierarchical": return { styles: repeatStyle("lower-alpha"), templates: HIERARCHICAL_TEMPLATES };
    case "upper-roman-hierarchical": return { styles: repeatStyle("upper-roman"), templates: HIERARCHICAL_TEMPLATES };
    case "lower-roman-hierarchical": return { styles: repeatStyle("lower-roman"), templates: HIERARCHICAL_TEMPLATES };
    case "upper-greek-hierarchical": return { styles: repeatStyle("upper-greek"), templates: HIERARCHICAL_TEMPLATES };
    case "lower-greek-hierarchical": return { styles: repeatStyle("lower-greek"), templates: HIERARCHICAL_TEMPLATES };
    case "decimal-parenthesized": return {
      styles: repeatStyle("decimal"),
      templates: ["{1}）", "{2}）", "{3}）", "{4}）", "{5}）", "{6}）"],
    };
    case "chinese-document": return {
      styles: ["chinese", "chinese", "decimal", "decimal", "circled", "upper-alpha"],
      templates: ["{1}、", "（{2}）", "{3}.", "（{4}）", "{5}", "{6}."],
    };
    default: return { styles: repeatStyle("decimal"), templates: HIERARCHICAL_TEMPLATES };
  }
}

function alphabeticNumber(number: number, alphabet: string): string {
  if (number < 1 || !alphabet) return String(number);
  const characters = Array.from(alphabet);
  let result = "";
  while (number > 0) {
    number--;
    result = characters[number % characters.length]! + result;
    number = Math.floor(number / characters.length);
  }
  return result;
}

function romanNumber(number: number): string {
  if (number < 1 || number > 3999) return String(number);
  const values = [1000, 900, 500, 400, 100, 90, 50, 40, 10, 9, 5, 4, 1];
  const symbols = ["M", "CM", "D", "CD", "C", "XC", "L", "XL", "X", "IX", "V", "IV", "I"];
  let result = "";
  for (let index = 0; index < values.length; index++) {
    while (number >= values[index]!) {
      result += symbols[index]!;
      number -= values[index]!;
    }
  }
  return result;
}

function chineseSection(section: number): string {
  const digits = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const units = ["千", "百", "十", ""];
  const divisors = [1000, 100, 10, 1];
  let result = "";
  let zeroPending = false;
  for (let index = 0; index < divisors.length; index++) {
    const divisor = divisors[index]!;
    const digit = Math.floor(section / divisor);
    section %= divisor;
    if (digit === 0) {
      if (result && section > 0) zeroPending = true;
      continue;
    }
    if (zeroPending) {
      result += digits[0];
      zeroPending = false;
    }
    result += digits[digit]! + units[index]!;
  }
  return result;
}

export function chineseNumber(number: number): string {
  if (!Number.isInteger(number) || number < 1) return String(number);
  const original = number;
  const bigUnits = ["", "万", "亿", "万亿"];
  let result = "";
  let zeroPending = false;
  let lowerSection = 0;
  let unitIndex = 0;
  while (number > 0) {
    const section = number % 10000;
    if (section === 0) {
      if (result) zeroPending = true;
    } else {
      if (unitIndex >= bigUnits.length) return String(original);
      let sectionText = chineseSection(section) + bigUnits[unitIndex]!;
      if (result && (zeroPending || lowerSection < 1000)) sectionText += "零";
      result = sectionText + result;
      zeroPending = false;
    }
    lowerSection = section;
    number = Math.floor(number / 10000);
    unitIndex++;
  }
  return result.startsWith("一十") ? `十${result.slice(2)}` : result;
}

function formatCounter(number: number, style: CounterStyle): string {
  switch (style) {
    case "upper-alpha": return alphabeticNumber(number, "ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    case "lower-alpha": return alphabeticNumber(number, "abcdefghijklmnopqrstuvwxyz");
    case "upper-roman": return romanNumber(number);
    case "lower-roman": return romanNumber(number).toLowerCase();
    case "upper-greek": return alphabeticNumber(number, "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ");
    case "lower-greek": return alphabeticNumber(number, "αβγδεζηθικλμνξοπρστυφχψω");
    case "chinese": return chineseNumber(number);
    case "circled": return ["", "①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩", "⑪", "⑫", "⑬", "⑭", "⑮", "⑯", "⑰", "⑱", "⑲", "⑳"][number] ?? String(number);
    default: return String(number);
  }
}

export function formatHeadingNumber(path: readonly number[], format: HeadingNumberFormat = "decimal-hierarchical"): string {
  if (path.length === 0) return "";
  const preset = presetFor(format);
  const template = preset.templates[path.length - 1];
  if (!template) return path.join(".");
  return path.reduce((result, number, index) => (
    result.replaceAll(`{${index + 1}}`, formatCounter(number, preset.styles[index] ?? "decimal"))
  ), template).trim();
}

/** Match SiYuan's logical-outline rule: level jumps still add one depth. */
export function numberHeadings<T extends HeadingNumberSource>(
  headings: readonly T[],
  format: HeadingNumberFormat = "decimal-hierarchical",
): HeadingNumberEntry<T>[] {
  const levels: number[] = [];
  let counters: number[] = [];
  return headings.map((heading) => {
    while (levels.length > 0 && levels[levels.length - 1]! >= heading.level) levels.pop();
    const depth = levels.length;
    levels.push(heading.level);
    if (depth === counters.length) counters.push(0);
    else counters = counters.slice(0, depth + 1);
    counters[depth] = (counters[depth] ?? 0) + 1;
    const path = [...counters];
    return { heading, path, label: formatHeadingNumber(path, format) };
  });
}
