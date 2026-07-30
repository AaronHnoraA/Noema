// Full-screen, vault-wide agenda view (org-agenda-class): week/list/month/
// log/gantt/projects/clocktable/lints views over the server-computed agenda
// view-model (`api.notes.agenda`). This is the first-class surface for
// priority/scheduled/deadline/repeat/dependency/project/clock work across
// the whole vault — served as its own page (see `agenda.html`/
// `agenda-main.ts`) as well as embeddable via `openAgendaView`. All edits
// round-trip through `api.notes.patchTodo`/`clockIn`/`clockOut`, which write
// straight back into markdown — this view holds no state that isn't
// re-derivable from it. See `docs/agenda.md` for the view-model shapes.
import type { AgendaEntry, AgendaMsg, GanttMilestone, GanttTask, ProjectRollup, TodoItem, TodoLint } from "./api-client.ts";

export type AgendaViewDeps = {
  api: {
    notes: {
      agenda: (body: Record<string, unknown>) => Promise<AgendaMsg>;
      createTodo: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
      patchTodo: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
      todoDepRef: (body: Record<string, unknown>) => Promise<{ ref?: string }>;
      clockIn: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
      clockOut: (body: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  };
  jumpToTodo: (todo: TodoItem) => void | Promise<void>;
  setStatus: (message: string) => void;
  /** True when mounted as the standalone `/agenda` page: hides the "Close"
   * button (there is nothing to return to) and syncs `view`/`q` to the URL. */
  pageMode?: boolean;
};

type ViewKind = "week" | "list" | "month" | "log" | "gantt" | "projects" | "clocktable" | "lints";

// Legacy/external view names (e.g. `main.ts`'s Agenda+ link, or a bookmark)
// map onto the real ones above.
const VIEW_ALIASES: Record<string, ViewKind> = { agenda: "week", calendar: "month" };

function normalizeView(raw: string | null | undefined): ViewKind {
  const v = String(raw || "").trim().toLowerCase();
  if (VIEW_ALIASES[v]) return VIEW_ALIASES[v];
  const known: ViewKind[] = ["week", "list", "month", "log", "gantt", "projects", "clocktable", "lints"];
  return (known as string[]).includes(v) ? (v as ViewKind) : "week";
}

const DAY_MS = 86_400_000;
const STATUS_CYCLE = ["todo", "doing", "done"];

let deps: AgendaViewDeps | null = null;
let overlay: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let headerEl: HTMLElement | null = null;
let statsEl: HTMLElement | null = null;
let data: AgendaMsg | null = null;
let view: ViewKind = "week";
let anchorMs = midnight(Date.now());
let query = "";
let cursorId = "";
let selection = new Set<string>();
let loading = false;
let helpOpen = false;
let projectPickerOpen = false;
let projectFilter = new Set<string>();
let keydownInstalled = false;
let documentClickInstalled = false;

// Bumped on every fetchAgenda() call; a response is only applied if its
// token is still current when it resolves — guards against an
// earlier-issued, later-resolving fetch (rapid f/b/v, or a nav overlapping
// an edit's own refetch) clobbering a newer one's result.
let fetchGeneration = 0;
// Set immediately before a local edit's own fetchAgenda() call. The SSE
// `agenda-changed`/`notes-index-changed` handler (refreshAgendaView) skips a
// refresh triggered inside this window — that broadcast is an echo of the
// edit we already issued our own refetch for, so acting on it too just
// duplicates the request.
let lastLocalMutationMs = 0;
const LOCAL_MUTATION_SUPPRESS_MS = 800;

type GanttScale = "day" | "week" | "month";
type GanttDragMode = "move" | "resize-start" | "resize-end" | "progress";
type GanttDragState = {
  task: GanttTask;
  mode: GanttDragMode;
  bar: HTMLElement;
  timeline: HTMLElement;
  range: { min: number; days: number; pxPerDay: number };
  startX: number;
  originStartMs: number;
  originEndMs: number;
  originProgress: number;
  previewStartMs: number;
  previewEndMs: number;
  previewProgress: number;
};

let ganttScale: GanttScale = "day";
let ganttCollapsed = new Set<string>();
let ganttDrag: GanttDragState | null = null;
let ganttDragListenersInstalled = false;
let calendarDrag: { todoId: string; field: "ddl" | "sche"; originalDate?: string } | null = null;

const SHORTCUT_GROUPS: Array<[string, Array<[string, string]>]> = [
  ["Navigation", [
    ["j / ↓", "Next item"],
    ["k / ↑", "Previous item"],
    ["Enter / Tab", "Jump to item"],
    ["f / b", "Next / previous range"],
    [".", "Today"],
    ["v", "Next view"],
  ]],
  ["Edit", [
    ["n", "New todo"],
    ["t", "Cycle status"],
    ["p / ,", "Set priority"],
    ["d", "Set deadline"],
    ["s", "Set scheduled"],
    ["r", "Set repeat"],
    ["a", "Add dependency"],
    ["c", "Clock in / out"],
  ]],
  ["Manage", [
    ["m / u", "Mark / unmark"],
    ["B", "Bulk status"],
    ["g", "Refresh"],
    ["?", "Show shortcuts"],
    ["q / Esc", "Close"],
  ]],
];

function midnight(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function parseYmd(s: string): number {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return midnight(Date.now());
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
}

function startOfMonth(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
}

function addDays(ms: number, days: number): number {
  const d = new Date(ms);
  d.setDate(d.getDate() + days);
  return midnight(d.getTime());
}

function addMonths(ms: number, months: number): number {
  const d = new Date(ms);
  const day = d.getDate();
  const target = new Date(d.getFullYear(), d.getMonth() + months, 1);
  const maxDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(day, maxDay));
  return midnight(target.getTime());
}

function calendarGridStart(ms: number): number {
  const first = startOfMonth(ms);
  return addDays(first, -new Date(first).getDay());
}

function todoField(todo: TodoItem, ...keys: string[]): string {
  for (const key of keys) {
    const value = (todo as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return "";
}

function todoNote(todo: TodoItem): string {
  return todoField(todo, "noteTitle", "title", "path") || "Untitled";
}

function todoText(todo: TodoItem): string {
  return todoField(todo, "text") || "(empty todo)";
}

function todoStatus(todo: TodoItem): string {
  return (todo.effectiveStatus as string) || (todo.status as string) || "todo";
}

function todoPrio(todo: TodoItem): string {
  return String((todo.canon as Record<string, string> | undefined)?.prio || "");
}

function normalizeProjectKey(value: unknown): string {
  return String(value || "").trim();
}

// Reverse index (childTodoId -> project key) over `data.projectModel`,
// rebuilt only when the `data` object identity changes — avoids an O(projects
// * childIds) `.find`/`.includes` scan on every todo, on every render.
let projectChildIndexData: AgendaMsg | null = null;
let projectChildIndexMap = new Map<string, string>();

function ensureProjectChildIndex(): Map<string, string> {
  if (projectChildIndexData !== data) {
    projectChildIndexData = data;
    projectChildIndexMap = new Map();
    for (const project of data?.projectModel || []) {
      const key = normalizeProjectKey(project.key);
      if (!key) continue;
      for (const id of project.childTodoIds || []) {
        if (!projectChildIndexMap.has(id)) projectChildIndexMap.set(id, key);
      }
    }
  }
  return projectChildIndexMap;
}

function projectForTodo(todo: TodoItem): string {
  const canon = (todo.canon as Record<string, string> | undefined) || {};
  const explicit = normalizeProjectKey(canon.project || canon.proj || (todo as Record<string, unknown>).project || (todo as Record<string, unknown>).proj);
  if (explicit) return explicit;
  const id = String(todo.id || "");
  if (id) {
    const key = ensureProjectChildIndex().get(id);
    if (key) return key;
  }
  return "";
}

function projectTitleForKey(key: string): string {
  const normalized = normalizeProjectKey(key);
  if (!normalized) return "No project";
  const project = (data?.projectModel || []).find((entry) => normalizeProjectKey(entry.key) === normalized);
  return normalizeProjectKey(project?.title) || normalized;
}

function projectMatchesFilter(key: unknown): boolean {
  if (projectFilter.size === 0) return true;
  const normalized = normalizeProjectKey(key);
  return Boolean(normalized && projectFilter.has(normalized));
}

function matchesProject(todo: TodoItem): boolean {
  return projectMatchesFilter(projectForTodo(todo));
}

function todoHaystack(todo: TodoItem): string {
  const projectKey = projectForTodo(todo);
  return [
    todoStatus(todo),
    todoPrio(todo),
    projectKey,
    projectTitleForKey(projectKey),
    todoNote(todo),
    todoText(todo),
    todoField(todo, "id", "noteId", "path", "file"),
    ...(Array.isArray(todo.tags) ? todo.tags : []),
  ].join(" ").toLowerCase();
}

function matchesQuery(todo: TodoItem): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((term) => todoHaystack(todo).includes(term));
}

function matchesTodo(todo: TodoItem): boolean {
  return matchesProject(todo) && matchesQuery(todo);
}

// Rebuilt only when the `data` object identity changes (i.e. once per
// fetchAgenda(), not once per lookup) — avoids an O(todos) `.find` scan on
// every row of every render.
let todoIndexData: AgendaMsg | null = null;
let todoIndexMap = new Map<string, TodoItem>();

function ensureTodoIndex(): Map<string, TodoItem> {
  if (todoIndexData !== data) {
    todoIndexData = data;
    todoIndexMap = new Map();
    for (const todo of data?.todos || []) todoIndexMap.set(String(todo.id || ""), todo);
  }
  return todoIndexMap;
}

function todoById(id: string): TodoItem | undefined {
  return ensureTodoIndex().get(id);
}

// Grouped once per renderBody() pass (query/projectFilter can change every
// render, unlike the todo/project indexes above) instead of re-filtering
// the full lint list — and re-`todoById`-scanning it — once per row.
let lintsByTodoIdMap = new Map<string, TodoLint[]>();

function rebuildLintsByTodoId(): void {
  lintsByTodoIdMap = new Map();
  for (const lint of visibleLints()) {
    if (!lint.todoId) continue;
    const list = lintsByTodoIdMap.get(lint.todoId);
    if (list) list.push(lint);
    else lintsByTodoIdMap.set(lint.todoId, [lint]);
  }
}

function lintsFor(todoId: string): TodoLint[] {
  return lintsByTodoIdMap.get(todoId) || [];
}

type ProjectOption = { key: string; title: string; total: number; open: number };

function emptyProjectOption(key: string): ProjectOption {
  return { key, title: projectTitleForKey(key), total: 0, open: 0 };
}

function projectOptions(): ProjectOption[] {
  const byKey = new Map<string, ProjectOption>();
  const ensure = (key: unknown, title?: unknown): ProjectOption | null => {
    const normalized = normalizeProjectKey(key);
    if (!normalized) return null;
    if (!byKey.has(normalized)) byKey.set(normalized, emptyProjectOption(normalized));
    const option = byKey.get(normalized)!;
    const label = normalizeProjectKey(title);
    if (label && option.title === normalized) option.title = label;
    return option;
  };

  for (const project of data?.projectModel || []) {
    ensure(project.key, project.title);
  }
  for (const todo of data?.todos || []) {
    const key = projectForTodo(todo);
    const option = ensure(key);
    if (!option) continue;
    option.total++;
    const status = todoStatus(todo);
    if (status !== "done" && status !== "cancelled") option.open++;
  }
  for (const task of [...(data?.gantt?.tasks || []), ...(data?.gantt?.backlog || [])]) ensure(task.project);
  for (const milestone of data?.gantt?.milestones || []) ensure(milestone.project);
  for (const key of Object.keys(data?.clocktable?.byProject || {})) ensure(key);

  return [...byKey.values()]
    .filter((option) => option.total > 0 || projectFilter.has(option.key))
    .sort((a, b) => b.open - a.open || b.total - a.total || a.title.localeCompare(b.title));
}

function visibleTodos(): TodoItem[] {
  return (data?.todos || []).filter(matchesTodo);
}

function matchesLint(lint: TodoLint): boolean {
  const todo = lint.todoId ? todoById(lint.todoId) : undefined;
  if (projectFilter.size > 0 && (!todo || !matchesProject(todo))) return false;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    lint.kind,
    lint.ref,
    lint.message,
    lint.file,
    todo ? todoHaystack(todo) : "",
  ].join(" ").toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

function visibleLints(): TodoLint[] {
  return (data?.lints || []).filter(matchesLint);
}

const WIDE_VIEWS = new Set<ViewKind>(["gantt", "projects", "clocktable", "lints"]);

function syncPageUrl(): void {
  if (!deps?.pageMode || typeof history === "undefined") return;
  const params = new URLSearchParams();
  params.set("view", view);
  if (query) params.set("q", query);
  for (const key of projectFilter) params.append("project", key);
  history.replaceState(null, "", `/agenda?${params.toString()}`);
}

function focusAgenda(): void {
  if (!overlay || overlay.hidden) return;
  try {
    overlay.focus({ preventScroll: true });
  } catch {
    overlay.focus();
  }
}

function installKeydownHandler(): void {
  if (keydownInstalled || typeof document === "undefined") return;
  document.addEventListener("keydown", handleKeydown, true);
  keydownInstalled = true;
}

function handleDocumentClick(event: MouseEvent): void {
  if (!overlay || overlay.hidden || !projectPickerOpen) return;
  const target = targetElement(event.target);
  if (target?.closest(".aaronnote-agenda-full-project-filter")) return;
  projectPickerOpen = false;
  render();
}

function installDocumentClickHandler(): void {
  if (documentClickInstalled || typeof document === "undefined") return;
  document.addEventListener("click", handleDocumentClick);
  documentClickInstalled = true;
}

installKeydownHandler();
installDocumentClickHandler();

async function fetchAgenda(): Promise<void> {
  if (!deps) return;
  const gen = ++fetchGeneration;
  loading = true;
  render();
  try {
    const wide = WIDE_VIEWS.has(view);
    const from = wide ? fmtDate(midnight(Date.now())) : view === "month" ? fmtDate(calendarGridStart(anchorMs)) : fmtDate(anchorMs);
    const days = wide ? 60 : view === "month" ? 42 : view === "week" ? 7 : view === "list" ? 30 : 60;
    const next = await deps.api.notes.agenda({ from, days, includePlanning: true, includeGantt: true });
    if (gen !== fetchGeneration) return;
    data = next;
  } catch (error) {
    if (gen !== fetchGeneration) return;
    deps.setStatus(error instanceof Error ? error.message : "Agenda failed");
    data = null;
  } finally {
    if (gen === fetchGeneration) {
      loading = false;
      render();
    }
  }
}

// --- editing actions (all round-trip through patchTodo / write straight to disk) ---

function todoPatchBase(todo: TodoItem): Record<string, unknown> {
  return {
    file: todoField(todo, "file"),
    id: todoField(todo, "id"),
    index: todo.index,
    source: todoField(todo, "source"),
    text: todoText(todo),
  };
}

async function applyPatch(todo: TodoItem, patch: Record<string, unknown>): Promise<void> {
  if (!deps) return;
  try {
    await deps.api.notes.patchTodo({ ...todoPatchBase(todo), ...patch });
    lastLocalMutationMs = Date.now();
    await fetchAgenda();
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Todo update failed");
  }
}

function cycleStatus(todo: TodoItem): void {
  const current = (todo.status as string) || "todo";
  const idx = STATUS_CYCLE.indexOf(current);
  const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
  if (next === "done") {
    void applyPatch(todo, { op: "complete" });
  } else {
    void applyPatch(todo, { status: next });
  }
}

function promptEdit(label: string, current: string, apply: (value: string) => void): void {
  const value = window.prompt(label, current);
  if (value === null) return;
  apply(value.trim());
}

function parseQuickTodo(raw: string): Record<string, unknown> {
  const chunks = raw.split("|").map((part) => part.trim()).filter(Boolean);
  const text = chunks.shift() || "";
  const body: Record<string, unknown> = { text };
  for (const chunk of chunks) {
    const match = chunk.match(/^([A-Za-z][\w-]*)\s*[:=]\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key && value) body[key] = value;
  }
  return body;
}

async function createTodoFromPrompt(): Promise<void> {
  if (!deps) return;
  const current = cursorId ? todoById(cursorId) : undefined;
  const singleProject = projectFilter.size === 1 ? [...projectFilter][0] : "";
  const project = singleProject || (current ? projectForTodo(current) : "");
  const raw = window.prompt("New todo: task | project=paper | ddl=today | sche=+1d | prio=A | file=inbox.md", "");
  if (raw === null) return;
  const body = parseQuickTodo(raw);
  if (!String(body.text || "").trim()) return;
  if (!body.file && current?.file) body.file = current.file;
  if (!body.project && project) body.project = project;
  try {
    const result = await deps.api.notes.createTodo(body);
    const todo = result.todo as TodoItem | undefined;
    if (todo?.id) cursorId = String(todo.id);
    lastLocalMutationMs = Date.now();
    await fetchAgenda();
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Todo create failed");
  }
}

async function refreshAgendaFromUi(): Promise<void> {
  await fetchAgenda();
  if (data) deps?.setStatus("Agenda refreshed");
  focusAgenda();
}

function applyProjectFilter(keys: Iterable<string>, options: { keepPicker?: boolean; announce?: boolean } = {}): void {
  projectFilter = new Set([...keys].map(normalizeProjectKey).filter(Boolean));
  projectPickerOpen = options.keepPicker === true;
  cursorId = "";
  syncPageUrl();
  render();
  if (options.announce) {
    const label = projectFilter.size === 0
      ? "Any project"
      : [...projectFilter].map(projectTitleForKey).join(", ");
    deps?.setStatus(`Project filter: ${label}`);
  }
  focusAgenda();
}

function toggleProjectFilter(key: string): void {
  const normalized = normalizeProjectKey(key);
  if (!normalized) return;
  const next = new Set(projectFilter);
  if (next.has(normalized)) next.delete(normalized);
  else next.add(normalized);
  applyProjectFilter(next, { keepPicker: true });
}

function focusProject(key: string): void {
  const normalized = normalizeProjectKey(key);
  if (!normalized) return;
  view = "list";
  applyProjectFilter([normalized], { announce: true });
}

// Steps by each view's actual fetch window (see fetchAgenda's `days`) so f/b
// paging moves a full window instead of always paging by a week and
// producing large overlapping re-fetches for the 30/60-day list/log views.
function shiftAnchor(ranges: number): void {
  if (view === "month") anchorMs = addMonths(anchorMs, ranges);
  else if (view === "list") anchorMs = addDays(anchorMs, ranges * 30);
  else if (view === "log") anchorMs = addDays(anchorMs, ranges * 60);
  else anchorMs = addDays(anchorMs, ranges * 7);
}

function showHelp(): void {
  projectPickerOpen = false;
  helpOpen = true;
  render();
  focusAgenda();
}

function closeHelp(): void {
  if (!helpOpen) return;
  helpOpen = false;
  render();
  focusAgenda();
}

function toggleHelp(): void {
  if (helpOpen) closeHelp();
  else showHelp();
}

function editPriority(todo: TodoItem): void {
  promptEdit("Priority (A-F, blank to clear):", todoPrio(todo), (value) => {
    void applyPatch(todo, { prio: value });
  });
}

function editDeadline(todo: TodoItem): void {
  const current = (todo.canon as Record<string, string> | undefined)?.ddl || "";
  promptEdit("Deadline (e.g. 2026-07-10, +1w, today; blank to clear):", current, (value) => {
    void applyPatch(todo, { ddl: value });
  });
}

function editScheduled(todo: TodoItem): void {
  const current = (todo.canon as Record<string, string> | undefined)?.sche || "";
  promptEdit("Scheduled (e.g. 2026-07-10, +1w, today; blank to clear):", current, (value) => {
    void applyPatch(todo, { sche: value });
  });
}

function editRepeat(todo: TodoItem): void {
  const current = (todo.canon as Record<string, string> | undefined)?.repeat || "";
  promptEdit("Repeat (+1w / ++1w / .+3d; blank to clear):", current, (value) => {
    void applyPatch(todo, { repeat: value });
  });
}

async function addDependency(todo: TodoItem): Promise<void> {
  if (!deps || !data) return;
  // Validation below checks against `shown.length`, not the full candidate
  // count — matching what the prompt actually lists, so a number beyond the
  // displayed 200 is rejected instead of silently resolving to an unlisted
  // todo.
  const shown = (data.todos || []).filter((t) => t.id !== todo.id).slice(0, 200);
  const label = shown
    .map((t, i) => `${i + 1}. [${todoNote(t)}] ${todoText(t)}`)
    .join("\n");
  const raw = window.prompt(`Depends on which # (from below)?\n\n${label}`, "");
  if (!raw) return;
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > shown.length) {
    deps.setStatus("No matching todo number");
    return;
  }
  const target = shown[n - 1];
  try {
    const { ref } = await deps.api.notes.todoDepRef({ targetId: target.id, sourceId: todo.id });
    if (!ref) throw new Error("Could not build a dependency reference");
    await applyPatch(todo, { afterAdd: ref });
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Dependency link failed");
  }
}

async function clockInTodo(todo: TodoItem): Promise<void> {
  if (!deps) return;
  try {
    await deps.api.notes.clockIn(todoPatchBase(todo));
    lastLocalMutationMs = Date.now();
    await fetchAgenda();
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Clock in failed");
  }
}

async function clockOutRunning(): Promise<void> {
  if (!deps) return;
  try {
    await deps.api.notes.clockOut({});
    lastLocalMutationMs = Date.now();
    await fetchAgenda();
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Clock out failed");
  }
}

function toggleMark(id: string): void {
  if (selection.has(id)) selection.delete(id);
  else selection.add(id);
  render();
}

// Batches the patches themselves (rather than reusing applyPatch, which
// would issue a full agenda refetch after *every* todo) and issues a single
// refetch once the whole selection has landed.
async function bulkStatus(): Promise<void> {
  if (!deps || selection.size === 0) return;
  const value = window.prompt("Bulk set status (todo/doing/done/blocked/cancelled):", "done");
  if (!value) return;
  const status = value.trim().toLowerCase();
  const ids = [...selection];
  selection.clear();
  const touchedFiles = new Set<string>();
  let failed = 0;
  for (const id of ids) {
    const todo = todoById(id);
    if (!todo) continue;
    const file = todoField(todo, "file");
    const base = todoPatchBase(todo);
    // A same-file todo patched earlier in this batch may have shifted this
    // one's `index` (status/attr changes alter line length) — omit it so
    // the server falls through to its text/source-based match instead of a
    // possibly-stale line anchor that could land on the wrong todo.
    if (touchedFiles.has(file)) delete base.index;
    const patch = status === "done" ? { op: "complete" } : { status };
    try {
      await deps.api.notes.patchTodo({ ...base, ...patch });
      touchedFiles.add(file);
    } catch {
      failed++;
    }
  }
  lastLocalMutationMs = Date.now();
  await fetchAgenda();
  deps.setStatus(
    failed > 0
      ? `Bulk update: ${ids.length - failed}/${ids.length} succeeded`
      : `Bulk update: ${ids.length} todo${ids.length === 1 ? "" : "s"} updated`,
  );
}

// --- rendering ---

function prioClass(prio: string): string {
  if (prio === "A") return "prio-a";
  if (prio === "B") return "prio-b";
  return "prio-other";
}

function renderHelpPanel(): HTMLElement {
  const backdrop = document.createElement("div");
  backdrop.className = "aaronnote-agenda-full-help";
  backdrop.dataset.agendaHelp = "1";

  const panel = document.createElement("div");
  panel.className = "aaronnote-agenda-full-help-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-label", "Agenda keyboard shortcuts");

  const head = document.createElement("div");
  head.className = "aaronnote-agenda-full-help-head";
  const title = document.createElement("h2");
  title.textContent = "Agenda shortcuts";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "Close";
  close.title = "Close help (Esc)";
  close.addEventListener("click", closeHelp);
  head.append(title, close);
  panel.appendChild(head);

  const grid = document.createElement("div");
  grid.className = "aaronnote-agenda-full-help-grid";
  for (const [group, rows] of SHORTCUT_GROUPS) {
    const section = document.createElement("section");
    const heading = document.createElement("h3");
    heading.textContent = group;
    section.appendChild(heading);
    for (const [key, label] of rows) {
      const row = document.createElement("div");
      row.className = "aaronnote-agenda-full-help-row";
      const keyEl = document.createElement("kbd");
      keyEl.textContent = key;
      const labelEl = document.createElement("span");
      labelEl.textContent = label;
      row.append(keyEl, labelEl);
      section.appendChild(row);
    }
    grid.appendChild(section);
  }
  panel.appendChild(grid);
  backdrop.appendChild(panel);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) closeHelp();
  });
  return backdrop;
}

