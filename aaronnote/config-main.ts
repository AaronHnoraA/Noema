import "../src/styles/theme-loader.ts";
import "./config.css";

import type { NoemaAppConfigMsg, NoemaAppTheme, NoemaDesktopPlugin } from "./api-client.ts";
import { api } from "./api-client.ts";
import {
  installNoemaThemeRuntime,
  loadNoemaAppConfig,
  noemaAppConfigState,
  setNoemaAppTheme,
} from "./theme-runtime.ts";

const root = document.querySelector<HTMLElement>("#config-app");
if (!root) throw new Error("Missing #config-app");

document.body.dataset.hostMode = window.noemaDesktop ? "desktop" : "browser";
if (window.noemaDesktop) document.body.dataset.desktopPlatform = window.noemaDesktop.platform;

root.innerHTML = `
  <header class="noema-config-titlebar">
    <div class="noema-config-title">
      <span class="noema-config-mark" aria-hidden="true">N</span>
      <span>
        <strong>Noema</strong>
        <small>Configuration</small>
      </span>
    </div>
    <button type="button" data-config-close>Close</button>
  </header>
  <div class="noema-config-layout">
    <nav class="noema-config-nav" aria-label="Configuration sections">
      <span>Settings</span>
      <a href="#appearance" class="is-active">Appearance</a>
      <a href="#workspace">Workspace</a>
      <a href="#new-pages">New pages</a>
      <a href="#plugins">Plugins</a>
      <a href="#configuration-file">Configuration file</a>
    </nav>
    <main class="noema-config-main">
      <section class="noema-config-intro">
        <p class="noema-config-eyebrow">Application settings</p>
        <h1>Configuration</h1>
        <p>Choose how Noema looks. Changes are saved globally and applied to every open window.</p>
      </section>
      <section class="noema-config-section" id="workspace">
        <div class="noema-config-section-head">
          <div>
            <p class="noema-config-eyebrow">Wiki storage</p>
            <h2>Workspace</h2>
          </div>
        </div>
        <label class="noema-config-field">
          <span>Root directory</span>
          <input data-workspace-root type="text" spellcheck="false" placeholder="~/Documents/Noema">
        </label>
        <label class="noema-config-field">
          <span>Layout</span>
          <select data-workspace-layout>
            <option value="legacy">Legacy · current single repository</option>
            <option value="wiki">Wiki · public/private repository collections</option>
          </select>
        </label>
        <p class="noema-config-copy">
          Switching layout never moves files and never initializes a Git repository. Wiki layout indexes only direct
          Git repository children of <code>public/</code> and <code>private/</code>. Restart Noema after changing this section.
        </p>
      </section>
      <section class="noema-config-section" id="new-pages">
        <div class="noema-config-section-head">
          <div>
            <p class="noema-config-eyebrow">Wiki creation</p>
            <h2>Default destination</h2>
          </div>
        </div>
        <div class="noema-config-form-grid">
          <label class="noema-config-field"><span>Partition</span><select data-profile-partition><option>private</option><option>public</option></select></label>
          <label class="noema-config-field"><span>Repository</span><input data-profile-repository type="text" spellcheck="false"></label>
          <label class="noema-config-field"><span>Directory</span><input data-profile-directory type="text" spellcheck="false"></label>
          <label class="noema-config-field"><span>Filename pattern</span><input data-profile-filename type="text" spellcheck="false" placeholder="{slug}.md"></label>
        </div>
        <div class="noema-config-actions"><button type="button" data-config-save-workspace>Save workspace settings</button></div>
      </section>
      <section class="noema-config-section" id="appearance">
        <div class="noema-config-section-head">
          <div>
            <p class="noema-config-eyebrow">Appearance</p>
            <h2>Theme</h2>
          </div>
          <span data-config-status role="status" aria-live="polite"></span>
        </div>
        <div class="noema-config-themes" data-config-themes role="radiogroup" aria-label="Noema theme"></div>
      </section>
      <section class="noema-config-section" id="plugins">
        <div class="noema-config-section-head">
          <div>
            <p class="noema-config-eyebrow">Extensions</p>
            <h2>Plugins</h2>
          </div>
        </div>
        <p class="noema-config-copy">Enable or disable desktop plugins. Changes take effect after restarting Noema.</p>
        <div class="noema-config-plugins" data-config-plugins></div>
      </section>
      <section class="noema-config-section" id="configuration-file">
        <div class="noema-config-section-head">
          <div>
            <p class="noema-config-eyebrow">Advanced</p>
            <h2>Configuration file</h2>
          </div>
        </div>
        <p class="noema-config-copy">
          Noema stores settings here. Manual edits are watched and reloaded automatically.
          Packaged theme files stay inside the application.
        </p>
        <code class="noema-config-path" data-config-path>~/.config/noema/config.json</code>
        <div class="noema-config-diagnostics" data-config-diagnostics hidden></div>
      </section>
    </main>
  </div>
`;

