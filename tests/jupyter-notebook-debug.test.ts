import net from 'node:net';
import { once } from 'node:events';
import { describe, expect, test } from '@voidzero-dev/vite-plus-test';
import { createNotebookDebugAdapter, debugRequest, NotebookDebugSources, supportsNotebookDebug } from '../server/jupyter/notebook-debug.mjs';

class Signal {
  slots = new Set<Function>();
  connect(fn: Function) { this.slots.add(fn); }
  disconnect(fn: Function) { this.slots.delete(fn); }
  emit(value: unknown) { for (const fn of this.slots) fn(null, value); }
}
function kernelFixture() {
  const requests: any[] = [];
  const kernel = {
    iopubMessage: new Signal(), statusChanged: new Signal(), connectionStatusChanged: new Signal(),
    requestDebug(request: any) {
      requests.push(request);
      let body: any = {};
      switch (request.command) {
        case 'debugInfo': body = { isStarted: false }; break;
        case 'dumpCell': body = { sourcePath: '/kernel/' + Buffer.from(request.arguments.code).toString('hex') + '.py' }; break;
        case 'initialize': body = { supportsConfigurationDoneRequest: true, supportsConditionalBreakpoints: true }; break;
        case 'setBreakpoints': body = { breakpoints: request.arguments.breakpoints.map((bp: any, index: number) => ({ ...bp, id: index + 1, verified: true })) }; break;
        case 'source': body = { content: 'remote module source' }; break;
      }
      return { done: Promise.resolve({ content: { success: true, command: request.command, request_seq: request.seq, body } }), dispose() {} };
    },
  };
  return { kernel, requests };
}
async function client(port: number) {
  const socket = net.connect(port, '127.0.0.1');
  await once(socket, 'connect');
  const pending = new Map<number, { resolve: Function; reject: Function; timer: ReturnType<typeof setTimeout> }>();
  const events: any[] = [];
  let seq = 0, buffer = Buffer.alloc(0);
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, typeof chunk === 'string' ? Buffer.from(chunk) : chunk]);
    while (true) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const size = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, end).toString())?.[1]);
      if (buffer.length < end + 4 + size) return;
      const message = JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString());
      buffer = buffer.subarray(end + 4 + size);
      if (message.type === 'response') {
        const waiter = pending.get(message.request_seq);
        if (waiter) { clearTimeout(waiter.timer); pending.delete(message.request_seq); waiter.resolve(message); }
      } else events.push(message);
    }
  });
  return { socket, events,
    request(command: string, args: any = {}, fragmented = false): Promise<any> {
      const id = ++seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('DAP request timed out')); }, 2000);
        pending.set(id, { resolve, reject, timer });
        const data = Buffer.from(JSON.stringify({ type: 'request', seq: id, command, arguments: args }));
        const bytes = Buffer.concat([Buffer.from(`Content-Length: ${data.length}\r\n\r\n`), data]);
        if (fragmented) { socket.write(bytes.subarray(0, 8)); socket.write(bytes.subarray(8)); }
        else socket.write(bytes);
      });
    },
  };
}

