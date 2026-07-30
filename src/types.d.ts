// markdown-it-emoji ships a `lib/data/full.mjs` with the full shortcode
// → glyph map. The package has no .d.ts for it; declare a minimal
// shape so the emoji feature can import it without `any`.
declare module "markdown-it-emoji/lib/data/full.mjs" {
  const data: Record<string, string>;
  export default data;
}

declare module "markdown-it-emoji" {
  import type MarkdownIt from "markdown-it";

  export const bare: MarkdownIt.PluginSimple;
  export const light: MarkdownIt.PluginSimple;
  export const full: MarkdownIt.PluginSimple;
}

declare module "turndown-plugin-gfm" {
  import type TurndownService from "turndown";

  export function gfm(service: TurndownService): void;
  export function tables(service: TurndownService): void;
  export function strikethrough(service: TurndownService): void;
  export function taskListItems(service: TurndownService): void;
}