function syncHelpPanel(): void {
  if (!overlay) return;
  overlay.querySelector<HTMLElement>("[data-agenda-help]")?.remove();
  if (helpOpen) overlay.appendChild(renderHelpPanel());
}

function projectFilterLabel(): string {
  if (projectFilter.size === 0) return "Project: Any";
  if (projectFilter.size === 1) return `Project: ${projectTitleForKey([...projectFilter][0])}`;
  return `Projects: ${projectFilter.size}`;
}

function renderProjectFilter(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-project-filter";

  const button = document.createElement("button");
  button.type = "button";
  button.className = projectFilter.size > 0 ? "is-active" : "";
  button.textContent = projectFilterLabel();
  button.title = "Filter agenda by project";
  button.addEventListener("click", () => {
    projectPickerOpen = !projectPickerOpen;
    render();
    focusAgenda();
  });
  wrap.appendChild(button);

  if (!projectPickerOpen) return wrap;

  const menu = document.createElement("div");
  menu.className = "aaronnote-agenda-full-project-menu";
  menu.addEventListener("mousedown", (event) => event.stopPropagation());

  const any = document.createElement("button");
  any.type = "button";
  any.className = projectFilter.size === 0 ? "is-selected" : "";
  any.textContent = "Any";
  any.addEventListener("click", () => applyProjectFilter([], { keepPicker: true }));
  menu.appendChild(any);

  const options = projectOptions();
  if (options.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-agenda-full-project-empty";
    empty.textContent = "No projects";
    menu.appendChild(empty);
  }
  for (const option of options) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = projectFilter.has(option.key) ? "is-selected" : "";
    item.dataset.projectKey = option.key;
    item.textContent = `${projectFilter.has(option.key) ? "✓ " : ""}${option.title} (${option.open}/${option.total})`;
    item.title = option.key;
    item.addEventListener("click", () => toggleProjectFilter(option.key));
    menu.appendChild(item);
  }

  wrap.appendChild(menu);
  return wrap;
}

