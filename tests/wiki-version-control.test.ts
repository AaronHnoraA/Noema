import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createVersionControlView, type VersionControlApi, type VersionControlHost } from "../aaronnote/wiki-version-control.ts";
import type { WikiBranch, WikiRemote, WikiRepository, WikiRepositoryStatus, WikiSyncState } from "../aaronnote/api-client.ts";

const repository: WikiRepository = {
  id: "private/research",
  uid: "0199",
  identityStatus: "managed",
  name: "research",
  partition: "private",
  path: "/notes/private/research",
};

function dirtyStatus(overrides: Partial<WikiRepositoryStatus> = {}): WikiRepositoryStatus {
  return {
    ok: true,
    branch: "work/mac",
    upstream: "origin/main",
    ahead: 2,
    behind: 1,
    clean: false,
    remote: "git@example.test:noema/research.git",
    head: "0123456789abcdef0123456789abcdef01234567",
    path: repository.path,
    status: "## work/mac...origin/main [ahead 2, behind 1]",
    changedFiles: 2,
    conflictedFiles: 0,
    entries: [
      { code: " M", path: "alpha.md", origPath: "", label: "Modified", conflicted: false, untracked: false, staged: false, unstaged: true },
      { code: "??", path: "beta.md", origPath: "", label: "Untracked", conflicted: false, untracked: true, staged: false, unstaged: true },
    ],
    ...overrides,
  };
}

type Calls = {
  git: Array<Record<string, unknown>>;
  sync: string[];
  diff: string[];
  branch: Array<Record<string, unknown>>;
  remote: Array<Record<string, unknown>>;
};

const branches: WikiBranch[] = [
  { name: "noema/device-a", upstream: "", committedAt: "2026-08-30T00:00:00Z", subject: "device work", current: true, managed: true, checkedOutAt: "" },
  { name: "main", upstream: "origin/main", committedAt: "2026-08-29T00:00:00Z", subject: "seed", current: false, managed: false, checkedOutAt: "" },
  { name: "noema-integration/device-a", upstream: "", committedAt: "2026-08-28T00:00:00Z", subject: "integration", current: false, managed: true, checkedOutAt: "/notes/.noema/worktrees/a" },
];
const remotes: WikiRemote[] = [
  { name: "origin", fetchUrl: "git@example.test:noema/research.git", pushUrl: "git@example.test:noema/research.git" },
];