describe('notebook DAP bridge', () => {
  test('requires the kernel to advertise debugging and bounds unsupported replies', async () => {
    expect(supportsNotebookDebug({})).toBe(false);
    expect(supportsNotebookDebug({ debugger: true })).toBe(true);
    expect(supportsNotebookDebug({ supported_features: ['debugger'] })).toBe(true);
    let disposed = false;
    await expect(debugRequest({ requestDebug() { return { done: new Promise(() => {}), dispose() { disposed = true; } }; } },
      { command: 'debugInfo' }, 5)).rejects.toThrow(/timed out/);
    expect(disposed).toBe(true);
  });
  test('maps notebook lines and requests remote modules by reference', () => {
    const sources = new NotebookDebugSources('/fs:lab:/book.ipynb', [
      { id: 'a', code: 'x = 1\nprint(x)', line: 8, path: '/kernel/a.py' },
    ], 'a');
    expect(sources.location({ source: { path: '/kernel/a.py' }, line: 2, endLine: 2 }))
      .toMatchObject({ source: { path: '/fs:lab:/book.ipynb', sourceReference: 0 }, line: 9, endLine: 9 });
    const module = sources.source({ path: '/home/remote/pkg.py' });
    expect(module.sourceReference).toBeGreaterThan(0);
    expect(sources.incomingSource(module)).toEqual({ path: '/home/remote/pkg.py' });
  });
  test('routes conditional breakpoints, preserves order and rejects Markdown lines', async () => {
    const { kernel, requests } = kernelFixture();
    const adapter = await createNotebookDebugAdapter({ kernel, info: { debugger: true }, sourceFile: '/fs:lab:/book.ipynb',
      cells: [{ id: 'a', code: 'x = 1\nx += 2', line: 3 }, { id: 'b', code: 'print(x)', line: 12 }], cellId: 'a', execute: async () => {} });
    const dap = await client(adapter.port);
    try {
      expect((await dap.request('initialize', {}, true)).success).toBe(true);
      const result = await dap.request('setBreakpoints', { source: { path: adapter.sourceFile }, breakpoints: [
        { line: 12, condition: 'x > 0' }, { line: 8 }, { line: 4, logMessage: '{x}' },
      ] });
      expect(result.body.breakpoints.map((bp: any) => [bp.line, bp.verified])).toEqual([[12, true], [8, false], [4, true]]);
      expect(requests.filter(r => r.command === 'setBreakpoints').map(r => r.arguments.breakpoints))
        .toEqual([[{ line: 2, logMessage: '{x}' }], [{ line: 1, condition: 'x > 0' }]]);
      const module = adapter.sources.source({ path: '/remote/pkg.py' });
      await dap.request('source', { source: module, sourceReference: module.sourceReference });
      expect(requests.at(-1).arguments).toMatchObject({ source: { path: '/remote/pkg.py' }, sourceReference: 0 });
    } finally { await adapter.close(); dap.socket.destroy(); }
  });
  test('Run by Line installs an entry stop without user breakpoints and detaches without terminating the kernel', async () => {
    const { kernel, requests } = kernelFixture();
    let started = false, interrupted = false, ended = false, resolveExecution!: () => void;
    const adapter = await createNotebookDebugAdapter({ kernel, info: { debugger: true }, sourceFile: '/book.ipynb',
      cells: [{ id: 'a', code: 'x = 1\nx += 1', line: 2 }], cellId: 'a', runByLine: true,
      execute: () => { started = true; return new Promise<void>(resolve => { resolveExecution = resolve; }); },
      interrupt: async () => { interrupted = true; }, onClose: () => { ended = true; } });
    const dap = await client(adapter.port);
    try {
      await dap.request('initialize'); await dap.request('attach'); await dap.request('configurationDone');
      expect(started).toBe(true);
      expect(requests.find(r => r.command === 'setBreakpoints').arguments.breakpoints).toEqual([{ line: 1 }]);
      kernel.iopubMessage.emit({ header: { msg_type: 'debug_event' }, content: { event: 'stopped', body: { threadId: 1 } } });
      await dap.request('threads');
      expect(requests.filter(r => r.command === 'setBreakpoints').at(-1).arguments.breakpoints).toEqual([]);
      const firstClose = adapter.close();
      await new Promise(resolve => setImmediate(resolve));
      expect(interrupted).toBe(true);
      expect(ended).toBe(false); // The output writer is still persisting.
      resolveExecution();
      // Shutdown racing a closed editor must await the same detach operation.
      await adapter.close();
      expect(interrupted).toBe(true); expect(ended).toBe(true);
      await firstClose;
      expect(requests.find(r => r.command === 'disconnect').arguments.terminateDebuggee).toBe(false);
      expect(kernel.iopubMessage.slots.size).toBe(0);
    } finally { await adapter.close(); dap.socket.destroy(); }
  });
});