function buildRow(todo: TodoItem, opts: { badge?: string } = {}): HTMLElement {
  const row = document.createElement("div");
  row.className = "aaronnote-agenda-full-row is-task-row";
  row.dataset.status = todoStatus(todo);
  row.dataset.todoId = String(todo.id || "");
  row.tabIndex = 0;
  row.setAttribute("role", "button");
  if (todo.id === cursorId) row.classList.add("is-cursor");
  if (todo.id && selection.has(String(todo.id))) row.classList.add("is-selected");

  const mark = document.createElement("span");
  mark.className = "aaronnote-agenda-full-mark";
  mark.textContent = todo.id && selection.has(String(todo.id)) ? "■" : "□";
  mark.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleMark(String(todo.id || ""));
  });

  const status = document.createElement("span");
  status.className = "aaronnote-agenda-full-status";
  status.textContent = todoStatus(todo).toUpperCase();
  status.addEventListener("click", (event) => {
    event.stopPropagation();
    cycleStatus(todo);
  });

  const prio = document.createElement("span");
  const prioValue = todoPrio(todo);
  prio.className = `aaronnote-agenda-full-prio ${prioValue ? prioClass(prioValue) : ""}`;
  prio.textContent = prioValue ? `#${prioValue}` : "";
  prio.addEventListener("click", (event) => {
    event.stopPropagation();
    editPriority(todo);
  });

  const badge = document.createElement("span");
  badge.className = "aaronnote-agenda-full-badge";
  badge.textContent = opts.badge || "";

  const clock = document.createElement("span");
  clock.className = "aaronnote-agenda-full-clock";
  const runningTodoId = data?.clocktable?.running?.todoId || "";
  const status0 = todoStatus(todo);
  if (todo.id && runningTodoId === String(todo.id)) {
    clock.classList.add("is-running");
    clock.textContent = `⏱ ${data?.clocktable?.running?.minutesSoFar ?? 0}m`;
    clock.title = "Clock out";
    clock.addEventListener("click", (event) => {
      event.stopPropagation();
      void clockOutRunning();
    });
  } else if (status0 !== "done" && status0 !== "cancelled") {
    clock.textContent = "⏱";
    clock.title = "Clock in";
    clock.addEventListener("click", (event) => {
      event.stopPropagation();
      void clockInTodo(todo);
    });
  }

  const body = document.createElement("span");
  body.className = "aaronnote-agenda-full-body";
  const text = document.createElement("span");
  text.className = "aaronnote-agenda-full-text";
  text.textContent = todoText(todo);
  const note = document.createElement("span");
  note.className = "aaronnote-agenda-full-note";
  note.textContent = todoNote(todo);
  body.append(text, note);

  const canon = (todo.canon as Record<string, string> | undefined) || {};
  if (canon.after) {
    const dep = document.createElement("span");
    dep.className = "aaronnote-agenda-full-dep";
    dep.textContent = `after: ${canon.after}`;
    body.appendChild(dep);
  }
  if (canon.repeat) {
    const rep = document.createElement("span");
    rep.className = "aaronnote-agenda-full-repeat";
    rep.textContent = `↻ ${canon.repeat}`;
    body.appendChild(rep);
  }
  const rowLints = lintsFor(String(todo.id || ""));
  if (rowLints.length > 0) {
    const lint = document.createElement("span");
    lint.className = "aaronnote-agenda-full-lint";
    lint.title = rowLints.map((l) => l.message || l.kind || "").join("; ");
    lint.textContent = "⚠";
    body.appendChild(lint);
  }

  row.append(mark, status, prio, clock, badge, body);
  row.addEventListener("click", () => {
    cursorId = String(todo.id || "");
    if (deps) void deps.jumpToTodo(todo);
  });
  return row;
}

function lintDetail(lint: TodoLint): string {
  const ref = typeof lint.ref === "string" && lint.ref.trim() && lint.ref.trim() !== "undefined" ? lint.ref.trim() : "";
  const todo = lint.todoId ? todoById(lint.todoId) : undefined;
  const subject = ref || (todo ? todoText(todo) : "") || lint.message || lint.kind || "issue";
  const label = (ref || todo) ? `"${subject}"` : subject;
  return `${label} (${lint.kind || "lint"})`;
}

function renderLints(): HTMLElement | null {
  const lints = visibleLints();
  if (lints.length === 0) return null;
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-lints";
  wrap.textContent = `${lints.length} issue${lints.length === 1 ? "" : "s"}: `;
  wrap.textContent += lints.slice(0, 6).map(lintDetail).join(", ");
  return wrap;
}

