import type { EditorView } from "@codemirror/view";
import { api, type DocumentCommit } from "../../../../../pages/api-client.ts";
import { writeSystemClipboard } from "../../../../system-clipboard.ts";
import { currentNotePath, loadWhenVisible } from "./document-excerpts.ts";

const connected = new WeakSet<HTMLElement>();

function renderHistory(commits: readonly DocumentCommit[], notePath: string): HTMLElement {
  const list = document.createElement("ul");
  list.className = "noema-repo-history";
  for (const commit of commits) {
    const row = document.createElement("li");
    const hash = document.createElement("button");
    hash.className = "noema-repo-hash";
    hash.type = "button";
    hash.title = commit.id;
    hash.setAttribute("aria-label", `Copy commit ${commit.short}`);
    const code = document.createElement("code");
    code.textContent = commit.short;
    hash.append(code);
    hash.addEventListener("click", () => {
      if (currentNotePath() !== notePath) return;
      void writeSystemClipboard(commit.id).then((copied) => {
        if (!hash.isConnected || !copied) return;
        code.textContent = "Copied";
        window.setTimeout(() => { code.textContent = commit.short; }, 1000);
      });
    });
    const time = document.createElement("time");
    time.dateTime = commit.date;
    time.textContent = commit.date;
    const author = document.createElement("span");
    author.className = "noema-repo-author";
    author.textContent = commit.author;
    author.title = commit.author;
    const subject = document.createElement("span");
    subject.className = "noema-repo-subject";
    subject.textContent = commit.subject || "Working copy";
    row.append(hash, time, author, subject);
    list.append(row);
  }
  return list;
}

function renderPatch(patch: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "noema-repo-patch noema-excerpt-code";
  pre.tabIndex = 0;
  pre.setAttribute("aria-label", "Repository patch");
  const code = document.createElement("code");
  let hunk = false;
  const lines = patch.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, index) => {
    if (line.startsWith("diff --git ")) hunk = false;
    const row = document.createElement("span");
    row.className = "noema-repo-patch-row";
    row.dataset.patchLine = hunk && line.startsWith("+") ? "added" : hunk && line.startsWith("-") ? "removed"
      : !hunk || line.startsWith("@@") ? "metadata" : "context";
    if (line.startsWith("@@")) hunk = true;
    row.textContent = line + (index + 1 < lines.length || patch.endsWith("\n") ? "\n" : "");
    code.append(row);
  });
  pre.append(code);
  return pre;
}

export function connectDocumentRepository(root: ParentNode, view: EditorView): void {
  for (const group of root.querySelectorAll<HTMLElement>(".noema-document-repository[data-repo-kind]")) {
    if (connected.has(group)) continue;
    connected.add(group);
    const output = group.querySelector<HTMLElement>(".noema-repo-output");
    const label = group.querySelector<HTMLElement>(".noema-repo-label");
    const status = group.querySelector<HTMLElement>(".noema-excerpt-status");
    const fallback = group.querySelector<HTMLElement>(".noema-excerpt-fallback");
    const refresh = group.querySelector<HTMLButtonElement>("[data-repo-refresh]");
    const copy = group.querySelector<HTMLButtonElement>("[data-repo-copy]");
    if (!output || !label || !status || !fallback || !refresh) continue;
    const data = group.dataset;
    const options = { kind: data.repoKind, path: data.repoPath, vcs: data.repoVcs, limit: data.repoLimit, range: data.repoRange };
    let patch: { text: string; notePath: string } | null = null;
    const load = async () => {
      if (!group.isConnected || refresh.disabled) return;
      const notePath = currentNotePath();
      refresh.disabled = true;
      if (copy) copy.disabled = true;
      patch = null;
      status.hidden = false;
      status.textContent = "Loading repository…";
      try {
        const snapshot = await api.documentAssets.version({ notePath, ...options });
        if (!group.isConnected || notePath !== currentNotePath()) return;
        label.textContent = `${snapshot.provider === "jj" ? "Jujutsu" : "Git"} · ${snapshot.label}`;
        fallback.hidden = true;
        if ("commits" in snapshot) {
          output.replaceChildren(renderHistory(snapshot.commits, notePath));
          status.textContent = snapshot.commits.length ? "" : "No commits in this view.";
        } else {
          const hasPatch = snapshot.patch.trim().length > 0;
          patch = hasPatch ? { text: snapshot.patch, notePath } : null;
          output.replaceChildren(...(hasPatch ? [renderPatch(snapshot.patch)] : []));
          status.textContent = hasPatch ? (snapshot.truncated ? "Patch preview limited to 200 lines." : "") : "No changes in this view.";
          if (copy) {
            copy.disabled = !hasPatch;
            copy.textContent = "Copy patch";
          }
        }
        status.hidden = !status.textContent;
      } catch (error) {
        if (!group.isConnected || notePath !== currentNotePath()) return;
        output.replaceChildren();
        fallback.hidden = false;
        status.textContent = error instanceof Error ? error.message : "The repository could not be read.";
      } finally {
        refresh.disabled = false;
        if (group.isConnected) view.requestMeasure();
      }
    };
    refresh.addEventListener("click", () => { void load(); });
    copy?.addEventListener("click", () => {
      const selected = patch;
      if (!selected || selected.notePath !== currentNotePath()) return;
      void writeSystemClipboard(selected.text).then((copied) => {
        if (copied && copy.isConnected && selected === patch) copy.textContent = "Copied";
      });
    });
    loadWhenVisible(group, () => { void load(); });
  }
}