function harness(options: {
  status?: WikiRepositoryStatus;
  syncState?: Partial<WikiSyncState>;
  repositories?: WikiRepository[];
  branches?: WikiBranch[];
  remotes?: WikiRemote[];
  confirm?: boolean;
} = {}) {
  const calls: Calls = { git: [], sync: [], diff: [], branch: [], remote: [] };
  const api: VersionControlApi = {
    async repositoryStatus() { return options.status ?? dirtyStatus(); },
    async repositoryDiff(_repositoryId, path) { calls.diff.push(path); return { diff: `--- a/${path}\n+++ b/${path}\n+added`, tracked: true }; },
    async syncStatus() { return (options.syncState ?? { phase: "idle" }) as Record<string, unknown>; },
    async checkpoint() { return { ok: true, message: "checkpointed" }; },
    async sync(repositoryId) { calls.sync.push(repositoryId); return { phase: "idle", message: "synced" } as WikiSyncState; },
    async git(body) { calls.git.push(body); return { ok: true, message: "committed" }; },
    async abortConflict() { return { ok: true }; },
    async adoptRepository() { return { ok: true }; },
    async branches() { return { current: "noema/device-a", branches: options.branches ?? branches }; },
    async branchAction(body) { calls.branch.push(body); return { branches: options.branches ?? branches, message: "done" }; },
    async remotes() { return { remotes: options.remotes ?? remotes }; },
    async remoteAction(body) { calls.remote.push(body); return { remotes: options.remotes ?? remotes, message: "done" }; },
  };
  const host: VersionControlHost = {
    api,
    repositories: () => options.repositories ?? [repository],
    setStatus: () => {},
    reloadIndex: async () => {},
    openConflict: () => {},
    openGitUi: async () => {},
    rememberSyncState: () => {},
    addRepository: () => {},
    confirm: () => options.confirm !== false,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const view = createVersionControlView(host);
  return { view, container, calls, host };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

afterEach(() => { document.body.replaceChildren(); });

describe("wiki version control view", () => {
  test("shows branch, upstream, ahead/behind and the changed-file count as badges", async () => {
    const { view, container } = harness();
    view.mount(container);
    await settle();

    const badges = [...container.querySelectorAll(".noema-vc-badge")].map((node) => node.textContent);
    expect(badges).toContain("work/mac");
    expect(badges).toContain("origin/main");
    expect(badges).toContain("↑2");
    expect(badges).toContain("↓1");
    expect(badges).toContain("2 changes");
    expect(container.querySelector(".noema-vc-location")!.textContent)
      .toContain("git@example.test:noema/research");
    expect(container.querySelector(".noema-vc-summary")!.textContent)
      .toContain("2 uncommitted changes");
  });

  test("commits only the selected paths through the git action channel", async () => {
    const { view, container, calls } = harness();
    view.mount(container);
    await settle();

    const boxes = [...container.querySelectorAll<HTMLInputElement>(".noema-vc-change-row input[type=checkbox]")];
    expect(boxes).toHaveLength(2);
    boxes[0].checked = true;
    boxes[0].dispatchEvent(new Event("change"));

    const message = container.querySelector<HTMLInputElement>(".noema-vc-commit-message")!;
    message.value = "just alpha";
    message.dispatchEvent(new Event("input"));

    const commit = [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.startsWith("Commit 1 file"))!;
    expect(commit.disabled).toBe(false);
    commit.click();
    await settle();

    expect(calls.git).toEqual([{
      repositoryId: "private/research",
      action: "commit",
      message: "just alpha",
      paths: ["alpha.md"],
    }]);
  });

  test("keeps commit disabled without a selection or without a message", async () => {
    const { view, container } = harness();
    view.mount(container);
    await settle();

    const commit = () => [...container.querySelectorAll<HTMLButtonElement>("button")]
      .find((node) => node.textContent?.startsWith("Commit"))!;
    expect(commit().disabled).toBe(true);

    const box = container.querySelector<HTMLInputElement>(".noema-vc-change-row input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    expect(commit().disabled).toBe(true);

    const message = container.querySelector<HTMLInputElement>(".noema-vc-commit-message")!;
    message.value = "now valid";
    message.dispatchEvent(new Event("input"));
    expect(commit().disabled).toBe(false);
  });

  test("disables pull and push when the repository has no origin remote", async () => {
    const { view, container } = harness({ status: dirtyStatus({ remote: "", upstream: "" }) });
    view.mount(container);
    await settle();

    const byLabel = (label: string) => [...container.querySelectorAll<HTMLButtonElement>(".noema-vc-actions button")]
      .find((node) => node.textContent === label)!;
    expect(byLabel("Pull").disabled).toBe(true);
    expect(byLabel("Push").disabled).toBe(true);
    expect(byLabel("Commit & sync").disabled).toBe(false);
  });

  test("renders a streamed phase without refetching status, and refetches on the terminal result", async () => {
    let statusReads = 0;
    const { view, container, host } = harness();
    const original = host.api.repositoryStatus;
    host.api.repositoryStatus = async (id) => { statusReads += 1; return original(id); };
    view.mount(container);
    await settle();
    expect(statusReads).toBe(1);

    view.applySyncState("private/research", { phase: "pushing", live: true } as Partial<WikiSyncState> & { live?: boolean });
    await settle();
    const phase = container.querySelector<HTMLElement>(".noema-vc-phase")!;
    expect(phase.hidden).toBe(false);
    expect(phase.textContent).toContain("Publishing to origin");
    expect(phase.textContent).toContain("step 4 of 5");
    expect(statusReads).toBe(1);

    view.applySyncState("private/research", { phase: "idle", message: "Synchronized" } as Partial<WikiSyncState>);
    await settle();
    expect(statusReads).toBe(2);
  });

  test("lists conflicts in their own section instead of the action row", async () => {
    const { view, container } = harness({
      syncState: {
        phase: "conflicted",
        conflicts: [
          { path: "alpha.md", kind: "text", stages: [1, 2, 3] },
          { path: "beta.md", kind: "text", stages: [1, 2, 3] },
        ],
      },
    });
    view.mount(container);
    await settle();

    const conflicts = container.querySelector<HTMLElement>(".noema-vc-conflicts")!;
    expect(conflicts.hidden).toBe(false);
    expect(conflicts.querySelector("h3")!.textContent).toBe("2 files need resolution");
    expect([...conflicts.querySelectorAll(".noema-vc-path")].map((node) => node.textContent))
      .toEqual(["alpha.md", "beta.md"]);
    expect(container.querySelectorAll(".noema-vc-actions .is-danger")).toHaveLength(0);
    const sync = [...container.querySelectorAll<HTMLButtonElement>(".noema-vc-actions button")]
      .find((node) => node.textContent === "Commit & sync")!;
    expect(sync.disabled).toBe(true);
  });

  test("loads a per-file diff on demand and folds it away again", async () => {
    const { view, container, calls } = harness();
    view.mount(container);
    await settle();

    const toggle = container.querySelector<HTMLButtonElement>(".noema-vc-diff-toggle")!;
    toggle.click();
    await settle();
    expect(calls.diff).toEqual(["alpha.md"]);
    expect(container.querySelector(".noema-vc-diff")!.textContent).toContain("+added");

    container.querySelector<HTMLButtonElement>(".noema-vc-diff-toggle")!.click();
    await settle();
    expect(container.querySelector(".noema-vc-diff")).toBeNull();
  });

  test("ignores sync state for a repository it is not showing", async () => {
    const { view, container } = harness();
    view.mount(container);
    await settle();
    expect(view.has("private/research")).toBe(true);
    expect(view.has("public/other")).toBe(false);
    view.applySyncState("public/other", { phase: "error", error: "boom" } as Partial<WikiSyncState>);
    await settle();
    expect(container.textContent).not.toContain("boom");
  });

  test("keeps the staging selection and commit message across a remount", async () => {
    const { view, container } = harness();
    view.mount(container);
    await settle();

    const box = container.querySelector<HTMLInputElement>(".noema-vc-change-row input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    const message = container.querySelector<HTMLInputElement>(".noema-vc-commit-message")!;
    message.value = "half typed";
    message.dispatchEvent(new Event("input"));

    // What a background index refresh does to this view.
    view.destroy();
    container.replaceChildren();
    view.mount(container);
    await settle();

    expect(container.querySelector<HTMLInputElement>(".noema-vc-commit-message")!.value).toBe("half typed");
    expect([...container.querySelectorAll<HTMLInputElement>(".noema-vc-change-row input[type=checkbox]")].map((n) => n.checked))
      .toEqual([true, false]);
    expect(container.querySelector(".noema-vc-changes-summary")!.textContent).toContain("1 selected");
  });

  test("drops a remembered selection once the file stops being changed", async () => {
    const { view, container } = harness();
    view.mount(container);
    await settle();
    const box = container.querySelector<HTMLInputElement>(".noema-vc-change-row input[type=checkbox]")!;
    box.checked = true;
    box.dispatchEvent(new Event("change"));

    view.destroy();
    container.replaceChildren();
    // alpha.md is gone from the working tree on the next read.
    const { view: second, container: secondContainer } = harness({
      status: dirtyStatus({
        changedFiles: 1,
        entries: [
          { code: "??", path: "beta.md", origPath: "", label: "Untracked", conflicted: false, untracked: true, staged: false, unstaged: true },
        ],
      }),
    });
    second.mount(secondContainer);
    await settle();
    expect([...secondContainer.querySelectorAll<HTMLInputElement>(".noema-vc-change-row input[type=checkbox]")].map((n) => n.checked))
      .toEqual([false]);
  });

  test("lists branches only once the maintenance disclosure is opened", async () => {
    const { view, container } = harness();
    view.mount(container);
    await settle();
    expect(container.querySelectorAll(".noema-vc-branch-row")).toHaveLength(0);

    const maintenance = container.querySelector<HTMLDetailsElement>(".noema-vc-maintenance")!;
    maintenance.open = true;
    maintenance.dispatchEvent(new Event("toggle"));
    await settle();

    const rows = [...container.querySelectorAll(".noema-vc-branch-row")];
    expect(rows.map((row) => row.querySelector(".noema-vc-path")!.textContent))
      .toEqual(["noema/device-a", "main", "noema-integration/device-a", "origin"]);
    expect(rows[0].classList.contains("is-current")).toBe(true);
    expect(rows[0].textContent).toContain("current");
  });

  test("refuses to switch to or delete a branch checked out in another worktree", async () => {
    const { view, container } = harness();
    view.mount(container);
    await settle();
    const maintenance = container.querySelector<HTMLDetailsElement>(".noema-vc-maintenance")!;
    maintenance.open = true;
    maintenance.dispatchEvent(new Event("toggle"));
    await settle();

    const integration = [...container.querySelectorAll(".noema-vc-branch-row")]
      .find((row) => row.querySelector(".noema-vc-path")!.textContent === "noema-integration/device-a")!;
    expect([...integration.querySelectorAll("button")].map((node) => node.disabled)).toEqual([true, true]);
    expect(integration.textContent).toContain("checked out elsewhere");
    expect(integration.textContent).toContain("Noema-managed");

    const plain = [...container.querySelectorAll(".noema-vc-branch-row")]
      .find((row) => row.querySelector(".noema-vc-path")!.textContent === "main")!;
    expect([...plain.querySelectorAll("button")].map((node) => node.disabled)).toEqual([false, false]);
  });

  test("switches branches and forces a delete only for a Noema-managed branch", async () => {
    const { view, container, calls } = harness();
    view.mount(container);
    await settle();
    const maintenance = container.querySelector<HTMLDetailsElement>(".noema-vc-maintenance")!;
    maintenance.open = true;
    maintenance.dispatchEvent(new Event("toggle"));
    await settle();

    const main = [...container.querySelectorAll(".noema-vc-branch-row")]
      .find((row) => row.querySelector(".noema-vc-path")!.textContent === "main")!;
    main.querySelectorAll("button")[0].click();
    await settle();
    expect(calls.branch[0]).toEqual({ repositoryId: "private/research", action: "switch", name: "main" });

    main.querySelectorAll("button")[1].click();
    await settle();
    expect(calls.branch[1]).toMatchObject({ action: "delete", name: "main", force: false });
  });

  test("keeps a delete that the user declines from reaching the API", async () => {
    const { view, container, calls } = harness({ confirm: false });
    view.mount(container);
    await settle();
    const maintenance = container.querySelector<HTMLDetailsElement>(".noema-vc-maintenance")!;
    maintenance.open = true;
    maintenance.dispatchEvent(new Event("toggle"));
    await settle();

    const main = [...container.querySelectorAll(".noema-vc-branch-row")]
      .find((row) => row.querySelector(".noema-vc-path")!.textContent === "main")!;
    main.querySelectorAll("button")[1].click();
    await settle();
    expect(calls.branch).toEqual([]);
  });

  test("creates a branch and saves an origin URL", async () => {
    const { view, container, calls } = harness();
    view.mount(container);
    await settle();
    const maintenance = container.querySelector<HTMLDetailsElement>(".noema-vc-maintenance")!;
    maintenance.open = true;
    maintenance.dispatchEvent(new Event("toggle"));
    await settle();

    const forms = [...container.querySelectorAll<HTMLElement>(".noema-vc-inline-form")];
    const branchInput = forms[0].querySelector("input")!;
    branchInput.value = "topic/rewrite";
    forms[0].querySelector("button")!.click();
    await settle();
    expect(calls.branch[0]).toEqual({ repositoryId: "private/research", action: "create", name: "topic/rewrite" });

    const remoteInput = forms[1].querySelector("input")!;
    remoteInput.value = "git@example.test:noema/moved.git";
    forms[1].querySelector("button")!.click();
    await settle();
    expect(calls.remote[0]).toEqual({
      repositoryId: "private/research",
      action: "set",
      name: "origin",
      url: "git@example.test:noema/moved.git",
    });
  });

  test("shows an empty state when the workspace has no repositories", async () => {
    const { view, container } = harness({ repositories: [] });
    view.mount(container);
    await settle();
    expect(container.textContent).toContain("No indexed repositories");
    expect(container.querySelector(".noema-vc-summary")!.textContent).toContain("0 repositories");
  });
});