function renderWeek(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-week";
  for (const day of data?.days || []) {
    const col = document.createElement("div");
    col.className = "aaronnote-agenda-full-day";
    if (day.date === data?.range?.today) col.classList.add("is-today");
    const head = document.createElement("div");
    head.className = "aaronnote-agenda-full-day-head";
    head.textContent = day.date || "";
    col.appendChild(head);
    const entries = (day.entries || []).filter((e) => {
      const todo = e.todoId ? todoById(e.todoId) : undefined;
      return todo ? matchesTodo(todo) : projectFilter.size === 0 && !query.trim();
    });
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "aaronnote-empty";
      empty.textContent = "—";
      col.appendChild(empty);
    }
    for (const entry of entries) {
      const todo = entry.todoId ? todoById(entry.todoId) : undefined;
      if (!todo) continue;
      col.appendChild(buildRow(todo, { badge: entry.label || "" }));
    }
    wrap.appendChild(col);
  }
  return wrap;
}

function renderList(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-list";
  const todos = (data?.todos || [])
    .filter((t) => t.status !== "done" && t.status !== "cancelled")
    .filter(matchesTodo);
  const byNote = new Map<string, TodoItem[]>();
  for (const todo of todos) {
    const key = todoNote(todo);
    if (!byNote.has(key)) byNote.set(key, []);
    byNote.get(key)!.push(todo);
  }
  for (const [noteTitle, group] of [...byNote.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const head = document.createElement("div");
    head.className = "aaronnote-agenda-full-group-head";
    head.textContent = noteTitle;
    wrap.appendChild(head);
    for (const todo of group) wrap.appendChild(buildRow(todo));
  }
  if (todos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "No matching tasks";
    wrap.appendChild(empty);
  }
  return wrap;
}

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function cssToken(value: unknown): string {
  return String(value || "none").toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

function calendarTitle(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function calendarEntryField(entry: AgendaEntry): "ddl" | "sche" | null {
  if (entry.kind === "scheduled" || entry.kind === "sched-carry") return "sche";
  if (entry.kind === "deadline" || entry.kind === "warning" || entry.kind === "overdue") return "ddl";
  return null;
}

function calendarEntryRank(entry: AgendaEntry): number {
  if (entry.kind === "overdue") return 0;
  if (entry.kind === "deadline" || entry.kind === "warning") return 1;
  if (entry.kind === "scheduled" || entry.kind === "sched-carry") return 2;
  if (entry.kind === "repeat") return 3;
  return 4;
}

function calendarEntryBadge(entry: AgendaEntry): string {
  if (entry.kind === "deadline" || entry.kind === "warning" || entry.kind === "overdue") return "D";
  if (entry.kind === "scheduled" || entry.kind === "sched-carry") return "S";
  if (entry.kind === "repeat") return "R";
  if (entry.kind === "log") return "L";
  return "A";
}

function visibleCalendarEntries(entries: AgendaEntry[]): AgendaEntry[] {
  return entries
    .filter((entry) => {
      const todo = entry.todoId ? todoById(entry.todoId) : undefined;
      return todo ? matchesTodo(todo) : projectFilter.size === 0 && !query.trim();
    })
    .sort((a, b) => {
      const ranked = calendarEntryRank(a) - calendarEntryRank(b);
      if (ranked !== 0) return ranked;
      return String(a.time || "").localeCompare(String(b.time || ""));
    });
}

function clearCalendarDropTargets(): void {
  document.querySelectorAll<HTMLElement>(".aaronnote-calendar-day.is-drop-target")
    .forEach((cell) => cell.classList.remove("is-drop-target"));
}

async function moveCalendarTodoToDate(todo: TodoItem, field: "ddl" | "sche", date: string): Promise<void> {
  if (!deps) return;
  try {
    await deps.api.notes.patchTodo({ ...todoPatchBase(todo), [field]: date });
    deps.setStatus(`${field === "ddl" ? "Deadline" : "Scheduled"} set to ${date}`);
    lastLocalMutationMs = Date.now();
    await fetchAgenda();
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Calendar move failed");
  }
}

async function commitCalendarDrop(date: string): Promise<void> {
  const drag = calendarDrag;
  calendarDrag = null;
  clearCalendarDropTargets();
  if (!drag || drag.originalDate === date) return;
  const todo = todoById(drag.todoId);
  if (!todo) return;
  await moveCalendarTodoToDate(todo, drag.field, date);
}

function renderCalendarEvent(entry: AgendaEntry, dayDate: string): HTMLElement | null {
  const todo = entry.todoId ? todoById(entry.todoId) : undefined;
  if (!todo) return null;
  const field = calendarEntryField(entry);
  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = `aaronnote-calendar-event kind-${cssToken(entry.kind)} status-${cssToken(todoStatus(todo))}`;
  pill.dataset.todoId = String(todo.id || "");
  pill.draggable = Boolean(field);
  pill.title = [entry.label || entry.kind || "Agenda", todoNote(todo), field ? "drag to move" : ""].filter(Boolean).join(" · ");
  if (todo.id === cursorId) pill.classList.add("is-cursor");
  if (todo.id && selection.has(String(todo.id))) pill.classList.add("is-selected");

  const badge = document.createElement("span");
  badge.className = "aaronnote-calendar-event-badge";
  badge.textContent = calendarEntryBadge(entry);
  pill.appendChild(badge);

  if (entry.time) {
    const time = document.createElement("span");
    time.className = "aaronnote-calendar-event-time";
    time.textContent = String(entry.time);
    pill.appendChild(time);
  }

  const text = document.createElement("span");
  text.className = "aaronnote-calendar-event-text";
  text.textContent = todoText(todo);
  pill.appendChild(text);

  pill.addEventListener("click", (event) => {
    event.stopPropagation();
    cursorId = String(todo.id || "");
    if (deps) void deps.jumpToTodo(todo);
  });
  if (field) {
    pill.addEventListener("dragstart", (event) => {
      if (!todo.id) return;
      calendarDrag = { todoId: String(todo.id), field, originalDate: entry.date || dayDate };
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(todo.id));
      }
      pill.classList.add("is-dragging");
    });
    pill.addEventListener("dragend", () => {
      calendarDrag = null;
      pill.classList.remove("is-dragging");
      clearCalendarDropTargets();
    });
  }
  return pill;
}

function renderMonth(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-calendar";
  const month = new Date(anchorMs).getMonth();
  const gridStart = calendarGridStart(anchorMs);
  const daysByDate = new Map((data?.days || []).map((day) => [day.date || "", day]));

  const head = document.createElement("div");
  head.className = "aaronnote-calendar-head";
  const title = document.createElement("h2");
  title.textContent = calendarTitle(anchorMs);
  const visibleCount = [...daysByDate.values()]
    .reduce((count, day) => count + visibleCalendarEntries(day.entries || []).length, 0);
  const summary = document.createElement("span");
  summary.textContent = `${visibleCount} event${visibleCount === 1 ? "" : "s"}`;
  head.append(title, summary);
  wrap.appendChild(head);

  const weekdays = document.createElement("div");
  weekdays.className = "aaronnote-calendar-weekdays";
  for (const label of WEEKDAY_LABELS) {
    const day = document.createElement("div");
    day.textContent = label;
    weekdays.appendChild(day);
  }
  wrap.appendChild(weekdays);

  const grid = document.createElement("div");
  grid.className = "aaronnote-calendar-grid";
  for (let i = 0; i < 42; i++) {
    const dayMs = addDays(gridStart, i);
    const dayDate = fmtDate(dayMs);
    const day = daysByDate.get(dayDate);
    const entries = visibleCalendarEntries(day?.entries || []);
    const cell = document.createElement("div");
    cell.className = "aaronnote-calendar-day";
    cell.dataset.date = dayDate;
    if (new Date(dayMs).getMonth() !== month) cell.classList.add("is-outside");
    if (dayDate === data?.range?.today) cell.classList.add("is-today");
    if (entries.length > 0) cell.classList.add("has-events");

    const dateBar = document.createElement("div");
    dateBar.className = "aaronnote-calendar-date";
    const dateNum = document.createElement("span");
    dateNum.textContent = String(new Date(dayMs).getDate());
    dateBar.appendChild(dateNum);
    if (entries.length > 0) {
      const count = document.createElement("small");
      count.textContent = String(entries.length);
      dateBar.appendChild(count);
    }
    cell.appendChild(dateBar);

    const events = document.createElement("div");
    events.className = "aaronnote-calendar-events";
    for (const entry of entries.slice(0, 4)) {
      const pill = renderCalendarEvent(entry, dayDate);
      if (pill) events.appendChild(pill);
    }
    if (entries.length > 4) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "aaronnote-calendar-more";
      more.textContent = `+${entries.length - 4} more`;
      more.addEventListener("click", (event) => {
        event.stopPropagation();
        anchorMs = dayMs;
        view = "week";
        syncPageUrl();
        void fetchAgenda();
      });
      events.appendChild(more);
    }
    cell.appendChild(events);

    cell.addEventListener("dragover", (event) => {
      if (!calendarDrag) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      cell.classList.add("is-drop-target");
    });
    cell.addEventListener("dragleave", (event) => {
      const next = event.relatedTarget;
      if (!(next instanceof Node) || !cell.contains(next)) cell.classList.remove("is-drop-target");
    });
    cell.addEventListener("drop", (event) => {
      if (!calendarDrag) return;
      event.preventDefault();
      void commitCalendarDrop(dayDate);
    });
    cell.addEventListener("click", (event) => {
      const target = targetElement(event.target);
      if (target?.closest(".aaronnote-calendar-event, .aaronnote-calendar-more")) return;
      anchorMs = dayMs;
      view = "week";
      syncPageUrl();
      void fetchAgenda();
    });
    grid.appendChild(cell);
  }
  wrap.appendChild(grid);
  return wrap;
}

function renderLog(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-list";
  const days = [...(data?.days || [])].reverse();
  for (const day of days) {
    const closed = (day.entries || []).filter((e) => {
      if (e.kind !== "log") return false;
      const todo = e.todoId ? todoById(e.todoId) : undefined;
      return todo ? matchesTodo(todo) : projectFilter.size === 0 && !query.trim();
    });
    if (closed.length === 0) continue;
    const head = document.createElement("div");
    head.className = "aaronnote-agenda-full-group-head";
    head.textContent = `${day.date} — ${closed.length} closed`;
    wrap.appendChild(head);
    for (const entry of closed) {
      const todo = entry.todoId ? todoById(entry.todoId) : undefined;
      if (todo) wrap.appendChild(buildRow(todo));
    }
  }
  return wrap;
}

// --- Gantt ---

const GANTT_SCALE_LABELS: Record<GanttScale, string> = { day: "Day", week: "Week", month: "Month" };

function ganttPxPerDay(): number {
  if (ganttScale === "month") return 5;
  if (ganttScale === "week") return 12;
  return 34;
}

