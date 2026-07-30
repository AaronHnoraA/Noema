// Entry point for the standalone `/agenda` page (see agenda.html). Mounts
// the shared `agenda-view.ts` renderer in page mode, using the same
// `api-client.ts` facade the embedded editor uses — `window.aaronnoteApi` is
// available here too, via the server's `adapterScript` bridge injected into
// this page's `<head>` (see `web-host.mjs` `serveStatic`).
import "./style.css";
import { api } from "./api-client.ts";
import type { TodoItem } from "./api-client.ts";
import { openAgendaView, refreshAgendaView } from "./agenda-view.ts";

let statusEl: HTMLElement | null = null;

function ensureStatusEl(): HTMLElement {
  if (statusEl) return statusEl;
  statusEl = document.createElement("div");
  statusEl.className = "aaronnote-agenda-page-status";
  document.body.appendChild(statusEl);
  return statusEl;
}

let statusTimer = 0;
function setStatus(message: string): void {
  const el = ensureStatusEl();
  el.textContent = message;
  el.classList.add("is-visible");
  window.clearTimeout(statusTimer);
  statusTimer = window.setTimeout(() => el.classList.remove("is-visible"), 4000);
}

async function jumpToTodo(todo: TodoItem): Promise<void> {
  const file = String(todo.file || todo.path || "");
  if (!file) return;
  await api.emacs.open({ file, line: typeof todo.line === "number" ? todo.line : undefined });
}

void openAgendaView({ api, jumpToTodo, setStatus, pageMode: true });

window.addEventListener("aaronnote:command", (event) => {
  const detail = (event as CustomEvent<{ command?: string }>).detail;
  if (detail?.command === "agenda-changed" || detail?.command === "notes-index-changed") {
    void refreshAgendaView();
  }
});
