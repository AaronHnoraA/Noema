import type {
  LanguageToolProbeMsg,
  LanguageToolSettings,
  LanguageToolSettingsMsg,
  LanguageToolSettingsUpdate,
} from "./api-client.ts";

type LanguageToolToolApi = {
  updateSettings: (body: LanguageToolSettingsUpdate) => Promise<LanguageToolSettingsMsg>;
  probe: (body: Partial<LanguageToolSettings> & { requestId?: string }) => Promise<LanguageToolProbeMsg>;
  cancelKeepalive?: (requestId: string) => void;
};

type LanguageToolToolOptions = {
  modal: HTMLElement;
  api: LanguageToolToolApi;
  settings: LanguageToolSettings;
  defaults: LanguageToolSettings;
  revision?: string;
  status?: string;
  onClose?: () => void;
};

export type LanguageToolToolResult = {
  settings: LanguageToolSettings;
  revision: string;
};

const PROFILE_LABELS: Array<{ value: LanguageToolSettings["performanceProfile"]; label: string }> = [
  { value: "responsive", label: "Responsive" },
  { value: "balanced", label: "Balanced" },
  { value: "quiet", label: "Quiet" },
];

const LEVEL_LABELS: Array<{ value: LanguageToolSettings["level"]; label: string }> = [
  { value: "default", label: "Standard" },
  { value: "picky", label: "Picky" },
];

function checkboxField(labelText: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = document.createElement("label");
  label.className = "aaronnote-languagetool-toggle";
  const input = document.createElement("input");
  input.type = "checkbox";
  const text = document.createElement("span");
  text.textContent = labelText;
  label.append(input, text);
  return { label, input };
}

function segmentedField<T extends string>(
  legendText: string,
  name: string,
  options: Array<{ value: T; label: string }>,
): { fieldset: HTMLFieldSetElement; inputs: HTMLInputElement[] } {
  const fieldset = document.createElement("fieldset");
  fieldset.className = "aaronnote-languagetool-field";
  const legend = document.createElement("legend");
  legend.textContent = legendText;
  const control = document.createElement("div");
  control.className = "aaronnote-languagetool-segments";
  const inputs = options.map((option) => {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = name;
    input.value = option.value;
    const text = document.createElement("span");
    text.textContent = option.label;
    label.append(input, text);
    control.appendChild(label);
    return input;
  });
  fieldset.append(legend, control);
  return { fieldset, inputs };
}

function selectedValue<T extends string>(inputs: HTMLInputElement[], fallback: T): T {
  return (inputs.find((input) => input.checked)?.value as T | undefined) ?? fallback;
}