function ganttRange(tasks: GanttTask[], milestones: GanttMilestone[] = []): { min: number; days: number; pxPerDay: number } {
  const vals: number[] = [];
  for (const t of tasks) {
    if (t.start) vals.push(parseYmd(t.start));
    if (t.end) vals.push(parseYmd(t.end));
  }
  for (const m of milestones) {
    if (m.date) vals.push(parseYmd(m.date));
  }
  const finite = vals.filter((v) => Number.isFinite(v));
  const rawMin = finite.length ? Math.min(...finite) : Date.now();
  const rawMax = finite.length ? Math.max(...finite) : rawMin + 14 * DAY_MS;
  const pad = ganttScale === "month" ? 14 : ganttScale === "week" ? 7 : 2;
  const min = rawMin - pad * DAY_MS;
  const max = rawMax + (pad + 1) * DAY_MS;
  return { min, days: Math.max(7, Math.round((max - min) / DAY_MS) + 1), pxPerDay: ganttPxPerDay() };
}

function ganttPatchBase(task: GanttTask, patch: Record<string, unknown>): Record<string, unknown> {
  const source = (task.source || {}) as Record<string, unknown>;
  return { file: source.file, index: source.index, source: source.source, text: source.text, ...patch };
}

async function patchGanttProgress(task: GanttTask, progress: number): Promise<void> {
  if (!deps) return;
  const next = Math.max(0, Math.min(100, Math.round(progress / 5) * 5));
  try {
    await deps.api.notes.patchTodo(ganttPatchBase(task, { progress: next }));
    lastLocalMutationMs = Date.now();
    await fetchAgenda();
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Progress update failed");
  }
}

function bumpGanttProgress(task: GanttTask): void {
  const next = ((Number(task.progress) || 0) + 25) % 125;
  void patchGanttProgress(task, next > 100 ? 0 : next);
}

async function commitGanttSchedule(task: GanttTask, startMs: number, endMs: number): Promise<void> {
  if (!deps) return;
  const nextStart = fmtDate(startMs);
  const nextEnd = fmtDate(endMs);
  try {
    await deps.api.notes.patchTodo(ganttPatchBase(task, { sche: nextStart, end: nextEnd, ddl: nextEnd }));
    lastLocalMutationMs = Date.now();
    await fetchAgenda();
  } catch (error) {
    deps.setStatus(error instanceof Error ? error.message : "Reschedule failed");
  }
}

function clampGanttMs(ms: number, range: { min: number; days: number }): number {
  return Math.max(range.min, Math.min(range.min + (range.days - 1) * DAY_MS, ms));
}

function ganttTaskStartMs(task: GanttTask, range: { min: number }): number {
  return task.start ? parseYmd(task.start) : range.min;
}

function ganttTaskEndMs(task: GanttTask, range: { min: number }): number {
  const start = ganttTaskStartMs(task, range);
  return task.end ? parseYmd(task.end) : start;
}

function positionGanttBar(
  bar: HTMLElement,
  startMs: number,
  endMs: number,
  range: { min: number; days: number; pxPerDay: number },
  progress = Number(bar.dataset.progress || 0) || 0,
): void {
  const startDay = Math.round((startMs - range.min) / DAY_MS);
  const endDay = Math.round((endMs - range.min) / DAY_MS);
  const left = Math.max(0, startDay * range.pxPerDay);
  const width = Math.max(range.pxPerDay, (endDay - startDay + 1) * range.pxPerDay);
  bar.style.left = `${left}px`;
  bar.style.width = `${width}px`;
  bar.dataset.preview = `${fmtDate(startMs)} -> ${fmtDate(endMs)}`;
  const progressPct = `${Math.max(0, Math.min(100, progress))}%`;
  bar.style.setProperty("--gantt-progress", progressPct);
  bar.querySelector<HTMLElement>(".aaronnote-gantt-bar-progress")?.style.setProperty("--gantt-progress", progressPct);
  const label = bar.querySelector<HTMLElement>(".aaronnote-gantt-bar-label");
  if (label) label.textContent = `${bar.dataset.name || ""} · ${Math.round(progress)}%`;
}

function installGanttDragListeners(): void {
  if (ganttDragListenersInstalled || typeof window === "undefined") return;
  window.addEventListener("pointermove", (event) => {
    if (!ganttDrag) return;
    event.preventDefault();
    const deltaDays = Math.round((event.clientX - ganttDrag.startX) / ganttDrag.range.pxPerDay);
    if (ganttDrag.mode === "progress") {
      const rect = ganttDrag.bar.getBoundingClientRect();
      ganttDrag.previewProgress = Math.max(0, Math.min(100, ((event.clientX - rect.left) / Math.max(1, rect.width)) * 100));
      positionGanttBar(ganttDrag.bar, ganttDrag.previewStartMs, ganttDrag.previewEndMs, ganttDrag.range, ganttDrag.previewProgress);
      return;
    }
    if (ganttDrag.mode === "move") {
      const nextStart = clampGanttMs(ganttDrag.originStartMs + deltaDays * DAY_MS, ganttDrag.range);
      const duration = ganttDrag.originEndMs - ganttDrag.originStartMs;
      ganttDrag.previewStartMs = nextStart;
      ganttDrag.previewEndMs = clampGanttMs(nextStart + duration, ganttDrag.range);
    } else if (ganttDrag.mode === "resize-start") {
      ganttDrag.previewStartMs = Math.min(
        clampGanttMs(ganttDrag.originStartMs + deltaDays * DAY_MS, ganttDrag.range),
        ganttDrag.previewEndMs,
      );
    } else {
      ganttDrag.previewEndMs = Math.max(
        clampGanttMs(ganttDrag.originEndMs + deltaDays * DAY_MS, ganttDrag.range),
        ganttDrag.previewStartMs,
      );
    }
    positionGanttBar(ganttDrag.bar, ganttDrag.previewStartMs, ganttDrag.previewEndMs, ganttDrag.range, ganttDrag.previewProgress);
  });
  window.addEventListener("pointerup", () => {
    const drag = ganttDrag;
    if (!drag) return;
    drag.bar.classList.remove("is-dragging");
    ganttDrag = null;
    if (drag.mode === "progress") {
      if (Math.round(drag.previewProgress) !== Math.round(drag.originProgress)) void patchGanttProgress(drag.task, drag.previewProgress);
      return;
    }
    if (fmtDate(drag.previewStartMs) !== fmtDate(drag.originStartMs) || fmtDate(drag.previewEndMs) !== fmtDate(drag.originEndMs)) {
      void commitGanttSchedule(drag.task, drag.previewStartMs, drag.previewEndMs);
    }
  });
  ganttDragListenersInstalled = true;
}

function startGanttDrag(
  event: PointerEvent,
  task: GanttTask,
  mode: GanttDragMode,
  bar: HTMLElement,
  timeline: HTMLElement,
  range: { min: number; days: number; pxPerDay: number },
): void {
  if (event.button !== 0) return;
  event.preventDefault();
  event.stopPropagation();
  installGanttDragListeners();
  const originStartMs = ganttTaskStartMs(task, range);
  const originEndMs = ganttTaskEndMs(task, range);
  const originProgress = Number(task.progress) || 0;
  ganttDrag = {
    task,
    mode,
    bar,
    timeline,
    range,
    startX: event.clientX,
    originStartMs,
    originEndMs,
    originProgress,
    previewStartMs: originStartMs,
    previewEndMs: originEndMs,
    previewProgress: originProgress,
  };
  bar.classList.add("is-dragging");
  bar.setPointerCapture?.(event.pointerId);
}

function renderTodayLine(range: { min: number; days: number; pxPerDay: number }): HTMLElement | null {
  const today = midnight(Date.now());
  const left = ((today - range.min) / DAY_MS) * range.pxPerDay;
  const max = range.days * range.pxPerDay;
  if (left < 0 || left > max) return null;
  const line = document.createElement("div");
  line.className = "aaronnote-gantt-today-line";
  line.style.left = `${left}px`;
  return line;
}

function appendTodayLine(timeline: HTMLElement, range: { min: number; days: number; pxPerDay: number }): void {
  const line = renderTodayLine(range);
  if (line) timeline.appendChild(line);
}

function renderGanttBar(task: GanttTask, range: { min: number; days: number; pxPerDay: number }): HTMLElement {
  const line = document.createElement("div");
  line.className = "aaronnote-gantt-line";

  const name = document.createElement("div");
  name.className = "aaronnote-gantt-name";
  const actions = document.createElement("span");
  actions.className = "aaronnote-gantt-actions";
  const progressBtn = document.createElement("button");
  progressBtn.type = "button";
  progressBtn.textContent = `${task.progress || 0}%`;
  progressBtn.title = "Click to step progress";
  progressBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    bumpGanttProgress(task);
  });
  actions.appendChild(progressBtn);
  const label = document.createElement("span");
  label.className = "aaronnote-gantt-task-title";
  label.textContent = task.name || "";
  const sub = document.createElement("small");
  const dates = `${task.start || ""}${task.end ? ` -> ${task.end}` : ""}`;
  const depCount = Array.isArray(task.dependencies) ? task.dependencies.length : 0;
  sub.textContent = [task.project || "No project", dates, depCount ? `${depCount} dep` : ""].filter(Boolean).join(" · ");
  name.append(actions, label, document.createElement("br"), sub);

  const timeline = document.createElement("div");
  timeline.className = "aaronnote-gantt-timeline";
  appendTodayLine(timeline, range);

  const bar = document.createElement("div");
  bar.className = `aaronnote-gantt-bar ${task.status || ""}`;
  bar.dataset.name = task.name || "";
  bar.dataset.progress = String(task.progress || 0);
  bar.title = `${task.name || ""}\n${task.start || ""} -> ${task.end || ""}\nDrag to move; use edges to resize; drag dot to set progress.`;
  const startMs = ganttTaskStartMs(task, range);
  const endMs = ganttTaskEndMs(task, range);
  const leftHandle = document.createElement("span");
  leftHandle.className = "aaronnote-gantt-resize is-start";
  leftHandle.title = "Resize start";
  const progress = document.createElement("span");
  progress.className = "aaronnote-gantt-bar-progress";
  const barLabel = document.createElement("span");
  barLabel.className = "aaronnote-gantt-bar-label";
  const progressHandle = document.createElement("span");
  progressHandle.className = "aaronnote-gantt-progress-handle";
  progressHandle.title = "Drag progress";
  const rightHandle = document.createElement("span");
  rightHandle.className = "aaronnote-gantt-resize is-end";
  rightHandle.title = "Resize end";
  bar.append(progress, barLabel, leftHandle, progressHandle, rightHandle);
  positionGanttBar(bar, startMs, endMs, range, Number(task.progress) || 0);
  bar.addEventListener("pointerdown", (event) => startGanttDrag(event, task, "move", bar, timeline, range));
  leftHandle.addEventListener("pointerdown", (event) => startGanttDrag(event, task, "resize-start", bar, timeline, range));
  rightHandle.addEventListener("pointerdown", (event) => startGanttDrag(event, task, "resize-end", bar, timeline, range));
  progressHandle.addEventListener("pointerdown", (event) => startGanttDrag(event, task, "progress", bar, timeline, range));
  bar.addEventListener("dblclick", (event) => {
    event.stopPropagation();
    const source = (task.source || {}) as Record<string, unknown>;
    if (deps) void deps.jumpToTodo({ file: source.file, line: source.line } as unknown as TodoItem);
  });
  timeline.appendChild(bar);

  line.append(name, timeline);
  return line;
}