const themesEl = root.querySelector<HTMLElement>("[data-config-themes]")!;
const pathEl = root.querySelector<HTMLElement>("[data-config-path]")!;
const statusEl = root.querySelector<HTMLElement>("[data-config-status]")!;
const diagnosticsEl = root.querySelector<HTMLElement>("[data-config-diagnostics]")!;
const closeButton = root.querySelector<HTMLButtonElement>("[data-config-close]")!;
const workspaceRootEl = root.querySelector<HTMLInputElement>("[data-workspace-root]")!;
const workspaceLayoutEl = root.querySelector<HTMLSelectElement>("[data-workspace-layout]")!;
const profilePartitionEl = root.querySelector<HTMLSelectElement>("[data-profile-partition]")!;
const profileRepositoryEl = root.querySelector<HTMLInputElement>("[data-profile-repository]")!;
const profileDirectoryEl = root.querySelector<HTMLInputElement>("[data-profile-directory]")!;
const profileFilenameEl = root.querySelector<HTMLInputElement>("[data-profile-filename]")!;
const saveWorkspaceButton = root.querySelector<HTMLButtonElement>("[data-config-save-workspace]")!;
const pluginsEl = root.querySelector<HTMLElement>("[data-config-plugins]")!;

let payload: NoemaAppConfigMsg | null = noemaAppConfigState();
let statusTimer = 0;
let savingTheme = "";
let plugins: NoemaDesktopPlugin[] = [];
let savingPlugin = "";

function setStatus(message: string, kind: "normal" | "error" = "normal"): void {
  statusEl.textContent = message;
  statusEl.dataset.kind = kind;
  window.clearTimeout(statusTimer);
  if (message) {
    statusTimer = window.setTimeout(() => {
      statusEl.textContent = "";
      delete statusEl.dataset.kind;
    }, 3500);
  }
}

function themePreview(theme: NoemaAppTheme): HTMLElement {
  const preview = document.createElement("span");
  preview.className = "noema-config-theme-preview";
  preview.style.setProperty("--theme-preview-bg", theme.backgroundColor);
  preview.innerHTML = `
    <i></i>
    <i></i>
    <i></i>
    <b></b>
  `;
  return preview;
}

function renderPlugins(): void {
  pluginsEl.replaceChildren();
  if (!window.noemaDesktop?.listPlugins) {
    const unavailable = document.createElement("p");
    unavailable.className = "noema-config-copy";
    unavailable.textContent = "Plugin management is available in Noema.app.";
    pluginsEl.appendChild(unavailable);
    return;
  }
  if (plugins.length === 0) {
    const empty = document.createElement("p");
    empty.className = "noema-config-copy";
    empty.textContent = "No plugins were found.";
    pluginsEl.appendChild(empty);
    return;
  }
  for (const plugin of plugins) {
    const row = document.createElement("label");
    row.className = "noema-config-plugin";
    const copy = document.createElement("span");
    copy.className = "noema-config-plugin-copy";
    const title = document.createElement("strong");
    title.textContent = plugin.name;
    const metadata = document.createElement("small");
    metadata.textContent = `${plugin.id} · ${plugin.version}${plugin.builtIn ? " · Built in" : ""}${plugin.configurable ? "" : " · Always active"}`;
    const description = document.createElement("span");
    description.textContent = plugin.description;
    const state = document.createElement("em");
    state.textContent = plugin.enabled === plugin.active
      ? (plugin.active ? "Active" : "Disabled")
      : "Restart required";
    copy.append(title, metadata, description, state);
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = plugin.enabled;
    toggle.disabled = Boolean(savingPlugin) || plugin.locked;
    toggle.setAttribute("aria-label", `${plugin.enabled ? "Disable" : "Enable"} ${plugin.name}`);
    toggle.addEventListener("change", () => {
      savingPlugin = plugin.id;
      renderPlugins();
      void window.noemaDesktop!.setPluginEnabled(plugin.id, toggle.checked).then((next) => {
        plugins = next;
        setStatus(`${plugin.name} changed · restart Noema to apply`);
      }).catch((error) => {
        setStatus(error instanceof Error ? error.message : String(error), "error");
      }).finally(() => {
        savingPlugin = "";
        renderPlugins();
      });
    });
    row.append(copy, toggle);
    pluginsEl.appendChild(row);
  }
}