export function openLanguageToolSettingsTool(
  options: LanguageToolToolOptions,
): Promise<LanguageToolToolResult | null> {
  return new Promise((resolve) => {
    const { modal } = options;
    modal.replaceChildren();
    modal.hidden = false;

    const panel = document.createElement("form");
    panel.className = "aaronnote-modal-panel aaronnote-languagetool-tool";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-labelledby", "aaronnote-languagetool-title");

    const heading = document.createElement("div");
    heading.className = "aaronnote-languagetool-head";
    const title = document.createElement("h2");
    title.id = "aaronnote-languagetool-title";
    title.textContent = "LanguageTool";
    const health = document.createElement("span");
    health.className = "aaronnote-languagetool-health";
    health.dataset.state = "idle";
    health.setAttribute("role", "status");
    health.textContent = options.status || "Not tested";
    heading.append(title, health);

    const auto = checkboxField("Real-time checking");
    const serverLabel = document.createElement("label");
    serverLabel.className = "aaronnote-languagetool-field";
    serverLabel.textContent = "Server URL";
    const serverUrl = document.createElement("input");
    serverUrl.type = "url";
    serverUrl.required = true;
    serverUrl.setAttribute("autocomplete", "url");
    serverUrl.spellcheck = false;
    serverLabel.appendChild(serverUrl);

    const grid = document.createElement("div");
    grid.className = "aaronnote-languagetool-grid";
    const languageLabel = document.createElement("label");
    languageLabel.className = "aaronnote-languagetool-field";
    languageLabel.textContent = "Language";
    const language = document.createElement("input");
    language.required = true;
    language.setAttribute("list", "aaronnote-languagetool-languages");
    language.autocomplete = "off";
    language.spellcheck = false;
    const languages = document.createElement("datalist");
    languages.id = "aaronnote-languagetool-languages";
    for (const value of ["en-AU", "en-US", "en-GB", "auto", "de-DE", "fr", "es"]) {
      const option = document.createElement("option");
      option.value = value;
      languages.appendChild(option);
    }
    languageLabel.append(language, languages);

    const timeoutLabel = document.createElement("label");
    timeoutLabel.className = "aaronnote-languagetool-field";
    timeoutLabel.textContent = "NAS timeout (ms)";
    const timeout = document.createElement("input");
    timeout.type = "number";
    timeout.min = "500";
    timeout.max = "30000";
    timeout.step = "100";
    timeoutLabel.appendChild(timeout);
    grid.append(languageLabel, timeoutLabel);

    const level = segmentedField("Checking level", "languagetool-level", LEVEL_LABELS);
    const profile = segmentedField("Performance", "languagetool-profile", PROFILE_LABELS);
    const fallback = checkboxField("Use local CLI for manual checks when NAS is unavailable");

    const statusLine = document.createElement("div");
    statusLine.className = "aaronnote-languagetool-status";
    statusLine.setAttribute("aria-live", "polite");

    const actions = document.createElement("div");
    actions.className = "aaronnote-modal-actions aaronnote-languagetool-actions";
    const test = document.createElement("button");
    test.type = "button";
    test.textContent = "Test server";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.textContent = "Defaults";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    const save = document.createElement("button");
    save.type = "submit";
    save.textContent = "Save";
    actions.append(test, reset, cancel, save);

    panel.append(
      heading,
      auto.label,
      serverLabel,
      grid,
      level.fieldset,
      profile.fieldset,
      fallback.label,
      statusLine,
      actions,
    );
    modal.appendChild(panel);

    let closed = false;
    let probeSequence = 0;
    let activeProbeId = "";
    let busyMode: "probe" | "save" | null = null;
    let retryCooldownMs = options.settings.retryCooldownMs;
    const editableControls = [...panel.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")];
    const setBusy = (mode: "probe" | "save" | null): void => {
      busyMode = mode;
      if (mode) panel.setAttribute("aria-busy", "true");
      else panel.removeAttribute("aria-busy");
      for (const control of editableControls) control.disabled = mode !== null;
      test.disabled = mode !== null;
      reset.disabled = mode !== null;
      save.disabled = mode !== null;
      cancel.disabled = mode === "save";
    };
    const setHealth = (state: "idle" | "checking" | "online" | "error", text: string): void => {
      health.dataset.state = state;
      health.textContent = text;
    };
    const read = (): LanguageToolSettings => ({
      automaticEnabled: auto.input.checked,
      serverUrl: serverUrl.value.trim(),
      language: language.value.trim(),
      level: selectedValue(level.inputs, "picky"),
      performanceProfile: selectedValue(profile.inputs, "balanced"),
      manualLocalFallback: fallback.input.checked,
      remoteTimeoutMs: Number(timeout.value),
      retryCooldownMs,
    });
    const fill = (settings: LanguageToolSettings): void => {
      auto.input.checked = settings.automaticEnabled;
      serverUrl.value = settings.serverUrl;
      language.value = settings.language;
      timeout.value = String(settings.remoteTimeoutMs);
      level.inputs.forEach((input) => { input.checked = input.value === settings.level; });
      profile.inputs.forEach((input) => { input.checked = input.value === settings.performanceProfile; });
      fallback.input.checked = settings.manualLocalFallback;
      retryCooldownMs = settings.retryCooldownMs;
    };
    const close = (value: LanguageToolToolResult | null): void => {
      if (closed) return;
      if (busyMode === "save" && value === null) return;
      closed = true;
      probeSequence += 1;
      if (activeProbeId) options.api.cancelKeepalive?.(activeProbeId);
      modal.removeEventListener("mousedown", onBackdrop);
      modal.hidden = true;
      modal.replaceChildren();
      options.onClose?.();
      resolve(value);
    };
    const onBackdrop = (event: MouseEvent): void => {
      if (event.target === modal) close(null);
    };

    fill(options.settings);
    statusLine.textContent = "";
    cancel.addEventListener("click", () => close(null));
    reset.addEventListener("click", () => {
      fill(options.defaults);
      setHealth("idle", "Defaults loaded");
    });
    test.addEventListener("click", () => {
      if (!panel.reportValidity()) return;
      const sequence = ++probeSequence;
      const requestId = globalThis.crypto?.randomUUID?.() ?? `probe-${Date.now()}-${sequence}`;
      activeProbeId = requestId;
      const draft = read();
      setBusy("probe");
      setHealth("checking", "Checking...");
      void options.api.probe({ ...draft, requestId }).then((result) => {
        if (closed || sequence !== probeSequence) return;
        const version = result.version ? ` · ${result.version}` : "";
        setHealth("online", `Online · ${Math.round(result.latencyMs || 0)} ms${version}`);
      }).catch((error) => {
        if (closed || sequence !== probeSequence) return;
        setHealth("error", error instanceof Error ? error.message : "Connection failed");
      }).finally(() => {
        if (activeProbeId === requestId) activeProbeId = "";
        if (!closed && sequence === probeSequence) setBusy(null);
      });
    });
    panel.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!panel.reportValidity()) return;
      const draft = read();
      probeSequence += 1;
      setBusy("save");
      statusLine.textContent = "Saving...";
      void options.api.updateSettings({ ...draft, revision: options.revision }).then((result) => {
        const saved = result.settings;
        if (!saved) throw new Error("LanguageTool settings response was incomplete");
        close({ settings: saved, revision: String(result.revision || "") });
      }).catch((error) => {
        if (closed) return;
        statusLine.textContent = error instanceof Error ? error.message : "Saving failed";
        setBusy(null);
      });
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        const focusable = [...panel.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled)")];
        const first = focusable[0];
        const last = focusable.at(-1);
        if (first && last && (event.shiftKey ? document.activeElement === first : document.activeElement === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
        return;
      }
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
      event.preventDefault();
      if (busyMode !== "save") close(null);
    });
    modal.addEventListener("mousedown", onBackdrop);
    window.setTimeout(() => serverUrl.focus(), 0);
  });
}
