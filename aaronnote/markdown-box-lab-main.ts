// Standalone lab page for Phase 2 of the SiYuan-kernel fork (see the plan at
// reference/siyuan and CLAUDE.md's kernel section): proves CM6 can load/save
// a markdown-box document directly against the new Go kernel's
// /api/noema/markdown/{loadDoc,saveDoc} endpoints, completely isolated from
// the production app shell (aaronnote/main.ts) and its Node backend
// (window.aaronnoteApi) — no existing code path is touched. Talks to the Go
// kernel with plain fetch(), not api-client.ts's channel bridge, since that
// bridge only knows about the Node backend.
import "../src/styles/widgets.css";
import "../src/styles/typography.css";
import "../src/styles/themes/aaronnote.css";
import "../src/styles/aaron-ui-tokens.css";
import "../src/styles/aaron-ui-elegant.css";

import { createEditor } from "../src/editor-api.ts";
import type { Editor } from "../src/editor-api.ts";
import { markdownLineStartOffset } from "./markdown-box-lab-navigation.ts";

interface MarkdownBlockRef {
  id: string;
  type: string;
  level?: number;
}

interface LoadDocResponse {
  code: number;
  msg: string;
  data?: { markdown: string; blocks: MarkdownBlockRef[] };
}

interface MarkdownDocSummary {
  path: string;
  title: string;
}

interface ListDocsResponse {
  code: number;
  msg: string;
  data?: { docs: MarkdownDocSummary[] };
}

interface MarkdownBlockLocation {
  id: string;
  notebook: string;
  path: string;
  line?: number;
  type?: string;
}

interface ResolveBlockResponse {
  code: number;
  msg: string;
  data?: MarkdownBlockLocation;
}

const root = document.createElement("div");
root.style.cssText = "display:flex;flex-direction:column;height:100vh;background:var(--aaron-surface-base,#141a27);color:var(--aaron-role-strong,#e2eaff);font-family:system-ui,sans-serif;";
document.body.style.margin = "0";
document.body.appendChild(root);

const toolbar = document.createElement("div");
toolbar.style.cssText = "display:flex;gap:8px;align-items:center;padding:8px 12px;border-bottom:1px solid var(--aaron-role-faded,#435574);flex-wrap:wrap;";
root.appendChild(toolbar);

function makeInput(placeholder: string, value: string, width: string): HTMLInputElement {
  const el = document.createElement("input");
  el.placeholder = placeholder;
  el.value = value;
  el.style.cssText = `width:${width};background:var(--aaron-surface-raised,#242e43);color:inherit;border:1px solid var(--aaron-role-faded,#435574);border-radius:4px;padding:4px 8px;font:inherit;`;
  return el;
}

function makeButton(label: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.textContent = label;
  el.style.cssText = "background:var(--aaron-role-popout,#7ee7ff);color:#141a27;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font:inherit;";
  return el;
}

const kernelBaseInput = makeInput(
  "kernel base URL",
  window.__noemaKernelBase || "http://127.0.0.1:16888",
  "220px",
);
const notebookInput = makeInput("notebook ID", "", "220px");
const connectBtn = makeButton("Connect");
const statusEl = document.createElement("span");
statusEl.style.cssText = "opacity:0.75;font-size:0.85em;margin-left:8px;";

async function discoverManagedKernel(): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const health = await fetch("/health", { cache: "no-store" }).then((response) => response.json());
      const managed = health?.kernel;
      if (managed?.baseUrl) kernelBaseInput.value = String(managed.baseUrl);
      if (managed?.box?.id && !notebookInput.value) notebookInput.value = String(managed.box.id);
      if (managed?.state === "listening") {
        statusEl.textContent = "managed kernel ready";
        return;
      }
    } catch {
      // Manual URLs remain supported for an isolated lab page.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  statusEl.textContent = "managed kernel unavailable; enter a URL manually";
}

for (const el of [kernelBaseInput, notebookInput, connectBtn, statusEl]) toolbar.appendChild(el);
if (window.__noemaKernel?.state === "listening" && window.__noemaKernel.box?.id) {
  notebookInput.value = window.__noemaKernel.box.id;
} else {
  void discoverManagedKernel();
}

const body = document.createElement("div");
body.style.cssText = "display:flex;flex:1;min-height:0;";
root.appendChild(body);

const sidebar = document.createElement("div");
sidebar.style.cssText = "width:220px;flex:0 0 auto;overflow-y:auto;border-right:1px solid var(--aaron-role-faded,#435574);padding:8px;";
body.appendChild(sidebar);

const newDocRow = document.createElement("div");
newDocRow.style.cssText = "display:flex;gap:4px;margin-bottom:8px;";
const newPathInput = makeInput("new doc path", "/notes/new.md", "140px");
const newDocBtn = makeButton("+");
newDocBtn.style.padding = "5px 8px";
newDocRow.append(newPathInput, newDocBtn);
sidebar.appendChild(newDocRow);

