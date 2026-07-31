import "../src/styles/theme-loader.ts";
import "./wiki.css";
import "@mismerge/core/styles.css";
import "@mismerge/core/light.css";
import "@mismerge/core/web";

import { api, type WikiIndex, type WikiNote, type WikiRepository, type WikiSyncState } from "./api-client.ts";
import { installNoemaThemeRuntime } from "./theme-runtime.ts";

const root = document.querySelector<HTMLElement>("#wiki-app");
if (!root) throw new Error("Missing #wiki-app");

document.body.dataset.hostMode = window.noemaDesktop ? "desktop" : "browser";

root.innerHTML = `
  <header class="noema-desktop-titlebar noema-wiki-titlebar" data-desktop-titlebar>
    <div class="noema-wiki-history">
      <button type="button" aria-label="Back" title="Back" data-desktop-command="back">←</button>
      <button type="button" aria-label="Forward" title="Forward" data-desktop-command="forward">→</button>
      <button type="button" aria-label="Refresh" title="Refresh" data-desktop-command="refresh">↻</button>
    </div>
    <strong>Noema Wiki</strong>
    <div class="noema-wiki-title-actions">
      <button type="button" aria-label="Editor actions" data-desktop-menu="actions">Editor actions</button>
      <button type="button" aria-label="Window actions" data-desktop-menu="window">Window actions</button>
    </div>
  </header>
  <main class="noema-wiki-shell">
    <aside class="noema-wiki-sidebar">
      <div class="noema-wiki-brand"><span>N</span><div><strong>Wiki</strong><small data-wiki-layout>Loading…</small></div></div>
      <nav>
        <button type="button" class="is-active" data-view="pages">All pages <b data-count-pages>0</b></button>
        <button type="button" data-view="recent">Recent</button>
        <button type="button" data-view="folders">Folders <b data-count-folders>0</b></button>
        <button type="button" data-view="files">Files <b data-count-files>0</b></button>
        <button type="button" data-view="tags">Tags</button>
        <button type="button" data-view="dependencies">Dependencies</button>
        <button type="button" data-view="sync">Sync</button>
        <button type="button" data-view="wanted">Wanted <b data-count-wanted>0</b></button>
        <button type="button" data-view="reports">Reports <b data-count-reports>0</b></button>
        <button type="button" data-view="repositories">Repositories <b data-count-repos>0</b></button>
      </nav>
      <a href="/config" class="noema-wiki-settings">Configuration</a>
    </aside>
    <section class="noema-wiki-content">
      <header class="noema-wiki-hero">
        <div>
          <p>Workspace knowledge</p>
          <h1 data-view-title>All pages</h1>
          <small data-wiki-root></small>
        </div>
        <div class="noema-wiki-hero-actions">
          <button type="button" data-export>Export</button>
          <button type="button" data-refresh>Refresh index</button>
          <button type="button" class="is-primary" data-new-page>New page</button>
        </div>
      </header>
      <div class="noema-wiki-search">
        <span>⌕</span>
        <input type="search" data-search placeholder="Search titles, aliases, tags, repositories…" autocomplete="off">
        <kbd>⌘ K</kbd>
      </div>
      <div class="noema-wiki-status" data-status role="status" aria-live="polite"></div>
      <section data-wiki-view></section>
    </section>
  </main>
  <dialog class="noema-wiki-dialog" data-new-dialog>
    <form method="dialog" data-new-form>
      <header><div><p>Wiki workbench</p><h2>New page</h2></div><button type="button" data-new-cancel aria-label="Close">×</button></header>
      <label><span>Title</span><input name="title" required autofocus></label>
      <div class="noema-wiki-form-grid">
        <label><span>Repository</span><select name="repositoryId" required></select></label>
        <label><span>Directory</span><span class="noema-wiki-path-input"><input name="directory" list="noema-wiki-directories" placeholder="repository root"><button type="button" data-choose-directory>Choose…</button></span></label>
        <label><span>Filename</span><input name="filename" placeholder="generated-from-title.md"></label>
        <label><span>Kind</span><input name="kind" value="page"></label>
      </div>
      <label><span>Tags</span><input name="tags" placeholder="wiki, subject"></label>
      <datalist id="noema-wiki-directories"></datalist>
      <footer><button type="button" data-new-cancel>Cancel</button><button type="submit" value="default" class="is-primary">Create and open</button></footer>
    </form>
  </dialog>
  <dialog class="noema-wiki-dialog" data-repo-dialog>
    <form method="dialog" data-repo-form>
      <header><div><p>Explicit repository action</p><h2>Add repository</h2></div><button type="button" data-repo-cancel aria-label="Close">×</button></header>
      <div class="noema-wiki-form-grid">
        <label><span>Action</span><select name="action"><option value="init">Initialize empty repository</option><option value="clone">Clone remote</option></select></label>
        <label><span>Partition</span><select name="partition"><option>private</option><option>public</option></select></label>
      </div>
      <label><span>Repository name</span><input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></label>
      <label data-remote-field hidden><span>Git remote</span><input name="remote" placeholder="git@host:owner/repository.git"></label>
      <p>Noema never initializes, stages, commits, pulls, or pushes without this explicit action.</p>
      <footer><button type="button" data-repo-cancel>Cancel</button><button type="submit" value="default" class="is-primary">Continue</button></footer>
    </form>
  </dialog>
  <dialog class="noema-wiki-dialog" data-page-dialog>
    <form data-page-form>
      <header><div><p>Page management</p><h2 data-page-title>Manage page</h2></div><button type="button" data-page-cancel aria-label="Close">×</button></header>
      <label><span>Operation</span><select name="action"><option value="move">Move or rename</option><option value="copy">Create independent copy</option><option value="merge">Merge duplicate</option><option value="delete">Move to Trash</option></select></label>
      <section data-page-destination>
        <div class="noema-wiki-form-grid">
          <label><span>Repository</span><select name="repositoryId" required></select></label>
          <label><span>Directory</span><span class="noema-wiki-path-input"><input name="directory" list="noema-page-directories" placeholder="repository root"><button type="button" data-page-choose-directory>Choose…</button></span></label>
          <label><span>Filename</span><input name="filename" required></label>
          <label data-copy-title hidden><span>Copy title</span><input name="copyTitle"></label>
        </div>
        <datalist id="noema-page-directories"></datalist>
      </section>
      <label data-merge-target hidden><span>Duplicate page</span><select name="duplicateId"></select></label>
      <p data-page-warning></p>
      <footer><button type="button" data-page-cancel>Cancel</button><button type="submit" class="is-primary" data-page-apply>Move page</button></footer>
    </form>
  </dialog>
  <dialog class="noema-wiki-dialog noema-wiki-conflict-dialog" data-conflict-dialog>
    <section>
      <header>
        <div><p>Git merge conflict</p><h2 data-conflict-title>Resolve conflict</h2></div>
        <button type="button" aria-label="Close" data-conflict-close>×</button>
      </header>
      <div class="noema-wiki-conflict-legend"><span>Your branch</span><span>Merge result</span><span>Remote main</span></div>
      <div data-conflict-editor></div>
      <p data-conflict-message></p>
      <footer>
        <button type="button" data-conflict-abort>Abort this merge</button>
        <button type="button" data-conflict-delete>Delete file</button>
        <button type="button" data-conflict-ours>Keep yours</button>
        <button type="button" data-conflict-theirs>Use remote</button>
        <button type="button" class="is-primary" data-conflict-save>Save merge result</button>
      </footer>
    </section>
  </dialog>
  <dialog class="noema-wiki-git-dialog" data-git-dialog>
    <header><strong>Advanced Git · ungit</strong><button type="button" data-git-close aria-label="Close">×</button></header>
    <iframe title="Advanced Git" data-git-frame></iframe>
  </dialog>
`;

