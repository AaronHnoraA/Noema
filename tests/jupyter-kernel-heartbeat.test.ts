import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import * as zmq from "zeromq";
import { createKernelHeartbeat } from "../server/jupyter/kernel-heartbeat.mjs";

// The `hb` channel is the only death signal that exists for a kernel this
// process did not spawn itself — an Emacs-broker-hosted kernel on a Remote
// target, or one we merely attached to. Those records used to stay `idle`
// forever once the kernel was gone, and an execute() against them never
// settled. No ipykernel needed here: `hb` is a plain echo socket, so a REP
// socket that mirrors its input is a faithful stand-in for a live kernel.

/** Stand up an echo responder on a free loopback port, like ipykernel's Heartbeat. */
async function startEchoResponder(): Promise<{ port: number; stop: () => Promise<void> }> {
  const socket = new zmq.Reply();
  await socket.bind("tcp://127.0.0.1:0");
  const endpoint = socket.lastEndpoint!;
  const port = Number(endpoint.slice(endpoint.lastIndexOf(":") + 1));

  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        const [frame] = await socket.receive();
        if (!running) break;
        await socket.send(frame);
      } catch {
        break; // socket closed underneath us
      }
    }
  })();

  return {
    port,
    stop: async () => {
      running = false;
      socket.close();
      await loop;
    },
  };
}

const connectionFor = (port: number) =>
  ({
    transport: "tcp",
    ip: "127.0.0.1",
    hb_port: port,
  }) as const;

const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("kernel heartbeat", () => {
  test("stays quiet while the kernel keeps echoing", async () => {
    const responder = await startEchoResponder();
    let deaths = 0;
    const heartbeat = createKernelHeartbeat({
      connection: connectionFor(responder.port),
      zmq,
      intervalMs: 20,
      timeoutMs: 200,
      maxMisses: 2,
      onDead: () => { deaths += 1; },
    });

    try {
      heartbeat.start();
      await settle(300);
      expect(deaths).toBe(0);
    } finally {
      heartbeat.stop();
      await responder.stop();
    }
  });

  test("reports death once the kernel stops answering", async () => {
    const responder = await startEchoResponder();
    let deaths = 0;
    const heartbeat = createKernelHeartbeat({
      connection: connectionFor(responder.port),
      zmq,
      intervalMs: 20,
      timeoutMs: 100,
      maxMisses: 2,
      onDead: () => { deaths += 1; },
    });

    try {
      heartbeat.start();
      await settle(150);
      expect(deaths).toBe(0);

      await responder.stop();
      await settle(1000);

      // Exactly once, however many pings were still in flight.
      expect(deaths).toBe(1);
    } finally {
      heartbeat.stop();
    }
  });

  test("stop() prevents any later death report and is idempotent", async () => {
    const responder = await startEchoResponder();
    let deaths = 0;
    const heartbeat = createKernelHeartbeat({
      connection: connectionFor(responder.port),
      zmq,
      intervalMs: 20,
      timeoutMs: 100,
      maxMisses: 1,
      onDead: () => { deaths += 1; },
    });

    heartbeat.start();
    heartbeat.stop();
    heartbeat.stop();
    await responder.stop();
    await settle(400);

    expect(deaths).toBe(0);
  });
});
