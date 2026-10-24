/** GitHub-style inline review card for one local Markdown replacement. */

import { EditorView } from "@codemirror/view";
import { MeasuredWidget } from "./measured-widget.ts";
import { shortHash } from "./measured-observer.ts";
import { markEmbeddedSurface } from "../../../embedded-surface.ts";
import { dispatchConstructEdit } from "../constructs/index.ts";
import { approvedEdiffMarkdown, ediffActionEdit, scanEdiffBlocks, type EdiffAction, type EdiffBlock } from "../../../../ediff.ts";

function button(label: string, title: string, action: () => void): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.textContent = label;
  el.title = title;
  el.addEventListener("mousedown", (event) => { event.preventDefault(); event.stopPropagation(); });
  el.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); action(); });
  return el;
}

function row(kind: string, oldNo: string, newNo: string, prefix: string, content: string): HTMLElement {
  const el = document.createElement("div");
  el.className = `noema-ediff-row noema-ediff-${kind}`;
  for (const [className, value] of [
    ["old-number", oldNo], ["new-number", newNo], ["prefix", prefix], ["content", content],
  ]) {
    const cell = document.createElement("span");
    cell.className = `noema-ediff-${className}`;
    cell.textContent = value;
    el.append(cell);
  }
  return el;
}

export class EdiffWidget extends MeasuredWidget {
  readonly from: number;
  readonly to: number;
  readonly source: string;
  constructor(from: number, to: number, source: string) {
    super();
    this.from = from;
    this.to = to;
    this.source = source;
  }

  protected measureKey(): string { return `ediff:${shortHash(this.source)}`; }
  protected estimatedHeightFallback(): number {
    const changed = this.source.split("\n").filter((line) => /^[+-]/.test(line)).length;
    return 50 + (changed <= 4 ? changed : 2) * 34;
  }
  eq(other: EdiffWidget): boolean {
    return this.from === other.from && this.to === other.to && this.source === other.source;
  }

