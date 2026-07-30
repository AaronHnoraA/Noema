import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import haskell from "highlight.js/lib/languages/haskell";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import julia from "highlight.js/lib/languages/julia";
import kotlin from "highlight.js/lib/languages/kotlin";
import latex from "highlight.js/lib/languages/latex";
import lisp from "highlight.js/lib/languages/lisp";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import nix from "highlight.js/lib/languages/nix";
import php from "highlight.js/lib/languages/php";
import r from "highlight.js/lib/languages/r";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scala from "highlight.js/lib/languages/scala";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export type CodeHighlightRange = {
  from: number;
  to: number;
  className: string;
};

type Rule = {
  className: string;
  pattern: RegExp;
};

const HIGHLIGHT_CACHE_LIMIT = 384;
const HIGHLIGHT_CACHE_BYTES = 4_000_000; // 4 MB
const MAX_HIGHLIGHT_CHARS = 180_000;
const cache = new Map<string, CodeHighlightRange[]>();
let cacheBytes = 0;

for (const [name, language] of Object.entries({
  bash,
  c,
  cpp,
  csharp,
  css,
  diff,
  dockerfile,
  go,
  haskell,
  ini,
  java,
  javascript,
  json,
  julia,
  kotlin,
  latex,
  lisp,
  lua,
  makefile,
  markdown,
  nix,
  php,
  r,
  ruby,
  rust,
  scala,
  sql,
  typescript,
  xml,
  yaml,
})) {
  hljs.registerLanguage(name, language);
}

function highlightEntryBytes(ranges: CodeHighlightRange[]): number {
  return ranges.length * 48;
}

function remember(key: string, ranges: CodeHighlightRange[]): CodeHighlightRange[] {
  if (cache.has(key)) return ranges;
  cache.set(key, ranges);
  cacheBytes += highlightEntryBytes(ranges);
  while (cache.size > HIGHLIGHT_CACHE_LIMIT || cacheBytes > HIGHLIGHT_CACHE_BYTES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest == null) break;
    const old = cache.get(oldest)!;
    cacheBytes -= highlightEntryBytes(old);
    cache.delete(oldest);
  }
  return ranges;
}

export function clearCodeHighlightCache(): void {
  cache.clear();
  cacheBytes = 0;
}

export function codeHighlightCacheSize(): number {
  return cache.size;
}

function normalizeLang(lang: string): string {
  const raw = lang.trim().toLowerCase().split(/\s+/, 1)[0] ?? "";
  if (["js", "jsx", "mjs", "cjs", "javascript"].includes(raw)) return "javascript";
  if (["ts", "tsx", "typescript"].includes(raw)) return "typescript";
  if (["py", "python"].includes(raw)) return "python";
  if (["sh", "bash", "zsh", "shell"].includes(raw)) return "shell";
  if (["html", "xml", "svg"].includes(raw)) return "markup";
  if (["css", "scss", "less"].includes(raw)) return "css";
  if (["json", "jsonc"].includes(raw)) return "json";
  if (["md", "markdown"].includes(raw)) return "markdown";
  if (["c", "h"].includes(raw)) return "c";
  if (["cc", "cpp", "cxx", "c++", "hpp", "hh", "hxx"].includes(raw)) return "cpp";
  if (["cs", "c#", "csharp"].includes(raw)) return "csharp";
  if (["kt", "kts", "kotlin"].includes(raw)) return "kotlin";
  if (["java"].includes(raw)) return "java";
  if (["scala", "sc"].includes(raw)) return "scala";
  if (["rb", "ruby"].includes(raw)) return "ruby";
  if (["php"].includes(raw)) return "php";
  if (["r"].includes(raw)) return "r";
  if (["jl", "julia"].includes(raw)) return "julia";
  if (["lua"].includes(raw)) return "lua";
  if (["hs", "haskell"].includes(raw)) return "haskell";
  if (["tex", "latex"].includes(raw)) return "latex";
  if (["docker", "dockerfile"].includes(raw)) return "dockerfile";
  if (["make", "makefile", "mk"].includes(raw)) return "makefile";
  if (["diff", "patch"].includes(raw)) return "diff";
  if (["ini", "conf", "cfg"].includes(raw)) return "ini";
  if (["rs", "rust"].includes(raw)) return "rust";
  if (["go", "golang"].includes(raw)) return "go";
  if (["el", "elisp", "emacs-lisp", "lisp", "cl", "clojure", "clj", "scheme", "scm"].includes(raw)) return "lisp";
  if (["sql", "pgsql", "postgres", "postgresql", "mysql", "sqlite"].includes(raw)) return "sql";
  if (["yaml", "yml"].includes(raw)) return "yaml";
  if (["toml"].includes(raw)) return "toml";
  if (["nix"].includes(raw)) return "nix";
  if (["lean", "lean4"].includes(raw)) return "lean4";
  return raw;
}

