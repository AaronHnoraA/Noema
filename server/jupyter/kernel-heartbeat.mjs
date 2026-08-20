// Liveness probing over the Jupyter `hb` channel.
//
// The five-port connection file has always reserved `hb_port`, and the Emacs
// broker forwards it as part of the five-channel group, but nothing used it:
// `RawSocket` only opens iopub/shell/control/stdin. Liveness therefore had a
// single source — OS process exit — which exists only for a kernel this Node
// process spawned itself. A kernel placed on a Remote target by the Emacs
// broker, or one we merely attached to, had no death signal at all: its record
// stayed `idle` forever and an execute() against it never settled, which also
// blocked every later cell sharing that kernel's execution queue.
//
// `hb` is an echo socket (ipykernel binds a REP that returns whatever it
// receives), so a round trip proves the kernel process is alive and its event
// loop is being serviced.

import { makeLogger } from "./util.mjs";
import { formConnectionString } from "./raw-socket.mjs";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000;
export const DEFAULT_HEARTBEAT_MAX_MISSES = 3;

/**
 * Watch one kernel's `hb` channel and call `onDead` once it stops answering.
 *
 * Returns a handle with `start()` and `stop()`. `stop()` is idempotent and
 * safe to call from a dispose path; `onDead` fires at most once.
 */
export function createKernelHeartbeat({
  connection,
  zmq,
  intervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
  timeoutMs = DEFAULT_HEARTBEAT_TIMEOUT_MS,
  maxMisses = DEFAULT_HEARTBEAT_MAX_MISSES,
  onDead,
  stderr = process.stderr,
}) {
  const log = makeLogger(stderr);
  const endpoint = formConnectionString(connection, "hb");
  let socket = null;
  let timer = null;
  let stopped = false;
  let fired = false;
  let misses = 0;

  function closeSocket() {
    const current = socket;
    socket = null;
    if (!current) return;
    try {
      current.close();
    } catch {
      /* a socket with a round trip still in flight can refuse to close */
    }
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(run, intervalMs);
    // Never hold the event loop open just to keep pinging.
    timer.unref?.();
  }

  async function run() {
    if (stopped) return;
    try {
      // REQ enforces strict send/receive alternation, so a timed-out round
      // trip leaves the socket unusable — always start from a fresh one after
      // a failure rather than trying to resynchronise it.
      if (!socket) {
        socket = new zmq.Request({ receiveTimeout: timeoutMs, sendTimeout: timeoutMs });
        socket.connect(endpoint);
      }
      const payload = Buffer.from(`aaronnote-hb-${Date.now()}`);
      await socket.send(payload);
      const [echo] = await socket.receive();
      if (!Buffer.from(echo).equals(payload)) {
        throw new Error("heartbeat echo did not match the ping");
      }
      misses = 0;
    } catch (ex) {
      closeSocket();
      misses += 1;
      if (!stopped && misses >= maxMisses) {
        log.warn(
          `kernel heartbeat missed ${misses} consecutive replies on ${endpoint}; treating the kernel as dead`,
        );
        stop();
        if (!fired) {
          fired = true;
          try {
            onDead?.(ex);
          } catch (handlerError) {
            log.error("kernel heartbeat onDead handler threw", handlerError);
          }
        }
        return;
      }
    }
    schedule();
  }

  function start() {
    if (stopped || timer) return;
    schedule();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    closeSocket();
  }

  return { start, stop };
}
