// Ported from microsoft/vscode-jupyter (MIT)
// src/kernels/raw/session/rawSocket.node.ts @ 7a4b2fae07617a6704e6e3af8590cd6c2f7cf519
//
// Presents a WebSocket-shaped front end (the shape @jupyterlab/services'
// KernelConnection expects) over a set of raw ZMQ Dealer/Subscriber sockets.
// This class does its own message (de)serialization; the `serialize` callback
// passed to the constructor is only used to hand hook listeners (ipywidgets)
// the same serialized form a real Jupyter-server WebSocket would have produced.

import crypto from "node:crypto";
import * as wireProtocol from "./wire-protocol.mjs";
import { noop, makeLogger } from "./util.mjs";

function formConnectionString(config, channel) {
  const portDelimiter = config.transport === "tcp" ? ":" : "-";
  const port = config[`${channel}_port`];
  if (!port) throw new Error(`Port not found for channel "${channel}"`);
  return `${config.transport}://${config.ip}${portDelimiter}${port}`;
}

/**
 * Sometimes kernels omit fields the @jupyterlab/services validator requires
 * (e.g. non-Python kernels whose bridging code doesn't format messages the
 * way ipykernel does). Fill in innocuous defaults rather than throwing.
 */
const HEADER_FIELDS = ["username", "version", "session", "msg_id", "msg_type"];
const IOPUB_CONTENT_FIELDS = {
  stream: { name: "string", text: "string" },
  display_data: { data: "object", metadata: "object" },
  execute_input: { code: "string", execution_count: "number" },
  execute_result: { execution_count: "number", data: "object", metadata: "object" },
  error: { ename: "string", evalue: "string", traceback: "object" },
  status: { execution_state: "string" },
  clear_output: { wait: "boolean" },
  comm_open: { comm_id: "string", target_name: "string", data: "object" },
  comm_msg: { comm_id: "string", data: "object" },
  comm_close: { comm_id: "string" },
  shutdown_reply: { restart: "boolean" },
};

function ensureFields(message, channel) {
  const header = message.header || (message.header = {});
  for (const field of HEADER_FIELDS) {
    if (typeof header[field] !== "string") header[field] = "";
  }
  if (typeof message.channel !== "string") message.channel = channel;
  if (!message.content) message.content = {};
  if (!message.metadata) message.metadata = {};
  if (message.channel === "iopub") ensureIOPubContent(message);
}

function ensureIOPubContent(message) {
  const fields = IOPUB_CONTENT_FIELDS[message.header.msg_type];
  if (!fields) return;
  const content = message.content;
  for (const [fieldName, type] of Object.entries(fields)) {
    if (!(fieldName in content) || typeof content[fieldName] !== type) {
      switch (type) {
        case "string": content[fieldName] = ""; break;
        case "boolean": content[fieldName] = false; break;
        case "object": content[fieldName] = {}; break;
        case "number": content[fieldName] = 0; break;
      }
    }
  }
}

/**
 * WebSocket-shaped front end over ZMQ shell/control/stdin/iopub sockets. One
 * instance owns one routing identity (shared by shell/control/stdin) plus its
 * own iopub subscription — safe to construct more than once against the same
 * kernel connection info (each caller gets an independent ZMQ identity).
 */
export class RawSocket {
  onopen = noop;
  onerror = noop;
  onclose = noop;
  onmessage = noop;
  /** Configures @jupyterlab/services' WS subprotocol negotiation; empty = legacy JSON. */
  protocol = "";

  #receiveHooks = [];
  #sendHooks = [];
  #msgChain = Promise.resolve();
  #sendChain = Promise.resolve();
  #channels;
  #closed = false;
  #connection;
  #serialize;
  #zmq;
  #log;

  constructor(connection, serialize, zmq, { stderr } = {}) {
    this.#connection = connection;
    this.#serialize = serialize;
    this.#zmq = zmq;
    this.#log = makeLogger(stderr);
    this.#channels = this.#generateChannels(connection);
  }

