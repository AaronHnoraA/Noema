import {DatabaseSync} from 'node:sqlite';
import {chmodSync,mkdirSync} from 'node:fs';
import {dirname} from 'node:path';

/** Durable binding snapshots and bounded intent/inbox data, never documents. */
export function createAgendaAttentionStore(file=':memory:') {
  if(file!==':memory:') mkdirSync(dirname(file),{recursive:true,mode:0o700});
  const db=new DatabaseSync(file,{timeout:1000});
  let closed=false;
  if(file!==':memory:') chmodSync(file,0o600);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS agenda_attention (id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL)');
  db.prepare('INSERT OR IGNORE INTO agenda_attention VALUES(1,0,?)').run('[]');
  const select=db.prepare('SELECT revision,body FROM agenda_attention WHERE id=1');
  const update=db.prepare('UPDATE agenda_attention SET revision=revision+1,body=? WHERE id=1 AND revision=?');
  function validate(records) {
    if(!Array.isArray(records)||records.length>2048||new Set(records.map(r=>r.id)).size!==records.length
      ||records.some(r=>!r||typeof r.id!=='string'||!['reminder','event'].includes(r.kind)
        ||typeof r.ref?.file!=='string'||typeof r.ref?.root!=='string'||!r.ref.nativeId||!r.calendarId))
      throw new Error('Invalid Agenda attention journal');
    return records;
  }
  return {
    read(){const row=select.get();return {revision:row.revision,records:validate(JSON.parse(row.body))};},
    commit(state,records){
      const body=JSON.stringify(validate(records));
      if(Buffer.byteLength(body)>16*1024*1024)throw new Error('Attention journal exceeds 16 MiB');
      if(Number(update.run(body,state.revision).changes)!==1)throw new Error('Attention journal changed in another host; retry after refreshing');
      return {revision:state.revision+1,records:structuredClone(records)};
    },
    close(){if(!closed){closed=true;db.close();}},
  };
}
