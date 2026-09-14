import { createHash } from "node:crypto";
import { parseDocument } from "htmlparser2";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const DROP_CONTENT_TAGS = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "form", "input", "button", "textarea", "select", "option"]);
const ALLOWED_TAGS = new Set([
  "article", "section", "main", "header", "footer", "aside", "nav", "div", "span",
  "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "hr", "blockquote", "pre", "code",
  "em", "strong", "b", "i", "u", "s", "del", "ul", "ol", "li", "dl", "dt", "dd",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "a", "img", "figure", "figcaption",
  "details", "summary", "sup", "sub", "mark", "time",
]);
const VOID_TAGS = new Set(["br", "hr", "img"]);

function byteLength(value) {
  return Buffer.byteLength(String(value || ""), "utf8");
}

function escapeText(value) {
  return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function escapeAttribute(value) {
  return escapeText(value).replaceAll('"', "&quot;");
}

function safeURL(value, { image = false } = {}) {
  const source = String(value || "").trim();
  if (!source || source.startsWith("#") || source.startsWith("/")) return source;
  try {
    const parsed = new URL(source);
    if (["http:", "https:"].includes(parsed.protocol)) return parsed.href;
    if (!image && parsed.protocol === "mailto:") return parsed.href;
  } catch {
    if (!source.startsWith("//") && !source.includes(":")) return source;
  }
  return "";
}

function renderSanitizedNode(node) {
  if (node?.type === "text") return escapeText(node.data);
  if (node?.type === "script" || node?.type === "style") return "";
  if (node?.type !== "tag") return (node?.children || []).map(renderSanitizedNode).join("");
  const name = String(node.name || "").toLowerCase();
  if (DROP_CONTENT_TAGS.has(name)) return "";
  const children = (node.children || []).map(renderSanitizedNode).join("");
  if (!ALLOWED_TAGS.has(name)) return children;
  const attributes = [];
  const raw = node.attribs && typeof node.attribs === "object" ? node.attribs : {};
  if (name === "a") {
    const href = safeURL(raw.href);
    if (href) attributes.push(`href="${escapeAttribute(href)}"`);
    if (raw.title) attributes.push(`title="${escapeAttribute(String(raw.title).slice(0, 1000))}"`);
  }
  if (name === "img") {
    const src = safeURL(raw.src, { image: true });
    if (!src) return "";
    attributes.push(`src="${escapeAttribute(src)}"`);
    if (raw.alt) attributes.push(`alt="${escapeAttribute(String(raw.alt).slice(0, 2000))}"`);
    if (raw.title) attributes.push(`title="${escapeAttribute(String(raw.title).slice(0, 1000))}"`);
  }
  if (["td", "th"].includes(name)) {
    for (const key of ["colspan", "rowspan"]) {
      const number = Number.parseInt(raw[key], 10);
      if (Number.isInteger(number) && number > 1 && number <= 100) attributes.push(`${key}="${number}"`);
    }
  }
  if (name === "ol") {
    const start = Number.parseInt(raw.start, 10);
    if (Number.isInteger(start) && Math.abs(start) < 1_000_000) attributes.push(`start="${start}"`);
  }
  const opening = `<${name}${attributes.length ? ` ${attributes.join(" ")}` : ""}>`;
  return VOID_TAGS.has(name) ? opening : `${opening}${children}</${name}>`;
}

export function sanitizeCaptureHTML(source) {
  const html = String(source || "");
  if (byteLength(html) > MAX_CAPTURE_BYTES) throw Object.assign(new Error("Capture HTML exceeds 8 MiB"), { statusCode: 413 });
  const document = parseDocument(html, { decodeEntities: true });
  return (document.children || []).map(renderSanitizedNode).join("").trim();
}

export function captureMarkdownFromHTML(source) {
  const sanitizedHtml = sanitizeCaptureHTML(source);
  const turndown = new TurndownService({ headingStyle: "atx", bulletListMarker: "-", codeBlockStyle: "fenced" });
  turndown.use(gfm);
  turndown.remove(["script", "style", "iframe", "object", "embed", "form"]);
  return { sanitizedHtml, markdown: turndown.turndown(sanitizedHtml).trim() };
}

function plainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function nonEmpty(value, label) {
  const result = String(value || "").trim();
  if (!result) throw Object.assign(new Error(`${label} is required`), { statusCode: 422 });
  return result;
}

function stableRequestID(prefix, id, markdown) {
  const digest = createHash("sha256").update(`${prefix}\0${id}\0${markdown}`).digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

function exportTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value * 1000).toISOString();
  const parsed = new Date(String(value || ""));
  return Number.isNaN(parsed.getTime()) ? new Date(0).toISOString() : parsed.toISOString();
}

function messageText(message) {
  const content = plainObject(message?.content);
  if (Array.isArray(content.parts)) return content.parts.map((part) => typeof part === "string" ? part : "").filter(Boolean).join("\n\n");
  return String(message?.text || content.text || "").trim();
}

function transcriptMarkdown(title, messages) {
  const sections = [`# ${String(title || "Imported conversation").trim() || "Imported conversation"}`];
  for (const message of messages) {
    const text = String(message.text || "").trim();
    if (!text) continue;
    const role = String(message.role || "unknown").toLowerCase();
    const heading = role === "assistant" ? "Assistant" : role === "user" || role === "human" ? "User" : "System";
    sections.push(`## ${heading}\n\n${text}`);
  }
  return `${sections.join("\n\n")}\n`;
}

