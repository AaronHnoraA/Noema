import {
  api,
  type NoemaAppConfigMsg,
  type NoemaAppTheme,
} from "./api-client.ts";

let state: NoemaAppConfigMsg | null = window.__noemaAppConfig ?? null;
let loadSequence = 0;

function themeFrom(payload: NoemaAppConfigMsg | null, themeId?: string): NoemaAppTheme | null {
  const id = String(themeId || payload?.config?.appearance?.theme || "");
  return payload?.themes?.find((theme) => theme.id === id)
    ?? payload?.activeTheme
    ?? payload?.themes?.[0]
    ?? null;
}

function updateThemeColor(theme: NoemaAppTheme | null): void {
  if (!theme) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.content = theme.backgroundColor;
}

export function applyNoemaAppConfig(payload: NoemaAppConfigMsg): NoemaAppConfigMsg {
  const theme = themeFrom(payload);
  window.__noemaAppConfig = payload;
  state = payload;
  if (theme) {
    document.documentElement.dataset.noemaTheme = theme.id;
    updateThemeColor(theme);
    window.dispatchEvent(new CustomEvent("noema:theme-changed", {
      detail: { theme, config: payload.config },
    }));
  }
  return payload;
}

export function noemaAppConfigState(): NoemaAppConfigMsg | null {
  return state;
}

export async function loadNoemaAppConfig(): Promise<NoemaAppConfigMsg> {
  const sequence = ++loadSequence;
  const payload = await api.config.app();
  if (sequence === loadSequence) applyNoemaAppConfig(payload);
  return payload;
}

export async function setNoemaAppTheme(themeId: string): Promise<NoemaAppConfigMsg> {
  const previous = state;
  const preview = themeFrom(state, themeId);
  if (!preview || preview.id !== themeId) throw new Error(`Unknown Noema theme: ${themeId}`);

  document.documentElement.dataset.noemaTheme = preview.id;
  updateThemeColor(preview);
  try {
    const payload = await api.config.updateApp({
      appearance: { theme: themeId },
      revision: state?.revision,
    });
    loadSequence += 1;
    return applyNoemaAppConfig(payload);
  } catch (error) {
    if (previous) applyNoemaAppConfig(previous);
    throw error;
  }
}

export function installNoemaThemeRuntime(): () => void {
  if (state) applyNoemaAppConfig(state);
  const controller = new AbortController();
  window.addEventListener("aaronnote:command", (event) => {
    const detail = (event as CustomEvent<{ command?: string; revision?: string }>).detail;
    if (detail?.command !== "app-config-changed") return;
    if (detail.revision && detail.revision === state?.revision) return;
    void loadNoemaAppConfig().catch((error) => {
      console.error("[noema-theme] unable to reload settings", error);
    });
  }, { signal: controller.signal });
  return () => controller.abort();
}
