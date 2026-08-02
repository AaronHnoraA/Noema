import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";

const ROLE_DEFAULTS = {
  about: "About",
  services: "Services",
  hide: "Hide",
  hideothers: "Hide Others",
  unhide: "Show All",
  quit: "Quit",
  close: "Close",
  cut: "Cut",
  copy: "Copy",
  paste: "Paste",
  selectall: "Select All",
  resetzoom: "Actual Size",
  zoomin: "Zoom In",
  zoomout: "Zoom Out",
  toggledevtools: "Toggle Developer Tools",
  togglefullscreen: "Toggle Full Screen",
  minimize: "Minimize",
  zoom: "Zoom",
  front: "Bring All to Front",
  undo: "Undo",
  redo: "Redo",
  filemenu: "File",
  editmenu: "Edit",
  viewmenu: "View",
  windowmenu: "Window",
  help: "Help",
  delete: "Delete",
  reload: "Reload",
  forcereload: "Force Reload"
};

export async function activate(api) {
  const dictionary = JSON.parse(await readFile(join(api.pluginDir, "zh-CN.json"), "utf8"));
  const rendererSource = await readFile(join(api.pluginDir, "renderer.js"), "utf8");
  const exact = dictionary.exact || {};
  const roles = dictionary.roles || {};
  const regexRules = (dictionary.regex || []).flatMap((rule) => {
    try { return [{ expression: new RegExp(rule.pattern), replace: rule.replace }]; }
    catch { return []; }
  });

  function translateText(value) {
    if (typeof value !== "string" || value.length === 0 || value.length > 500) return null;
    if (Object.prototype.hasOwnProperty.call(exact, value)) return exact[value];
    const trimmed = value.match(/^(\s*)(\S[\s\S]*?\S|\S)(\s*)$/);
    if (trimmed && Object.prototype.hasOwnProperty.call(exact, trimmed[2])) {
      return `${trimmed[1]}${exact[trimmed[2]]}${trimmed[3]}`;
    }
    for (const rule of regexRules) {
      rule.expression.lastIndex = 0;
      if (rule.expression.test(value)) {
        rule.expression.lastIndex = 0;
        return value.replace(rule.expression, rule.replace);
      }
    }
    return null;
  }

  function translateMenu(template) {
    if (!Array.isArray(template)) return template;
    return template.map((item) => {
      if (!item || typeof item !== "object" || item.type === "separator") return item;
      const next = { ...item };
      if (typeof next.label === "string") next.label = translateText(next.label) ?? next.label;
      else if (next.role) {
        const english = ROLE_DEFAULTS[String(next.role).toLowerCase()];
        if (english && roles[english]) next.label = roles[english];
      }
      if (Array.isArray(next.submenu)) next.submenu = translateMenu(next.submenu);
      return next;
    });
  }

  function translateDialog(options) {
    if (!options || typeof options !== "object") return options;
    const next = { ...options };
    for (const key of ["title", "message", "detail"]) {
      if (typeof next[key] === "string") next[key] = translateText(next[key]) ?? next[key];
    }
    if (Array.isArray(next.buttons)) next.buttons = next.buttons.map((button) => translateText(button) ?? button);
    if (Array.isArray(next.filters)) next.filters = next.filters.map((filter) => ({
      ...filter,
      name: translateText(filter?.name) ?? filter?.name,
    }));
    return next;
  }

  api.registerMenuTransformer(translateMenu);
  api.registerDialogTransformer(translateDialog);
  api.registerRendererBootstrap({
    source: rendererSource,
    payload: { exact, regex: dictionary.regex || [] },
    cloak: true,
  });

  if (process.env.NOEMA_ZH_DEBUG === "1") {
    const misses = new Set();
    api.onWebContentsCreated((contents) => {
      contents.on("console-message", (_event, _level, message) => {
        if (typeof message !== "string" || !message.startsWith("[NOEMA_ZH_MISS] ")) return;
        const value = message.slice("[NOEMA_ZH_MISS] ".length).trim();
        if (!value || misses.has(value)) return;
        misses.add(value);
        void appendFile(join(api.storageDir, "misses.log"), `${JSON.stringify(value)}\n`, "utf8");
      });
    });
  }

  api.log(`dictionary loaded (exact=${Object.keys(exact).length}, regex=${regexRules.length}, roles=${Object.keys(roles).length})`);
}