function ganttTickStepDays(): number {
  if (ganttScale === "month") return 30;
  if (ganttScale === "week") return 7;
  return 1;
}

function renderGanttHead(range: { min: number; days: number; pxPerDay: number }): HTMLElement {
  const head = document.createElement("div");
  head.className = "aaronnote-gantt-head";
  const name = document.createElement("div");
  name.className = "aaronnote-gantt-name";
  name.textContent = "Task / project";
  const ticks = document.createElement("div");
  ticks.className = "aaronnote-gantt-ticks";
  appendTodayLine(ticks, range);
  const step = ganttTickStepDays();
  for (let i = 0; i < range.days; i += step) {
    const days = Math.min(step, range.days - i);
    const ms = range.min + i * DAY_MS;
    const tick = document.createElement("div");
    tick.className = "aaronnote-gantt-tick";
    const date = new Date(ms);
    if (ganttScale === "month") tick.textContent = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    else if (ganttScale === "week") tick.textContent = `W ${fmtDate(ms).slice(5)}`;
    else tick.textContent = fmtDate(ms).slice(5);
    tick.style.width = `${days * range.pxPerDay}px`;
    if (date.getDay() === 0 || date.getDay() === 6) tick.classList.add("is-weekend");
    ticks.appendChild(tick);
  }
  head.append(name, ticks);
  return head;
}

function scrollGanttToToday(): void {
  const chart = listEl?.querySelector<HTMLElement>(".aaronnote-gantt-chart");
  const todayLine = chart?.querySelector<HTMLElement>(".aaronnote-gantt-today-line");
  if (!chart || !todayLine) return;
  const left = todayLine.offsetLeft;
  chart.scrollTo({ left: Math.max(0, left - chart.clientWidth / 2), behavior: "smooth" });
}

function renderGanttToolbar(tasks: GanttTask[], milestones: GanttMilestone[]): HTMLElement {
  const toolbar = document.createElement("div");
  toolbar.className = "aaronnote-gantt-toolbar";

  const scaleGroup = document.createElement("div");
  scaleGroup.className = "aaronnote-gantt-scale";
  for (const key of ["day", "week", "month"] as GanttScale[]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = key === ganttScale ? "is-active" : "";
    button.textContent = GANTT_SCALE_LABELS[key];
    button.addEventListener("click", () => {
      ganttScale = key;
      render();
      requestAnimationFrame(scrollGanttToToday);
    });
    scaleGroup.appendChild(button);
  }
  toolbar.appendChild(scaleGroup);

  const today = document.createElement("button");
  today.type = "button";
  today.textContent = "Today";
  today.title = "Scroll timeline to today";
  today.addEventListener("click", scrollGanttToToday);

  const laneKeys = new Set<string>();
  for (const task of tasks) laneKeys.add(normalizeProjectKey(task.project) || "__other");
  for (const milestone of milestones) laneKeys.add(normalizeProjectKey(milestone.project) || "__milestones");
  const collapse = document.createElement("button");
  collapse.type = "button";
  const allCollapsed = laneKeys.size > 0 && [...laneKeys].every((key) => ganttCollapsed.has(key));
  collapse.textContent = allCollapsed ? "Expand all" : "Collapse all";
  collapse.addEventListener("click", () => {
    ganttCollapsed = allCollapsed ? new Set() : new Set(laneKeys);
    render();
  });

  const summary = document.createElement("span");
  summary.className = "aaronnote-gantt-summary";
  summary.textContent = `${tasks.length} tasks · ${milestones.length} milestones`;
  toolbar.append(today, collapse, summary);
  return toolbar;
}

function toggleGanttLane(key: string): void {
  const normalized = normalizeProjectKey(key) || "__other";
  const next = new Set(ganttCollapsed);
  if (next.has(normalized)) next.delete(normalized);
  else next.add(normalized);
  ganttCollapsed = next;
  render();
}

function renderGanttLaneHead(
  key: string,
  label: string,
  range: { min: number; days: number; pxPerDay: number },
  count: number,
  lane?: { start?: string; end?: string },
): HTMLElement {
  const normalized = normalizeProjectKey(key) || "__other";
  const row = document.createElement("div");
  row.className = "aaronnote-gantt-lane-head";
  if (ganttCollapsed.has(normalized)) row.classList.add("is-collapsed");

  const name = document.createElement("button");
  name.type = "button";
  name.className = "aaronnote-gantt-lane-toggle";
  name.textContent = `${ganttCollapsed.has(normalized) ? "▸" : "▾"} ${label || "Other"} (${count})`;
  name.addEventListener("click", () => toggleGanttLane(normalized));

  const timeline = document.createElement("div");
  timeline.className = "aaronnote-gantt-timeline is-lane";
  appendTodayLine(timeline, range);
  if (lane?.start && lane.end) {
    const bar = document.createElement("div");
    bar.className = "aaronnote-gantt-lane-bar";
    bar.textContent = label || "Project";
    positionGanttBar(bar, parseYmd(lane.start), parseYmd(lane.end), range, 100);
    timeline.appendChild(bar);
  }

  row.append(name, timeline);
  return row;
}

function renderGanttMilestoneRow(milestone: GanttMilestone, range: { min: number; days: number; pxPerDay: number }): HTMLElement {
  const row = document.createElement("div");
  row.className = "aaronnote-gantt-line is-milestone";
  const name = document.createElement("div");
  name.className = "aaronnote-gantt-name";
  const title = document.createElement("span");
  title.className = "aaronnote-gantt-task-title";
  title.textContent = milestone.name || "Milestone";
  const sub = document.createElement("small");
  sub.textContent = [milestone.project || "No project", milestone.date || ""].filter(Boolean).join(" · ");
  name.append(title, document.createElement("br"), sub);

  const timeline = document.createElement("div");
  timeline.className = "aaronnote-gantt-timeline";
  appendTodayLine(timeline, range);
  if (milestone.date) {
    const marker = document.createElement("button");
    marker.type = "button";
    marker.className = "aaronnote-gantt-milestone";
    marker.title = `${milestone.name || "Milestone"} · ${milestone.date}`;
    marker.style.left = `${Math.round((parseYmd(milestone.date) - range.min) / DAY_MS) * range.pxPerDay}px`;
    marker.addEventListener("click", () => {
      const source = (milestone.source || {}) as Record<string, unknown>;
      if (deps) void deps.jumpToTodo({ file: source.file, line: source.line } as unknown as TodoItem);
    });
    timeline.appendChild(marker);
  }
  row.append(name, timeline);
  return row;
}