function hljsLangForLang(lang: string): string {
  switch (normalizeLang(lang)) {
    case "markup": return "xml";
    case "shell": return "bash";
    default: return normalizeLang(lang);
  }
}

const HLJS_CLASS_MAP: Record<string, string> = {
  addition: "code-token-string",
  attr: "code-token-attr",
  attribute: "code-token-attr",
  "built_in": "code-token-function",
  bullet: "code-token-punctuation",
  class: "code-token-keyword",
  code: "code-token-string",
  comment: "code-token-comment",
  deletion: "code-token-comment",
  doctag: "code-token-keyword",
  emphasis: "code-token-string",
  "function_": "code-token-function",
  keyword: "code-token-keyword",
  link: "code-token-string",
  literal: "code-token-keyword",
  meta: "code-token-comment",
  name: "code-token-tag",
  number: "code-token-number",
  operator: "code-token-operator",
  params: "code-token-variable",
  property: "code-token-property",
  punctuation: "code-token-punctuation",
  quote: "code-token-comment",
  regexp: "code-token-string",
  section: "code-token-keyword",
  "selector-attr": "code-token-attr",
  "selector-class": "code-token-property",
  "selector-id": "code-token-property",
  "selector-pseudo": "code-token-property",
  "selector-tag": "code-token-tag",
  string: "code-token-string",
  strong: "code-token-keyword",
  subst: "code-token-variable",
  symbol: "code-token-variable",
  tag: "code-token-tag",
  "template-variable": "code-token-variable",
  title: "code-token-function",
  type: "code-token-keyword",
  variable: "code-token-variable",
};

const HLJS_CLASS_PRIORITY = [
  "comment",
  "string",
  "regexp",
  "number",
  "keyword",
  "literal",
  "type",
  "function_",
  "title",
  "built_in",
  "property",
  "attr",
  "attribute",
  "tag",
  "name",
  "variable",
  "template-variable",
  "params",
  "operator",
  "punctuation",
  "meta",
];

function mappedHljsClass(rawClass: string): string | null {
  const classes = rawClass
    .split(/\s+/)
    .map((cls) => cls.trim().replace(/^hljs-/, ""))
    .filter(Boolean);
  for (const name of HLJS_CLASS_PRIORITY) {
    if (classes.includes(name)) return HLJS_CLASS_MAP[name] ?? null;
  }
  for (const name of classes) {
    if (HLJS_CLASS_MAP[name]) return HLJS_CLASS_MAP[name];
  }
  return null;
}

function decodeHtmlText(value: string): string {
  return value.replace(/&(?:#x([0-9a-f]+)|#(\d+)|([a-z]+));/gi, (entity, hex, dec, named) => {
    if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
    if (dec) return String.fromCodePoint(Number.parseInt(dec, 10));
    switch (String(named || "").toLowerCase()) {
      case "amp": return "&";
      case "apos": return "'";
      case "gt": return ">";
      case "lt": return "<";
      case "quot": return "\"";
      default: return entity;
    }
  });
}

function activeClass(stack: Array<string | null>): string | null {
  for (let i = stack.length - 1; i >= 0; i--) {
    if (stack[i]) return stack[i];
  }
  return null;
}

function rangesFromHighlightedHtml(html: string, source: string): CodeHighlightRange[] {
  const ranges: CodeHighlightRange[] = [];
  const classStack: Array<string | null> = [];
  let offset = 0;
  for (let i = 0; i < html.length;) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i + 1);
      if (end < 0) break;
      const tag = html.slice(i + 1, end);
      if (/^\s*\/\s*span\b/i.test(tag)) {
        classStack.pop();
      } else if (/^\s*span\b/i.test(tag)) {
        const match = tag.match(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        classStack.push(mappedHljsClass(match?.[1] ?? match?.[2] ?? match?.[3] ?? ""));
      }
      i = end + 1;
      continue;
    }
    const next = html.indexOf("<", i);
    const end = next < 0 ? html.length : next;
    const text = decodeHtmlText(html.slice(i, end));
    const len = text.length;
    const cls = activeClass(classStack);
    if (cls && len > 0) {
      ranges.push({ from: offset, to: offset + len, className: cls });
    }
    offset += len;
    i = end;
  }
  if (offset !== source.length) return [];
  return ranges;
}

