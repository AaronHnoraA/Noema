// Jupyter Contents is a filesystem in the server's API namespace, not an OS
// path. Its Remote target is jupyter.<UTF-8 server id hex>, shared with Emacs.

export function jupyterContentsLocation(file) {
  const match = /^\/fs:jupyter\.((?:[a-f0-9]{2})+):\/(.*)$/.exec(String(file || ''));
  if (!match) return null;
  const serverId = Buffer.from(match[1], 'hex').toString('utf8');
  if (Buffer.from(serverId).toString('hex') !== match[1]) throw fsError('EINVAL', 'Invalid server identity');
  return { serverId, path: contentsPath(match[2]) };
}
class ContentsFileError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fsError(code, message) { return new ContentsFileError(code, message); }
export function contentsPath(value) {
  const path = String(value ?? '').replace(/^\/+/, '');
  if (path.includes('\0') || path.includes('\\') || path.split('/').includes('..')) {
    throw fsError('EINVAL', 'Invalid Jupyter Contents path');
  }
  return path.split('/').filter(part => part && part !== '.').join('/');
}
function modelMetadata(model) {
  return { path: String(model.path || ''), name: String(model.name || ''), type: model.type,
    size: Number(model.size || 0), writable: Boolean(model.writable),
    lastModified: String(model.last_modified || ''), created: String(model.created || '') };
}
function normalizeError(err, path) {
  if (err instanceof ContentsFileError) return err;
  const status = Number(err?.response?.status || err?.statusCode || 0);
  const code = ({ 404: 'ENOENT', 401: 'EACCES', 403: 'EACCES', 409: 'EEXIST' })[status] || 'EIO';
  // Avoid copying request URLs/headers (which can carry credentials) into UI.
  return fsError(code, `Jupyter Contents ${status || 'request failure'}: ${path}`);
}

export function createContentsFiles({ servers }) {
  async function request(body) {
    const serverId = String(body.serverId || '');
    const path = contentsPath(body.path);
    if (!serverId || !servers) throw fsError('ENOTCONN', 'Jupyter server is unavailable');
    try {
      const manager = await servers.contents(serverId);
      const stat = async name => {
        try { return await manager.get(name, { content: false }); }
        catch (err) { throw normalizeError(err, name); }
      };
      switch (body.operation) {
        case 'stat': return { ok: true, model: modelMetadata(await stat(path)) };
        case 'list': {
          const model = await manager.get(path, { content: true });
          if (model.type !== 'directory') throw fsError('ENOTDIR', path);
          return { ok: true, model: modelMetadata(model), entries: (model.content || []).map(modelMetadata) };
        }
        case 'read': {
          const model = await manager.get(path, { content: true, type: 'file', format: 'base64' });
          if (model.format !== 'base64' || typeof model.content !== 'string') throw fsError('EIO', 'Expected base64 contents');
          return { ok: true, model: modelMetadata(model), content: model.content };
        }
        case 'write': {
          if (!path) throw fsError('EISDIR', 'Cannot write the Contents root');
          if (body.exclusive || body.expectedModified) {
            let existing;
            try { existing = await stat(path); } catch (err) { if (err.code !== 'ENOENT') throw err; }
            if (body.exclusive && existing) throw fsError('EEXIST', path);
            if (body.expectedModified && existing?.last_modified !== body.expectedModified) throw fsError('ESTALE', path);
          }
          const model = await manager.save(path, { type: 'file', format: 'base64', content: String(body.content || '') });
          return { ok: true, model: modelMetadata(model) };
        }
        case 'mkdir': {
          const paths = body.recursive
            ? path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/')) : [path];
          for (const name of paths) {
            try {
              const model = await stat(name);
              if (model.type !== 'directory') throw fsError('ENOTDIR', name);
              if (!body.recursive && name) throw fsError('EEXIST', name);
            } catch (err) {
              if (err.code !== 'ENOENT') throw err;
              await manager.save(name, { type: 'directory' });
            }
          }
          return { ok: true };
        }
        case 'rename': {
          const to = contentsPath(body.to);
          if (!path || !to) throw fsError('EINVAL', 'Cannot rename the Contents root');
          if (path === to) return { ok: true };
          let destination;
          try { destination = await stat(to); } catch (err) { if (err.code !== 'ENOENT') throw err; }
          if (destination) {
            if (!body.overwrite) throw fsError('EEXIST', to);
            if (destination.type === 'directory') throw fsError('EISDIR', to);
            // Contents PATCH does not provide POSIX replace semantics. Save
            // first, then remove the source; never delete the destination first.
            const source = await manager.get(path, { content: true, type: 'file', format: 'base64' });
            await manager.save(to, { type: 'file', format: 'base64', content: source.content });
            await manager.delete(path);
          } else await manager.rename(path, to);
          return { ok: true };
        }
        case 'delete': {
          if (!path) throw fsError('EINVAL', 'Cannot delete the Contents root');
          const remove = async name => {
            const model = await manager.get(name, { content: true });
            if (model.type === 'directory' && model.content?.length) {
              if (!body.recursive) throw fsError('ENOTEMPTY', name);
              for (const child of model.content) await remove(contentsPath(child.path));
            }
            await manager.delete(name);
          };
          try { await remove(path); } catch (err) {
            const normalized = normalizeError(err, path);
            if (!(body.force && normalized.code === 'ENOENT')) throw normalized;
          }
          return { ok: true };
        }
        default: throw fsError('ENOTSUP', 'Unsupported Contents operation');
      }
    } catch (err) { throw normalizeError(err, path); }
  }
  const locate = file => jupyterContentsLocation(file) || (() => { throw fsError('EINVAL', 'Not a Contents file'); })();
  return {
    request,
    async readFile(file, encoding) {
      const reply = await request({ ...locate(file), operation: 'read' });
      const bytes = Buffer.from(reply.content, 'base64');
      return encoding ? bytes.toString(encoding) : bytes;
    },
    async writeFile(file, data, encoding) {
      return await request({ ...locate(file), operation: 'write', content: Buffer.from(data, encoding).toString('base64') });
    },
    async stat(file) {
      const { model } = await request({ ...locate(file), operation: 'stat' });
      return { size: model.size, mtimeMs: Date.parse(model.lastModified), mtime: new Date(model.lastModified),
        isDirectory: () => model.type === 'directory', isFile: () => model.type !== 'directory' };
    },
    async mkdir(file, options = {}) { return await request({ ...locate(file), operation: 'mkdir', recursive: options.recursive }); },
    async rm(file, options = {}) { return await request({ ...locate(file), operation: 'delete', ...options }); },
    async rename(from, to) {
      const source = locate(from); const destination = locate(to);
      if (source.serverId !== destination.serverId) throw fsError('EXDEV', 'Cross-server rename');
      return await request({ ...source, operation: 'rename', to: destination.path, overwrite: true });
    },
  };
}
