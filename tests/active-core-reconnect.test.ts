import { describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import {
  installActiveCoreReconnect,
  type CoreConnectionStatus,
} from "../aaronnote/active-core-reconnect.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("active core reconnect", () => {
  test("coalesces focus, click, and typing into one reconnect attempt", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const attempt = deferred<boolean>();
    let status: CoreConnectionStatus = "disconnected";
    const reconnect = vi.fn(async () => {
      const connected = await attempt.promise;
      status = connected ? "connected" : "disconnected";
      return connected;
    });
    const controller = installActiveCoreReconnect({
      connection: { status: () => status, reconnect },
      windowTarget: windowTarget as unknown as Window,
      documentTarget: documentTarget as unknown as Document,
    });

    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("pointerdown"));
    documentTarget.dispatchEvent(new Event("mousedown"));
    documentTarget.dispatchEvent(new Event("keydown"));
    documentTarget.dispatchEvent(new Event("beforeinput"));
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledWith("focus");

    attempt.resolve(true);
    await controller.trigger("keyboard");
    expect(reconnect).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  test("does not poll and requires another active event after a failed cooldown", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    let clock = 10_000;
    const reconnect = vi.fn(async () => false);
    const controller = installActiveCoreReconnect({
      connection: { status: () => "disconnected", reconnect },
      windowTarget: windowTarget as unknown as Window,
      documentTarget: documentTarget as unknown as Document,
      now: () => clock,
      retryCooldownMs: 1_000,
    });

    await controller.trigger("keyboard");
    expect(reconnect).toHaveBeenCalledTimes(1);

    // Advancing time alone performs no work: there is no timer/idle retry.
    clock += 5_000;
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(1);
    documentTarget.dispatchEvent(new Event("beforeinput"));
    await Promise.resolve();
    expect(reconnect).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  test("stays dormant while connected and removes all activity listeners", async () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const reconnect = vi.fn(async () => true);
    let status: CoreConnectionStatus = "connected";
    const controller = installActiveCoreReconnect({
      connection: { status: () => status, reconnect },
      windowTarget: windowTarget as unknown as Window,
      documentTarget: documentTarget as unknown as Document,
    });

    windowTarget.dispatchEvent(new Event("focus"));
    documentTarget.dispatchEvent(new Event("pointerdown"));
    await Promise.resolve();
    expect(reconnect).not.toHaveBeenCalled();

    status = "disconnected";
    controller.destroy();
    documentTarget.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    expect(reconnect).not.toHaveBeenCalled();
  });

  test("forwards bridge connection-state events to the UI", () => {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    const seen: CoreConnectionStatus[] = [];
    const controller = installActiveCoreReconnect({
      connection: { status: () => "connected", reconnect: async () => true },
      windowTarget: windowTarget as unknown as Window,
      documentTarget: documentTarget as unknown as Document,
      onStatus: (status) => seen.push(status),
    });

    windowTarget.dispatchEvent(new CustomEvent("aaronnote:connection", {
      detail: { status: "disconnected", reason: "stream-error" },
    }));
    expect(seen).toEqual(["disconnected"]);
    controller.destroy();
  });
});