function highlightCodeWithHljs(lang: string, text: string): CodeHighlightRange[] | null {
  const language = hljsLangForLang(lang);
  if (!hljs.getLanguage(language)) return null;
  try {
    return rangesFromHighlightedHtml(
      hljs.highlight(text, { language, ignoreIllegals: true }).value,
      text,
    );
  } catch {
    return null;
  }
}

function jsRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /\/\*[\s\S]*?\*\/|\/\/[^\n]*/y },
    { className: "code-token-string", pattern: /`(?:\\[\s\S]|\$\{[^}]*\}|[^`\\])*`|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y },
    { className: "code-token-keyword", pattern: /\b(?:as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|of|private|protected|public|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\b/y },
    { className: "code-token-number", pattern: /\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy },
    { className: "code-token-function", pattern: /\b[A-Za-z_$][\w$]*(?=\s*\()/y },
    { className: "code-token-operator", pattern: /=>|===|!==|==|!=|<=|>=|\+\+|--|\*\*|&&|\|\||[+\-*/%=&|!<>?:~]/y },
    { className: "code-token-punctuation", pattern: /[{}[\]();,.]/y },
  ];
}

function pythonRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /#[^\n]*/y },
    { className: "code-token-string", pattern: /(?:[rbufRBUF]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/y },
    { className: "code-token-keyword", pattern: /\b(?:False|None|True|and|as|assert|async|await|break|class|continue|def|del|elif|else|except|finally|for|from|global|if|import|in|is|lambda|nonlocal|not|or|pass|raise|return|try|while|with|yield)\b/y },
    { className: "code-token-number", pattern: /\b(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)\b/iy },
    { className: "code-token-function", pattern: /\b[A-Za-z_]\w*(?=\s*\()/y },
    { className: "code-token-operator", pattern: /==|!=|<=|>=|\*\*|\/\/|:=|[+\-*/%=&|!<>:]/y },
    { className: "code-token-punctuation", pattern: /[{}[\]();,.]/y },
  ];
}

function shellRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /#[^\n]*/y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/y },
    { className: "code-token-keyword", pattern: /\b(?:case|do|done|elif|else|esac|export|fi|for|function|if|in|local|read|return|set|shift|then|while)\b/y },
    { className: "code-token-variable", pattern: /\$\{?[A-Za-z_][\w]*\}?|\$[0-9@*#?$!-]/y },
    { className: "code-token-number", pattern: /\b\d+(?:\.\d+)?\b/y },
    { className: "code-token-operator", pattern: /&&|\|\||>>|<<|[|&;<>]/y },
  ];
}

function cssRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /\/\*[\s\S]*?\*\//y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y },
    { className: "code-token-property", pattern: /--?[_a-zA-Z][\w-]*(?=\s*:)/y },
    { className: "code-token-keyword", pattern: /\b(?:align-items|block|border-box|center|flex|grid|inherit|inline|none|relative|absolute|solid|transparent|var)\b/y },
    { className: "code-token-number", pattern: /#[\da-f]{3,8}\b|\b\d+(?:\.\d+)?(?:px|em|rem|vh|vw|%|s|ms)?\b/iy },
    { className: "code-token-operator", pattern: /[{}:;(),.>+~*=\[\]]/y },
  ];
}

function markupRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /<!--[\s\S]*?-->/y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y },
    { className: "code-token-tag", pattern: /<\/?[A-Za-z][\w:-]*/y },
    { className: "code-token-attr", pattern: /\b[A-Za-z_:][\w:.-]*(?=\s*=)/y },
    { className: "code-token-punctuation", pattern: /\/?>|=/y },
  ];
}

function jsonRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /\/\/[^\n]*|\/\*[\s\S]*?\*\//y },
    { className: "code-token-property", pattern: /"(?:\\[\s\S]|[^"\\])*"(?=\s*:)/y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"/y },
    { className: "code-token-keyword", pattern: /\b(?:false|null|true)\b/y },
    { className: "code-token-number", pattern: /-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/iy },
    { className: "code-token-punctuation", pattern: /[{}[\]:,.]/y },
  ];
}

function markdownRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /<!--[\s\S]*?-->/y },
    { className: "code-token-keyword", pattern: /^(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)/my },
    { className: "code-token-string", pattern: /`[^`\n]+`|\*\*[^*\n]+\*\*|_[^_\n]+_/y },
    { className: "code-token-property", pattern: /\[[^\]\n]+\]\([^)]+\)/y },
  ];
}

