import { describe, expect, test } from '@voidzero-dev/vite-plus-test';
import { createContentsFiles, jupyterContentsLocation } from '../server/jupyter/contents-files.mjs';

function fixture() {
  const store = new Map<string, any>([['', { type: 'directory' }]]);
  let offline = false;
  const manager = {
    async get(path: string, options: any) {
      if (offline) throw { response: { status: 503 }, code: 'ERR_NETWORK', message: 'http://secret/?token=private' };
      const model = store.get(path);
      if (!model) throw { response: { status: 404 } };
      return { path, name: path.split('/').at(-1), writable: true, created: '2026-09-26T00:00:00Z',
        last_modified: '2026-09-26T00:00:01Z', ...model,
        ...(options.content && model.type === 'directory'
          ? { content: [...store].filter(([key]) => key && key.startsWith(path ? path + '/' : '')
            && !key.slice(path ? path.length + 1 : 0).includes('/')).map(([key, v]) => ({ path: key, ...v })) } : {}),
      };
    },
    async save(path: string, model: any) { store.set(path, model); return await this.get(path, {}); },
    async delete(path: string) { store.delete(path); },
    async rename(from: string, to: string) { store.set(to, store.get(from)); store.delete(from); },
  };
  const files = createContentsFiles({ servers: { async contents(id: string) { expect(id).toBe('Lab'); return manager; } } });
  return { files, store, offline: () => { offline = true; }, root: '/fs:jupyter.4c6162:/' };
}

describe('Jupyter Contents filesystem', () => {
  test('decodes server identity without confusing HTTP prefix with filesystem path', () => {
    expect(jupyterContentsLocation('/fs:jupyter.4c6162:/folder/a.ipynb')).toEqual({ serverId: 'Lab', path: 'folder/a.ipynb' });
    expect(jupyterContentsLocation('/fs:cluster:/folder/a.ipynb')).toBeNull();
    expect(() => jupyterContentsLocation('/fs:jupyter.4c6162:/../a')).toThrow();
    expect(() => jupyterContentsLocation('/fs:jupyter.ff:/a')).toThrow();
  });
  test('preserves binary bytes, unicode names and notebook JSON', async () => {
    const { files, root } = fixture();
    const bytes = Buffer.from([0, 128, 255, 10]);
    await files.writeFile(root + '图片.bin', bytes);
    expect(await files.readFile(root + '图片.bin')).toEqual(bytes);
    const notebook = JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [
      { id: 'keep', cell_type: 'raw', source: 'λ', metadata: { custom: true } },
    ] });
    await files.writeFile(root + 'research.ipynb', notebook, 'utf8');
    expect(await files.readFile(root + 'research.ipynb', 'utf8')).toBe(notebook);
  });
  test('distinguishes missing files from auth/network errors and redacts errors', async () => {
    const { files, root, offline } = fixture();
    await expect(files.stat(root + 'missing')).rejects.toMatchObject({ code: 'ENOENT' });
    offline();
    await expect(files.stat(root + 'missing')).rejects.toMatchObject({ code: 'EIO' });
    await expect(files.stat(root + 'missing')).rejects.not.toThrow(/private/);
  });
  test('checks stale writes and overwrite policy before mutation', async () => {
    const { files, root } = fixture();
    await files.writeFile(root + 'source.txt', 'new', 'utf8');
    await files.writeFile(root + 'destination.txt', 'old', 'utf8');
    await expect(files.request({ serverId: 'Lab', operation: 'rename', path: 'source.txt', to: 'destination.txt' }))
      .rejects.toMatchObject({ code: 'EEXIST' });
    await expect(files.request({ serverId: 'Lab', operation: 'write', path: 'destination.txt', expectedModified: 'old', content: '' }))
      .rejects.toMatchObject({ code: 'ESTALE' });
    expect(await files.readFile(root + 'destination.txt', 'utf8')).toBe('old');
    await files.rename(root + 'source.txt', root + 'destination.txt');
    expect(await files.readFile(root + 'destination.txt', 'utf8')).toBe('new');
  });
  test('creates nested directories and guards root and nonrecursive deletes', async () => {
    const { files, root, store } = fixture();
    await files.mkdir(root + 'a/b', { recursive: true });
    expect(store.get('a').type).toBe('directory');
    await files.writeFile(root + 'a/b/note', 'text');
    await expect(files.rm(root + 'a')).rejects.toMatchObject({ code: 'ENOTEMPTY' });
    await expect(files.rm(root, { recursive: true })).rejects.toMatchObject({ code: 'EINVAL' });
    await files.rm(root + 'a', { recursive: true });
    expect(store.has('a/b/note')).toBe(false);
  });
});
