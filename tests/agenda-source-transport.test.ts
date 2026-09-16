import { describe, expect, test } from '@voidzero-dev/vite-plus-test';
// @ts-ignore Node source module
import { createAgendaSourceTransport } from '../server/lib/agenda-source-transport.mjs';

const root = '/fs:research:/home/research/project';
const deferred = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise((done) => { resolve = done; });
  return {promise, resolve};
};
function fixture(requestOverride?: (body: any) => Promise<any>) {
  const calls: any[] = [], batches: any[] = [];
  let rescans = 0;
  const transport = createAgendaSourceTransport({
    excludePatterns: ['archive/**'],
    request: async (method: string, body: any) => {
      expect(method).toBe('aaronnote.agenda.source');
      calls.push(body);
      return requestOverride ? requestOverride(body) : body.op === 'list' ? {files:['task.md']} : {};
    },
  });
  const watch = () => transport.watch({root, onBatch: (paths: any) => batches.push(paths), onFullRescan: () => rescans++});
  return {transport, calls, batches, watch, rescans: () => rescans};
}

describe('Agenda routed source ownership', () => {
  test('entry is lazy; only an owned scope can list/read/write, with relative paths and filters', async () => {
    const {transport, calls, watch} = fixture();
    expect(await transport.canonicalRoot(root)).toBe(root);
    expect(calls).toEqual([]);
    await expect(transport.read(`${root}/task.md`)).rejects.toThrow('inactive');
    const handle = watch();
    expect(await transport.list(root)).toEqual([`${root}/task.md`]);
    expect(calls[0].options.hidden).toBe(false);
    expect(calls[0].options.exclude).toContain('archive/**');
    await transport.write(`${root}/task.md`, '新任务', 'revision');
    expect(calls.at(-1)).toMatchObject({op:'write',path:'task.md',content:'新任务',expectedRevision:'revision'});
    handle.close();
    const count = calls.length;
    await expect(transport.read(`${root}/task.md`)).rejects.toThrow('inactive');
    transport.reconnect(); handle.close();
    expect(calls.length).toBe(count);
  });

  test('closing while open is pending rejects the waiting read and releases late acknowledgement', async () => {
    const open = deferred();
    const {transport, calls, watch} = fixture(async (body) => body.op === 'open' ? open.promise : {});
    const handle = watch();
    const reading = transport.read(`${root}/task.md`);
    const rejected = expect(reading).rejects.toThrow('lease changed');
    handle.close(); open.resolve({}); await rejected;
    expect(calls.filter((call) => call.op === 'read')).toEqual([]);
    expect(calls.filter((call) => call.op === 'close').length).toBeGreaterThan(0);
  });

  test('gateway loss blocks IO and recovery replaces the lease, ignoring obsolete events', async () => {
    const {transport, calls, batches, watch, rescans} = fixture();
    const handle = watch(); await transport.list(root);
    const oldLease = calls[0].lease;
    transport.disconnected();
    const count = calls.length;
    await expect(transport.read(`${root}/task.md`)).rejects.toThrow('disconnected');
    expect(calls.length).toBe(count);
    transport.reconnect(); await transport.list(root);
    const lease = calls.findLast((call) => call.op === 'open').lease;
    expect(lease).not.toBe(oldLease);
    transport.event({lease:oldLease,event:'changed',paths:['old.md']});
    transport.event({lease,event:'changed',paths:['new.md','../escape.md']});
    expect(batches).toEqual([[`${root}/new.md`]]);
    expect(rescans()).toBeGreaterThan(0);
    handle.close();
    const closedRescans = rescans();
    transport.event({lease,event:'ready'});
    expect(rescans()).toBe(closedRescans);
  });

  test('rejects listings escaping the scope and preserves helper conflict errors', async () => {
    const {transport, watch} = fixture(async (body) => body.op === 'list'
      ? {files:['../escape.md']} : body.op === 'write'
        ? {error:{code:'ECONFLICT',message:'Source changed'}} : {});
    const handle = watch();
    await expect(transport.list(root)).rejects.toThrow('escaped root');
    await expect(transport.write(`${root}/task.md`, 'new', 'old')).rejects.toMatchObject({code:'ECONFLICT',statusCode:409});
    handle.close();
  });
});
