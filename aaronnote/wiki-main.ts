import "../src/styles/theme-loader.ts";
import "./wiki.css";

import { api, type WikiIndex, type WikiNote, type WikiRepository } from "./api-client.ts";
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
      <header><div><p>Wiki workbench</p><h2>New page</h2></div><button value="cancel" aria-label="Close">×</button></header>
      <label><span>Title</span><input name="title" required autofocus></label>
      <div class="noema-wiki-form-grid">
        <label><span>Repository</span><select name="repositoryId" required></select></label>
        <label><span>Directory</span><input name="directory" placeholder="optional/subfolder"></label>
        <label><span>Filename</span><input name="filename" placeholder="generated-from-title.md"></label>
        <label><span>Kind</span><input name="kind" value="note"></label>
      </div>
      <label><span>Tags</span><input name="tags" placeholder="wiki, subject"></label>
      <footer><button value="cancel">Cancel</button><button type="submit" value="default" class="is-primary">Create and open</button></footer>
    </form>
  </dialog>
  <dialog class="noema-wiki-dialog" data-repo-dialog>
    <form method="dialog" data-repo-form>
      <header><div><p>Explicit repository action</p><h2>Add repository</h2></div><button value="cancel" aria-label="Close">×</button></header>
      <div class="noema-wiki-form-grid">
        <label><span>Action</span><select name="action"><option value="init">Initialize empty repository</option><option value="clone">Clone remote</option></select></label>
        <label><span>Partition</span><select name="partition"><option>private</option><option>public</option></select></label>
      </div>
      <label><span>Repository name</span><input name="name" required pattern="[A-Za-z0-9][A-Za-z0-9._-]*"></label>
      <label data-remote-field hidden><span>Git remote</span><input name="remote" placeholder="git@host:owner/repository.git"></label>
      <p>Noema never initializes, stages, commits, pulls, or pushes without this explicit action.</p>
      <footer><button value="cancel">Cancel</button><button type="submit" value="default" class="is-primary">Continue</button></footer>
    </form>
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
let index: WikiIndex | null = null;
let activeView = "pages";
let busy = false;

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
    note.aliases.length ? `${note.aliases.length} aliases` : "",
    note.backlinks.length ? `${note.backlinks.length} backlinks` : "",
    note.tags.slice(0, 4).join(" · "),
  ].filter(Boolean).join(" · ") || "No metadata";
  copy.append(title, path, meta);
  card.append(partition, copy);
  card.addEventListener("click", () => openNote(note));
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") openNote(note);
  });
  return card;
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
  status.textContent = "Status not loaded";
  const actions = document.createElement("div");
  const statusButton = button("Status");
  const commit = button("Commit selected…");
  const pull = button("Pull --ff-only");
  const push = button("Push");
  statusButton.addEventListener("click", async () => {
    status.textContent = "Loading…";
    try {
      const result = await api.wiki.repositoryStatus(repository.id) as { status?: string; branch?: string; clean?: boolean };
      status.textContent = `${result.branch || "detached"} · ${result.clean ? "clean" : "changes"}\n${result.status || ""}`.trim();
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    }
  });
  commit.addEventListener("click", async () => {
    const paths = window.prompt("Repository-relative paths to commit (comma separated)");
    if (!paths) return;
    const message = window.prompt("Commit message");
    if (!message) return;
    commit.disabled = true;
    try {
      const result = await api.wiki.git({
        repositoryId: repository.id,
        action: "commit",
        paths: paths.split(",").map((path) => path.trim()).filter(Boolean),
        message,
      }) as { status?: string };
      status.textContent = result.status || "Commit completed";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : String(error);
    } finally {
      commit.disabled = false;
    }
  });
  for (const [control, action] of [[pull, "pull"], [push, "push"]] as const) {
    control.addEventListener("click", async () => {
      control.disabled = true;
      try {
        const result = await api.wiki.git({ repositoryId: repository.id, action }) as { status?: string };
        status.textContent = result.status || `${action} completed`;
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      } finally {
        control.disabled = false;
      }
    });
  }
  actions.append(statusButton, commit, pull, push);
  card.append(head, actions, status);
  return card;
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
  root.querySelector<HTMLElement>("[data-count-wanted]")!.textContent = String(index.reports.wanted.length);
  root.querySelector<HTMLElement>("[data-count-reports]")!.textContent = String(index.reports.ambiguous.length + index.reports.duplicates.length + index.diagnostics.length);
  root.querySelector<HTMLElement>("[data-count-repos]")!.textContent = String(index.repositories.length);
  const labels: Record<string, string> = { pages: "All pages", recent: "Recent pages", wanted: "Wanted pages", reports: "Reports", repositories: "Repositories" };
  titleEl.textContent = labels[activeView] || "Wiki";
  viewEl.replaceChildren();
  if (activeView === "wanted") renderWanted();
  else if (activeView === "reports") renderReports();
  else if (activeView === "repositories") void renderRepositories();
  else renderPages();
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
  newDialog.showModal();
}

root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((control) => {
  control.addEventListener("click", () => {
    activeView = control.dataset.view || "pages";
    root.querySelectorAll("[data-view]").forEach((item) => item.classList.toggle("is-active", item === control));
    render();
  });
});
root.querySelector("[data-refresh]")?.addEventListener("click", () => void load(true));
root.querySelector("[data-new-page]")?.addEventListener("click", () => showNewPage());
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

newForm.addEventListener("submit", (event) => {
  event.preventDefault();
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