const viewEl = root.querySelector<HTMLElement>("[data-wiki-view]")!;
const titleEl = root.querySelector<HTMLElement>("[data-view-title]")!;
const searchEl = root.querySelector<HTMLInputElement>("[data-search]")!;
const statusEl = root.querySelector<HTMLElement>("[data-status]")!;
const newDialog = root.querySelector<HTMLDialogElement>("[data-new-dialog]")!;
const newForm = root.querySelector<HTMLFormElement>("[data-new-form]")!;
const repoDialog = root.querySelector<HTMLDialogElement>("[data-repo-dialog]")!;
const repoForm = root.querySelector<HTMLFormElement>("[data-repo-form]")!;
const pageDialog = root.querySelector<HTMLDialogElement>("[data-page-dialog]")!;
const pageForm = root.querySelector<HTMLFormElement>("[data-page-form]")!;
const conflictDialog = root.querySelector<HTMLDialogElement>("[data-conflict-dialog]")!;
const conflictEditor = root.querySelector<HTMLElement>("[data-conflict-editor]")!;
const conflictMessage = root.querySelector<HTMLElement>("[data-conflict-message]")!;
const gitDialog = root.querySelector<HTMLDialogElement>("[data-git-dialog]")!;
const gitFrame = root.querySelector<HTMLIFrameElement>("[data-git-frame]")!;
let index: WikiIndex | null = null;
let activeView = "pages";
let busy = false;
let activeConflict: { repositoryId: string; path: string; kind: string; editor?: HTMLElement & { ctr?: string } } | null = null;
let activeManagedNote: WikiNote | null = null;

function setStatus(message: string, error = false): void {
  statusEl.textContent = message;
  statusEl.classList.toggle("is-error", error);
}

function openNote(note: Pick<WikiNote, "file">): void {
  const url = new URL("/", location.origin);
  url.searchParams.set("file", note.file);
  url.searchParams.set("host", window.noemaDesktop ? "desktop" : "browser");
  window.open(url.toString(), "_blank", "noopener");
}

function button(label: string, className = ""): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = label;
  element.className = className;
  return element;
}

function emptyState(title: string, copy: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "noema-wiki-empty";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const paragraph = document.createElement("p");
  paragraph.textContent = copy;
  el.append(heading, paragraph);
  return el;
}

function noteCard(note: WikiNote): HTMLElement {
  const card = document.createElement("article");
  card.className = "noema-wiki-page";
  card.tabIndex = 0;
  const partition = document.createElement("span");
  partition.className = `partition is-${note.partition}`;
  partition.textContent = note.partition;
  const copy = document.createElement("div");
  const title = document.createElement("h2");
  title.textContent = note.title;
  const path = document.createElement("p");
  path.textContent = `${note.repositoryId} · ${note.repositoryPath}`;
  const meta = document.createElement("small");
  meta.textContent = [
    note.kind || "page",
    note.aliases.length ? `${note.aliases.length} aliases` : "",
    note.backlinks.length ? `${note.backlinks.length} backlinks` : "",
    note.tags.slice(0, 4).join(" · "),
  ].filter(Boolean).join(" · ") || "No metadata";
  copy.append(title, path, meta);
  const actions = button("•••");
  actions.className = "noema-wiki-page-actions";
  actions.title = "Move, copy, or merge page";
  actions.addEventListener("click", (event) => {
    event.stopPropagation();
    void managePage(note);
  });
  card.append(partition, copy, actions);
  card.addEventListener("click", () => openNote(note));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openNote(note);
  });
  return card;
}

