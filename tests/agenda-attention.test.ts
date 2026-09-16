import {describe,expect,test} from '@voidzero-dev/vite-plus-test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
// @ts-ignore Node service
import {createAgendaAttention,mergeAttentionFields} from '../server/lib/agenda-attention.mjs';
// @ts-ignore Node store
import {createAgendaAttentionStore} from '../server/lib/agenda-attention-store.mjs';

const base={title:'证明',completed:false,priority:1,due:null,recurring:false};
async function fixture(run:(context:any)=>Promise<void>) {
  const directory=await mkdtemp(join(tmpdir(),'noema-attention-'));
  const file=join(directory,'state.sqlite');
  let active=true,revision=1,fields={...base},reads=0,writes=0,creates=0,dropAppleAck=false,dropSourceAck=false,repeat=false;
  let afterWrite:(()=>void)|undefined,sourceFailure:string|undefined,readFailure:string|undefined,appleFailure:string|undefined;
  const items=new Map(),instances:any[]=[],calls:any[]=[];
  const sources={
    active:()=>active,
    prepare:async()=>({ref:{file:'/fs:lab:/project/tasks.md',root:'/fs:lab:/project',nativeId:'#abc123'},options:{},snapshot:{fields,revision:String(revision),repeat}}),
    read:async()=>{if(!active)throw new Error('Inactive source was read');reads++;
      if(readFailure){const code=readFailure;readFailure=undefined;throw Object.assign(new Error('Source unavailable'),{code});}
      return {fields:{...fields},revision:String(revision),repeat};},
    write:async(_record:any,before:any,next:any)=>{
      if(!active)throw new Error('Inactive source was written');
      if(before.revision!==String(revision))throw new Error('Source changed');
      if(sourceFailure){const code=sourceFailure;sourceFailure=undefined;throw Object.assign(new Error('Source protected'),{code});}
      writes++;fields={...next};revision++;
      if(repeat&&next.completed)fields={...fields,completed:false,due:{date:'2026-09-18',timeZone:'floating'}} as any;
      if(dropSourceAck){dropSourceAck=false;throw new Error('Source acknowledgement lost');}
      const receipt={revision:String(revision)};
      const hook=afterWrite;afterWrite=undefined;hook?.();
      return receipt;
    },
  };
  const apple=async(body:any)=>{
    calls.push(body);
    if(body.op==='collections')return {collections:[{id:'selected',writable:true}]};
    const item=items.get(body.token);
    if(body.op==='get')return item||{missing:true,scopeLimited:true};
    if(body.op==='put'){
      if(appleFailure){const code=appleFailure;appleFailure=undefined;throw Object.assign(new Error('Apple write failed'),{code});}
      if(item&&JSON.stringify(item.fields)===JSON.stringify(body.fields))return item;
      if(item&&item.revision!==body.expectedRevision)throw Object.assign(new Error('Apple changed'),{code:'ECONFLICT'});
      if(!item&&!body.allowCreate)throw Object.assign(new Error('Unconfirmed create'),{code:'EUNCONFIRMED'});
      if(!item)creates++;
      const next={itemId:body.token,externalId:body.token,fields:{...body.fields},revision:String(Number(item?.revision||0)+1)};
      items.set(body.token,next);
      if(dropAppleAck){dropAppleAck=false;throw new Error('Apple acknowledgement lost');}
      return next;
    }
    if(body.op==='remove'){items.delete(body.token);return {removed:true};}
    throw new Error(body.op);
  };
  const open=()=>{const service=createAgendaAttention({store:createAgendaAttentionStore(file),sources,apple});instances.push(service);return service;};
  const c={open,items,calls,sources,fields:()=>fields,counts:()=>({reads,writes,creates}),
    active:(value:boolean)=>{active=value;},local:(patch:any)=>{fields={...fields,...patch};revision++;},
    remote:(id:string,patch:any)=>{const old=items.get(id);items.set(id,{...old,fields:{...old.fields,...patch},revision:String(Number(old.revision)+1)});},
    loseApple:()=>{dropAppleAck=true;},loseSource:()=>{dropSourceAck=true;},repeat:()=>{repeat=true;},
    afterWrite:(hook:()=>void)=>{afterWrite=hook;},failSource:(code:string)=>{sourceFailure=code;},failApple:(code:string)=>{appleFailure=code;},
    failRead:(code:string)=>{readFailure=code;},
    promote:(s:any)=>s.promote({kind:'reminder',calendarId:'selected'}),
  };
  try{await run(c);}finally{for(const instance of instances)await instance.close();await rm(directory,{recursive:true,force:true});}
}
describe('durable global attention',()=>{
  test('only explicit promotion creates a binding; lost create acknowledgement never duplicates it',()=>fixture(async(c:any)=>{
    const s=c.open();await s.sync();expect(c.calls).toEqual([]);
    c.loseApple();const r=await c.promote(s);expect(r.status).toBe('error');
    expect(c.counts().creates).toBe(1);
    const restarted=c.open();await restarted.sync();
    expect(restarted.list().items[0].status).toBe('synced');expect(c.counts().creates).toBe(1);
    await c.promote(restarted);expect(restarted.list().items).toHaveLength(1);expect(c.counts().creates).toBe(1);
  }));
  test('inactive phone completion survives restart without any source IO, then applies on entry',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);c.active(false);
    const before=c.counts();c.remote(r.id,{completed:true});await s.sync();
    expect(c.counts().reads).toBe(before.reads);expect(c.counts().writes).toBe(0);
    expect(s.list().items[0].status).toBe('pending-source');
    const restarted=c.open();await restarted.sync();expect(c.counts().reads).toBe(before.reads);
    c.active(true);await restarted.sync({fetchApple:false});
    expect(c.fields().completed).toBe(true);expect(c.counts().writes).toBe(1);
    expect(restarted.list().items[0].status).toBe('synced');
  }));
  test('merges disjoint fields, retains same-field conflicts and resolves from current source',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);
    c.local({title:'本地标题'});c.remote(r.id,{completed:true});await s.sync();
    expect(c.fields()).toMatchObject({title:'本地标题',completed:true});
    expect(c.items.get(r.id).fields.title).toBe('本地标题');
    c.local({title:'本地新标题'});c.remote(r.id,{title:'手机标题'});await s.sync();
    expect(s.list().items[0]).toMatchObject({status:'conflict',conflicts:['title']});
    expect(c.fields().title).toBe('本地新标题');
    await s.resolve({id:r.id,choice:'source'});expect(c.items.get(r.id).fields.title).toBe('本地新标题');
  }));
  test('lost source acknowledgement recognizes an applied state without repeating the write',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);c.remote(r.id,{completed:true});c.loseSource();await s.sync();
    expect(c.counts().writes).toBe(1);expect(s.list().items[0].pendingSource).toBeTruthy();
    const restarted=c.open();await restarted.sync();
    expect(c.counts().writes).toBe(1);expect(restarted.list().items[0].status).toBe('synced');
  }));
  test('recurrence advances in Noema once and mirrors the next occurrence to Apple',()=>fixture(async(c:any)=>{
    c.repeat();const s=c.open(),r=await c.promote(s);c.remote(r.id,{completed:true});await s.sync();await s.sync();
    expect(c.counts().writes).toBe(1);expect(c.items.get(r.id).fields).toMatchObject({completed:false,due:{date:'2026-09-18'}});
  }));
  test('uncertain recurring completion stays inspectable instead of advancing twice',()=>fixture(async(c:any)=>{
    c.repeat();const s=c.open(),r=await c.promote(s);c.remote(r.id,{completed:true});c.loseSource();await s.sync();
    await c.open().sync();expect(c.counts().writes).toBe(1);
    expect(s.list().items[0].errorCode).toBe('EUNCERTAIN');
  }));
  test('missing Apple item never deletes or recreates a source; forgetting only unlinks',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);c.items.delete(r.id);await s.sync();
    expect(s.list().items[0].status).toBe('missing');expect(c.counts().writes).toBe(0);
    expect(c.counts().creates).toBe(1);await s.remove({id:r.id,forget:true});expect(s.list().items).toEqual([]);
    expect(c.fields()).toEqual(base);
  }));
  test('separate baselines tolerate lossy priority projection without an echo write',()=>{
    expect(mergeAttentionFields({...base,priority:1},{...base,priority:2},{...base,priority:1},{...base,priority:2}))
      .toMatchObject({toSource:{priority:1},toApple:{priority:2},conflicts:[]});
  });

  test('an unacknowledged Apple push keeps local edits when a newer remote field invalidates the outbox',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);
    c.local({title:'本地标题'});c.remote(r.id,{completed:true});c.failApple('EIO');
    await s.sync();
    expect(s.list().items[0]).toMatchObject({status:'error',outbox:{fields:{title:'本地标题'}}});
    c.remote(r.id,{priority:5});await c.open().sync();
    expect(c.fields()).toMatchObject({title:'本地标题',completed:true,priority:5});
    expect(c.items.get(r.id).fields).toEqual(c.fields());
    expect(s.list().items[0]).toMatchObject({status:'synced',errorCode:null});
  }));

  test('a later source edit cannot be acknowledged as the result of an earlier write',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);c.remote(r.id,{completed:true});
    c.afterWrite(()=>c.local({title:'回执到达前的新标题'}));await s.sync();
    expect(s.list().items[0]).toMatchObject({status:'error',errorCode:'EUNCERTAIN',pendingSource:{phase:'written'}});
    expect(c.items.get(r.id).fields.title).toBe(base.title);
    await s.resolve({id:r.id,choice:'source'});
    expect(c.items.get(r.id).fields).toMatchObject({title:'回执到达前的新标题',completed:true});
    expect(c.counts().writes).toBe(1);
  }));

  test('pending source receipts survive exit even if Apple returns to its original fields',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);c.remote(r.id,{completed:true});
    c.afterWrite(()=>c.active(false));await s.sync();
    c.remote(r.id,{completed:false});const counts=c.counts();await s.sync();
    expect(c.counts()).toEqual(counts);expect(s.list().items[0].status).toBe('pending-source');
    const restarted=c.open();c.active(true);await restarted.sync();
    expect(c.fields().completed).toBe(false);expect(c.counts().writes).toBe(2);
    expect(restarted.list().items[0]).toMatchObject({status:'synced',pendingSource:null});
  }));

  test('reentry merges newer Apple changes while retaining a local field that still needs pushing',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);c.local({title:'本地标题'});c.remote(r.id,{completed:true});
    c.afterWrite(()=>c.active(false));await s.sync();
    c.remote(r.id,{priority:5});await s.sync();
    const restarted=c.open();c.active(true);await restarted.sync();
    expect(c.items.get(r.id).fields).toEqual(c.fields());
    expect(c.fields()).toMatchObject({title:'本地标题',completed:true,priority:5});
    expect(restarted.list().items[0].status).toBe('synced');
  }));

  test('known pre-write protection failures remerge the newest Apple fields on the next event',()=>fixture(async(c:any)=>{
    const s=c.open(),r=await c.promote(s);c.remote(r.id,{completed:true});c.failSource('ESOURCE');await s.sync();
    expect(c.counts().writes).toBe(0);expect(s.list().items[0].pendingSource.phase).toBe('prepared');
    c.remote(r.id,{completed:false,title:'更新后的手机标题'});await s.sync();
    expect(c.fields()).toMatchObject({completed:false,title:'更新后的手机标题'});
    expect(s.list().items[0]).toMatchObject({status:'synced',errorCode:null});
  }));

  test('a permission rejection can retry its recorded initial promotion without duplication',()=>fixture(async(c:any)=>{
    const s=c.open();c.failApple('EAUTH');await c.promote(s);
    expect(c.counts().creates).toBe(0);await s.sync();
    expect(c.counts().creates).toBe(1);expect(s.list().items[0].status).toBe('synced');
    await s.close();await s.close();
  }));

  test('a later read failure cannot turn an uncertain recurring write into a safe retry',()=>fixture(async(c:any)=>{
    c.repeat();const s=c.open(),r=await c.promote(s);c.remote(r.id,{completed:true});c.loseSource();await s.sync();
    c.failRead('ESOURCE');await s.sync();
    expect(s.list().items[0].pendingSource.phase).toBe('writing');
    await s.sync();expect(s.list().items[0].errorCode).toBe('EUNCERTAIN');expect(c.counts().writes).toBe(1);
  }));

  test('connection events expose saved receipts without IO or activating a source',()=>fixture(async(c:any)=>{
    const s=c.open();await c.promote(s);c.active(false);const count=c.counts(),calls=c.calls.length;
    s.connectionChanged({state:'unavailable',message:'Helper stopped'});
    expect(s.list().connection).toEqual({state:'unavailable',message:'Helper stopped'});
    expect(c.counts()).toEqual(count);expect(c.calls).toHaveLength(calls);
    await s.sync();expect(s.list().connection.state).toBe('connected');
  }));
});

test('two journal owners cannot overwrite a newer durable state',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'attention-cas-'));
  const first=createAgendaAttentionStore(join(directory,'state.sqlite'));
  const second=createAgendaAttentionStore(join(directory,'state.sqlite'));
  try {
    const stale=second.read();
    const record={id:'binding',kind:'reminder',calendarId:'selected',ref:{file:'/project/task.md',root:'/project',nativeId:'#task'}};
    first.commit(first.read(),[record]);
    expect(()=>second.commit(stale,[])).toThrow('another host');
    expect(second.read().records).toEqual([record]);
  }finally{first.close();second.close();await rm(directory,{recursive:true,force:true});}
});
