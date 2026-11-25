import { renderHighlightedCode } from "../../../../code-highlight-dom.ts";
import { writeSystemClipboard } from "../../../../system-clipboard.ts";

const connected = new WeakSet<HTMLElement>();

export function connectDocumentPackages(root: HTMLElement): void {
  for (const panel of root.querySelectorAll<HTMLElement>(".noema-package-panel")) {
    if (connected.has(panel)) continue;
    const code = panel.querySelector<HTMLElement>("pre > code");
    const copy = panel.querySelector<HTMLButtonElement>("[data-copy-package-command]");
    if (!code || !copy) continue;
    connected.add(panel);
    const command = code.textContent ?? "";
    if (command.length < 12_000) renderHighlightedCode(code, command, "sh");
    copy.addEventListener("click", async () => {
      const copied = await writeSystemClipboard(command);
      if (copy.isConnected) copy.textContent = copied ? "Copied" : "Could not copy";
    });
  }
}
