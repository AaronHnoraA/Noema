// The repository view used to be a heading, four buttons and a <pre> rebuilt
// from scratch on every sync broadcast.  This module owns its DOM instead and
// updates one repository at a time, which is what lets it hold a staging
// selection, a commit message and an in-flight button across the phase events
// the sync engine now streams.

import type {
  WikiBranch,
  WikiBranchList,
  WikiRemote,
  WikiRemoteList,
  WikiRepository,
  WikiRepositoryStatus,
  WikiSyncState,
} from "./api-client.ts";

export type RepositoryStatusEntry = {
  code: string;
  path: string;
  origPath: string;
  label: string;
  conflicted: boolean;
  untracked: boolean;
  staged: boolean;
  unstaged: boolean;
};

export type RepositoryStatus = WikiRepositoryStatus;

// The slice of `api.wiki` this view needs, injected so the panel can be
// exercised without a host bridge — the same shape `agenda-view.ts` uses.
export type VersionControlApi = {
  repositoryStatus: (repositoryId: string) => Promise<WikiRepositoryStatus>;
  repositoryDiff: (repositoryId: string, path: string) => Promise<{ diff?: string; tracked?: boolean }>;
  syncStatus: (repositoryId?: string) => Promise<Record<string, unknown>>;
  checkpoint: (repositoryId: string, message?: string) => Promise<Record<string, unknown>>;
  sync: (repositoryId: string) => Promise<WikiSyncState>;
  git: (body: {
    repositoryId: string;
    action: "pull" | "push" | "commit";
    message?: string;
    paths?: string[];
  }) => Promise<Record<string, unknown>>;
  abortConflict: (repositoryId: string) => Promise<Record<string, unknown>>;
  adoptRepository: (repositoryId: string) => Promise<Record<string, unknown>>;
  branches: (repositoryId: string) => Promise<WikiBranchList>;
  branchAction: (body: {
    repositoryId: string;
    action: "create" | "switch" | "delete";
    name: string;
    startPoint?: string;
    force?: boolean;
  }) => Promise<WikiBranchList>;
  remotes: (repositoryId: string) => Promise<WikiRemoteList>;
  remoteAction: (body: {
    repositoryId: string;
    action: "set" | "remove";
    name: string;
    url?: string;
  }) => Promise<WikiRemoteList>;
};

export type VersionControlHost = {
  api: VersionControlApi;
  repositories: () => WikiRepository[];
  setStatus: (message: string, error?: boolean) => void;
  reloadIndex: () => Promise<void>;
  openConflict: (repositoryId: string, path: string) => void;
  openGitUi: (repositoryId: string) => Promise<void>;
  rememberSyncState: (repositoryId: string, state: Partial<WikiSyncState>) => void;
  addRepository: () => void;
  confirm: (message: string) => boolean;
};

const PHASE_LABELS: Record<string, string> = {
  idle: "Up to date",
  checkpointing: "Committing local changes",
  fetching: "Fetching origin",
  merging: "Merging remote work",
  pushing: "Publishing to origin",
  applying: "Applying the published result",
  waiting: "Waiting to retry",
  conflicted: "Conflicts need resolution",
  error: "Sync failed",
};

