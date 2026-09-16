import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { listDocuments, readDocument } from './agenda-index.mjs';
import { startNoteWatcher } from './watch.mjs';

const inside = (root, file) => { const rel = relative(root, file); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const failure = (message, code = 'ECLOSED') => Object.assign(new Error(message), { code, statusCode: code === 'ENOENT' ? 404 : code === 'EACCES' ? 403 : 409 });

/** Explicit client/target IO boundary. Consumers never parse backend names. */
export function createAgendaSourceTransport({ request, excludePatterns = [], nativeWatch = startNoteWatcher } = {}) {
  const handles = new Map();
  const owns = (file) => /^\/fs:[^:]+:\//.test(String(file));
  async function rpc(body) {
    const result = await request('aaronnote.agenda.source', body);
    if (result?.error) throw failure(result.error.message, result.error.code);
    return result;
  }
  function owner(file) {
    const handle = [...handles.values()].filter((h) => h.active && inside(h.root, file)).sort((a,b) => b.root.length-a.root.length)[0];
    if (!handle) throw failure('Source scope is inactive');
    return handle;
  }
  function open(handle) {
    handle.lease = `source:${randomUUID()}`;
    handle.error = null;
    const lease = handle.lease;
    handle.ready = rpc({ op:'open', lease, root:handle.root, options: {
      hidden:false, extensions:['.md','.markdown','.noema'],
      exclude:['**/node_modules/**','**/vendor/**','**/build/**','**/dist/**','**/__pycache__/**',...excludePatterns],
    }}).then(() => {
      if (!handle.active || lease !== handle.lease) return rpc({op:'close',lease});
    });
    handle.ready.catch(() => {});
  }
  async function call(file, op, body = {}) {
    const handle = owner(file), lease = handle.lease;
    await handle.ready;
    if (!handle.active || handle.lease !== lease) throw failure('Source lease changed while waiting');
    if (handle.error) throw failure(handle.error);
    return rpc({ ...body, op, lease, path:relative(handle.root,file) });
  }
  return {
    owns,
    async canonicalRoot(file) {
      if (!owns(file)) return realpath(file);
      file = resolve(file);
      // Entry identity is logical. The source process validates the actual
      // target root before any discovery; canonical checks inside it are IO.
      if (!handles.has(file)) {
        let active;
        try { active = owner(file); } catch { return file; }
        if (active.root !== file) await call(file,'canonical');
      }
      return file;
    },
    async list(root, options) {
      if (!owns(root)) return listDocuments(root,options);
      options?.signal?.throwIfAborted();
      const result = await call(root,'list');
      options?.signal?.throwIfAborted();
      return result.files.map((file) => { const full=resolve(root,file); if (!inside(root,full)) throw failure('Source listing escaped root','EACCES'); return full; });
    },
    async read(file, options) {
      if (!owns(file)) return readDocument(file,options);
      options?.signal?.throwIfAborted();
      const result = await call(file,'read');
      options?.signal?.throwIfAborted();
      return result;
    },
    write(file, content, expectedRevision) { return call(file,'write',{content,expectedRevision}); },
    watch(options) {
      if (!owns(options.root)) return nativeWatch?.(options);
      const handle={...options,root:resolve(options.root),active:true};
      handles.set(handle.root,handle); open(handle);
      return { close() {
        if (!handle.active) return;
        handle.active=false; handles.delete(handle.root);
        rpc({op:'close',lease:handle.lease}).catch(()=>{});
      }};
    },
    event(body) {
      const handle=[...handles.values()].find((h)=>h.active && h.lease===body.lease);
      if (!handle) return;
      if (body.event==='changed') handle.onBatch((body.paths||[]).map((file)=>resolve(handle.root,file)).filter((file)=>inside(handle.root,file)));
      else {
        if (body.event==='error' || body.event==='disconnected') handle.error=body.message || 'Source process disconnected';
        if (body.event==='ready') handle.error=null;
        handle.onFullRescan();
      }
    },
    disconnected() { for (const handle of handles.values()) {handle.error='Emacs source gateway disconnected';handle.onFullRescan();} },
    reconnect() { for (const handle of handles.values()) {open(handle);handle.ready.then(()=>handle.active && handle.onFullRescan()).catch(()=>handle.onFullRescan());} },
  };
}