function chatGPTMessages(conversation) {
  const mapping = plainObject(conversation.mapping);
  const chain = [];
  let current = String(conversation.current_node || "");
  const seen = new Set();
  while (current && mapping[current] && !seen.has(current)) {
    seen.add(current);
    const node = plainObject(mapping[current]);
    const message = plainObject(node.message);
    const text = messageText(message);
    if (text) chain.push({ role: plainObject(message.author).role, text });
    current = String(node.parent || "");
  }
  if (chain.length) return chain.reverse();
  return Object.values(mapping).map((node) => plainObject(node).message).filter(Boolean).map((message) => ({
    role: plainObject(message.author).role, text: messageText(message), at: Number(message.create_time) || 0,
  })).filter((message) => message.text).sort((a, b) => a.at - b.at);
}

function claudeMessages(conversation) {
  return (Array.isArray(conversation.chat_messages) ? conversation.chat_messages : []).map((message) => ({
    role: message.sender, text: String(message.text || message.content || ""), at: String(message.created_at || ""),
  }));
}

export function parseOfficialConversationExport({ format, data }) {
  const kind = String(format || "").trim().toLowerCase();
  const parsed = typeof data === "string" || Buffer.isBuffer(data) ? JSON.parse(String(data)) : data;
  const records = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.conversations) ? parsed.conversations : [];
  if (!records.length) throw Object.assign(new Error("Official export contains no conversations"), { statusCode: 422 });
  if (!["chatgpt", "claude"].includes(kind)) throw Object.assign(new Error("Official export format must be chatgpt or claude"), { statusCode: 422 });
  return records.map((conversation, index) => {
    const source = plainObject(conversation);
    const id = String(source.id || source.uuid || source.conversation_id || index);
    const title = String(source.title || source.name || `Imported conversation ${index + 1}`);
    const messages = kind === "chatgpt" ? chatGPTMessages(source) : claudeMessages(source);
    const markdown = transcriptMarkdown(title, messages);
    return {
      clientRequestId: stableRequestID(`official-${kind}`, id, markdown),
      url: kind === "chatgpt" ? "https://chatgpt.com/" : "https://claude.ai/",
      title,
      adapter: `official-${kind}`,
      completeness: "export",
      capturedAt: exportTimestamp(source.update_time || source.updated_at || source.created_at),
      markdown,
      sanitizedHtml: "",
      metadata: { conversationId: id, source: "official-export", messages: messages.length },
    };
  });
}

export function createResearchCaptureService({ getProvider, root }) {
  const provider = () => {
    const current = getProvider?.();
    if (!current) throw Object.assign(new Error("Noema research kernel is unavailable"), { statusCode: 503 });
    return current;
  };
  const repositoryRoot = nonEmpty(root, "Capture repository root");
  return {
    async create(body = {}) {
      const input = plainObject(body);
      const adapter = nonEmpty(input.adapter, "Capture adapter").toLowerCase();
      if (!["generic-selection", "generic-page"].includes(adapter)) {
        throw Object.assign(new Error("Browser capture adapter is unsupported"), { statusCode: 422 });
      }
      const completeness = nonEmpty(input.completeness, "Capture completeness").toLowerCase();
      if (adapter === "generic-selection" && completeness !== "selection") {
        throw Object.assign(new Error("GenericSelection must declare selection completeness"), { statusCode: 422 });
      }
      if (adapter === "generic-page" && !["full", "partial"].includes(completeness)) {
        throw Object.assign(new Error("GenericPage completeness must be full or partial"), { statusCode: 422 });
      }
      const { sanitizedHtml, markdown } = captureMarkdownFromHTML(nonEmpty(input.html, "Capture HTML"));
      if (!markdown) throw Object.assign(new Error("Capture contains no readable content"), { statusCode: 422 });
      const capture = await provider().createCapture({ root: repositoryRoot, capture: {
        clientRequestId: nonEmpty(input.clientRequestId, "Capture request id"),
        url: nonEmpty(input.url, "Capture URL"), title: String(input.title || "").slice(0, 1000),
        adapter, completeness, capturedAt: String(input.capturedAt || new Date().toISOString()),
        markdown, sanitizedHtml, workstreamId: String(input.workstreamId || ""), metadata: plainObject(input.metadata),
      } });
      return { root: repositoryRoot, capture };
    },
    async list(body = {}) {
      const limit = Math.min(1000, Math.max(1, Number(body.limit) || 200));
      return { root: repositoryRoot, captures: await provider().captures({ root: repositoryRoot, limit }) };
    },
    async importOfficial(body = {}) {
      const encoded = nonEmpty(body.dataBase64 || body.data_base64, "Official export payload");
      const bytes = Buffer.from(encoded, "base64");
      if (!bytes.length || bytes.length > 32 * 1024 * 1024) throw Object.assign(new Error("Official export payload exceeds 32 MiB"), { statusCode: 413 });
      const records = parseOfficialConversationExport({ format: body.format, data: bytes });
      const captures = [];
      for (const capture of records) {
        captures.push(await provider().createCapture({ root: repositoryRoot, capture: {
          ...capture, workstreamId: String(body.workstreamId || body.workstream_id || ""),
        } }));
      }
      return { root: repositoryRoot, captures };
    },
  };
}