const PHASE_ORDER = ["checkpointing", "fetching", "merging", "pushing", "applying"];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function actionButton(label: string, className = ""): HTMLButtonElement {
  const node = element("button", className, label);
  node.type = "button";
  return node;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function shortRemote(remote: string): string {
  const value = remote.trim();
  if (!value) return "";
  return value.replace(/^https?:\/\/[^@/]+@/, "https://").replace(/\.git$/, "");
}

type CardControls = {
  root: HTMLElement;
  badges: HTMLElement;
  location: HTMLElement;
  phase: HTMLElement;
  phaseLabel: HTMLElement;
  phaseDetail: HTMLElement;
  changes: HTMLElement;
  changesSummary: HTMLElement;
  changesList: HTMLElement;
  selectAll: HTMLInputElement;
  commitMessage: HTMLInputElement;
  commitSelected: HTMLButtonElement;
  checkpoint: HTMLButtonElement;
  conflicts: HTMLElement;
  conflictList: HTMLElement;
  conflictHeading: HTMLElement;
  actions: HTMLElement;
  maintenance: HTMLDetailsElement;
  branchList: HTMLElement;
  branchName: HTMLInputElement;
  remoteList: HTMLElement;
  remoteUrl: HTMLInputElement;
  maintenanceMessage: HTMLElement;
  sync: HTMLButtonElement;
  pull: HTMLButtonElement;
  push: HTMLButtonElement;
  message: HTMLElement;
  raw: HTMLElement;
  rawBody: HTMLElement;
};

type Card = {
  repository: WikiRepository;
  controls: CardControls;
  status: RepositoryStatus | null;
  sync: Partial<WikiSyncState> | null;
  statusError: string;
  selected: Set<string>;
  openDiff: string;
  diffText: string;
  busy: boolean;
  branches: WikiBranch[] | null;
  remotes: WikiRemote[] | null;
};

export function createVersionControlView(host: VersionControlHost) {
  const cards = new Map<string, Card>();
  // A background index refresh remounts the view.  Staging selection and a
  // half-typed commit message are the user's work, not derived state, so they
  // outlive the DOM that displayed them.
  const drafts = new Map<string, { selected: string[]; message: string }>();
  let summaryEl: HTMLElement | null = null;
  let syncAllButton: HTMLButtonElement | null = null;
  let generation = 0;

  function repositoryOf(id: string): Card | undefined {
    return cards.get(id);
  }

  function setBusy(card: Card, busy: boolean): void {
    card.busy = busy;
    card.controls.root.classList.toggle("is-busy", busy);
    updateActionState(card);
  }

  function updateActionState(card: Card): void {
    const { controls } = card;
    const hasRemote = Boolean(card.status?.remote);
    const conflicted = card.sync?.phase === "conflicted";
    const selected = card.selected.size;
    controls.sync.disabled = card.busy || conflicted;
    controls.pull.disabled = card.busy || !hasRemote || conflicted;
    controls.push.disabled = card.busy || !hasRemote || conflicted;
    controls.checkpoint.disabled = card.busy || conflicted || Boolean(card.status?.clean);
    controls.commitSelected.disabled = card.busy || conflicted || selected === 0
      || !controls.commitMessage.value.trim();
    controls.commitSelected.textContent = selected
      ? `Commit ${countLabel(selected, "file")}`
      : "Commit selected";
    controls.pull.title = hasRemote ? "" : "This repository has no origin remote";
    controls.push.title = controls.pull.title;
  }

  function renderBadges(card: Card): void {
    const { controls, status } = card;
    controls.badges.replaceChildren();
    if (!status) {
      controls.badges.append(element("span", "noema-vc-badge is-muted", card.statusError ? "Status unavailable" : "Loading…"));
      return;
    }
    const branch = status.detached ? "detached HEAD" : (status.branch || "no branch");
    controls.badges.append(element("span", "noema-vc-badge is-branch", branch));
    if (status.upstream) {
      controls.badges.append(element(
        "span",
        `noema-vc-badge ${status.upstreamGone ? "is-warn" : "is-muted"}`,
        status.upstreamGone ? `${status.upstream} (gone)` : status.upstream,
      ));
    } else if (status.publishTarget) {
      // A device work branch tracks nothing but still publishes somewhere;
      // naming that target beats reporting "no upstream" on every repository.
      const badge = element("span", "noema-vc-badge is-muted", `→ ${status.publishTarget}`);
      badge.title = "Publish target for this device branch";
      controls.badges.append(badge);
    } else if (!status.initial) {
      controls.badges.append(element("span", "noema-vc-badge is-muted", "no upstream"));
    }
    if (status.ahead) controls.badges.append(element("span", "noema-vc-badge is-ahead", `↑${status.ahead}`));
    if (status.behind) controls.badges.append(element("span", "noema-vc-badge is-behind", `↓${status.behind}`));
    const conflicted = status.conflictedFiles || 0;
    const changed = (status.changedFiles || 0) - conflicted;
    if (conflicted) controls.badges.append(element("span", "noema-vc-badge is-conflict", `${countLabel(conflicted, "conflict")}`));
    if (changed > 0) controls.badges.append(element("span", "noema-vc-badge is-dirty", `${countLabel(changed, "change")}`));
    if (status.clean) controls.badges.append(element("span", "noema-vc-badge is-clean", "Clean"));
    if (status.initial) controls.badges.append(element("span", "noema-vc-badge is-muted", "no commits yet"));
  }

  function renderLocation(card: Card): void {
    const { controls, status, repository } = card;
    const parts: string[] = [];
    const remote = shortRemote(String(status?.remote || ""));
    parts.push(remote ? `origin ${remote}` : "no origin remote");
    parts.push(String(status?.path || repository.path || repository.id));
    if (status?.head) parts.push(status.head.slice(0, 8));
    controls.location.textContent = parts.join("  ·  ");
  }

  function renderPhase(card: Card): void {
    const { controls, sync } = card;
    const phase = String(sync?.phase || "");
    const running = PHASE_ORDER.includes(phase);
    controls.phase.hidden = !phase || (phase === "idle" && !sync?.lastSyncedAt);
    controls.phase.classList.toggle("is-running", running || card.busy);
    controls.phase.classList.toggle("is-error", phase === "error");
    controls.phase.classList.toggle("is-conflict", phase === "conflicted");
    controls.phase.dataset.step = running ? String(PHASE_ORDER.indexOf(phase) + 1) : "";
    controls.phaseLabel.textContent = PHASE_LABELS[phase] || phase || "Idle";
    const detail: string[] = [];
    if (running) detail.push(`step ${PHASE_ORDER.indexOf(phase) + 1} of ${PHASE_ORDER.length}`);
    if (sync?.localOnly) detail.push("local commit only (no origin remote)");
    if (sync?.lastSyncedAt && !running) detail.push(`last synced ${new Date(sync.lastSyncedAt).toLocaleString()}`);
    // Only a state that is actually waiting has a retry pending.
    if (sync?.nextRetryAt && sync?.retryable) detail.push(`next retry ${new Date(sync.nextRetryAt).toLocaleString()}`);
    if (sync?.attemptsExhausted) {
      detail.push("paused after repeated failures — Commit & sync retries now");
    } else if (sync?.automatic) {
      detail.push(sync.automaticIntervalMinutes && sync.automaticIntervalMinutes !== 1440
        ? `automatic sync every ${sync.automaticIntervalMinutes} min`
        : "automatic daily sync on");
    } else if (sync?.automaticForcedOff) {
      detail.push("automatic sync disabled by NOEMA_WIKI_AUTO_SYNC=0");
    }
    controls.phaseDetail.textContent = detail.join("  ·  ");
  }

  function renderMessage(card: Card): void {
    const { controls, sync } = card;
    const lines: string[] = [];
    if (card.statusError) lines.push(card.statusError);
    if (sync?.actionRequired) lines.push(sync.actionRequired);
    if (sync?.error) lines.push(sync.error);
    else if (sync?.message) lines.push(sync.message);
    for (const artifact of sync?.recoveryArtifacts || []) {
      lines.push(`Recovered ${countLabel(artifact.files.length, "working file")} to ${artifact.path}`);
    }
    controls.message.textContent = lines.join("\n");
    controls.message.hidden = lines.length === 0;
    const kind = String(sync?.errorKind || "");
    controls.message.dataset.errorKind = sync?.error || card.statusError ? (kind || "internal") : "";
    controls.message.classList.toggle("is-error", Boolean(sync?.error || card.statusError));
  }

  function renderRaw(card: Card): void {
    const raw = String(card.status?.status || "").trim();
    card.controls.raw.hidden = !raw;
    card.controls.rawBody.textContent = raw;
  }

  function renderConflicts(card: Card): void {
    const { controls } = card;
    const conflicts = card.sync?.phase === "conflicted" ? (card.sync?.conflicts || []) : [];
    controls.conflicts.hidden = conflicts.length === 0;
    controls.conflictHeading.textContent = `${countLabel(conflicts.length, "file needs", "files need")} resolution`;
    controls.conflictList.replaceChildren();
    for (const conflict of conflicts) {
      const row = element("li", "noema-vc-conflict-row");
      row.append(element("span", "noema-vc-path", conflict.path));
      const open = actionButton("Resolve", "is-danger");
      open.addEventListener("click", () => host.openConflict(card.repository.id, conflict.path));
      row.append(open);
      controls.conflictList.append(row);
    }
  }

  function rememberDraft(card: Card): void {
    const message = card.controls.commitMessage.value;
    if (!message && card.selected.size === 0) drafts.delete(card.repository.id);
    else drafts.set(card.repository.id, { selected: [...card.selected], message });
  }

  function renderChanges(card: Card): void {
    const { controls } = card;
    const entries = (card.status?.entries || []).filter((entry) => !entry.conflicted);
    const known = new Set(entries.map((entry) => entry.path));
    // Only prune against a status that has actually been read; the first render
    // happens before the round-trip lands and would otherwise discard a
    // restored selection.
    let pruned = false;
    if (card.status) {
      for (const path of [...card.selected]) {
        if (known.has(path)) continue;
        card.selected.delete(path);
        pruned = true;
      }
    }
    if (pruned) rememberDraft(card);
    controls.changes.hidden = entries.length === 0;
    controls.changesSummary.textContent = entries.length
      ? `${countLabel(entries.length, "changed file")} · ${card.selected.size} selected`
      : "";
    controls.selectAll.checked = entries.length > 0 && card.selected.size === entries.length;
    controls.selectAll.indeterminate = card.selected.size > 0 && card.selected.size < entries.length;
    controls.changesList.replaceChildren();
    for (const entry of entries) {
      const row = element("li", "noema-vc-change-row");
      if (entry.path === card.openDiff) row.classList.add("is-open");
      const label = element("label", "noema-vc-change-label");
      const check = element("input");
      check.type = "checkbox";
      check.checked = card.selected.has(entry.path);
      check.addEventListener("change", () => {
        if (check.checked) card.selected.add(entry.path);
        else card.selected.delete(entry.path);
        rememberDraft(card);
        renderChanges(card);
        updateActionState(card);
      });
      const code = element("code", `noema-vc-code is-${entry.untracked ? "new" : entry.code.trim().toLowerCase() || "mod"}`, entry.code.replace(/ /g, "·"));
      code.title = entry.label;
      const path = element("span", "noema-vc-path", entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path);
      label.append(check, code, path);
      const diff = actionButton(entry.path === card.openDiff ? "Hide diff" : "Diff", "noema-vc-diff-toggle");
      diff.addEventListener("click", () => { void toggleDiff(card, entry.path); });
      row.append(label, diff);
      controls.changesList.append(row);
      if (entry.path === card.openDiff) {
        const body = element("pre", "noema-vc-diff", card.diffText || "Loading diff…");
        controls.changesList.append(body);
      }
    }
  }

  async function toggleDiff(card: Card, path: string): Promise<void> {
    if (card.openDiff === path) {
      card.openDiff = "";
      card.diffText = "";
      renderChanges(card);
      return;
    }
    card.openDiff = path;
    card.diffText = "";
    renderChanges(card);
    try {
      const result = await host.api.repositoryDiff(card.repository.id, path);
      if (card.openDiff !== path) return;
      card.diffText = result.diff?.trim() || "No textual difference.";
    } catch (error) {
      if (card.openDiff !== path) return;
      card.diffText = errorText(error);
    }
    renderChanges(card);
  }

  function renderBranches(card: Card): void {
    const { controls } = card;
    controls.branchList.replaceChildren();
    if (!card.branches) {
      controls.branchList.append(element("p", "noema-vc-hint", "Loading branches…"));
      return;
    }
    if (!card.branches.length) {
      controls.branchList.append(element("p", "noema-vc-hint", "This repository has no commits yet."));
      return;
    }
    for (const branch of card.branches) {
      const row = element("li", "noema-vc-branch-row");
      if (branch.current) row.classList.add("is-current");
      const label = element("div", "noema-vc-branch-label");
      label.append(element("span", "noema-vc-path", branch.name));
      const meta: string[] = [];
      if (branch.upstream) meta.push(`→ ${branch.upstream}`);
      if (branch.checkedOutAt && !branch.current) meta.push("checked out elsewhere");
      if (branch.managed) meta.push("Noema-managed");
      if (branch.committedAt) meta.push(new Date(branch.committedAt).toLocaleDateString());
      label.append(element("small", "noema-vc-branch-meta", meta.join("  ·  ")));
      row.append(label);
      const rowActions = element("div", "noema-vc-branch-actions");
      if (branch.current) {
        rowActions.append(element("span", "noema-vc-badge is-branch", "current"));
      } else {
        const use = actionButton("Switch");
        use.disabled = card.busy || Boolean(branch.checkedOutAt);
        use.addEventListener("click", () => {
          void runAction(card, `Switch to ${branch.name}`, async () => {
            const result = await host.api.branchAction({
              repositoryId: card.repository.id,
              action: "switch",
              name: branch.name,
            });
            card.branches = result.branches || null;
            return result as Record<string, unknown>;
          });
        });
        const remove = actionButton("Delete");
        remove.disabled = card.busy || Boolean(branch.checkedOutAt);
        remove.addEventListener("click", () => {
          const warning = branch.managed
            ? `${branch.name} is maintained by Noema's sync engine. Delete it anyway?`
            : `Delete ${branch.name}?`;
          if (!host.confirm(warning)) return;
          void runAction(card, `Delete ${branch.name}`, async () => {
            const result = await host.api.branchAction({
              repositoryId: card.repository.id,
              action: "delete",
              name: branch.name,
              force: branch.managed,
            });
            card.branches = result.branches || null;
            return result as Record<string, unknown>;
          });
        });
        rowActions.append(use, remove);
      }
      row.append(rowActions);
      controls.branchList.append(row);
    }
  }

  function renderRemotes(card: Card): void {
    const { controls } = card;
    controls.remoteList.replaceChildren();
    if (!card.remotes) {
      controls.remoteList.append(element("p", "noema-vc-hint", "Loading remotes…"));
      return;
    }
    if (!card.remotes.length) {
      controls.remoteList.append(element("p", "noema-vc-hint", "No remote configured; sync keeps a local commit only."));
      return;
    }
    for (const remote of card.remotes) {
      const row = element("li", "noema-vc-branch-row");
      const label = element("div", "noema-vc-branch-label");
      label.append(element("span", "noema-vc-path", remote.name));
      label.append(element("small", "noema-vc-branch-meta", shortRemote(remote.fetchUrl || remote.pushUrl)));
      row.append(label);
      const rowActions = element("div", "noema-vc-branch-actions");
      const edit = actionButton("Edit");
      edit.disabled = card.busy;
      edit.addEventListener("click", () => {
        controls.remoteUrl.value = remote.fetchUrl || remote.pushUrl;
        controls.remoteUrl.dataset.remoteName = remote.name;
        controls.remoteUrl.focus();
      });
      const remove = actionButton("Remove");
      remove.disabled = card.busy;
      remove.addEventListener("click", () => {
        if (!host.confirm(`Remove remote ${remote.name}? Sync will keep local commits only.`)) return;
        void runAction(card, `Remove remote ${remote.name}`, async () => {
          const result = await host.api.remoteAction({
            repositoryId: card.repository.id,
            action: "remove",
            name: remote.name,
          });
          card.remotes = result.remotes || null;
          return result as Record<string, unknown>;
        });
      });
      rowActions.append(edit, remove);
      row.append(rowActions);
      controls.remoteList.append(row);
    }
  }

  async function loadMaintenance(card: Card): Promise<void> {
    const token = generation;
    const [branches, remotes] = await Promise.all([
      host.api.branches(card.repository.id).catch((error) => ({ message: errorText(error) } as WikiBranchList)),
      host.api.remotes(card.repository.id).catch((error) => ({ message: errorText(error) } as WikiRemoteList)),
    ]);
    if (token !== generation) return;
    card.branches = branches.branches || [];
    card.remotes = remotes.remotes || [];
    renderBranches(card);
    renderRemotes(card);
  }

  function renderCard(card: Card): void {
    renderBadges(card);
    renderLocation(card);
    renderPhase(card);
    renderConflicts(card);
    renderChanges(card);
    renderMessage(card);
    renderRaw(card);
    if (card.controls.maintenance.open) {
      renderBranches(card);
      renderRemotes(card);
    }
    updateActionState(card);
  }

  function renderSummary(): void {
    if (!summaryEl) return;
    const list = [...cards.values()];
    const loaded = list.filter((card) => card.status);
    const changed = loaded.reduce((total, card) => total + (card.status?.changedFiles || 0), 0);
    const ahead = loaded.reduce((total, card) => total + (card.status?.ahead || 0), 0);
    const behind = loaded.reduce((total, card) => total + (card.status?.behind || 0), 0);
    const conflicts = loaded.reduce((total, card) => total + (card.status?.conflictedFiles || 0), 0);
    const parts = [countLabel(list.length, "repository", "repositories")];
    if (conflicts) parts.push(`${countLabel(conflicts, "conflict")}`);
    parts.push(changed ? `${countLabel(changed, "uncommitted change")}` : "no uncommitted changes");
    if (ahead) parts.push(`↑${ahead} to push`);
    if (behind) parts.push(`↓${behind} to merge`);
    summaryEl.textContent = parts.join("  ·  ");
    if (syncAllButton) syncAllButton.disabled = list.length === 0 || list.some((card) => card.busy);
  }

  async function refreshStatus(card: Card): Promise<void> {
    const token = generation;
    try {
      const status = await host.api.repositoryStatus(card.repository.id) as RepositoryStatus;
      if (token !== generation) return;
      card.status = status;
      card.statusError = "";
    } catch (error) {
      if (token !== generation) return;
      card.status = null;
      card.statusError = errorText(error);
    }
    renderCard(card);
    renderSummary();
  }

  async function refreshSync(card: Card): Promise<void> {
    const token = generation;
    try {
      const state = await host.api.syncStatus(card.repository.id) as WikiSyncState;
      if (token !== generation) return;
      card.sync = state;
      host.rememberSyncState(card.repository.id, state);
    } catch (error) {
      if (token !== generation) return;
      card.statusError = card.statusError || errorText(error);
    }
    renderCard(card);
  }

  async function runAction(
    card: Card,
    label: string,
    task: () => Promise<Partial<WikiSyncState> | Record<string, unknown>>,
  ): Promise<void> {
    if (card.busy) return;
    setBusy(card, true);
    card.sync = { ...card.sync, phase: card.sync?.phase, message: `${label}…`, error: "" } as Partial<WikiSyncState>;
    renderMessage(card);
    renderSummary();
    try {
      const result = await task() as Partial<WikiSyncState>;
      if (result && typeof result === "object" && "phase" in result) {
        card.sync = result;
        host.rememberSyncState(card.repository.id, result);
      } else if (result && typeof result === "object") {
        card.sync = { ...card.sync, message: String(result.message || `${label} complete`), error: "" } as Partial<WikiSyncState>;
      }
      host.setStatus(`${card.repository.id}: ${label} complete`);
    } catch (error) {
      card.sync = { ...card.sync, error: errorText(error) } as Partial<WikiSyncState>;
      host.setStatus(`${card.repository.id}: ${label} failed — ${errorText(error)}`, true);
    } finally {
      setBusy(card, false);
      await refreshStatus(card);
      if (card.controls.maintenance.open) await loadMaintenance(card);
      renderCard(card);
      renderSummary();
    }
  }

  function buildCard(repository: WikiRepository): Card {
    const root = element("article", "noema-vc-repo");
    root.dataset.repositoryId = repository.id;

    const head = element("header", "noema-vc-repo-head");
    const identity = element("div", "noema-vc-identity");
    identity.append(element("h2", "", repository.name));
    identity.append(element("span", `noema-vc-partition is-${repository.partition}`, repository.partition));
    identity.append(element("span", "noema-vc-repo-id", repository.id));
    const badges = element("div", "noema-vc-badges");
    head.append(identity, badges);

    const location = element("p", "noema-vc-location");

    const phase = element("div", "noema-vc-phase");
    const phaseLabel = element("strong");
    const phaseDetail = element("span");
    phase.append(element("i", "noema-vc-phase-dot"), phaseLabel, phaseDetail);

    const conflicts = element("section", "noema-vc-conflicts");
    const conflictHeading = element("h3");
    const conflictList = element("ul", "noema-vc-conflict-list");
    const abort = actionButton("Abort the merge");
    abort.addEventListener("click", () => {
      if (!host.confirm(`Abort the integration merge for ${repository.id} and keep your local branch unchanged?`)) return;
      void runAction(card, "Abort merge", () => host.api.abortConflict(repository.id));
    });
    conflicts.append(conflictHeading, conflictList, abort);

    const changes = element("section", "noema-vc-changes");
    const changesHead = element("header", "noema-vc-changes-head");
    const selectAllLabel = element("label", "noema-vc-select-all");
    const selectAll = element("input");
    selectAll.type = "checkbox";
    selectAllLabel.append(selectAll, element("span", "", "Select all"));
    const changesSummary = element("span", "noema-vc-changes-summary");
    changesHead.append(selectAllLabel, changesSummary);
    const changesList = element("ul", "noema-vc-change-list");
    const commitRow = element("div", "noema-vc-commit-row");
    const commitMessage = element("input", "noema-vc-commit-message");
    commitMessage.type = "text";
    commitMessage.placeholder = "Commit message";
    commitMessage.setAttribute("aria-label", `Commit message for ${repository.id}`);
    const commitSelected = actionButton("Commit selected", "is-primary");
    const checkpoint = actionButton("Checkpoint all");
    commitRow.append(commitMessage, commitSelected, checkpoint);
    changes.append(changesHead, changesList, commitRow);

    const actions = element("div", "noema-vc-actions");
    const sync = actionButton("Commit & sync", "is-primary");
    const pull = actionButton("Pull");
    const push = actionButton("Push");
    const advanced = actionButton("Advanced Git");
    const refresh = actionButton("Refresh");
    actions.append(sync, pull, push, refresh, advanced);
    if (repository.identityStatus !== "managed") {
      const adopt = actionButton("Establish shared identity");
      adopt.addEventListener("click", () => {
        adopt.disabled = true;
        void host.api.adoptRepository(repository.id)
          .then(() => host.reloadIndex())
          .catch((error) => {
            adopt.disabled = false;
            host.setStatus(errorText(error), true);
          });
      });
      actions.append(adopt);
    }

    // Branch and remote maintenance is deliberately behind a disclosure: it is
    // rare next to commit/sync, and its lists cost a round-trip each.
    const maintenance = element("details", "noema-vc-maintenance");
    maintenance.append(element("summary", "", "Branches and remotes"));
    const maintenanceBody = element("div", "noema-vc-maintenance-body");
    const branchHeading = element("h3", "", "Branches");
    const branchList = element("ul", "noema-vc-branch-list");
    const branchForm = element("div", "noema-vc-inline-form");
    const branchName = element("input", "noema-vc-commit-message");
    branchName.type = "text";
    branchName.placeholder = "New branch name";
    branchName.setAttribute("aria-label", `New branch in ${repository.id}`);
    const branchCreate = actionButton("Create and switch");
    const remoteHeading = element("h3", "", "Remotes");
    const remoteList = element("ul", "noema-vc-branch-list");
    const remoteForm = element("div", "noema-vc-inline-form");
    const remoteUrl = element("input", "noema-vc-commit-message");
    remoteUrl.type = "text";
    remoteUrl.placeholder = "git@host:owner/repository.git";
    remoteUrl.setAttribute("aria-label", `Origin URL for ${repository.id}`);
    const remoteSave = actionButton("Save origin");
    const maintenanceMessage = element("p", "noema-vc-hint");
    branchForm.append(branchName, branchCreate);
    remoteForm.append(remoteUrl, remoteSave);
    maintenanceBody.append(branchHeading, branchList, branchForm, remoteHeading, remoteList, remoteForm, maintenanceMessage);
    maintenance.append(maintenanceBody);

    const message = element("p", "noema-vc-message");
    const raw = element("details", "noema-vc-raw");
    raw.append(element("summary", "", "Raw git status"));
    const rawBody = element("pre");
    raw.append(rawBody);

    root.append(head, location, phase, conflicts, changes, actions, message, maintenance, raw);

    const controls: CardControls = {
      root, badges, location, phase, phaseLabel, phaseDetail,
      changes, changesSummary, changesList, selectAll, commitMessage, commitSelected, checkpoint,
      conflicts, conflictList, conflictHeading,
      actions, maintenance, branchList, branchName, remoteList, remoteUrl, maintenanceMessage,
      sync, pull, push, message, raw, rawBody,
    };
    const draft = drafts.get(repository.id);
    commitMessage.value = draft?.message || "";
    const card: Card = {
      repository,
      controls,
      status: null,
      sync: null,
      statusError: "",
      selected: new Set<string>(draft?.selected || []),
      openDiff: "",
      diffText: "",
      busy: false,
      branches: null,
      remotes: null,
    };

    selectAll.addEventListener("change", () => {
      const entries = (card.status?.entries || []).filter((entry) => !entry.conflicted);
      card.selected = selectAll.checked ? new Set(entries.map((entry) => entry.path)) : new Set();
      rememberDraft(card);
      renderChanges(card);
      updateActionState(card);
    });
    commitMessage.addEventListener("input", () => {
      rememberDraft(card);
      updateActionState(card);
    });
    commitSelected.addEventListener("click", () => {
      const paths = [...card.selected];
      const commitText = commitMessage.value.trim();
      if (!paths.length || !commitText) return;
      void runAction(card, `Commit ${countLabel(paths.length, "file")}`, async () => {
        const result = await host.api.git({ repositoryId: repository.id, action: "commit", message: commitText, paths });
        card.selected.clear();
        commitMessage.value = "";
        rememberDraft(card);
        return result;
      });
    });
    checkpoint.addEventListener("click", () => {
      const commitText = commitMessage.value.trim();
      void runAction(card, "Checkpoint", async () => {
        const result = await host.api.checkpoint(repository.id, commitText);
        commitMessage.value = "";
        rememberDraft(card);
        return result;
      });
    });
    sync.addEventListener("click", () => {
      void runAction(card, "Sync", () => host.api.sync(repository.id));
    });
    pull.addEventListener("click", () => {
      void runAction(card, "Pull", () => host.api.git({ repositoryId: repository.id, action: "pull" }));
    });
    push.addEventListener("click", () => {
      void runAction(card, "Push", () => host.api.git({ repositoryId: repository.id, action: "push" }));
    });
    refresh.addEventListener("click", () => {
      void Promise.all([refreshStatus(card), refreshSync(card)]);
    });
    advanced.addEventListener("click", () => {
      advanced.disabled = true;
      void host.openGitUi(repository.id).finally(() => { advanced.disabled = false; });
    });

    maintenance.addEventListener("toggle", () => {
      if (!maintenance.open || card.branches) return;
      renderBranches(card);
      renderRemotes(card);
      void loadMaintenance(card);
    });
    branchCreate.addEventListener("click", () => {
      const name = branchName.value.trim();
      if (!name) return;
      void runAction(card, `Create ${name}`, async () => {
        const result = await host.api.branchAction({
          repositoryId: repository.id,
          action: "create",
          name,
        });
        branchName.value = "";
        card.branches = result.branches || null;
        return result as Record<string, unknown>;
      });
    });
    remoteSave.addEventListener("click", () => {
      const url = remoteUrl.value.trim();
      if (!url) return;
      const name = remoteUrl.dataset.remoteName || "origin";
      void runAction(card, `Save remote ${name}`, async () => {
        const result = await host.api.remoteAction({ repositoryId: repository.id, action: "set", name, url });
        remoteUrl.value = "";
        delete remoteUrl.dataset.remoteName;
        card.remotes = result.remotes || null;
        return result as Record<string, unknown>;
      });
    });

    renderCard(card);
    return card;
  }

  return {
    mount(target: HTMLElement): void {
      generation += 1;
      cards.clear();
      const toolbar = element("div", "noema-vc-toolbar");
      summaryEl = element("p", "noema-vc-summary", "Reading repository status…");
      const toolbarActions = element("div", "noema-vc-toolbar-actions");
      syncAllButton = actionButton("Sync all");
      syncAllButton.addEventListener("click", () => {
        for (const card of cards.values()) {
          if (card.busy || card.sync?.phase === "conflicted") continue;
          void runAction(card, "Sync", () => host.api.sync(card.repository.id));
        }
      });
      const refreshAll = actionButton("Refresh status");
      refreshAll.addEventListener("click", () => {
        for (const card of cards.values()) void Promise.all([refreshStatus(card), refreshSync(card)]);
      });
      const add = actionButton("Add repository", "is-primary");
      add.addEventListener("click", () => host.addRepository());
      toolbarActions.append(syncAllButton, refreshAll, add);
      toolbar.append(summaryEl, toolbarActions);
      target.append(toolbar);

      const list = element("div", "noema-vc-list");
      target.append(list);
      const repositories = host.repositories();
      for (const repository of repositories) {
        const card = buildCard(repository);
        cards.set(repository.id, card);
        list.append(card.controls.root);
      }
      if (!repositories.length) {
        const empty = element("div", "noema-wiki-empty");
        empty.append(element("h2", "", "No indexed repositories"));
        empty.append(element("p", "", "Add a Git repository, or switch to Legacy layout in Configuration."));
        list.append(empty);
      }
      renderSummary();
      // Statuses load together rather than one card at a time.
      for (const card of cards.values()) void Promise.all([refreshStatus(card), refreshSync(card)]);
    },

    applySyncState(repositoryId: string, state: Partial<WikiSyncState> & { live?: boolean }): void {
      const card = repositoryOf(repositoryId);
      if (!card) return;
      // Every event carries the whole stored state, so replace rather than
      // merge: a shallow merge keeps fields the new state deliberately dropped,
      // which is how a cleared `nextRetryAt` kept advertising a retry that was
      // no longer scheduled.  Only the policy fields, which arrive on a
      // different channel, survive.
      card.sync = {
        automatic: card.sync?.automatic,
        automaticIntervalMinutes: card.sync?.automaticIntervalMinutes,
        automaticForcedOff: card.sync?.automaticForcedOff,
        ...state,
      };
      renderPhase(card);
      renderConflicts(card);
      renderMessage(card);
      updateActionState(card);
      // A terminal result can have moved HEAD or the working tree; progress
      // events cannot, so they never pay for a status round-trip.
      if (!state.live && !card.busy) void refreshStatus(card);
    },

    has(repositoryId: string): boolean {
      return cards.has(repositoryId);
    },

    destroy(): void {
      generation += 1;
      cards.clear();
      summaryEl = null;
      syncAllButton = null;
    },
  };
}
