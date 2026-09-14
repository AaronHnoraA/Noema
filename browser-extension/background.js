import { extractCapture } from "./extract.mjs";

const MENU_SELECTION = "noema-capture-selection";
const MENU_PAGE = "noema-capture-page";

function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_SELECTION, title: "Capture selection in Noema", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_PAGE, title: "Capture page in Noema", contexts: ["page"] });
  });
}

chrome.runtime.onInstalled.addListener(installMenus);
chrome.runtime.onStartup.addListener(installMenus);

async function settings() {
  const stored = await chrome.storage.local.get({ endpoint: "", token: "", workstreamId: "" });
  const endpoint = String(stored.endpoint || "").replace(/\/+$/, "");
  const parsed = new URL(endpoint);
  if (parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" || !parsed.port) {
    throw new Error("Configure an http://127.0.0.1:<port> Noema endpoint in extension options");
  }
  const token = String(stored.token || "").trim();
  if (!token) throw new Error("Configure the Noema capture token in extension options");
  return { endpoint, token, workstreamId: String(stored.workstreamId || "").trim() };
}

async function setBadge(text, color) {
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text });
  setTimeout(() => chrome.action.setBadgeText({ text: "" }).catch(() => {}), 2500);
}

async function capture(tab, mode) {
  if (!tab?.id || !/^https?:/i.test(String(tab.url || ""))) throw new Error("Noema captures only http(s) pages");
  const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: extractCapture, args: [mode] });
  if (!result?.html) throw new Error("The page produced no capturable content");
  const config = await settings();
  const response = await fetch(`${config.endpoint}/v1/captures`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${config.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      clientRequestId: crypto.randomUUID(),
      adapter: mode === "selection" ? "generic-selection" : "generic-page",
      completeness: mode === "selection" ? "selection" : "full",
      capturedAt: new Date().toISOString(),
      url: result.url,
      title: result.title,
      html: result.html,
      workstreamId: config.workstreamId,
      metadata: { language: result.language },
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok || !payload.capture?.id) throw new Error(String(payload.message || `Noema returned HTTP ${response.status}`));
  await setBadge("✓", "#2f855a");
  return payload.capture;
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const mode = info.menuItemId === MENU_SELECTION ? "selection" : info.menuItemId === MENU_PAGE ? "page" : "";
  if (!mode) return;
  capture(tab, mode).catch(async (error) => {
    await setBadge("!", "#c53030");
    console.error("Noema capture failed", error);
  });
});

chrome.action.onClicked.addListener((tab) => {
  capture(tab, "page").catch(async (error) => {
    await setBadge("!", "#c53030");
    console.error("Noema capture failed", error);
  });
});
