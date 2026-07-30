import type { InlineCommand } from "./command-syntax.ts";

export type SemanticOutlineKind = "part" | "section";

export type SemanticOutline = {
  kind: SemanticOutlineKind;
  level: number;
  label: string;
  text: string;
  slug: string;
  attrs: Record<string, string>;
};

const SWITCH_LEVELS: Record<string, number> = {
  "": 2,
  sec: 2,
  section: 2,
  sub: 3,
  subsub: 4,
  subsubsub: 5,
};

export const MARKDOWN_OUTLINE_OFFSET = 5;

export function slugOutlineAnchor(value: string): string {
  const slug = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[!"#$%&'()*+,./:;<=>?@[\\\]^`{|}~]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "section";
}

export function semanticOutlineFromCommand(command: InlineCommand): SemanticOutline | null {
  const name = command.name.toLowerCase();
  const title = command.context.trim() || "Untitled";
  if (name === "part") {
    return {
      kind: "part",
      level: 1,
      label: "Part",
      text: title,
      slug: command.args.id?.trim() || slugOutlineAnchor(title),
      attrs: command.args,
    };
  }
  if (name !== "section") return null;
  const switchKey = command.switchValue.trim().toLowerCase();
  const level = SWITCH_LEVELS[switchKey];
  if (!level) return null;
  const label = level === 2
    ? "Section"
    : level === 3
      ? "Subsection"
      : level === 4
        ? "Subsubsection"
        : "Subsubsubsection";
  return {
    kind: "section",
    level,
    label,
    text: title,
    slug: command.args.id?.trim() || slugOutlineAnchor(title),
    attrs: command.args,
  };
}

export function semanticMarkdownLevel(markdownLevel: number, hasSemantic: boolean): number {
  return Math.max(1, hasSemantic ? MARKDOWN_OUTLINE_OFFSET + markdownLevel : markdownLevel);
}