  dispose() {
    if (!this.#closed) this.close();
  }

  close() {
    this.#closed = true;
    const closer = (closable) => {
      try {
        closable.close();
      } catch (ex) {
        this.#log.error("Error during socket shutdown", ex);
      }
    };
    closer(this.#channels.control);
    closer(this.#channels.iopub);
    closer(this.#channels.shell);
    closer(this.#channels.stdin);
  }

  emit(event, ...args) {
    switch (event) {
      case "message": this.onmessage({ data: args[0], type: "message", target: this }); break;
      case "close": this.onclose({ wasClean: true, code: 0, reason: "", target: this }); break;
      case "error": this.onerror({ error: "", message: "to do", type: "error", target: this }); break;
      case "open": this.onopen({ target: this }); break;
    }
    return true;
  }

  send(data, _callback) {
    this.#sendMessage(data, false);
  }

  addReceiveHook(hook) { this.#receiveHooks.push(hook); }
  removeReceiveHook(hook) { this.#receiveHooks = this.#receiveHooks.filter((h) => h !== hook); }
  addSendHook(hook) { this.#sendHooks.push(hook); }
  removeSendHook(hook) { this.#sendHooks = this.#sendHooks.filter((h) => h !== hook); }

  #generateChannel(connection, channel, ctor) {
    const result = ctor();
    result.connect(formConnectionString(connection, channel));
    this.#processSocketMessages(channel, result).catch((ex) =>
      this.#log.error(`Failed to read messages from channel ${channel}`, ex),
    );
    return result;
  }

  async #processSocketMessages(channel, readable) {
    for await (const msg of readable) {
      if (this.#closed) break;
      this.#onIncomingMessage(channel, msg);
    }
  }

  #generateChannels(connection) {
    const zmq = this.#zmq;
    const routingId = crypto.randomUUID();
    const result = {
      iopub: this.#generateChannel(
        connection,
        "iopub",
        () => new zmq.Subscriber({ maxMessageSize: -1, receiveHighWaterMark: 0 }),
      ),
      shell: this.#generateChannel(
        connection,
        "shell",
        () => new zmq.Dealer({ routingId, sendHighWaterMark: 0, receiveHighWaterMark: 0, maxMessageSize: -1 }),
      ),
      control: this.#generateChannel(
        connection,
        "control",
        () => new zmq.Dealer({ routingId, sendHighWaterMark: 0, receiveHighWaterMark: 0, maxMessageSize: -1 }),
      ),
      stdin: this.#generateChannel(
        connection,
        "stdin",
        () => new zmq.Dealer({ routingId, sendHighWaterMark: 0, receiveHighWaterMark: 0, maxMessageSize: -1 }),
      ),
    };
    // Subscribe to all iopub topics (status changes, stream, display_data, ...).
    result.iopub.subscribe();
    return result;
  }

  #onIncomingMessage(channel, data) {
    const message = this.#closed
      ? {}
      : wireProtocol.decode(data, this.#connection.key, this.#connection.signature_scheme);
    message.channel = channel;

    if (this.#receiveHooks.length) {
      this.#msgChain = this.#msgChain
        .then(() => {
          const serialized = this.#serialize(message);
          return Promise.all(this.#receiveHooks.map((hook) => hook(serialized)));
        })
        .then(() => this.#fireOnMessage(message, channel));
    } else {
      this.#msgChain = this.#msgChain.then(() => this.#fireOnMessage(message, channel));
    }
  }

  #fireOnMessage(message, channel) {
    if (this.#closed) return;
    try {
      ensureFields(message, channel);
      this.onmessage({ data: message, type: "message", target: this });
    } catch (ex) {
      this.#log.error(`Failed to handle message ${JSON.stringify(message)}`, ex);
    }
  }

  #sendMessage(msg, bypassHooking) {
    const data = wireProtocol.encode(msg, this.#connection.key, this.#connection.signature_scheme);

    if (!bypassHooking && this.#sendHooks.length) {
      const hookData = this.#serialize(msg);
      this.#sendChain = this.#sendChain
        .then(() => Promise.all(this.#sendHooks.map((hook) => hook(hookData, noop))))
        .then(async () => {
          try {
            await this.#postToSocket(msg.channel, data);
          } catch (ex) {
            this.#log.error(`Failed to write data to the kernel channel ${msg.channel}`, ex);
          }
        });
    } else {
      this.#sendChain = this.#sendChain.then(() => this.#postToSocket(msg.channel, data));
    }
    this.#sendChain.catch(noop);
  }

  #postToSocket(channel, data) {
    const socket = this.#channels[channel];
    if (!socket) {
      this.#log.error(`Attempting to send message on invalid channel: ${channel}`);
      return;
    }
    return socket.send(data).catch((ex) => this.#log.error("Error communicating with the kernel", ex));
  }
}