const docListEl = document.createElement("div");
sidebar.appendChild(docListEl);

const editorHost = document.createElement("div");
editorHost.style.cssText = "flex:1;overflow:auto;min-height:0;";
body.appendChild(editorHost);

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.style.color = isError ? "var(--aaron-status-error,#ff8fa3)" : "";
}

function kernelBase(): string {
  return kernelBaseInput.value.trim().replace(/\/+$/, "");
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${kernelBase()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

let editor: Editor | null = null;
let currentNotebook = "";
let currentPath = "";
let currentDocID = "";
let lastSyncedMarkdown = "";
let saveTimer = 0;
let saveInFlight = false;
let saveAgainAfterFlight = false;
let ws: WebSocket | null = null;
let wsReconnectTimer = 0;

function ensureEditor(): Editor {
  if (editor) return editor;
  editor = createEditor(editorHost, {
    initialContent: "",
    onChange: () => {
      if (!currentNotebook || !currentPath) return;
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => void doSave(), 800);
    },
  });
  return editor;
}

function docIDFromBlocks(blocks: MarkdownBlockRef[]): string {
  return blocks.find((b) => "NodeDocument" === b.type)?.id ?? "";
}

async function doLoad(path?: string): Promise<void> {
  currentNotebook = notebookInput.value.trim();
  currentPath = path ?? currentPath;
  if (!currentNotebook || !currentPath) {
    setStatus("notebook and path are required", true);
    return;
  }
  setStatus("loading…");
  try {
    const resp = await postJson<LoadDocResponse>("/api/noema/markdown/loadDoc", {
      notebook: currentNotebook,
      path: currentPath,
    });
    if (0 !== resp.code || !resp.data) {
      setStatus(`load failed: ${resp.msg}`, true);
      return;
    }
    ensureEditor().setMarkdown(resp.data.markdown, { history: "reset" });
    lastSyncedMarkdown = resp.data.markdown;
    currentDocID = docIDFromBlocks(resp.data.blocks);
    connectWs();
    highlightActiveDoc();
    setStatus(`loaded, ${resp.data.blocks.length} block(s) with a persisted ID`);
  } catch (err) {
    setStatus(`load error: ${String(err)}`, true);
  }
}

// Block-ref widgets stay host-agnostic and only dispatch this event. The lab
// is the first Go-backed host adapter: resolve canonical UUIDv7 -> repository
// path/line in the kernel, open that exact source document, then let CM6 own
// the source offset and scrolling.
editorHost.addEventListener("aaronnote:open-block-ref", (event) => {
  const custom = event as CustomEvent<{ id?: string }>;
  const id = String(custom.detail?.id || "").trim();
  if (!id) return;
  event.preventDefault();
  void (async () => {
    setStatus(`resolving block ${id}…`);
    try {
      const resp = await postJson<ResolveBlockResponse>("/api/noema/markdown/resolveBlock", { id });
      if (0 !== resp.code || !resp.data) {
        setStatus(`block resolve failed: ${resp.msg}`, true);
        return;
      }
      notebookInput.value = resp.data.notebook;
      await doLoad(resp.data.path);
      if (!editor || currentNotebook !== resp.data.notebook || currentPath !== resp.data.path) return;
      const offset = markdownLineStartOffset(editor.getMarkdown(), resp.data.line || 1);
      editor.setMarkdownSelection(offset, offset);
      editor.revealCursor();
      setStatus(`opened block ${resp.data.id} at ${resp.data.path}:${resp.data.line || 1}`);
    } catch (err) {
      setStatus(`block resolve error: ${String(err)}`, true);
    }
  })();
});

// Document browser sidebar. A markdown box has no notion of "open this
// notebook" the way a .sy box does — Connect just means "the notebook ID
// field is good enough to list and load against". Manually refreshable
// (button + after every load/save/new-doc) rather than wired to
// PushReloadFiletree's WS event: that broadcasts to a different session
// "type" (filetree, not main) than the live-reload connection uses, and a
// second parallel WS connection isn't worth it yet for a lab page — see
// plan.md's "一点点写一点点挪" note.
async function refreshDocList(): Promise<void> {
  const notebook = notebookInput.value.trim();
  if (!notebook) {
    docListEl.textContent = "";
    return;
  }
  let resp: ListDocsResponse;
  try {
    resp = await postJson<ListDocsResponse>("/api/noema/markdown/listDocs", { notebook });
  } catch (err) {
    docListEl.textContent = `list failed: ${String(err)}`;
    return;
  }
  if (0 !== resp.code || !resp.data) {
    docListEl.textContent = `list failed: ${resp.msg}`;
    return;
  }
  docListEl.textContent = "";
  for (const doc of resp.data.docs) {
    const entry = document.createElement("div");
    entry.textContent = doc.title;
    entry.title = doc.path;
    entry.dataset.path = doc.path;
    entry.style.cssText = "padding:4px 6px;border-radius:4px;cursor:pointer;font-size:0.9em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    entry.addEventListener("click", () => void doLoad(doc.path));
    docListEl.appendChild(entry);
  }
  if (0 === resp.data.docs.length) {
    docListEl.textContent = "(no documents yet)";
    docListEl.style.opacity = "0.6";
  } else {
    docListEl.style.opacity = "1";
  }
  highlightActiveDoc();
}

function highlightActiveDoc(): void {
  for (const child of Array.from(docListEl.children)) {
    const el = child as HTMLElement;
    el.style.background = el.dataset.path === currentPath ? "var(--aaron-surface-selected,#2d3b57)" : "";
  }
}

// Live reload: an external editor (Emacs, git checkout, ...) changed the file
// on disk. The kernel's watcher (markdown_watcher.go) picks it up, reindexes,
// and pushes a "reloaddoc" WS event carrying the doc's root ID — this is the
// core "Emacs and CM6 see the same document live" experience the whole point
// of this fork is chasing. Never silently clobber an unsaved local edit: only
// auto-reload when the editor's content still matches what we last confirmed
// synced with the server.
interface WsPush {
  cmd: string;
  data: unknown;
}

function wsUrl(): string {
  const base = kernelBase().replace(/^https:\/\//, "wss://").replace(/^http:\/\//, "ws://");
  const sessionId = Math.random().toString(36).slice(2);
  return `${base}/ws?app=noema-markdown-box-lab&id=${sessionId}&type=main`;
}

function connectWs(): void {
  window.clearTimeout(wsReconnectTimer);
  ws?.close();
  ws = null;
  if (!currentNotebook) return;

  const socket = new WebSocket(wsUrl());
  ws = socket;
  socket.addEventListener("message", (event) => {
    let msg: WsPush;
    try {
      msg = JSON.parse(String(event.data)) as WsPush;
    } catch {
      return;
    }
    if ("reloaddoc" !== msg.cmd || !currentDocID || msg.data !== currentDocID) return;
    void reloadIfUnedited();
  });
  socket.addEventListener("close", () => {
    if (ws !== socket) return; // superseded by a newer connection; don't reconnect on its behalf
    ws = null;
    wsReconnectTimer = window.setTimeout(connectWs, 2000);
  });
  socket.addEventListener("error", () => socket.close());
}

async function reloadIfUnedited(): Promise<void> {
  if (!editor || !currentNotebook || !currentPath) return;
  if (editor.getMarkdown() !== lastSyncedMarkdown) {
    setStatus("changed externally — you have unsaved edits here, not auto-reloading", true);
    return;
  }
  setStatus("reloading (changed externally)…");
  await doLoad();
}

async function doSave(): Promise<void> {
  if (!editor || !currentNotebook || !currentPath) return;
  if (saveInFlight) {
    saveAgainAfterFlight = true;
    return;
  }
  const sent = editor.getMarkdown();
  saveInFlight = true;
  setStatus("saving…");
  try {
    const resp = await postJson<LoadDocResponse>("/api/noema/markdown/saveDoc", {
      notebook: currentNotebook,
      path: currentPath,
      markdown: sent,
    });
    if (0 !== resp.code || !resp.data) {
      setStatus(`save failed: ${resp.msg}`, true);
      return;
    }
    // Only reconcile normalization drift if the user hasn't kept typing past what we sent.
    if (editor.getMarkdown() === sent) {
      if (resp.data.markdown !== sent) {
        editor.setMarkdown(resp.data.markdown, { history: "skip", preserveView: true });
      }
      lastSyncedMarkdown = resp.data.markdown;
    }
    currentDocID = docIDFromBlocks(resp.data.blocks);
    setStatus(`saved (${resp.data.blocks.length} persisted block ID(s))`);
    void refreshDocList(); // cheap; catches a brand-new path appearing in the sidebar
  } catch (err) {
    setStatus(`save error: ${String(err)}`, true);
  } finally {
    saveInFlight = false;
    if (saveAgainAfterFlight) {
      saveAgainAfterFlight = false;
      void doSave();
    }
  }
}

connectBtn.addEventListener("click", () => void refreshDocList());
newDocBtn.addEventListener("click", () => {
  const p = newPathInput.value.trim();
  if (!p) return;
  newPathInput.value = "";
  void doLoad(p);
});
ensureEditor();
setStatus("enter a notebook ID, click Connect, then pick or create a doc");
