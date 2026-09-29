import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { FRAME_KEY_RELAY_MESSAGE, FRAME_KEY_RELAY_SOURCE } from "../src/frame-key-relay.ts";
import { handleXwidgetEmacsKeydown, installFrameKeyRelay } from "../aaronnote/xwidget-key-guard.ts";

type Init = KeyboardEventInit & { key: string; code: string };

function withForwarded(run: (forwarded: string[]) => void): void {
  const win = window as Window & { aaronnoteApi?: unknown };
  const previous = win.aaronnoteApi;
  const forwarded: string[] = [];
  win.aaronnoteApi = { emacs: { key: async (payload: unknown) => {
    forwarded.push(typeof payload === "string" ? payload : String((payload as { key: string }).key));
  } } };
  try { run(forwarded); } finally { win.aaronnoteApi = previous; }
}

/** Run the relay in a fake frame; return what it posts for each key. */
function relay(sequence: Init[], hasFocus = true): { posted: Record<string, unknown>[]; prevented: boolean[] } {
  let listener: ((event: KeyboardEvent) => void) | null = null;
  const fakeDocument = {
    hasFocus: () => hasFocus,
    addEventListener: (_type: string, handler: (event: KeyboardEvent) => void) => { listener = handler; },
  };
  const posted: Record<string, unknown>[] = [];
  const fakeParent = { postMessage: (data: Record<string, unknown>) => posted.push(data) };
  new Function("document", "parent", FRAME_KEY_RELAY_SOURCE)(fakeDocument, fakeParent);
  const prevented = sequence.map((init) => {
    const event = new KeyboardEvent("keydown", { ...init, cancelable: true });
    listener!(event);
    return event.defaultPrevented;
  });
  return { posted, prevented };
}

const SEQUENCES: Init[][] = [
  [{ key: "x", code: "KeyX", ctrlKey: true }, { key: "3", code: "Digit3" }],
  [{ key: "x", code: "KeyX", ctrlKey: true }, { key: "Control", code: "ControlLeft", ctrlKey: true }, { key: "f", code: "KeyF", ctrlKey: true }],
  [{ key: "x", code: "KeyX", ctrlKey: true }, { key: "-", code: "Minus" }],
  [{ key: "x", code: "KeyX", ctrlKey: true }, { key: "Enter", code: "Enter" }],
  [{ key: "x", code: "KeyX", ctrlKey: true }, { key: " ", code: "Space" }],
  [{ key: "c", code: "KeyC", ctrlKey: true }, { key: ".", code: "Period" }],
  [{ key: "x", code: "KeyX", ctrlKey: true }, { key: "Shift", code: "ShiftLeft", shiftKey: true }, { key: "B", code: "KeyB", shiftKey: true }],
  [{ key: "x", code: "KeyX", metaKey: true }],
  [{ key: "ArrowLeft", code: "ArrowLeft", metaKey: true }],
  [{ key: "ArrowLeft", code: "ArrowLeft", metaKey: true, shiftKey: true }],
  [{ key: "¬", code: "KeyL", altKey: true }],
  [{ key: "ArrowLeft", code: "ArrowLeft", altKey: true }],
  [{ key: "a", code: "KeyA" }],
  [{ key: "c", code: "KeyC", metaKey: true }],
  [{ key: "a", code: "KeyA", ctrlKey: true }],
  [{ key: "g", code: "KeyG", ctrlKey: true }],
];

describe("output frame key relay", () => {
  test("forwards exactly what the page itself forwards, for every sequence", () => {
    for (const sequence of SEQUENCES) {
      let direct: string[] = [];
      withForwarded((forwarded) => {
        for (const init of sequence) handleXwidgetEmacsKeydown(new KeyboardEvent("keydown", { ...init, cancelable: true }));
        direct = [...forwarded];
      });
      let relayed: string[] = [];
      withForwarded((forwarded) => {
        const { posted } = relay(sequence);
        for (const data of posted) {
          handleXwidgetEmacsKeydown(new KeyboardEvent("keydown", data as KeyboardEventInit));
        }
        relayed = [...forwarded];
      });
      expect(relayed, JSON.stringify(sequence)).toEqual(direct);
    }
  });

  test("a prefix waits through modifier presses and accepts any following key", () => {
    const expected = ["C-x 3", "C-x C-f", "C-x -", "C-x RET", "C-x SPC", "C-c .", "C-x B", "M-x", "M-<left>"];
    withForwarded((forwarded) => {
      for (const sequence of SEQUENCES.slice(0, 9)) {
        for (const init of sequence) handleXwidgetEmacsKeydown(new KeyboardEvent("keydown", { ...init, cancelable: true }));
      }
      expect(forwarded).toEqual(expected);
    });
  });

  test("keeps the output's own keys and yields everything without native focus", () => {
    expect(relay([{ key: "a", code: "KeyA" }, { key: "c", code: "KeyC", metaKey: true }]).prevented).toEqual([false, false]);
    expect(relay([{ key: "x", code: "KeyX", ctrlKey: true }]).prevented).toEqual([true]);
    const unfocused = relay([{ key: "x", code: "KeyX", ctrlKey: true }], false);
    expect(unfocused).toEqual({ posted: [], prevented: [false] });
  });

  test("the page forwards relayed keys only from its own frames", () => {
    withForwarded((forwarded) => {
      const frame = document.createElement("iframe");
      document.body.appendChild(frame);
      const uninstall = installFrameKeyRelay({ client: () => "pane" });
      try {
        const data = { [FRAME_KEY_RELAY_MESSAGE]: true, key: "x", code: "KeyX", metaKey: true };
        window.dispatchEvent(new MessageEvent("message", { data, source: window }));
        expect(forwarded).toEqual([]);
        window.dispatchEvent(new MessageEvent("message", { data, source: frame.contentWindow }));
        expect(forwarded).toEqual(["M-x"]);
      } finally {
        uninstall();
        frame.remove();
      }
    });
  });
});