function matchesPlainText(parts: unknown[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = parts.join(" ").toLowerCase();
  return q.split(/\s+/).every((term) => haystack.includes(term));
}

function matchesGanttTask(task: GanttTask): boolean {
  const todo = task.id ? todoById(String(task.id)) : undefined;
  if (todo) return matchesTodo(todo);
  return projectMatchesFilter(task.project) && matchesPlainText([task.name, task.project, task.status, task.start, task.end]);
}

function matchesGanttMilestone(milestone: GanttMilestone): boolean {
  return projectMatchesFilter(milestone.project)
    && matchesPlainText([milestone.name, milestone.project, milestone.date]);
}

function renderGantt(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-gantt";
  const gantt = data?.gantt;
  const tasks = (gantt?.tasks || []).filter(matchesGanttTask);
  const backlog = (gantt?.backlog || []).filter(matchesGanttTask);
  const milestones = (gantt?.milestones || []).filter(matchesGanttMilestone);
  const range = ganttRange(tasks, milestones);
  const timelineWidth = Math.max(420, range.days * range.pxPerDay);
  wrap.appendChild(renderGanttToolbar(tasks, milestones));

  const chart = document.createElement("div");
  chart.className = "aaronnote-gantt-chart";
  chart.style.setProperty("--gantt-days", String(range.days));
  chart.style.setProperty("--gantt-px-per-day", `${range.pxPerDay}px`);
  chart.style.setProperty("--gantt-timeline-width", `${timelineWidth}px`);
  chart.appendChild(renderGanttHead(range));

  const laned = new Set<string>();
  const visibleTaskIds = new Set(tasks.map((task) => String(task.id || "")));
  for (const lane of gantt?.lanes || []) {
    const childTaskIds = (lane.childTaskIds || []).filter((id) => visibleTaskIds.has(String(id)));
    if (childTaskIds.length === 0) continue;
    const laneKey = normalizeProjectKey(lane.key) || "__other";
    chart.appendChild(renderGanttLaneHead(laneKey, lane.name || lane.key || "Project", range, childTaskIds.length, lane));
    if (ganttCollapsed.has(laneKey)) {
      for (const childId of childTaskIds) laned.add(childId);
      continue;
    }
    for (const childId of childTaskIds) {
      laned.add(childId);
      const task = tasks.find((t) => String(t.id || "") === String(childId));
      if (task) chart.appendChild(renderGanttBar(task, range));
    }
  }
  const rest = tasks.filter((t) => !laned.has(String(t.id || "")));
  if (rest.length > 0 && (gantt?.lanes?.length || 0) > 0) {
    const otherKey = "__other";
    chart.appendChild(renderGanttLaneHead(otherKey, "Other", range, rest.length));
    if (!ganttCollapsed.has(otherKey)) {
      for (const task of rest) chart.appendChild(renderGanttBar(task, range));
    }
  } else {
    for (const task of rest) chart.appendChild(renderGanttBar(task, range));
  }

  if (milestones.length > 0) {
    const milestoneKey = "__milestones";
    chart.appendChild(renderGanttLaneHead(milestoneKey, "Milestones", range, milestones.length));
    if (!ganttCollapsed.has(milestoneKey)) {
      for (const m of milestones) chart.appendChild(renderGanttMilestoneRow(m, range));
    }
  }
  wrap.appendChild(chart);

  if (backlog.length > 0) {
    const backlogHead = document.createElement("div");
    backlogHead.className = "aaronnote-agenda-full-group-head";
    backlogHead.textContent = "Backlog (unscheduled)";
    wrap.appendChild(backlogHead);
    for (const t of backlog) {
      const todo = t.id ? todoById(t.id) : undefined;
      if (todo) wrap.appendChild(buildRow(todo, { badge: "unscheduled" }));
    }
  }

  if (tasks.length === 0 && backlog.length === 0 && milestones.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "No matching Gantt items";
    wrap.appendChild(empty);
  }

  return wrap;
}

// --- Projects ---

function matchesProjectRollup(project: ProjectRollup): boolean {
  const key = normalizeProjectKey(project.key);
  if (!projectMatchesFilter(key)) return false;
  if (!query.trim()) return true;
  const childMatch = (project.childTodoIds || []).some((id) => {
    const todo = todoById(id);
    return todo ? matchesQuery(todo) : false;
  });
  return childMatch || matchesPlainText([project.title, project.key, project.status, project.area, project.phase, project.file]);
}

function renderProjects(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-list";
  const projects = (data?.projectModel || []).filter(matchesProjectRollup);
  if (projects.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = projectFilter.size > 0 || query.trim() ? "No matching projects" : "No @@project entries yet";
    wrap.appendChild(empty);
    return wrap;
  }
  for (const project of projects) {
    const key = normalizeProjectKey(project.key);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "aaronnote-agenda-full-project";
    if (projectFilter.has(key)) card.classList.add("is-selected");
    card.title = key ? `Filter by ${project.title || key}` : "Filter by project";
    card.addEventListener("click", () => focusProject(key));
    const title = document.createElement("h3");
    title.textContent = project.title || key || "";
    const meta = document.createElement("div");
    meta.className = "aaronnote-agenda-full-note";
    const parts = [
      `${project.progress ?? 0}% done`,
      `${project.open ?? 0} open`,
      `${project.doing ?? 0} doing`,
      `${project.blocked ?? 0} blocked`,
    ];
    if (project.effortMinutes) parts.push(`${Math.round((project.effortMinutes || 0) / 60)}h effort`);
    if (project.clockedMinutes) parts.push(`${Math.round((project.clockedMinutes || 0) / 60)}h clocked`);
    meta.textContent = parts.join(" · ");
    const hint = document.createElement("div");
    hint.className = "aaronnote-agenda-full-project-hint";
    hint.textContent = "Click to filter";
    card.append(title, meta, hint);
    wrap.appendChild(card);
  }
  return wrap;
}

// --- Clocktable ---

function matchesClockTask(task: { todoId?: string; text?: string; file?: string }): boolean {
  const todo = task.todoId ? todoById(task.todoId) : undefined;
  if (todo) return matchesTodo(todo);
  if (projectFilter.size > 0) return false;
  return matchesPlainText([task.text, task.file]);
}

function renderClocktable(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-list";
  const model = data?.clocktable;
  if (!model) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "No clock data";
    wrap.appendChild(empty);
    return wrap;
  }
  if (model.running) {
    const runningTodo = model.running.todoId ? todoById(model.running.todoId) : undefined;
    const showRunning = runningTodo ? matchesTodo(runningTodo) : projectFilter.size === 0 && matchesPlainText([model.running.text, model.running.file]);
    if (showRunning) {
      const running = document.createElement("div");
      running.className = "aaronnote-agenda-full-clocktable-running";
      running.textContent = `● Running: ${model.running.text || ""} (${model.running.minutesSoFar ?? 0}m)`;
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "Clock out";
      stop.addEventListener("click", () => void clockOutRunning());
      running.appendChild(stop);
      wrap.appendChild(running);
    }
  }
  const tasksHead = document.createElement("div");
  tasksHead.className = "aaronnote-agenda-full-group-head";
  tasksHead.textContent = "By task";
  wrap.appendChild(tasksHead);
  const tasks = (model.tasks || []).filter(matchesClockTask);
  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = "aaronnote-agenda-full-row is-simple-row";
    const body = document.createElement("span");
    body.className = "aaronnote-agenda-full-body";
    const text = document.createElement("span");
    text.className = "aaronnote-agenda-full-text";
    text.textContent = task.text || "(untitled)";
    const note = document.createElement("span");
    note.className = "aaronnote-agenda-full-note";
    const hours = ((task.minutes || 0) / 60).toFixed(1);
    const effort = task.effortMinutes ? ` / ${(task.effortMinutes / 60).toFixed(1)}h effort` : "";
    note.textContent = `${hours}h${effort}`;
    body.append(text, note);
    row.appendChild(body);
    wrap.appendChild(row);
  }

  const projectMinutes = Object.entries(model.byProject || {})
    .filter(([key]) => projectMatchesFilter(key))
    .filter(([key]) => matchesPlainText([key, projectTitleForKey(key)]));
  if (projectMinutes.length > 0) {
    const projectHead = document.createElement("div");
    projectHead.className = "aaronnote-agenda-full-group-head";
    projectHead.textContent = "By project";
    wrap.appendChild(projectHead);
    for (const [key, minutes] of projectMinutes) {
      const row = document.createElement("div");
      row.className = "aaronnote-agenda-full-row is-simple-row";
      const body = document.createElement("span");
      body.className = "aaronnote-agenda-full-body";
      body.textContent = `${projectTitleForKey(key)} — ${(minutes / 60).toFixed(1)}h`;
      row.appendChild(body);
      wrap.appendChild(row);
    }
  }

  const dayMinutes = Object.entries(model.byDay || {});
  if (projectFilter.size === 0) {
    const dayHead = document.createElement("div");
    dayHead.className = "aaronnote-agenda-full-group-head";
    dayHead.textContent = "By day";
    wrap.appendChild(dayHead);
    for (const [day, minutes] of dayMinutes) {
      const row = document.createElement("div");
      row.className = "aaronnote-agenda-full-row is-simple-row";
      const body = document.createElement("span");
      body.className = "aaronnote-agenda-full-body";
      body.textContent = `${day} — ${(minutes / 60).toFixed(1)}h`;
      row.appendChild(body);
      wrap.appendChild(row);
    }
  }

  if (tasks.length === 0 && projectMinutes.length === 0 && (projectFilter.size > 0 || dayMinutes.length === 0)) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "No matching clock entries";
    wrap.appendChild(empty);
  }
  return wrap;
}

// --- Lints ---

function renderLintsView(): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "aaronnote-agenda-full-list";
  const lints = visibleLints();
  if (lints.length === 0) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "No lints";
    wrap.appendChild(empty);
    return wrap;
  }
  for (const lint of lints) {
    const row = document.createElement("div");
    row.className = "aaronnote-agenda-full-lint";
    const kind = document.createElement("b");
    kind.textContent = lint.kind || "";
    row.appendChild(kind);
    row.appendChild(document.createTextNode(` ${lint.message || lint.ref || ""} `));
    const where = document.createElement("small");
    where.textContent = `${lint.file || ""}${lint.line ? `:${lint.line}` : ""}`;
    row.appendChild(where);
    wrap.appendChild(row);
  }
  return wrap;
}

function flatTodoIds(): string[] {
  if (!listEl) return [];
  return [...listEl.querySelectorAll<HTMLElement>("[data-todo-id]")].map((el) => el.dataset.todoId || "");
}

// Toggles the `.is-cursor` class on the already-rendered elements in place
// instead of rebuilding the whole view — a todo can appear more than once in
// a single render (e.g. the same deadline pill on two month cells), so every
// matching element is updated, not just the first.
function setCursorHighlight(id: string): void {
  if (!listEl) return;
  for (const el of listEl.querySelectorAll<HTMLElement>(".is-cursor")) el.classList.remove("is-cursor");
  if (!id) return;
  for (const el of listEl.querySelectorAll<HTMLElement>(`[data-todo-id="${CSS.escape(id)}"]`)) el.classList.add("is-cursor");
}

function moveCursor(delta: number): void {
  const ids = flatTodoIds();
  if (ids.length === 0) return;
  const idx = Math.max(0, ids.indexOf(cursorId));
  const next = Math.min(ids.length - 1, Math.max(0, idx + delta));
  cursorId = ids[next];
  setCursorHighlight(cursorId);
  listEl?.querySelector<HTMLElement>(`[data-todo-id="${CSS.escape(cursorId)}"]`)?.scrollIntoView({ block: "nearest" });
}

function visibleStats(): { open: number; doing: number; done: number; cancelled: number; blocked: number; overdue: number } {
  const stats = { open: 0, doing: 0, done: 0, cancelled: 0, blocked: 0, overdue: 0 };
  const overdueIds = new Set<string>();
  for (const todo of visibleTodos()) {
    const status = String(todo.status || "");
    if (todo.effectiveStatus === "blocked") stats.blocked++;
    else if (status === "todo") stats.open++;
    else if (status === "doing") stats.doing++;
    else if (status === "done") stats.done++;
    else if (status === "cancelled") stats.cancelled++;
  }
  for (const day of data?.days || []) {
    for (const entry of day.entries || []) {
      if (entry.kind !== "overdue" || !entry.todoId) continue;
      const todo = todoById(entry.todoId);
      if (todo && matchesTodo(todo)) overdueIds.add(String(entry.todoId));
    }
  }
  stats.overdue = overdueIds.size;
  return stats;
}

