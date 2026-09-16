import { expect, test, vi } from '@voidzero-dev/vite-plus-test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
// @ts-ignore Node source module
import { createAgendaSourceWriter } from '../server/lib/agenda-source-writer.mjs';

const hash = (content: string) => createHash('sha256').update(content).digest('hex');
const file = '/fs:lab:/project/work.noema';
async function fixture() {
  let content = await readFile(resolve('poc/org-agenda/example.noema'), 'utf8');
  const original = JSON.parse(content);
  const writes: any[] = [];
  const transport = {
    owns: (path: string) => path.startsWith('/fs:'),
    read: async () => ({content,revision:hash(content)}),
    write: async (path: string, next: string, expected: string) => {
      if (expected !== hash(content)) throw Object.assign(new Error('Source changed externally'), {code:'ECONFLICT'});
      writes.push({path,expected}); content = next;
      return {revision:hash(content)};
    },
  };
  const native = {mutate:vi.fn(async () => ({native:true}))};
  const compute = vi.fn();
  const writer = createAgendaSourceWriter({transport,native,compute});
  return {writer, native, compute, writes, original, transport,
    content: () => content,
    replace: (next: string) => {content = next;},
    todo: () => ({file,sourceKind:'work-node',workNodeId:'wn_proof',sourceRef:{revision:hash(content)}}),
  };
}

test('routed WorkNode completion preserves prompts, outputs and DAG and returns the saved revision', async () => {
  const {writer, content, original, writes, todo, compute} = await fixture();
  const result = await writer.mutate(todo(), {op:'complete'});
  const saved = JSON.parse(content());
  expect(saved.cells.map((cell: any) => cell.metadata)).toEqual(original.cells.map((cell: any) => cell.metadata));
  expect(saved.cells.find((cell: any) => cell.id === 'cell_proof').source).toContain('done:');
  expect(saved.cells.find((cell: any) => cell.id === 'cell_proof').source).toContain('Research prompt; no scheduling control is sent to the agent.');
  expect(saved.metadata.noema_research.dependencies).toEqual(original.metadata.noema_research.dependencies);
  expect(saved.metadata.noema_research.work_nodes.find((node: any) => node.id === 'wn_proof').state).toBe('done');
  expect(result.contentRevision).toBe(hash(content()));
  expect(result.content).toBeUndefined();
  expect(writes).toHaveLength(1);
  expect(compute).not.toHaveBeenCalled();
});

test('stale read and a competing external write are both rejected without overwriting the source', async () => {
  const f = await fixture();
  const stale = f.todo();
  f.replace(f.content() + '\n');
  await expect(f.writer.mutate(stale, {op:'complete'})).rejects.toThrow('refresh');
  expect(f.writes).toEqual([]);
  const current = f.todo();
  const read = f.transport.read;
  f.transport.read = async () => {
    const snapshot = await read();
    f.replace(f.content() + '\n');
    return snapshot;
  };
  await expect(f.writer.mutate(current, {op:'complete'})).rejects.toMatchObject({code:'ECONFLICT'});
  expect(f.writes).toEqual([]);
  expect(JSON.parse(f.content()).metadata.noema_research.work_nodes).toEqual(f.original.metadata.noema_research.work_nodes);
});

test('concurrent updates using one revision serialize and only the first can write', async () => {
  const f = await fixture();
  const todo = f.todo();
  const results = await Promise.allSettled([
    f.writer.mutate(todo, {progress:25}), f.writer.mutate(todo, {progress:50}),
  ]);
  expect(results.map((result) => result.status)).toEqual(['fulfilled','rejected']);
  expect(f.writes).toHaveLength(1);
  expect(JSON.parse(f.content()).cells.find((cell: any) => cell.id === 'cell_proof').source).toContain('progress: 25');
});

test('client placement continues to use the existing native storage provider', async () => {
  const f = await fixture();
  const todo = {...f.todo(),file:'/native/work.noema'};
  expect(await f.writer.mutate(todo, {op:'complete'})).toEqual({native:true});
  expect(f.native.mutate).toHaveBeenCalledWith(todo, {op:'complete'});
  expect(f.writes).toEqual([]);
});
