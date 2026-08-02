import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  pluginDirectoryList,
  pluginEnabled,
  pluginIdList,
  validatePluginManifest,
} from "../shared/plugin-system.mjs";

function containedEntry(root, entry) {
  const target = resolve(root, entry);
  return target.startsWith(`${resolve(root)}${sep}`) ? target : "";
}

async function pluginDirectories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(root, entry.name));
  } catch {
    return [];
  }
}

export function createDesktopPluginHost({ app, session, net, appRoot, userData, env = process.env }) {
  const menuTransformers = [];
  const dialogTransformers = [];
  const hostEnvironmentTransformers = [];
  const rendererBootstraps = [];
  const webContentsListeners = [];
  const loaded = [];
  const available = [];
  const configPath = join(userData, "plugins.json");
  let persistedConfig = {};

  const log = (message, error = null) => {
    const detail = error ? `: ${error?.stack || error}` : "";
    process.stderr.write(`[noema-plugin] ${message}${detail}\n`);
  };

  function transform(value, transformers, context) {
    return transformers.reduce((current, entry) => {
      try {
        return entry.transform(current, context) ?? current;
      } catch (error) {
        log(`${entry.id} transformer failed`, error);
        return current;
      }
    }, value);
  }

  function rendererScript(bootstrap) {
    return `(${bootstrap.source})(${JSON.stringify(bootstrap.payload ?? {})});`;
  }

  async function installRendererBridge() {
    if (rendererBootstraps.length === 0 && webContentsListeners.length === 0) return;
    const fallback = rendererBootstraps.map(rendererScript).join("\n");
    const inlineScripts = rendererBootstraps.map((item) =>
      `<script data-noema-plugin="${item.id}">${rendererScript(item).replace(/<\/script/gi, "<\\/script")}</script>`).join("");
    const cloak = rendererBootstraps.some((item) => item.cloak)
      ? '<style id="noema-plugin-cloak">html[data-noema-plugins-pending] body{animation:noemaPluginsFailOpen 1500ms steps(1,end) both}@keyframes noemaPluginsFailOpen{from{opacity:0}to{opacity:1}}</style><script>document.documentElement.setAttribute("data-noema-plugins-pending","1")</script>'
      : "";
    const bootstrap = `${cloak}${inlineScripts}`;

    if (bootstrap) {
      try {
        session.defaultSession.protocol.handle("http", async (request) => {
          const passthrough = () => net.fetch(request, { bypassCustomProtocolHandlers: true });
          try {
            const url = new URL(request.url);
            const local = url.hostname === "127.0.0.1" || url.hostname === "localhost";
            if (!local || request.method !== "GET" || (request.destination && request.destination !== "document")) {
              return passthrough();
            }
            const response = await passthrough();
            if (!(response.headers.get("content-type") || "").includes("text/html")) return response;
            const html = await response.text();
            const head = /<head[^>]*>/i.exec(html);
            const output = head
              ? `${html.slice(0, head.index + head[0].length)}${bootstrap}${html.slice(head.index + head[0].length)}`
              : `${bootstrap}${html}`;
            const headers = new Headers(response.headers);
            for (const name of ["content-length", "content-encoding", "etag", "content-md5", "digest", "last-modified"]) headers.delete(name);
            headers.set("cache-control", "no-store");
            return new Response(output, { status: response.status, statusText: response.statusText, headers });
          } catch (error) {
            log("renderer bootstrap injection failed", error);
            return passthrough();
          }
        });
      } catch (error) {
        log("HTTP renderer bridge could not be installed", error);
      }
    }

    app.on("web-contents-created", (_event, contents) => {
      if (contents.getType() !== "window") return;
      for (const entry of webContentsListeners) {
        try { entry.listener(contents); } catch (error) { log(`${entry.id} webContents listener failed`, error); }
      }
      if (fallback) contents.on("dom-ready", () => {
        contents.executeJavaScript(fallback).catch((error) => log("renderer fallback failed", error));
      });
    });
  }

  async function load() {
    try { persistedConfig = JSON.parse(await readFile(configPath, "utf8")); } catch { persistedConfig = {}; }
    const environmentEnabled = pluginIdList(env.NOEMA_ENABLED_PLUGINS);
    const environmentDisabled = pluginIdList(env.NOEMA_DISABLED_PLUGINS);
    const configuredEnabled = pluginIdList(persistedConfig.enabled);
    const configuredDisabled = pluginIdList(persistedConfig.disabled);
    const extraRoots = pluginDirectoryList(env.NOEMA_PLUGIN_DIRS).filter(isAbsolute);
    const roots = [join(appRoot, "plugins"), join(userData, "plugins"), ...extraRoots];
    const seen = new Set();

    for (const root of roots) {
      for (const pluginDir of await pluginDirectories(root)) {
        try {
          const manifest = validatePluginManifest(JSON.parse(await readFile(join(pluginDir, "plugin.json"), "utf8")));
          if (seen.has(manifest.id)) {
            log(`ignoring duplicate ${manifest.id} at ${pluginDir}`);
            continue;
          }
          seen.add(manifest.id);
          const configurable = manifest.configurable !== false;
          const isEnabled = configurable
            ? environmentDisabled.includes(manifest.id)
              ? false
              : environmentEnabled.includes(manifest.id)
                ? true
                : pluginEnabled(manifest, { enabled: configuredEnabled, disabled: configuredDisabled, env })
            : manifest.enabledByDefault === true;
          available.push({
            id: manifest.id,
            name: manifest.name,
            description: String(manifest.description || ""),
            version: manifest.version,
            enabled: isEnabled,
            active: false,
            builtIn: root === roots[0],
            configurable,
            locked: !configurable || environmentEnabled.includes(manifest.id) || environmentDisabled.includes(manifest.id),
          });
          if (!isEnabled) continue;
          const entry = containedEntry(pluginDir, manifest.main);
          if (!entry) throw new Error("plugin entry escapes its directory");
          const module = await import(pathToFileURL(entry).href);
          if (typeof module.activate !== "function") throw new Error("main module must export activate(api)");
          const storageDir = join(userData, "plugin-state", manifest.id);
          await mkdir(storageDir, { recursive: true });
          const api = Object.freeze({
            apiVersion: 1,
            manifest: Object.freeze(manifest),
            pluginDir,
            storageDir,
            appRoot,
            app,
            log: (message) => log(`${manifest.id}: ${message}`),
            registerMenuTransformer(transformer) {
              if (typeof transformer === "function") menuTransformers.push({ id: manifest.id, transform: transformer });
            },
            registerDialogTransformer(transformer) {
              if (typeof transformer === "function") dialogTransformers.push({ id: manifest.id, transform: transformer });
            },
            registerHostEnvironmentTransformer(transformer) {
              if (typeof transformer === "function") hostEnvironmentTransformers.push({ id: manifest.id, transform: transformer });
            },
            registerRendererBootstrap(options) {
              if (options && typeof options.source === "string") rendererBootstraps.push({ id: manifest.id, ...options });
            },
            onWebContentsCreated(listener) {
              if (typeof listener === "function") webContentsListeners.push({ id: manifest.id, listener });
            },
          });
          await module.activate(api);
          loaded.push({ id: manifest.id, name: manifest.name, version: manifest.version, directory: pluginDir });
          available.find((item) => item.id === manifest.id).active = true;
          log(`loaded ${manifest.id}@${manifest.version}`);
        } catch (error) {
          log(`failed to load plugin at ${pluginDir}`, error);
        }
      }
    }
    await installRendererBridge();
    return loaded.slice();
  }

  async function setPluginEnabled(id, enabled) {
    const plugin = available.find((item) => item.id === id);
    if (!plugin) throw new Error(`Unknown plugin: ${id}`);
    if (!plugin.configurable) throw new Error(`${id} is an always-active built-in plugin`);
    if (plugin.locked) throw new Error(`${id} is controlled by an environment variable`);
    const enabledIds = new Set(pluginIdList(persistedConfig.enabled));
    const disabledIds = new Set(pluginIdList(persistedConfig.disabled));
    if (enabled) {
      enabledIds.add(id);
      disabledIds.delete(id);
    } else {
      disabledIds.add(id);
      enabledIds.delete(id);
    }
    persistedConfig = { ...persistedConfig, enabled: [...enabledIds].sort(), disabled: [...disabledIds].sort() };
    await mkdir(userData, { recursive: true });
    const temporary = `${configPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(persistedConfig, null, 2)}\n`, "utf8");
    await rename(temporary, configPath);
    plugin.enabled = Boolean(enabled);
    return available.map((item) => ({ ...item }));
  }

  return Object.freeze({
    load,
    loadedPlugins: () => loaded.slice(),
    availablePlugins: () => available.map((item) => ({ ...item })),
    setPluginEnabled,
    transformMenuTemplate: (template, context = {}) => transform(template, menuTransformers, context),
    transformDialogOptions: (kind, options, context = {}) => transform(options, dialogTransformers, { ...context, kind }),
    transformHostEnvironment: (environment, context = {}) => transform(environment, hostEnvironmentTransformers, context),
  });
}
