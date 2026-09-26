// A single-client, loopback DAP adapter over the kernel's control channel.
// Dape owns the UI. Notebook code continues through the normal execution /
// output writer; debug requests never queue behind that execution on shell.
import net from 'node:net';
import { basename } from 'node:path';

export function supportsNotebookDebug(info) {
  return info?.debugger === true || info?.supported_features?.includes('debugger') === true;
}

export async function debugRequest(kernel, content, timeoutMs = 15000) {
  const future = kernel.requestDebug(content);
  let timer;
  try {
    const reply = await Promise.race([future.done,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Debugger timed out: ${content.command}`)), timeoutMs); }),
    ]);
    const result = reply?.content;
    if (!result || typeof result.success !== 'boolean') throw new Error(`Invalid debug_reply: ${content.command}`);
    return result;
  } finally { clearTimeout(timer); future.dispose?.(); }
}

export class NotebookDebugSources {
  constructor(file, cells, activeId) {
    this.file = file;
    this.cells = cells.map(cell => ({ ...cell, endLine: cell.line + cell.code.split('\n').length - 1 }));
    this.activeId = activeId;
    this.external = new Map();
    this.references = new Map();
  }
  byPath(path) {
    return this.cells.find(cell => cell.path === path && cell.id === this.activeId)
      || this.cells.find(cell => cell.path === path);
  }
  byLine(line) { return this.cells.find(cell => line >= cell.line && line <= cell.endLine); }
  source(source) {
    if (!source?.path) return source;
    if (this.byPath(source.path)) return { ...source, path: this.file, name: basename(this.file), sourceReference: 0 };
    // A module on a remote kernel is not a same-named client file. Ask DAP
    // for its contents and let Dape display a source buffer by reference.
    let reference = this.external.get(source.path);
    if (!reference) {
      reference = 1000000 + this.external.size;
      this.external.set(source.path, reference);
      this.references.set(reference, { ...source });
    }
    return { ...source, sourceReference: reference };
  }
  location(value) {
    if (!value?.source) return value;
    const cell = this.byPath(value.source.path);
    const result = { ...value, source: this.source(value.source) };
    if (cell) for (const key of ['line', 'endLine']) {
      if (Number.isInteger(result[key]) && result[key] > 0) result[key] += cell.line - 1;
    }
    return result;
  }
  incomingSource(source) {
    return this.references.get(source?.sourceReference) || source;
  }
  response(command, body = {}) {
    if (command === 'stackTrace') return { ...body, stackFrames: body.stackFrames?.map(frame => this.location(frame)) };
    if (command === 'loadedSources') return { ...body, sources: body.sources?.map(source => this.source(source)) };
    if (command === 'scopes') return { ...body, scopes: body.scopes?.map(scope => this.location(scope)) };
    return body;
  }
}

/** Create a DAP endpoint for one notebook run, without owning the kernel. */
export async function createNotebookDebugAdapter({ kernel, info, sourceFile, cells, cellId,
  runByLine = false, execute, interrupt, onClose = () => {}, timeoutMs = 15000,
  connectTimeoutMs = 60000 }) {
  if (!supportsNotebookDebug(info)) throw new Error('This kernel does not advertise notebook debugging support');
  if (!cells.some(cell => cell.id === cellId && cell.code.trim())) throw new Error('Select a nonempty code cell to debug');
  let requestSeq = 0, outputSeq = 0, socket, closed = false, closing = false;
  let attached = false, configured = false, executing = false, temporaryEntry = runByLine;
  let connectTimer, finishPromise, execution;
  const sources = new NotebookDebugSources(sourceFile, cells, cellId);
  const wantedBreakpoints = new Map();
  const ask = (command, args = {}) => debugRequest(kernel,
    { seq: ++requestSeq, type: 'request', command, arguments: args }, timeoutMs);
  const requireSuccess = reply => {
    if (!reply.success) throw new Error(reply.message || `Debugger refused ${reply.command}`);
    return reply.body || {};
  };
  const state = requireSuccess(await ask('debugInfo'));
  if (state.isStarted) throw new Error('This kernel already has an active debugger; disconnect it before starting another');
  const write = message => {
    if (!socket || socket.destroyed || closed) return;
    const bytes = Buffer.from(JSON.stringify({ ...message, seq: ++outputSeq }));
    socket.write(Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]));
  };
  const event = (name, body = {}) => write({ type: 'event', event: name, body });
  const respond = (request, reply) => write({ ...reply, type: 'response', request_seq: request.seq, command: request.command });
  async function applyCellBreakpoints(path) {
    const breakpoints = [...(wantedBreakpoints.get(path) || [])];
    const entry = sources.cells.find(cell => cell.id === cellId);
    if (temporaryEntry && path === entry.path && !breakpoints.some(bp => bp.line === 1)) breakpoints.push({ line: 1 });
    return requireSuccess(await ask('setBreakpoints', { source: { path }, breakpoints, sourceModified: false }));
  }
  async function setNotebookBreakpoints(args) {
    const requested = args.breakpoints || (args.lines || []).map(line => ({ line }));
    const groups = new Map(sources.cells.map(cell => [cell.path, []]));
    const mapped = requested.map(bp => {
      const cell = sources.byLine(bp.line);
      if (!cell) return { verified: false, line: bp.line, message: 'Breakpoints require a code-cell line' };
      const group = groups.get(cell.path);
      const index = group.length;
      group.push({ ...bp, line: bp.line - cell.line + 1 });
      return { cell, index };
    });
    const replies = new Map();
    for (const [path, breakpoints] of groups) {
      wantedBreakpoints.set(path, breakpoints);
      replies.set(path, await applyCellBreakpoints(path));
    }
    return { breakpoints: mapped.map((item, index) => {
      if (!item.cell) return item;
      const bp = replies.get(item.cell.path).breakpoints?.[item.index] || { verified: false };
      return sources.location({ line: requested[index].line - item.cell.line + 1,
        ...bp, source: { path: item.cell.path } });
    }) };
  }
  function finish({ stop = false } = {}) {
    if (closed || closing) return finishPromise;
    closing = true;
    finishPromise = (async () => {
      clearTimeout(connectTimer);
      // Closing Dape must not shut down an adopted or owned notebook kernel.
      if (stop && executing) await Promise.resolve(interrupt?.()).catch(() => {});
      if (attached) await ask('disconnect', { restart: false, terminateDebuggee: false }).catch(() => {});
      // Execution also persists outputs. Do not unlock the editor before that
      // write finishes, or the next source save races the final output update.
      if (execution) {
        let settleTimer;
        try {
          await Promise.race([execution, new Promise(resolve => {
            settleTimer = setTimeout(resolve, timeoutMs);
          })]);
        } finally { clearTimeout(settleTimer); }
      }
      event('terminated');
      closed = true;
      kernel.iopubMessage.disconnect(onIOPub);
      kernel.statusChanged?.disconnect(onStatus);
      kernel.connectionStatusChanged?.disconnect(onConnection);
      server.close();
      socket?.end();
      onClose();
    })();
    return finishPromise;
  }
  function onStatus(_sender, status) {
    if (status === 'dead' || status === 'restarting' || status === 'autorestarting') void finish();
  }
  function onConnection(_sender, status) {
    if (status === 'disconnected') void finish();
  }
  function onIOPub(_sender, msg) {
    if (msg?.header?.msg_type !== 'debug_event' || closed) return;
    const content = msg.content || {};
    if (content.event === 'terminated') { void finish(); return; }
    if (content.event === 'stopped' && temporaryEntry) {
      temporaryEntry = false;
      const entry = sources.cells.find(cell => cell.id === cellId);
      void applyCellBreakpoints(entry.path).catch(() => {});
    }
    let body = content.body || {};
    if (content.event === 'breakpoint' && body.breakpoint) body = { ...body, breakpoint: sources.location(body.breakpoint) };
    else body = sources.location(body);
    event(content.event, body);
  }
  async function handle(request) {
    if (closed || request?.type !== 'request' || !Number.isInteger(request.seq)) return;
    const command = request.command;
    let args = request.arguments || {};
    try {
      if (command === 'disconnect' || command === 'terminate') {
        respond(request, { success: true });
        await finish({ stop: true }); return;
      }
      if (command === 'restart') throw new Error('Stop debugging before restarting the notebook kernel');
      if (command === 'setBreakpoints' && args.source?.path === sourceFile) {
        respond(request, { success: true, body: await setNotebookBreakpoints(args) }); return;
      }
      if (args.source) args = { ...args, source: sources.incomingSource(args.source) };
      if (command === 'source' && sources.references.has(args.sourceReference)) {
        const original = sources.references.get(args.sourceReference);
        args = { ...args, source: original, sourceReference: original.sourceReference || 0 };
      }
      if (command === 'attach') { args = { ...args, justMyCode: args.justMyCode !== false }; attached = true; }
      // Always install Run by Line's entry stop, even with no user breakpoints.
      if (command === 'configurationDone' && temporaryEntry) {
        await applyCellBreakpoints(sources.cells.find(cell => cell.id === cellId).path);
      }
      const reply = await ask(command, args);
      let body = sources.response(command, reply.body);
      if (command === 'initialize' && reply.success) {
        attached = true;
        // ipykernel accepts dumpCell only after initialize has started its
        // debugger. Finish registration before Dape can configure breakpoints.
        for (const cell of sources.cells) {
          const dumped = requireSuccess(await ask('dumpCell', { code: cell.code }));
          if (typeof dumped.sourcePath !== 'string' || !dumped.sourcePath) throw new Error('Debugger did not return a cell source path');
          cell.path = dumped.sourcePath;
        }
        body = { ...body, supportsRestartRequest: false, supportsTerminateRequest: true };
      }
      respond(request, { ...reply, body });
      if (command === 'configurationDone' && reply.success && !configured) {
        configured = true; executing = true;
        execution = Promise.resolve().then(execute).catch(err => {
          event('output', { category: 'stderr', output: `${err.message || err}\n` });
        });
        execution.finally(() => { executing = false; void finish(); });
      }
    } catch (err) { respond(request, { success: false, message: String(err.message || err) }); }
  }
  const server = net.createServer(client => {
    if (socket || closed) { client.destroy(); return; }
    socket = client;
    clearTimeout(connectTimer);
    server.close(); // One Emacs debugger owns this adapter.
    let buffer = Buffer.alloc(0);
    client.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16 * 1024 * 1024) { client.destroy(); return; }
      while (true) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) break;
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(buffer.subarray(0, end).toString('ascii'));
        const length = Number(match?.[1]);
        if (!Number.isSafeInteger(length) || length < 1 || length > 16 * 1024 * 1024) { client.destroy(); return; }
        if (buffer.length < end + 4 + length) break;
        const bytes = buffer.subarray(end + 4, end + 4 + length);
        buffer = buffer.subarray(end + 4 + length);
        try { void handle(JSON.parse(bytes.toString('utf8'))); }
        catch { client.destroy(); return; }
      }
    });
    client.on('error', () => { void finish({ stop: true }); });
    client.on('close', () => { void finish({ stop: true }); });
  });
  kernel.iopubMessage.connect(onIOPub);
  kernel.statusChanged?.connect(onStatus);
  kernel.connectionStatusChanged?.connect(onConnection);
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  connectTimer = setTimeout(() => { void finish(); }, connectTimeoutMs);
  connectTimer.unref?.();
  return { host: '127.0.0.1', port: server.address().port, sourceFile, cellId,
    close: () => finish({ stop: true }), sources };
}