function renderHeader(): void {
  if (!headerEl) return;
  headerEl.replaceChildren();

  const views: Array<[ViewKind, string]> = [
    ["week", "Week"],
    ["list", "List"],
    ["month", "Month"],
    ["log", "Log"],
    ["gantt", "Gantt"],
    ["projects", "Projects"],
    ["clocktable", "Clock"],
    ["lints", "Lints"],
  ];
  const tabs = document.createElement("div");
  tabs.className = "aaronnote-agenda-full-tabs";
  for (const [kind, label] of views) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = kind === view ? "is-active" : "";
    button.textContent = label;
    button.addEventListener("click", () => {
      view = kind;
      syncPageUrl();
      void fetchAgenda();
    });
    tabs.appendChild(button);
  }
  headerEl.appendChild(tabs);

  if (!WIDE_VIEWS.has(view)) {
    const nav = document.createElement("div");
    nav.className = "aaronnote-agenda-full-nav";
    const prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "←";
    prev.addEventListener("click", () => {
      shiftAnchor(-1);
      void fetchAgenda();
    });
    const today = document.createElement("button");
    today.type = "button";
    today.textContent = "Today";
    today.addEventListener("click", () => {
      anchorMs = midnight(Date.now());
      void fetchAgenda();
    });
    const next = document.createElement("button");
    next.type = "button";
    next.textContent = "→";
    next.addEventListener("click", () => {
      shiftAnchor(1);
      void fetchAgenda();
    });
    nav.append(prev, today, next);
    headerEl.appendChild(nav);
  }

  headerEl.appendChild(renderProjectFilter());

  const search = document.createElement("input");
  search.type = "search";
  search.value = query;
  search.placeholder = "Search status, priority, note, text, tag...";
  search.addEventListener("input", () => {
    query = search.value;
    syncPageUrl();
    // Body + stats only — rebuilding the header here would destroy this
    // very input mid-keystroke (and mid-IME-composition for CJK input),
    // dropping focus after every character typed.
    renderBody();
    updateHeaderStats();
  });
  headerEl.appendChild(search);

  const create = document.createElement("button");
  create.type = "button";
  create.className = "aaronnote-agenda-full-primary";
  create.textContent = "New";
  create.title = "Create todo (n)";
  create.addEventListener("click", () => void createTodoFromPrompt());
  headerEl.appendChild(create);

  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.textContent = "Refresh";
  refresh.title = "Refresh agenda (g)";
  refresh.addEventListener("click", () => void refreshAgendaFromUi());
  headerEl.appendChild(refresh);

  const help = document.createElement("button");
  help.type = "button";
  help.className = helpOpen ? "is-active" : "";
  help.textContent = "?";
  help.title = "Keyboard shortcuts (?)";
  help.addEventListener("click", toggleHelp);
  headerEl.appendChild(help);

  if (selection.size > 0) {
    const bulk = document.createElement("button");
    bulk.type = "button";
    bulk.className = "aaronnote-agenda-full-bulk";
    bulk.textContent = `Bulk (${selection.size})`;
    bulk.addEventListener("click", () => void bulkStatus());
    headerEl.appendChild(bulk);
  }

  if (data?.clocktable?.running) {
    const running = data.clocktable.running;
    const clockBadge = document.createElement("button");
    clockBadge.type = "button";
    clockBadge.className = "aaronnote-agenda-full-clock-badge";
    clockBadge.textContent = `⏱ ${running.text || ""} (${running.minutesSoFar ?? 0}m)`;
    clockBadge.title = "Clock out";
    clockBadge.addEventListener("click", () => void clockOutRunning());
    headerEl.appendChild(clockBadge);
  }

  if (!deps?.pageMode) {
    const close = document.createElement("button");
    close.type = "button";
    close.className = "aaronnote-agenda-full-close";
    close.textContent = "Close";
    close.addEventListener("click", closeAgendaView);
    headerEl.appendChild(close);
  }

  const stats = document.createElement("div");
  stats.className = "aaronnote-agenda-full-stats";
  statsEl = stats;
  stats.textContent = statsText();
  headerEl.appendChild(stats);
}

function statsText(): string {
  if (!data) return "";
  const s = visibleStats();
  const filterLabel = projectFilter.size > 0 ? `${projectFilter.size} project${projectFilter.size === 1 ? "" : "s"} · ` : "";
  return `${filterLabel}${s.open || 0} open · ${s.doing || 0} doing · ${s.blocked || 0} blocked · ${s.overdue || 0} overdue`;
}

// Rewrites just the stats text in place — used by the search-input handler,
// which must not touch the rest of the header (see renderHeader's `search`
// listener).
function updateHeaderStats(): void {
  if (statsEl) statsEl.textContent = statsText();
}

function renderBody(): void {
  if (!listEl) return;
  listEl.replaceChildren();
  if (loading) {
    const spinner = document.createElement("div");
    spinner.className = "aaronnote-empty";
    spinner.textContent = "Loading agenda...";
    listEl.appendChild(spinner);
    syncHelpPanel();
    return;
  }
  if (!data) {
    const empty = document.createElement("div");
    empty.className = "aaronnote-empty";
    empty.textContent = "Agenda unavailable";
    listEl.appendChild(empty);
    syncHelpPanel();
    return;
  }
  rebuildLintsByTodoId();
  if (view !== "lints") {
    const lints = renderLints();
    if (lints) listEl.appendChild(lints);
  }
  if (view === "week") listEl.appendChild(renderWeek());
  else if (view === "list") listEl.appendChild(renderList());
  else if (view === "month") listEl.appendChild(renderMonth());
  else if (view === "log") listEl.appendChild(renderLog());
  else if (view === "gantt") listEl.appendChild(renderGantt());
  else if (view === "projects") listEl.appendChild(renderProjects());
  else if (view === "clocktable") listEl.appendChild(renderClocktable());
  else listEl.appendChild(renderLintsView());

  if (!cursorId) {
    const ids = flatTodoIds();
    if (ids.length > 0) {
      cursorId = ids[0];
      setCursorHighlight(cursorId);
    }
  }
  syncHelpPanel();
}

function render(): void {
  if (!overlay || !listEl) return;
  renderHeader();
  renderBody();
}

function hasCommandModifier(event: KeyboardEvent): boolean {
  return event.isComposing || event.metaKey || event.ctrlKey || event.altKey;
}

function targetElement(target: EventTarget | null): HTMLElement | null {
  if (target instanceof HTMLElement) return target;
  if (target instanceof Node) return target.parentElement;
  return null;
}

function isEditableTarget(target: EventTarget | null): boolean {
  const element = targetElement(target);
  if (!element) return false;
  if (element.closest("input, textarea, select")) return true;
  const editable = element.closest<HTMLElement>("[contenteditable]");
  return Boolean(editable && editable.contentEditable !== "false");
}

function isNativeActivationTarget(target: EventTarget | null): boolean {
  const element = targetElement(target);
  return Boolean(element?.closest("button, a, [role='button']"));
}

function handleKeydown(event: KeyboardEvent): void {
  if (!overlay || overlay.hidden) return;
  if (hasCommandModifier(event)) return;
  if (projectPickerOpen && event.key === "Escape") {
    event.preventDefault();
    projectPickerOpen = false;
    render();
    focusAgenda();
    return;
  }
  if (helpOpen && (event.key === "Escape" || event.key === "q" || event.key === "?")) {
    event.preventDefault();
    closeHelp();
    return;
  }
  if (isEditableTarget(event.target)) {
    if (event.key === "Escape") {
      event.preventDefault();
      targetElement(event.target)?.blur();
      focusAgenda();
    } else if (event.key === "?") {
      event.preventDefault();
      showHelp();
    }
    return;
  }
  if ((event.key === "Enter" || event.key === " " || event.key === "Spacebar") && isNativeActivationTarget(event.target)) return;
  const todo = cursorId ? todoById(cursorId) : undefined;
  switch (event.key) {
    case "Escape":
    case "q":
      event.preventDefault();
      closeAgendaView();
      break;
    case "j":
    case "ArrowDown":
      event.preventDefault();
      moveCursor(1);
      break;
    case "k":
    case "ArrowUp":
      event.preventDefault();
      moveCursor(-1);
      break;
    case "Enter":
    case "Tab":
      event.preventDefault();
      if (todo && deps) void deps.jumpToTodo(todo);
      break;
    case "t":
      event.preventDefault();
      if (todo) cycleStatus(todo);
      break;
    case "n":
      event.preventDefault();
      void createTodoFromPrompt();
      break;
    case "p":
    case ",":
      event.preventDefault();
      if (todo) editPriority(todo);
      break;
    case "d":
      event.preventDefault();
      if (todo) editDeadline(todo);
      break;
    case "s":
      event.preventDefault();
      if (todo) editScheduled(todo);
      break;
    case "r":
      event.preventDefault();
      if (todo) editRepeat(todo);
      break;
    case "a":
      event.preventDefault();
      if (todo) void addDependency(todo);
      break;
    case "m":
    case "u":
      event.preventDefault();
      if (todo?.id) toggleMark(String(todo.id));
      break;
    case "B":
      event.preventDefault();
      void bulkStatus();
      break;
    case "f":
      event.preventDefault();
      shiftAnchor(1);
      void fetchAgenda();
      break;
    case "b":
      event.preventDefault();
      shiftAnchor(-1);
      void fetchAgenda();
      break;
    case ".":
      event.preventDefault();
      anchorMs = midnight(Date.now());
      void fetchAgenda();
      break;
    case "v": {
      event.preventDefault();
      const order: ViewKind[] = ["week", "list", "month", "log", "gantt", "projects", "clocktable", "lints"];
      view = order[(order.indexOf(view) + 1) % order.length];
      syncPageUrl();
      void fetchAgenda();
      break;
    }
    case "c":
      event.preventDefault();
      if (data?.clocktable?.running) void clockOutRunning();
      else if (todo) void clockInTodo(todo);
      break;
    case "g":
      event.preventDefault();
      void refreshAgendaFromUi();
      break;
    case "?":
      event.preventDefault();
      toggleHelp();
      break;
    default:
      break;
  }
}

function ensureOverlay(): void {
  installKeydownHandler();
  installDocumentClickHandler();
  if (overlay) return;
  overlay = document.createElement("section");
  overlay.className = "aaronnote-agenda-full";
  overlay.hidden = true;
  overlay.tabIndex = -1;
  overlay.innerHTML = `
    <div class="aaronnote-agenda-full-header" data-agenda-full-header></div>
    <div class="aaronnote-agenda-full-body" data-agenda-full-list></div>
  `;
  document.body.appendChild(overlay);
  headerEl = overlay.querySelector<HTMLElement>("[data-agenda-full-header]");
  listEl = overlay.querySelector<HTMLElement>("[data-agenda-full-list]");
}

export function closeAgendaView(): void {
  helpOpen = false;
  projectPickerOpen = false;
  if (overlay) {
    syncHelpPanel();
    overlay.hidden = true;
  }
  selection.clear();
}

// Re-fetches without resetting view/anchor/cursor — for SSE-driven refresh
// (`agenda-changed`/`notes-index-changed`) so a background edit doesn't
// yank the user back to today's view.
export async function refreshAgendaView(): Promise<void> {
  if (!overlay || overlay.hidden) return;
  if (Date.now() - lastLocalMutationMs < LOCAL_MUTATION_SUPPRESS_MS) return;
  await fetchAgenda();
}

export async function openAgendaView(nextDeps: AgendaViewDeps): Promise<void> {
  deps = nextDeps;
  ensureOverlay();
  if (!overlay) return;
  overlay.hidden = false;
  anchorMs = midnight(Date.now());
  cursorId = "";
  helpOpen = false;
  projectPickerOpen = false;
  lastLocalMutationMs = 0;
  if (nextDeps.pageMode && typeof location !== "undefined") {
    const params = new URLSearchParams(location.search);
    view = normalizeView(params.get("view"));
    query = params.get("q") || "";
    projectFilter = new Set(params.getAll("project").flatMap((value) => value.split(",")).map(normalizeProjectKey).filter(Boolean));
  } else {
    view = "week";
    query = "";
    projectFilter = new Set();
  }
  await fetchAgenda();
  focusAgenda();
}
