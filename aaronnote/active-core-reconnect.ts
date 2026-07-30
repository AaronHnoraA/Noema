export type CoreConnectionStatus = "connected" | "connecting" | "disconnected";
export type CoreReconnectReason = "focus" | "pointer" | "keyboard" | "input";

export type CoreConnectionBridge = {
  status(): CoreConnectionStatus;
  reconnect(reason: CoreReconnectReason): Promise<boolean>;
};

type ActiveCoreReconnectOptions = {
  connection: CoreConnectionBridge;
  windowTarget?: Window;
  documentTarget?: Document;
  now?: () => number;
  retryCooldownMs?: number;
  onStatus?: (status: CoreConnectionStatus, detail?: { reason?: string }) => void;
};

export type ActiveCoreReconnectController = {
  trigger(reason: CoreReconnectReason): Promise<boolean>;
  destroy(): void;
};

/**
 * Reconnect the host event stream only in response to deliberate activity.
 *
 * There is deliberately no timeout, interval, idle callback, visibility poll,
 * or network probe here. A failed attempt merely starts a timestamp cooldown;
 * another focus/click/key/input after the cooldown is what permits the next
 * attempt. This keeps a suspended Noema tab completely quiet.
 */
export function installActiveCoreReconnect(
  options: ActiveCoreReconnectOptions,
): ActiveCoreReconnectController {
  const windowTarget = options.windowTarget ?? window;
  const documentTarget = options.documentTarget ?? document;
  const now = options.now ?? Date.now;
  const retryCooldownMs = Math.max(0, options.retryCooldownMs ?? 1_000);
  let destroyed = false;
  let retryNotBefore = 0;
  let inFlight: Promise<boolean> | null = null;

  const report = (status: CoreConnectionStatus, detail?: { reason?: string }): void => {
    options.onStatus?.(status, detail);
  };

  const trigger = (reason: CoreReconnectReason): Promise<boolean> => {
    if (destroyed || options.connection.status() !== "disconnected") {
      return Promise.resolve(false);
    }
    if (inFlight) return inFlight;
    if (now() < retryNotBefore) return Promise.resolve(false);

    report("connecting", { reason });
    const attempt = Promise.resolve()
      .then(() => options.connection.reconnect(reason))
      .then((connected) => {
        if (connected || options.connection.status() === "connected") {
          retryNotBefore = 0;
          report("connected", { reason });
          return true;
        }
        retryNotBefore = now() + retryCooldownMs;
        report("disconnected", { reason });
        return false;
      })
      .catch(() => {
        retryNotBefore = now() + retryCooldownMs;
        report("disconnected", { reason });
        return false;
      })
      .finally(() => {
        if (inFlight === attempt) inFlight = null;
      });
    inFlight = attempt;
    return attempt;
  };

  const onFocus = (): void => { void trigger("focus"); };
  const onPointer = (): void => { void trigger("pointer"); };
  const onKeyboard = (): void => { void trigger("keyboard"); };
  const onInput = (): void => { void trigger("input"); };
  const onConnectionStatus = (event: Event): void => {
    const detail = (event as CustomEvent<{ status?: CoreConnectionStatus; reason?: string }>).detail;
    if (detail?.status) report(detail.status, { reason: detail.reason });
  };

  windowTarget.addEventListener("focus", onFocus, true);
  windowTarget.addEventListener("aaronnote:connection", onConnectionStatus);
  documentTarget.addEventListener("pointerdown", onPointer, { capture: true, passive: true });
  // WebKit builds without PointerEvent still emit mousedown. The in-flight
  // guard makes the normal pointerdown+mousedown pair cost only a status read.
  documentTarget.addEventListener("mousedown", onPointer, { capture: true, passive: true });
  documentTarget.addEventListener("keydown", onKeyboard, true);
  documentTarget.addEventListener("beforeinput", onInput, true);

  return {
    trigger,
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      windowTarget.removeEventListener("focus", onFocus, true);
      windowTarget.removeEventListener("aaronnote:connection", onConnectionStatus);
      documentTarget.removeEventListener("pointerdown", onPointer, true);
      documentTarget.removeEventListener("mousedown", onPointer, true);
      documentTarget.removeEventListener("keydown", onKeyboard, true);
      documentTarget.removeEventListener("beforeinput", onInput, true);
    },
  };
}