  toDOM(view: EditorView): HTMLElement {
    const documentSource = view.state.doc.toString();
    const block = scanEdiffBlocks(documentSource).find((candidate) => candidate.from === this.from && candidate.to === this.to);
    const root = document.createElement("section");
    root.className = "noema-ediff noema-ediff-compact";
    root.dataset.cmSourceFrom = String(this.from);
    root.dataset.cmSourceTo = String(this.to);
    root.setAttribute("role", "group");
    root.setAttribute("aria-label", `Proposed Markdown edit: ${block?.title ?? "invalid block"}`);

    const header = document.createElement("div");
    header.className = "noema-ediff-header";
    const heading = document.createElement("div");
    heading.className = "noema-ediff-heading";
    const title = document.createElement("span");
    title.textContent = block?.title ?? "Invalid ediff";
    const deletions = block?.changes.filter((line) => line.kind === "-").length ?? 0;
    const additions = block?.changes.filter((line) => line.kind === "+").length ?? 0;
    const changed = deletions + additions;
    const visibleChanges = changed <= 4 ? changed
      : additions && deletions ? 2 : Math.min(changed, 2);
    const hiddenChanges = changed - visibleChanges;
    const detailsLabel = hiddenChanges ? `Details (${hiddenChanges} more)` : "Details";
    const counts = document.createElement("small");
    counts.textContent = block
      ? `−${deletions} +${additions}${block.comments.length ? ` · ${block.comments.length} comments` : ""}`
      : "";
    heading.append(title, counts);
    const actions = document.createElement("div");
    actions.className = "noema-ediff-actions";
    const details = button(detailsLabel, "Show line numbers and full context", () => {
      const expanded = root.classList.toggle("noema-ediff-expanded");
      details.textContent = expanded ? "Less" : detailsLabel;
      details.setAttribute("aria-expanded", String(expanded));
    });
    details.className = "noema-ediff-details-toggle";
    details.setAttribute("aria-expanded", "false");
    header.append(heading, details, actions);
    root.append(header);

    const status = document.createElement("div");
    status.className = "noema-ediff-status";
    root.append(status);
    const report = (message: string): void => {
      status.textContent = message;
      status.hidden = !message;
    };
    const current = (): { source: string; block: EdiffBlock } | null => {
      const source = view.state.doc.toString();
      const found = scanEdiffBlocks(source).find((item) => item.from === this.from && item.to === this.to);
      if (!found || source.slice(this.from, this.to) !== this.source) {
        report("The proposal changed. Review its current source before acting.");
        return null;
      }
      return { source, block: found };
    };
    const act = (action: EdiffAction, message = ""): void => {
      const fresh = current();
      if (!fresh) return;
      try {
        const edit = ediffActionEdit(fresh.source, fresh.block.from, action, message);
        dispatchConstructEdit(view, {
          changes: edit,
          selection: action === "accept" ? { anchor: edit.from + edit.insert.length } : undefined,
        }, `ediff.${action}`);
        view.focus();
      } catch (error) { report(error instanceof Error ? error.message : String(error)); }
    };

    if (block?.rejected) root.classList.add("noema-ediff-rejected");
    if (block?.error) root.classList.add("noema-ediff-invalid");
    report(block?.error || (block?.rejected ? "Rejected. The original remains in the note for follow-up." : ""));

    const accept = button("Accept", "Replace these lines with the proposed lines", () => act("accept"));
    accept.disabled = !!block?.error || view.state.readOnly;
    const reject = button("Reject", "Keep the original lines and mark this proposal rejected", () => act("reject"));
    reject.disabled = !!block?.rejected || view.state.readOnly;
    const comment = button("Comment", "Leave a message on this proposal", () => {
      form.hidden = false;
      input.focus({ preventScroll: true });
    });
    comment.disabled = view.state.readOnly;
    const edit = button("Edit diff", "Show the local diff source", () => {
      view.dispatch({ selection: { anchor: this.from + 1 }, scrollIntoView: true });
      view.focus();
    });
    actions.append(accept, reject, comment, edit);

    const diff = document.createElement("div");
    diff.className = "noema-ediff-diff";
    if (block) {
      const prefix = approvedEdiffMarkdown(documentSource.slice(0, block.from));
      let oldNo = prefix ? prefix.split("\n").length : 1;
      let newNo = oldNo;
      diff.append(row("hunk", "", "", "", `@@ -${oldNo},${block.oldLines.length} +${newNo},${block.newLines.length} @@`));
      const mixed = additions > 0 && deletions > 0;
      const previewPerSide = mixed ? 1 : 2;
      let shownOld = 0;
      let shownNew = 0;
      for (const line of block.changes) {
        const oldLabel = line.kind === "+" ? "" : String(oldNo++);
        const newLabel = line.kind === "-" ? "" : String(newNo++);
        const item = row(line.kind === "+" ? "addition" : line.kind === "-" ? "deletion" : "context",
          oldLabel, newLabel, line.kind, line.text);
        const preview = line.kind === "-"
          ? changed <= 4 || shownOld++ < previewPerSide
          : line.kind === "+" && (changed <= 4 || shownNew++ < previewPerSide);
        if (!preview) item.classList.add("noema-ediff-extra");
        diff.append(item);
        if (line.noNewline) diff.append(row("marker", "", "", "", "\\ No newline at end of file"));
      }
      if (block.error && !block.changes.length) {
        for (const line of this.source.split("\n")) diff.append(row("raw", "", "", "", line));
      }
    }
    root.append(diff);

    if (block?.comments.length) {
      const comments = document.createElement("div");
      comments.className = "noema-ediff-comments";
      for (const message of block.comments) {
        const item = document.createElement("p");
        item.textContent = message;
        comments.append(item);
      }
      root.append(comments);
    }

    const form = document.createElement("div");
    form.className = "noema-ediff-comment-form";
    form.hidden = true;
    const input = document.createElement("textarea");
    input.rows = 3;
    input.placeholder = "Leave a comment for the agent";
    input.setAttribute("aria-label", "Ediff comment");
    markEmbeddedSurface(input);
    input.addEventListener("mousedown", (event) => event.stopPropagation());
    const submit = button("Add comment", "Save this comment in the note", () => {
      if (!input.value.trim()) return;
      act("comment", input.value);
    });
    const cancel = button("Cancel", "Discard this comment", () => { form.hidden = true; input.value = ""; });
    form.append(input, submit, cancel);
    root.append(form);
    root.addEventListener("mousedown", (event) => {
      if (!form.contains(event.target as Node)) event.stopPropagation();
    });
    return this.registerMeasured(root, view);
  }

  ignoreEvent(): boolean { return false; }
}