function render(): void {
  if (!payload) return;
  pathEl.textContent = payload.configFile || "~/.config/noema/config.json";
  themesEl.replaceChildren();
  workspaceRootEl.value = payload.config.workspace.root;
  workspaceLayoutEl.value = payload.config.workspace.layout;
  const profile = payload.config.wiki.creation.profiles.find((item) => item.id === payload?.config.wiki.creation.activeProfile)
    || payload.config.wiki.creation.profiles[0];
  profilePartitionEl.value = profile?.partition || "private";
  profileRepositoryEl.value = profile?.repository || "";
  profileDirectoryEl.value = profile?.directory || "";
  profileFilenameEl.value = profile?.filenamePattern || "{slug}.md";

  for (const theme of payload.themes) {
    const selected = theme.id === payload.config.appearance.theme;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "noema-config-theme";
    button.classList.toggle("is-active", selected);
    button.disabled = Boolean(savingTheme);
    button.dataset.themeId = theme.id;
    button.setAttribute("role", "radio");
    button.setAttribute("aria-checked", String(selected));
    button.setAttribute("aria-label", `${theme.name}, ${theme.colorScheme} theme`);

    const copy = document.createElement("span");
    copy.className = "noema-config-theme-copy";
    const name = document.createElement("strong");
    name.textContent = theme.name;
    const scheme = document.createElement("small");
    scheme.textContent = theme.colorScheme;
    const description = document.createElement("span");
    description.textContent = theme.description;
    copy.append(name, scheme, description);

    const check = document.createElement("span");
    check.className = "noema-config-theme-check";
    check.textContent = selected ? "Selected" : "Select";
    button.append(themePreview(theme), copy, check);
    button.addEventListener("click", () => {
      if (selected || savingTheme) return;
      savingTheme = theme.id;
      setStatus(`Applying ${theme.name}…`);
      render();
      void setNoemaAppTheme(theme.id).then((next) => {
        payload = next;
        savingTheme = "";
        setStatus(`${theme.name} applied`);
        render();
      }).catch((error) => {
        savingTheme = "";
        payload = noemaAppConfigState();
        setStatus(error instanceof Error ? error.message : String(error), "error");
        render();
      });
    });
    themesEl.appendChild(button);
  }

  diagnosticsEl.replaceChildren();
  for (const diagnostic of payload.diagnostics) {
    const message = document.createElement("p");
    message.textContent = diagnostic.message;
    diagnosticsEl.appendChild(message);
  }
  diagnosticsEl.hidden = payload.diagnostics.length === 0;
  renderPlugins();
}

function closeConfiguration(): void {
  window.close();
  window.setTimeout(() => {
    if (history.length > 1) history.back();
    else window.location.assign("/");
  }, 50);
}

closeButton.addEventListener("click", closeConfiguration);
saveWorkspaceButton.addEventListener("click", () => {
  if (!payload) return;
  const currentProfile = payload.config.wiki.creation.profiles.find((item) => item.id === payload?.config.wiki.creation.activeProfile)
    || payload.config.wiki.creation.profiles[0];
  if (!currentProfile) return;
  saveWorkspaceButton.disabled = true;
  setStatus("Saving workspace settings…");
  void api.config.updateApp({
    revision: payload.revision,
    workspace: {
      root: workspaceRootEl.value.trim(),
      layout: workspaceLayoutEl.value as "legacy" | "wiki",
    },
    wiki: {
      creation: {
        activeProfile: currentProfile.id,
        profiles: payload.config.wiki.creation.profiles.map((profile) => profile.id === currentProfile.id ? {
          ...profile,
          partition: profilePartitionEl.value as "public" | "private",
          repository: profileRepositoryEl.value.trim(),
          directory: profileDirectoryEl.value.trim(),
          filenamePattern: profileFilenameEl.value.trim() || "{slug}.md",
        } : profile),
      },
    },
  }).then((next) => {
    payload = next;
    setStatus("Saved · restart Noema to apply workspace changes");
    render();
  }).catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }).finally(() => {
    saveWorkspaceButton.disabled = false;
  });
});
window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  event.preventDefault();
  closeConfiguration();
});

const removeThemeRuntime = installNoemaThemeRuntime();
window.addEventListener("noema:theme-changed", () => {
  payload = noemaAppConfigState();
  render();
});
window.addEventListener("beforeunload", removeThemeRuntime, { once: true });

void loadNoemaAppConfig().then((next) => {
  payload = next;
  render();
}).catch((error) => {
  setStatus(error instanceof Error ? error.message : String(error), "error");
});

if (window.noemaDesktop?.listPlugins) {
  void window.noemaDesktop.listPlugins().then((next) => {
    plugins = next;
    renderPlugins();
  }).catch((error) => {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  });
}

render();