function managePage(note: WikiNote): void {
  activeManagedNote = note;
  root.querySelector<HTMLElement>("[data-page-title]")!.textContent = note.title;
  const repository = pageForm.elements.namedItem("repositoryId") as HTMLSelectElement;
  repository.replaceChildren(...(index?.repositories || []).map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.id;
    return option;
  }));
  repository.value = note.repositoryId;
  (pageForm.elements.namedItem("directory") as HTMLInputElement).value = note.repositoryPath.includes("/")
    ? note.repositoryPath.slice(0, note.repositoryPath.lastIndexOf("/"))
    : "";
  (pageForm.elements.namedItem("filename") as HTMLInputElement).value = note.repositoryPath.split("/").at(-1) || "";
  (pageForm.elements.namedItem("copyTitle") as HTMLInputElement).value = `${note.title} copy`;
  const duplicates = pageForm.elements.namedItem("duplicateId") as HTMLSelectElement;
  duplicates.replaceChildren(...(index?.notes || []).filter((item) => item.id !== note.id).map((item) => {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = `${item.title} · ${item.repositoryId}/${item.repositoryPath}`;
    return option;
  }));
  (pageForm.elements.namedItem("action") as HTMLSelectElement).value = "move";
  updatePageOperation();
  updatePageDirectories();
  pageDialog.showModal();
}

function filteredNotes(): WikiNote[] {
  if (!index) return [];
  const query = searchEl.value.trim().toLocaleLowerCase();
  let notes = [...index.notes];
  if (activeView === "recent") notes.sort((a, b) => b.mtimeMs - a.mtimeMs);
  else notes.sort((a, b) => a.title.localeCompare(b.title));
  if (!query) return activeView === "recent" ? notes.slice(0, 40) : notes;
  return notes.filter((note) => [
    note.title, note.path, note.repositoryId, ...note.aliases, ...note.tags,
  ].join(" ").toLocaleLowerCase().includes(query));
}

function renderPages(): void {
  const notes = filteredNotes();
  if (!notes.length) {
    viewEl.append(emptyState("No matching pages", "Try another search or create a page from the workbench."));
    return;
  }
  const grid = document.createElement("div");
  grid.className = "noema-wiki-page-list";
  notes.forEach((note) => grid.append(noteCard(note)));
  viewEl.append(grid);
}

function renderFolders(): void {
  const directories = index?.directories || [];
  const list = document.createElement("div");
  list.className = "noema-wiki-folder-list";
  for (const repository of index?.repositories || []) {
    const rootRow = document.createElement("article");
    rootRow.className = "noema-wiki-folder is-root";
    rootRow.innerHTML = `<span>▾</span><div><strong></strong><small></small></div><b></b>`;
    rootRow.querySelector("strong")!.textContent = repository.id;
    rootRow.querySelector("small")!.textContent = repository.identityStatus === "managed"
      ? `repository ${repository.uid}`
      : "repository identity needs migration";
    rootRow.querySelector("b")!.textContent = String((index?.files || []).filter((file) => file.repositoryId === repository.id).length);
    list.append(rootRow);
    for (const directory of directories.filter((item) => item.repositoryId === repository.id)) {
      const row = document.createElement("article");
      row.className = "noema-wiki-folder";
      const depth = directory.path.split("/").filter(Boolean).length;
      row.style.setProperty("--folder-depth", String(depth));
      row.innerHTML = `<span>⌞</span><div><strong></strong><small></small></div><b></b>`;
      row.querySelector("strong")!.textContent = directory.name;
      row.querySelector("small")!.textContent = directory.path;
      row.querySelector("b")!.textContent = String(directory.fileCount);
      row.addEventListener("click", () => {
        activeView = "files";
        searchEl.value = `${directory.repositoryId} ${directory.path}`;
        selectActiveNav();
        render();
      });
      list.append(row);
    }
  }
  if (!list.childElementCount) viewEl.append(emptyState("No folders", "Repositories retain their physical folder layout."));
  else viewEl.append(list);
}

function renderFiles(): void {
  const query = searchEl.value.trim().toLocaleLowerCase();
  const files = (index?.files || []).filter((file) => !query || [
    file.repositoryId, file.repositoryPath, file.name, file.ext, file.gitStatus,
  ].join(" ").toLocaleLowerCase().includes(query));
  if (!files.length) {
    viewEl.append(emptyState("No matching files", "Every tracked research asset remains visible here, not only Wiki pages."));
    return;
  }
  const list = document.createElement("div");
  list.className = "noema-wiki-file-list";
  for (const file of files) {
    const row = document.createElement("article");
    const icon = document.createElement("span");
    icon.textContent = file.kind === "note" ? "MD" : (file.ext.slice(1, 4).toUpperCase() || "FILE");
    const copy = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = file.name;
    const path = document.createElement("small");
    path.textContent = `${file.repositoryId} · ${file.repositoryPath}`;
    copy.append(name, path);
    const stats = document.createElement("small");
    stats.textContent = `${Math.max(1, Math.round(file.size / 1024))} KB${file.gitStatus ? ` · ${file.gitStatus}` : ""}`;
    row.append(icon, copy, stats);
    if (file.kind === "note") {
      row.tabIndex = 0;
      row.addEventListener("click", () => openNote({ file: file.file }));
    }
    list.append(row);
  }
  viewEl.append(list);
}