function cLikeRules(kind: "c" | "cpp" | "go" | "rust"): Rule[] {
  const keywordMap = {
    c: "auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while",
    cpp: "alignas|alignof|and|asm|auto|bool|break|case|catch|char|class|concept|const|constexpr|consteval|constinit|continue|decltype|default|delete|do|double|else|enum|explicit|export|extern|false|float|for|friend|if|inline|int|long|mutable|namespace|new|noexcept|nullptr|operator|private|protected|public|return|short|signed|sizeof|static|struct|switch|template|this|throw|true|try|typedef|typename|union|unsigned|using|virtual|void|volatile|while",
    go: "break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var",
    rust: "as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while",
  };
  return [
    { className: "code-token-comment", pattern: /\/\*[\s\S]*?\*\/|\/\/[^\n]*/y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'/y },
    { className: "code-token-keyword", pattern: new RegExp(`\\b(?:${keywordMap[kind]})\\b`, "y") },
    { className: "code-token-number", pattern: /\b(?:0x[\da-f_]+|0b[01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:e[+-]?\d+)?)\b/iy },
    { className: "code-token-function", pattern: /\b[A-Za-z_][\w]*(?=\s*\()/y },
    { className: "code-token-operator", pattern: /::|->|=>|==|!=|<=|>=|\+\+|--|&&|\|\||[+\-*/%=&|!<>?:~]/y },
    { className: "code-token-punctuation", pattern: /[{}[\]();,.]/y },
  ];
}

function lispRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /;[^\n]*/y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"/y },
    { className: "code-token-keyword", pattern: /:[A-Za-z_*!?<>=+\-/][\w*!?<>=+\-/]*/y },
    { className: "code-token-keyword", pattern: /\b(?:defun|defvar|defconst|defmacro|lambda|let|let\*|if|cond|when|unless|setq|quote|progn|interactive|require|provide|use-package)\b/y },
    { className: "code-token-number", pattern: /[-+]?\b\d+(?:\.\d+)?\b/y },
    { className: "code-token-function", pattern: /(?<=\()[A-Za-z_*!?<>=+\-/][\w*!?<>=+\-/]*/y },
    { className: "code-token-punctuation", pattern: /[()'`,.]/y },
  ];
}

function sqlRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /--[^\n]*|\/\*[\s\S]*?\*\//y },
    { className: "code-token-string", pattern: /'(?:''|[^'])*'|"(?:\"\"|[^"])*"/y },
    { className: "code-token-keyword", pattern: /\b(?:add|alter|and|as|asc|between|by|case|check|column|constraint|create|delete|desc|distinct|drop|else|end|exists|false|foreign|from|group|having|in|index|inner|insert|into|is|join|key|left|like|limit|null|on|or|order|outer|primary|references|right|select|set|table|then|true|union|update|values|view|when|where)\b/iy },
    { className: "code-token-number", pattern: /\b\d+(?:\.\d+)?\b/y },
    { className: "code-token-function", pattern: /\b[A-Za-z_][\w$]*(?=\s*\()/y },
    { className: "code-token-operator", pattern: /<>|!=|<=|>=|[-+*/%=<>]/y },
    { className: "code-token-punctuation", pattern: /[(),.;]/y },
  ];
}

function yamlRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /#[^\n]*/y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"|'[^']*'/y },
    { className: "code-token-property", pattern: /[A-Za-z0-9_.-]+(?=\s*:)/y },
    { className: "code-token-keyword", pattern: /\b(?:false|null|off|on|true|yes|no)\b/iy },
    { className: "code-token-number", pattern: /[-+]?\b\d+(?:\.\d+)?\b/y },
    { className: "code-token-operator", pattern: /---|\.\.\.|[?:[\]{},&*!|>-]/y },
  ];
}

function tomlRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /#[^\n]*/y },
    { className: "code-token-string", pattern: /"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\[\s\S]|[^"\\])*"|'[^']*'/y },
    { className: "code-token-property", pattern: /[A-Za-z0-9_.-]+(?=\s*=)/y },
    { className: "code-token-keyword", pattern: /\b(?:false|true)\b/y },
    { className: "code-token-number", pattern: /[-+]?\b\d+(?:\.\d+)?\b/y },
    { className: "code-token-punctuation", pattern: /[=[\]{},.]/y },
  ];
}

function nixRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /\/\*[\s\S]*?\*\/|#[^\n]*/y },
    { className: "code-token-string", pattern: /''[\s\S]*?''|"(?:\\[\s\S]|[^"\\])*"/y },
    { className: "code-token-keyword", pattern: /\b(?:assert|else|false|if|in|inherit|let|null|or|rec|then|true|with)\b/y },
    { className: "code-token-property", pattern: /[A-Za-z_][\w'-]*(?=\s*=)/y },
    { className: "code-token-number", pattern: /\b\d+(?:\.\d+)?\b/y },
    { className: "code-token-operator", pattern: /==|!=|<=|>=|\+\+|->|[+\-*/=!<>?:&|]/y },
    { className: "code-token-punctuation", pattern: /[{}[\]();,.]/y },
  ];
}

function leanRules(): Rule[] {
  return [
    { className: "code-token-comment", pattern: /\/-[\s\S]*?-\/|--[^\n]*/y },
    { className: "code-token-string", pattern: /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])'/y },
    { className: "code-token-keyword", pattern: /\b(?:abbrev|axiom|by|calc|case|class|def|deriving|do|else|end|example|extends|for|forall|fun|have|if|import|in|inductive|infix|instance|let|macro|match|mutual|namespace|opaque|open|private|protected|public|rec|section|simp|structure|syntax|termination_by|then|theorem|universe|variable|where|with)\b/y },
    { className: "code-token-number", pattern: /\b(?:0x[\da-fA-F_]+|\d[\d_]*(?:\.\d[\d_]*)?)\b/y },
    { className: "code-token-function", pattern: /\b[A-Za-z_][\w'.!?]*(?=\s*(?:\(|:|:=))/y },
    { className: "code-token-operator", pattern: /:=|=>|←|→|↔|∀|∃|⊢|∧|∨|¬|≤|≥|≠|::|<-|->|[+\-*/%=<>:|&!.?]+/y },
    { className: "code-token-punctuation", pattern: /[{}[\]();,]/y },
  ];
}

function rulesForLang(lang: string): Rule[] {
  switch (normalizeLang(lang)) {
    case "javascript":
    case "typescript":
      return jsRules();
    case "python":
      return pythonRules();
    case "shell":
      return shellRules();
    case "css":
      return cssRules();
    case "markup":
      return markupRules();
    case "json":
      return jsonRules();
    case "markdown":
      return markdownRules();
    case "c":
      return cLikeRules("c");
    case "cpp":
      return cLikeRules("cpp");
    case "go":
      return cLikeRules("go");
    case "rust":
      return cLikeRules("rust");
    case "lisp":
      return lispRules();
    case "sql":
      return sqlRules();
    case "yaml":
      return yamlRules();
    case "toml":
      return tomlRules();
    case "nix":
      return nixRules();
    case "lean4":
      return leanRules();
    default:
      return [];
  }
}

export function highlightCode(lang: string, text: string): CodeHighlightRange[] {
  if (!lang.trim() || text.length === 0 || text.length > MAX_HIGHLIGHT_CHARS) return [];
  const key = `${normalizeLang(lang)}\u0000${text}`;
  const cached = cache.get(key);
  if (cached) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const hljsRanges = highlightCodeWithHljs(lang, text);
  if (hljsRanges) return remember(key, hljsRanges);
  const rules = rulesForLang(lang);
  if (rules.length === 0) return remember(key, []);

  const out: CodeHighlightRange[] = [];
  for (let i = 0; i < text.length;) {
    let matched = false;
    for (const rule of rules) {
      rule.pattern.lastIndex = i;
      const match = rule.pattern.exec(text);
      if (!match || match.index !== i || match[0].length === 0) continue;
      out.push({ from: i, to: i + match[0].length, className: rule.className });
      i += match[0].length;
      matched = true;
      break;
    }
    if (!matched) i++;
  }
  return remember(key, out);
}
