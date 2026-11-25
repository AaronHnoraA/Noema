import type { EditorView } from "@codemirror/view";
import { api, type DocumentRun } from "../../../../../pages/api-client.ts";
import { currentNotePath, loadWhenVisible } from "./document-excerpts.ts";
import { documentViewState, rememberDocumentView } from "./document-view-state.ts";

const attached = new WeakSet<HTMLElement>();
const states: Record<DocumentRun["status"], string> = {
  awaiting: "Continue in Emacs",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Connection interrupted",
  "cancel-unconfirmed": "Stop could not be confirmed",
  unavailable: "Previous run is no longer available",
};

export function connectDocumentRuns(root: ParentNode, view: EditorView, locate: (element: HTMLElement) => number | null): void {
  for (const group of root.querySelectorAll<HTMLElement>(".noema-document-run[data-run-command]")) {
    if (attached.has(group)) continue;
    attached.add(group);
    const start = group.querySelector<HTMLButtonElement>("[data-run-start]");
    const stop = group.querySelector<HTMLButtonElement>("[data-run-stop]");
    const open = group.querySelector<HTMLButtonElement>("[data-run-open]");
    const status = group.querySelector<HTMLElement>(".noema-run-status");
    const output = group.querySelector<HTMLElement>(".noema-run-output");
    const outputText = output?.querySelector("code");
    if (!start || !stop || !open || !status || !output || !outputText) continue;
    const command = group.dataset.runCommand!;
    const cwd = group.dataset.runCwd || ".";
    const isCurrent = (note: string) => group.isConnected && currentNotePath() === note;
    let run: { id: string; note: string } | null = null;
    let launch: Promise<DocumentRun> | undefined;
    let pollTimer: number | undefined;
    let missedPolls = 0;
    const displayStatus = (message: string, state: string) => {
      if (status.textContent === message && status.dataset.runStatus === state) return;
      status.textContent = message;
      status.dataset.runStatus = state;
      view.requestMeasure();
    };
    const report = (error: unknown) => displayStatus(error instanceof Error ? error.message : "Emacs could not run the command.", "failed");
    const show = (snapshot: DocumentRun): void => {
      const pending = snapshot.status === "awaiting" || snapshot.status === "running";
      start.disabled = pending;
      stop.toggleAttribute("data-run-inactive", snapshot.status !== "running");
      stop.disabled = snapshot.stopRequested;
      open.toggleAttribute("data-run-inactive", !snapshot.hasOutput);
      const content = snapshot.output || "";
      output.toggleAttribute("data-run-inactive", !content);
      if (outputText.textContent !== content) {
        outputText.textContent = content;
        view.requestMeasure();
      }
      const exit = snapshot.exitCode != null && snapshot.status === "failed" ? ` · exit ${snapshot.exitCode}` : "";
      const label = snapshot.status === "running" && snapshot.stopRequested ? "Stop requested" : states[snapshot.status];
      displayStatus(snapshot.message || label + exit, snapshot.status);
      if (pending) pollTimer = window.setTimeout(() => { void refresh(); }, 450);
    };
    const refresh = async () => {
      const selected = run;
      if (!selected || !isCurrent(selected.note)) return;
      try {
        const snapshot = await api.documentAssets.run(selected.note, { action: "status", id: selected.id });
        if (run === selected && isCurrent(selected.note)) {
          missedPolls = 0;
          show(snapshot);
        }
      } catch {
        if (run !== selected || !isCurrent(selected.note)) return;
        displayStatus("Reconnecting to Emacs…", "awaiting");
        const delay = 450 * (2 ** Math.min(missedPolls++, 3));
        pollTimer = window.setTimeout(() => { void refresh(); }, delay);
      }
    };
    const watchLaunch = async (pending: Promise<DocumentRun>, note: string, remounted: boolean) => {
      if (launch === pending) return;
      launch = pending;
      window.clearTimeout(pollTimer);
      missedPolls = 0;
      run = null;
      start.disabled = true;
      open.toggleAttribute("data-run-inactive", true);
      output.toggleAttribute("data-run-inactive", true);
      displayStatus("Opening Emacs…", "awaiting");
      try {
        const snapshot = await pending;
        if (launch !== pending || !isCurrent(note)) return;
        run = { id: snapshot.id, note };
        if (remounted) void refresh();
        else show(snapshot);
      } catch (error) {
        if (launch !== pending || !isCurrent(note)) return;
        start.disabled = false;
        report(error);
      }
    };
    start.addEventListener("click", () => {
      const note = currentNotePath();
      const position = locate(group);
      const pending = api.documentAssets.run(note, { action: "start", command, cwd });
      void watchLaunch(pending, note, false);
      if (position !== null) rememberDocumentView(view, position, { launch: pending, note, command, cwd });
    });
    const action = (kind: "open" | "stop") => {
      const selected = run;
      if (!selected || !isCurrent(selected.note)) return;
      void api.documentAssets.run(selected.note, { action: kind, id: selected.id }).catch((error: unknown) => {
        if (run === selected && isCurrent(selected.note)) report(error);
      });
    };
    stop.addEventListener("click", () => { stop.disabled = true; action("stop"); });
    open.addEventListener("click", () => action("open"));
    loadWhenVisible(group, () => {
      const position = locate(group);
      const note = currentNotePath();
      const choice = position === null ? undefined : view.state.field(documentViewState, false)?.get(position);
      if (!choice || typeof choice !== "object" || !("launch" in choice)
          || choice.note !== note || choice.command !== command || choice.cwd !== cwd) return;
      void watchLaunch(choice.launch, note, true);
    });
  }
}