async function renderTags(): Promise<void> {
  const marker = activeView;
  try {
    const result = await api.wiki.tags();
    if (activeView !== marker) return;
    const tags = (result.tags || []) as Array<{
      name?: string;
      count?: number;
      variants?: string[];
      pages?: Array<{ id: string; title: string }>;
    }>;
    if (!tags.length) {
      viewEl.append(emptyState("No tags", "Tags declared in page metadata appear here."));
      return;
    }
    const list = document.createElement("div");
    list.className = "noema-wiki-tag-list";
    for (const tag of tags) {
      const row = document.createElement("article");
      const copy = document.createElement("div");
      const name = document.createElement("h2");
      name.textContent = `#${tag.name || ""}`;
      const detail = document.createElement("p");
      detail.textContent = `${tag.count || 0} pages · ${(tag.variants || []).join(", ")}`;
      copy.append(name, detail);
      const actions = document.createElement("div");
      const filter = button("Show pages");
      const rename = button("Rename");
      const remove = button("Delete");
      filter.addEventListener("click", () => {
        activeView = "pages";
        searchEl.value = String(tag.name || "");
        selectActiveNav();
        render();
      });
      rename.addEventListener("click", async () => {
        const to = window.prompt(`Rename #${tag.name} to`);
        if (!to) return;
        await api.wiki.updateTag({ action: "rename", from: tag.name, to });
        await load(true);
      });
      remove.addEventListener("click", async () => {
        if (!window.confirm(`Remove #${tag.name} from ${tag.count || 0} pages?`)) return;
        await api.wiki.updateTag({ action: "delete", from: tag.name });
        await load(true);
      });
      actions.append(filter, rename, remove);
      row.append(copy, actions);
      list.append(row);
    }
    viewEl.append(list);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function renderDependencies(): void {
  const rows = (index?.notes || []).flatMap((note) =>
    (note.dependencies || []).map((dependency) => ({ note, dependency })));
  if (!rows.length) {
    viewEl.append(emptyState("No hard dependencies", "Markdown assets and include directives appear here once referenced."));
    return;
  }
  const list = document.createElement("div");
  list.className = "noema-wiki-dependency-list";
  for (const { note, dependency } of rows) {
    const row = document.createElement("article");
    row.classList.toggle("is-missing", dependency.status !== "resolved");
    const copy = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = note.title;
    const path = document.createElement("small");
    path.textContent = dependency.raw;
    copy.append(title, path);
    const state = document.createElement("span");
    state.textContent = `${dependency.kind} · ${dependency.status}`;
    row.append(copy, state);
    row.addEventListener("click", () => openNote(note));
    list.append(row);
  }
  viewEl.append(list);
}

async function exportCurrentView(): Promise<void> {
  if (!index) return;
  const outputPath = window.prompt("Absolute .zip output path", `${index.root}/noema-export.zip`);
  if (!outputPath) return;
  try {
    let result: Record<string, unknown>;
    if (activeView === "folders" || activeView === "files") {
      const repositoryId = window.prompt("Repository to export physically", index.repositories[0]?.id || "");
      if (!repositoryId) return;
      const path = window.prompt("Folder within repository (empty exports all)", "") ?? "";
      result = await api.wiki.export({ mode: "physical", repositoryId, path, outputPath });
    } else {
      result = await api.wiki.export({ mode: "selection", pageIds: filteredNotes().map((note) => note.id), outputPath });
    }
    setStatus(`Exported ${String(result.fileCount || 0)} files to ${String(result.outputPath || outputPath)}`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

function renderWanted(): void {
  const wanted = index?.reports.wanted || [];
  if (!wanted.length) {
    viewEl.append(emptyState("No wanted pages", "Every Wiki link currently resolves to a page."));
    return;
  }
  const list = document.createElement("div");
  list.className = "noema-wiki-report-list";
  for (const item of wanted) {
    const row = document.createElement("article");
    const copy = document.createElement("div");
    const heading = document.createElement("h2");
    heading.textContent = `[[${item.title}]]`;
    const detail = document.createElement("p");
    detail.textContent = `${item.references.length} unresolved reference${item.references.length === 1 ? "" : "s"}`;
    copy.append(heading, detail);
    const create = button("Open workbench", "is-primary");
    create.addEventListener("click", () => showNewPage(item.title));
    row.append(copy, create);
    list.append(row);
  }
  viewEl.append(list);
}

function renderReports(): void {
  const reports = [
    ["Ambiguous links", index?.reports.ambiguous.length || 0, "A title or alias matches more than one page."],
    ["Duplicate titles / aliases", index?.reports.duplicates.length || 0, "Use partition, repository, and path to disambiguate."],
    ["Workspace diagnostics", index?.diagnostics.length || 0, "Non-Git directories are reported and never initialized automatically."],
  ];
  const grid = document.createElement("div");
  grid.className = "noema-wiki-report-cards";
  for (const [name, count, copy] of reports) {
    const card = document.createElement("article");
    const value = document.createElement("strong");
    value.textContent = String(count);
    const heading = document.createElement("h2");
    heading.textContent = String(name);
    const paragraph = document.createElement("p");
    paragraph.textContent = String(copy);
    card.append(value, heading, paragraph);
    grid.append(card);
  }
  viewEl.append(grid);
  for (const diagnostic of index?.diagnostics || []) {
    const row = document.createElement("p");
    row.className = "noema-wiki-diagnostic";
    row.textContent = `${diagnostic.message}${diagnostic.path ? ` · ${diagnostic.path}` : ""}`;
    viewEl.append(row);
  }
}

async function repositoryCard(repository: WikiRepository): Promise<HTMLElement> {
  const card = document.createElement("article");
  card.className = "noema-wiki-repository";
  const head = document.createElement("div");
  const heading = document.createElement("h2");
  heading.textContent = repository.name;
  const path = document.createElement("p");
  path.textContent = repository.id;
  head.append(heading, path);
  const status = document.createElement("pre");
  status.textContent = "Loading sync state…";
  const actions = document.createElement("div");
  const statusButton = button("Status");
  const checkpoint = button("Checkpoint");
  const sync = button("Sync now", "is-primary");
  const advanced = button("Advanced Git");
  const adopt = repository.identityStatus === "managed" ? null : button("Establish shared identity");
  statusButton.addEventListener("click", async () => {
    status.textContent = "Loading…";
    try {
      const result = await api.wiki.repositoryStatus(repository.id) as { status?: string; branch?: string; clean?: boolean };
      status.textContent = `${result.branch || "detached"} · ${result.clean ? "clean" : "changes"}\n${result.status || ""}`.trim();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  checkpoint.addEventListener("click", async () => {
    checkpoint.disabled = true;
    try {
      const result = await api.wiki.checkpoint(repository.id);
      status.textContent = JSON.stringify(result, null, 2);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      checkpoint.disabled = false;
    }
  });
  sync.addEventListener("click", async () => {
    sync.disabled = true;
    status.textContent = "Checkpointing, fetching, merging, and pushing…";
    try {
      const result = await api.wiki.sync(repository.id);
      renderSyncState(result, status, actions, repository);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      sync.disabled = false;
    }
  });
  advanced.addEventListener("click", async () => {
    advanced.disabled = true;
    try {
      const result = await api.wiki.gitUi(repository.id);
      if (!result.url) throw new Error("ungit did not return an embedded URL");
      gitFrame.src = result.url;
      gitDialog.showModal();
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      advanced.disabled = false;
    }
  });
  adopt?.addEventListener("click", async () => {
    adopt.disabled = true;
    try {
      await api.wiki.adoptRepository(repository.id);
      await load(true);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
      adopt.disabled = false;
    }
  });
  actions.append(statusButton, checkpoint, sync, advanced);
  if (adopt) actions.prepend(adopt);
  card.append(head, actions, status);
  try {
    const state = await api.wiki.syncStatus(repository.id) as WikiSyncState;
    renderSyncState(state, status, actions, repository);
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : String(error);
  }
  return card;
}

function renderSyncState(
  state: WikiSyncState,
  status: HTMLElement,
  actions: HTMLElement,
  repository: WikiRepository,
): void {
  status.textContent = [
    `${state.phase || "idle"} · ${state.branch || "branch pending"}`,
    state.localOnly ? "Local checkpoint only (no origin remote)" : "",
    state.lastSyncedAt ? `Last synced ${state.lastSyncedAt}` : "",
    state.message || "",
    state.error || "",
  ].filter(Boolean).join("\n");
  actions.querySelectorAll("[data-conflict-path]").forEach((item) => item.remove());
  for (const conflict of state.conflicts || []) {
    const resolve = button(`Resolve ${conflict.path}`, "is-danger");
    resolve.dataset.conflictPath = conflict.path;
    resolve.addEventListener("click", () => {
      void openConflict(repository.id, conflict.path);
    });
    actions.append(resolve);
  }
}

async function openConflict(repositoryId: string, path: string): Promise<void> {
  conflictEditor.replaceChildren();
  conflictMessage.textContent = "Loading Base / your branch / remote main…";
  root.querySelector<HTMLElement>("[data-conflict-title]")!.textContent = path;
  if (!conflictDialog.open) conflictDialog.showModal();
  try {
    const conflict = await api.wiki.conflict({ repositoryId, path }) as {
      kind?: string;
      base?: string;
      ours?: string;
      theirs?: string;
    };
    activeConflict = { repositoryId, path, kind: String(conflict.kind || "text") };
    if (activeConflict.kind === "text") {
      const editor = document.createElement("mis-merge3") as HTMLElement & {
        lhs: string;
        ctr: string;
        rhs: string;
        lhsEditable: boolean;
        rhsEditable: boolean;
        wrapLines: boolean;
      };
      editor.lhs = String(conflict.ours || "");
      editor.ctr = String(conflict.base || "");
      editor.rhs = String(conflict.theirs || "");
      editor.lhsEditable = false;
      editor.rhsEditable = false;
      editor.wrapLines = true;
      activeConflict.editor = editor;
      conflictEditor.append(editor);
      conflictMessage.textContent = "Use the arrows inside the merge editor, then review the center result before saving.";
      root.querySelector<HTMLButtonElement>("[data-conflict-save]")!.hidden = false;
    } else {
      conflictEditor.append(emptyState("Binary conflict", "Choose your file, the remote file, or delete it. Binary content cannot be merged by blocks."));
      conflictMessage.textContent = "No content is uploaded; the choice is applied inside the local integration worktree.";
      root.querySelector<HTMLButtonElement>("[data-conflict-save]")!.hidden = true;
    }
  } catch (error) {
    conflictMessage.textContent = error instanceof Error ? error.message : String(error);
    activeConflict = null;
  }
}

async function finishConflict(choice: "result" | "ours" | "theirs" | "delete"): Promise<void> {
  if (!activeConflict) return;
  try {
    const body: Record<string, unknown> = {
      repositoryId: activeConflict.repositoryId,
      path: activeConflict.path,
      choice,
    };
    if (choice === "result") body.result = activeConflict.editor?.ctr || "";
    const state = await api.wiki.resolveConflict(body) as WikiSyncState;
    if (state.phase === "conflicted" && state.conflicts?.length) {
      await openConflict(activeConflict.repositoryId, state.conflicts[0].path);
    } else {
      conflictDialog.close();
      activeConflict = null;
      await load(true);
      setStatus(state.message || "Conflict resolved");
    }
  } catch (error) {
    conflictMessage.textContent = error instanceof Error ? error.message : String(error);
  }
}

async function renderRepositories(): Promise<void> {
  const toolbar = document.createElement("div");
  toolbar.className = "noema-wiki-repository-toolbar";
  const add = button("Add repository", "is-primary");
  add.addEventListener("click", () => repoDialog.showModal());
  toolbar.append(add);
  viewEl.append(toolbar);
  const list = document.createElement("div");
  list.className = "noema-wiki-repository-list";
  viewEl.append(list);
  for (const repository of index?.repositories || []) list.append(await repositoryCard(repository));
  if (!index?.repositories.length) list.append(emptyState("No indexed repositories", "Add a Git repository or switch to Legacy layout in Configuration."));
}

function render(): void {
  if (!index) return;
  root.querySelector<HTMLElement>("[data-wiki-layout]")!.textContent = `${index.layout} layout`;
  root.querySelector<HTMLElement>("[data-wiki-root]")!.textContent = `${index.root} · ${index.dbFile}`;
  root.querySelector<HTMLElement>("[data-count-pages]")!.textContent = String(index.notes.length);
  root.querySelector<HTMLElement>("[data-count-folders]")!.textContent = String(index.directories.length);
  root.querySelector<HTMLElement>("[data-count-files]")!.textContent = String(index.files.length);
  root.querySelector<HTMLElement>("[data-count-wanted]")!.textContent = String(index.reports.wanted.length);
  root.querySelector<HTMLElement>("[data-count-reports]")!.textContent = String(index.reports.ambiguous.length + index.reports.duplicates.length + index.diagnostics.length);
  root.querySelector<HTMLElement>("[data-count-repos]")!.textContent = String(index.repositories.length);
  const labels: Record<string, string> = {
    pages: "All pages",
    recent: "Recent pages",
    folders: "Physical folders",
    files: "All files",
    tags: "Tag management",
    dependencies: "Dependencies",
    sync: "Local and Git sync",
    wanted: "Wanted pages",
    reports: "Reports",
    repositories: "Repositories",
  };
  titleEl.textContent = labels[activeView] || "Wiki";
  viewEl.replaceChildren();
  if (activeView === "wanted") renderWanted();
  else if (activeView === "reports") renderReports();
  else if (activeView === "repositories" || activeView === "sync") void renderRepositories();
  else if (activeView === "folders") renderFolders();
  else if (activeView === "files") renderFiles();
  else if (activeView === "tags") void renderTags();
  else if (activeView === "dependencies") renderDependencies();
  else renderPages();
}

function selectActiveNav(): void {
  root.querySelectorAll<HTMLElement>("[data-view]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.view === activeView);
  });
}

async function load(refresh = false): Promise<void> {
  if (busy) return;
  busy = true;
  setStatus(refresh ? "Refreshing the global Wiki index…" : "Loading Wiki…");
  try {
    index = refresh ? await api.wiki.refresh() : await api.wiki.bootstrap();
    setStatus(`${index.notes.length} pages across ${index.repositories.length} repositories`);
    const select = newForm.elements.namedItem("repositoryId") as HTMLSelectElement;
    select.replaceChildren();
    for (const repository of index.repositories) {
      const option = document.createElement("option");
      option.value = repository.id;
      option.textContent = index.layout === "legacy" ? "Current Legacy repository" : repository.id;
      select.append(option);
    }
    const config = window.__noemaAppConfig?.config;
    const profiles = config?.wiki.creation.profiles || [];
    const profile = profiles.find((item) => item.id === config?.wiki.creation.activeProfile) || profiles[0];
    if (profile) {
      const preferredRepository = profile.repository ? `${profile.partition}/${profile.repository}` : "";
      if ([...select.options].some((option) => option.value === preferredRepository)) {
        select.value = preferredRepository;
      }
      (newForm.elements.namedItem("directory") as HTMLInputElement).value = profile.directory;
      (newForm.elements.namedItem("filename") as HTMLInputElement).placeholder = profile.filenamePattern;
      (newForm.elements.namedItem("kind") as HTMLInputElement).value = profile.kind;
    }
    render();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    viewEl.replaceChildren(emptyState("Wiki unavailable", "Check the workspace root and layout in Configuration."));
  } finally {
    busy = false;
  }
}

function showNewPage(title = ""): void {
  if (!index?.repositories.length) {
    activeView = "repositories";
    render();
    setStatus("Create or clone a repository before creating a page", true);
    return;
  }
  (newForm.elements.namedItem("title") as HTMLInputElement).value = title;
  const sourceFile = new URLSearchParams(location.search).get("source") || "";
  const source = index.notes.find((note) => note.file === sourceFile);
  if (source) {
    (newForm.elements.namedItem("repositoryId") as HTMLSelectElement).value = source.repositoryId;
    (newForm.elements.namedItem("directory") as HTMLInputElement).value = source.repositoryPath.includes("/")
      ? source.repositoryPath.slice(0, source.repositoryPath.lastIndexOf("/"))
      : "";
  }
  updateNewPageDirectories();
  newDialog.showModal();
}

function updateNewPageDirectories(): void {
  const repositoryId = (newForm.elements.namedItem("repositoryId") as HTMLSelectElement).value;
  const datalist = root.querySelector<HTMLDataListElement>("#noema-wiki-directories")!;
  datalist.replaceChildren();
  const rootOption = document.createElement("option");
  rootOption.value = "";
  rootOption.label = "Repository root";
  datalist.append(rootOption);
  for (const directory of index?.directories.filter((item) => item.repositoryId === repositoryId) || []) {
    const option = document.createElement("option");
    option.value = directory.path;
    option.label = `${directory.fileCount} file${directory.fileCount === 1 ? "" : "s"}`;
    datalist.append(option);
  }
}

function updatePageDirectories(): void {
  const repositoryId = (pageForm.elements.namedItem("repositoryId") as HTMLSelectElement).value;
  const datalist = root.querySelector<HTMLDataListElement>("#noema-page-directories")!;
  datalist.replaceChildren();
  for (const directory of index?.directories.filter((item) => item.repositoryId === repositoryId) || []) {
    const option = document.createElement("option");
    option.value = directory.path;
    option.label = `${directory.fileCount} file${directory.fileCount === 1 ? "" : "s"}`;
    datalist.append(option);
  }
}

function updatePageOperation(): void {
  const action = (pageForm.elements.namedItem("action") as HTMLSelectElement).value;
  root.querySelector<HTMLElement>("[data-page-destination]")!.hidden = action === "merge" || action === "delete";
  root.querySelector<HTMLElement>("[data-copy-title]")!.hidden = action !== "copy";
  root.querySelector<HTMLElement>("[data-merge-target]")!.hidden = action !== "merge";
  const warning = root.querySelector<HTMLElement>("[data-page-warning]")!;
  const apply = root.querySelector<HTMLButtonElement>("[data-page-apply]")!;
  const verbs: Record<string, string> = { move: "Move page", copy: "Create copy", merge: "Merge pages", delete: "Move to Trash" };
  apply.textContent = verbs[action] || "Apply";
  apply.classList.toggle("is-danger", action === "delete");
  warning.textContent = action === "delete"
    ? `${activeManagedNote?.backlinks.length || 0} backlinks will become wanted links. The page and its owned assets remain recoverable from Trash.`
    : action === "merge"
      ? "The selected duplicate remains at its path as a redirect, so existing links keep working."
      : action === "move"
        ? "The stable page ID is preserved. Title-based Wiki links continue to resolve after reindexing."
        : "The copy receives a new stable page ID.";
}

async function choosePageDirectory(): Promise<void> {
  const repositoryId = (pageForm.elements.namedItem("repositoryId") as HTMLSelectElement).value;
  const repository = index?.repositories.find((item) => item.id === repositoryId);
  if (!repository || !window.noemaDesktop?.chooseDirectory) return;
  const input = pageForm.elements.namedItem("directory") as HTMLInputElement;
  const result = await window.noemaDesktop.chooseDirectory({
    root: repository.path,
    defaultPath: input.value ? `${repository.path}/${input.value}` : repository.path,
    title: `Choose a folder in ${repository.id}`,
  });
  if (result.message) setStatus(result.message, true);
  if (!result.canceled) input.value = result.relativePath || "";
}

async function applyPageOperation(): Promise<void> {
  const note = activeManagedNote;
  if (!note) return;
  const values = new FormData(pageForm);
  const action = String(values.get("action") || "");
  try {
    if (action === "delete") {
      if (!window.confirm(`Move “${note.title}” and its page-owned assets to the macOS Trash?`)) return;
      const confirm = note.backlinks.length ? window.prompt("Type DELETE to confirm after reviewing the backlinks") : "";
      if (note.backlinks.length && confirm !== "DELETE") return;
      const result = await api.wiki.deletePage({ pageId: note.id, confirm });
      setStatus(`Moved ${note.title} to Trash · ${String(result.trashedTo || "recoverable")}`);
    } else if (action === "merge") {
      const duplicateId = String(values.get("duplicateId") || "");
      if (!duplicateId || window.prompt("Type MERGE to preserve the duplicate as a redirect") !== "MERGE") return;
      await api.wiki.mergePages({ survivorId: note.id, duplicateId, confirm: "MERGE" });
    } else {
      const repositoryId = String(values.get("repositoryId") || "");
      const directory = String(values.get("directory") || "");
      const filename = String(values.get("filename") || "");
      if (action === "move") {
        const target = index?.repositories.find((repository) => repository.id === repositoryId);
        const confirm = note.partition === "private" && target?.partition === "public"
          ? window.prompt("This crosses the privacy boundary. Type MOVE PRIVATE TO PUBLIC")
          : "";
        await api.wiki.movePage({ pageId: note.id, repositoryId, directory, filename, confirm });
      } else {
        await api.wiki.copyPage({
          pageId: note.id,
          repositoryId,
          directory,
          filename,
          title: String(values.get("copyTitle") || ""),
        });
      }
    }
    pageDialog.close();
    activeManagedNote = null;
    await load(true);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  }
}

root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((control) => {
  control.addEventListener("click", () => {
    activeView = control.dataset.view || "pages";
    selectActiveNav();
    render();
  });
});
root.querySelector("[data-refresh]")?.addEventListener("click", () => void load(true));
root.querySelector("[data-new-page]")?.addEventListener("click", () => showNewPage());
root.querySelector("[data-export]")?.addEventListener("click", () => void exportCurrentView());
root.querySelectorAll<HTMLButtonElement>("[data-new-cancel]").forEach((control) => {
  control.addEventListener("click", () => newDialog.close("cancel"));
});
root.querySelectorAll<HTMLButtonElement>("[data-repo-cancel]").forEach((control) => {
  control.addEventListener("click", () => repoDialog.close("cancel"));
});
root.querySelectorAll<HTMLButtonElement>("[data-page-cancel]").forEach((control) => {
  control.addEventListener("click", () => pageDialog.close("cancel"));
});
(pageForm.elements.namedItem("action") as HTMLSelectElement).addEventListener("change", updatePageOperation);
(pageForm.elements.namedItem("repositoryId") as HTMLSelectElement).addEventListener("change", () => {
  (pageForm.elements.namedItem("directory") as HTMLInputElement).value = "";
  updatePageDirectories();
});
root.querySelector<HTMLButtonElement>("[data-page-choose-directory]")?.addEventListener("click", () => void choosePageDirectory());
pageForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void applyPageOperation();
});
(newForm.elements.namedItem("repositoryId") as HTMLSelectElement).addEventListener("change", () => {
  (newForm.elements.namedItem("directory") as HTMLInputElement).value = "";
  updateNewPageDirectories();
});
root.querySelector<HTMLButtonElement>("[data-choose-directory]")?.addEventListener("click", async () => {
  const repositoryId = (newForm.elements.namedItem("repositoryId") as HTMLSelectElement).value;
  const repository = index?.repositories.find((item) => item.id === repositoryId);
  if (!repository) return;
  if (!window.noemaDesktop?.chooseDirectory) {
    (newForm.elements.namedItem("directory") as HTMLInputElement).focus();
    setStatus("Choose an indexed folder from the Directory field, or type a new subfolder");
    return;
  }
  const directory = (newForm.elements.namedItem("directory") as HTMLInputElement).value.trim();
  const result = await window.noemaDesktop.chooseDirectory({
    root: repository.path,
    defaultPath: directory ? `${repository.path}/${directory}` : repository.path,
    title: `Choose a folder in ${repository.id}`,
  });
  if (result.message) setStatus(result.message, true);
  if (!result.canceled) (newForm.elements.namedItem("directory") as HTMLInputElement).value = result.relativePath || "";
});
searchEl.addEventListener("input", render);
window.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchEl.focus();
  }
});
window.addEventListener("aaronnote:command", (event) => {
  const detail = (event as CustomEvent<{ command?: string }>).detail;
  if (detail?.command === "wiki-index-changed") void load(true);
});

root.querySelector("[data-conflict-close]")?.addEventListener("click", () => conflictDialog.close());
root.querySelector("[data-conflict-save]")?.addEventListener("click", () => void finishConflict("result"));
root.querySelector("[data-conflict-ours]")?.addEventListener("click", () => void finishConflict("ours"));
root.querySelector("[data-conflict-theirs]")?.addEventListener("click", () => void finishConflict("theirs"));
root.querySelector("[data-conflict-delete]")?.addEventListener("click", () => void finishConflict("delete"));
root.querySelector("[data-conflict-abort]")?.addEventListener("click", () => {
  if (!activeConflict || !window.confirm("Abort the integration merge and keep your local branch unchanged?")) return;
  void api.wiki.abortConflict(activeConflict.repositoryId).then(() => {
    activeConflict = null;
    conflictDialog.close();
    void load(true);
  }).catch((error) => {
    conflictMessage.textContent = error instanceof Error ? error.message : String(error);
  });
});
root.querySelector("[data-git-close]")?.addEventListener("click", () => gitDialog.close());
gitDialog.addEventListener("close", () => {
  gitFrame.src = "about:blank";
});

newForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if ((event.submitter as HTMLButtonElement | null)?.value === "cancel") return;
  const values = new FormData(newForm);
  void api.wiki.createPage({
    title: values.get("title"),
    repositoryId: values.get("repositoryId"),
    directory: values.get("directory"),
    filename: values.get("filename"),
    kind: values.get("kind"),
    tags: values.get("tags"),
  }).then((result) => {
    newDialog.close();
    if (result.file) openNote({ file: result.file });
    void load(true);
  }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
});

const repoAction = repoForm.elements.namedItem("action") as HTMLSelectElement;
const remoteField = repoForm.querySelector<HTMLElement>("[data-remote-field]")!;
repoAction.addEventListener("change", () => {
  remoteField.hidden = repoAction.value !== "clone";
});
repoForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const values = new FormData(repoForm);
  const body = { partition: values.get("partition"), name: values.get("name"), remote: values.get("remote") };
  const operation = values.get("action") === "clone" ? api.wiki.cloneRepository(body) : api.wiki.initRepository(body);
  void operation.then(() => {
    repoDialog.close();
    repoForm.reset();
    remoteField.hidden = true;
    void load(true);
  }).catch((error) => setStatus(error instanceof Error ? error.message : String(error), true));
});

root.querySelectorAll<HTMLElement>("[data-desktop-command]").forEach((control) => {
  control.addEventListener("click", () => {
    const command = control.dataset.desktopCommand;
    if (command === "back") history.back();
    else if (command === "forward") history.forward();
    else if (command === "refresh") void load(true);
  });
});
root.querySelectorAll<HTMLElement>("[data-desktop-menu]").forEach((control) => {
  control.addEventListener("click", () => {
    void window.noemaDesktop?.showMenu(control.dataset.desktopMenu === "window" ? "window" : "actions", {
      x: control.getBoundingClientRect().left,
      y: control.getBoundingClientRect().bottom,
    });
  });
});

const removeThemeRuntime = installNoemaThemeRuntime();
window.addEventListener("beforeunload", removeThemeRuntime, { once: true });
const initialQuery = new URLSearchParams(location.search);
searchEl.value = initialQuery.get("q") || "";
if (initialQuery.get("new") === "1") {
  void load().then(() => showNewPage(initialQuery.get("title") || ""));
} else {
  void load();
}
