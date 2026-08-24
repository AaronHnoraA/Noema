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

const kernelBaseInput = makeInput("kernel base URL", "http://127.0.0.1:16888", "220px");
const notebookInput = makeInput("notebook ID", "", "220px");
const pathInput = makeInput("path", "/notes/hello.md", "220px");
const loadBtn = document.createElement("button");
loadBtn.textContent = "Load";
loadBtn.style.cssText = "background:var(--aaron-role-popout,#7ee7ff);color:#141a27;border:none;border-radius:4px;padding:5px 12px;cursor:pointer;font:inherit;";
const statusEl = document.createElement("span");
statusEl.style.cssText = "opacity:0.75;font-size:0.85em;margin-left:8px;";

for (const el of [kernelBaseInput, notebookInput, pathInput, loadBtn, statusEl]) toolbar.appendChild(el);

const editorHost = document.createElement("div");
editorHost.style.cssText = "flex:1;overflow:auto;min-height:0;";
root.appendChild(editorHost);

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
let saveTimer = 0;
let saveInFlight = false;
let saveAgainAfterFlight = false;

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

async function doLoad(): Promise<void> {
  currentNotebook = notebookInput.value.trim();
  currentPath = pathInput.value.trim();
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
    setStatus(`loaded, ${resp.data.blocks.length} block(s) with a persisted ID`);
  } catch (err) {
    setStatus(`load error: ${String(err)}`, true);
  }
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
    if (editor.getMarkdown() === sent && resp.data.markdown !== sent) {
      editor.setMarkdown(resp.data.markdown, { history: "skip", preserveView: true });
    }
    setStatus(`saved (${resp.data.blocks.length} persisted block ID(s))`);
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

loadBtn.addEventListener("click", () => void doLoad());
ensureEditor();
setStatus("enter a notebook ID + path, then Load");
