import {randomUUID} from 'node:crypto';

const ordered=(value)=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,ordered(value[key])])):value;
export const attentionEqual=(a,b)=>JSON.stringify(ordered(a))===JSON.stringify(ordered(b));
const failure=(message,code='ECONFLICT')=>Object.assign(new Error(message),{code,statusCode:409});

/** Compare each side with its own baseline: projection can be lossy (priority
 * groups, whitespace). Acknowledging one side must not rewrite the other. */
export function mergeAttentionFields(sourceBase,appleBase,source,apple) {
  const toSource={...source},toApple={...apple},conflicts=[];
  for(const key of new Set([...Object.keys(source),...Object.keys(apple)])) {
    const local=!attentionEqual(source[key],sourceBase[key]);
    const remote=!attentionEqual(apple[key],appleBase[key]);
    if(local&&remote&&!attentionEqual(source[key],apple[key]))conflicts.push(key);
    else if(local)toApple[key]=source[key];
    else if(remote)toSource[key]=apple[key];
  }
  return {toSource,toApple,conflicts};
}

/** Explicit promotion + event-driven reconciliation. `sources.active` is a
 * memory-only ownership check; no inactive source may reach read or write. */
export function createAgendaAttention({store,sources,apple,onChange=()=>{},now=Date.now}) {
  let state=store.read(),queue=Promise.resolve(),closing=null,closed=false,signalPending=false,signalApple=false,signalDirty=false;
  const signalFiles=new Set();
  let connection={state:'unknown',message:'Apple connection has not been checked'};
  function connectionChanged(next) {
    if(closed||attentionEqual(connection,next))return;
    connection={...next};onChange({connection,files:[]});
  }
  const run=(fn)=>{const task=queue.then(async()=>{if(closed)throw failure('Attention service closed');state=store.read();return fn();});queue=task.catch(()=>{});return task;};
  const current=(id)=>state.records.find(r=>r.id===id);
  function put(record) {
    const old=current(record.id);
    if(attentionEqual(old,record))return record;
    state=store.commit(state,old?state.records.map(r=>r.id===record.id?record:r):[...state.records,record]);
    onChange({attentionRevision:state.revision,files:[]});return record;
  }
  const replace=(r,fields)=>put({...r,...(fields.status&&!Object.hasOwn(fields,'errorCode')?{errorCode:null}:{}),...fields});
  const ref=(r)=>({kind:r.kind,calendarId:r.calendarId,token:r.id,itemId:r.latest?.itemId||r.appleBase?.itemId,
    externalId:r.latest?.externalId||r.appleBase?.externalId,window:r.window});
  async function request(body) {
    let response;
    try {response=await apple(body);}
    catch(error){connectionChanged({state:'unavailable',message:String(error.message||error)});throw error;}
    connectionChanged(response?.error?.code==='EDISABLED'
      ?{state:'unavailable',message:response.error.message}:{state:'connected',message:''});
    if(response?.error)throw failure(response.error.message,response.error.code);
    return response;
  }
  function outgoing(record,fields,sourceSnapshot,op='put') {
    return replace(record,{outbox:{id:randomUUID(),op,fields,sourceSnapshot,expectedRevision:record.latest?.revision??null,
      create:!record.appleBase,attempted:false},status:'pending-apple',message:'',conflicts:[]});
  }
  async function deliver(record) {
    const intent=record.outbox;
    if(!intent)return record;
    let reply;
    if(intent.attempted&&intent.create) {
      reply=await request({...ref(record),op:'get'});
      if(reply.missing)throw failure('Creation is unconfirmed; inspect Apple before explicitly creating another item','EUNCONFIRMED');
      // The token proves identity even if Apple was edited after creation.
      return replace(record,{outbox:null,appleBase:{...reply,fields:intent.fields},latest:reply,
        sourceBase:intent.sourceSnapshot,status:'pending-source',message:''});
    }
    record=replace(record,{outbox:{...intent,attempted:true}}); // Commit before side effect.
    reply=await request({...ref(record),op:intent.op,fields:intent.fields,expectedRevision:intent.expectedRevision,
      allowCreate:intent.create&&!intent.attempted,mutationId:intent.id});
    if(intent.op==='remove') {
      if(!reply.removed)throw failure('Apple absence is limited to the selected collection; inspect before forgetting this binding','EMISSING');
      return replace(record,{outbox:null,tombstone:true,status:'unlinked',message:'',removedAt:now()});
    }
    return replace(record,{outbox:null,sourceBase:intent.sourceSnapshot,appleBase:reply,latest:reply,status:'synced',message:'',conflicts:[]});
  }
  async function completeSource(record,snapshot) {
    const intent=record.pendingSource;
    let toApple=intent.toApple;
    // Noema advances recurring Markdown. Apple mirrors the resulting current
    // occurrence; it must not remain completed and trigger another advance.
    if(snapshot.repeat&&intent.fields.completed===true) {
      toApple={...toApple,completed:snapshot.fields.completed,due:snapshot.fields.due};
    }
    // A source receipt acknowledges the pull only. Fields still awaiting an
    // Apple write must retain their earlier source baseline, including when
    // another Apple edit invalidates that pending write's revision.
    const acknowledged={...snapshot,fields:{...snapshot.fields}};
    for(const key of new Set([...Object.keys(toApple),...Object.keys(intent.appleSnapshot.fields)])) {
      if(!attentionEqual(toApple[key],intent.appleSnapshot.fields[key]))acknowledged.fields[key]=record.sourceBase.fields[key];
    }
    record=replace(record,{pendingSource:null,sourceBase:acknowledged,appleBase:intent.appleSnapshot,
      latest:record.latest||intent.appleSnapshot,status:'synced',message:'',conflicts:[]});
    if(!attentionEqual(toApple,intent.appleSnapshot.fields)) {
      // A newer Apple observation must be reconciled before overwriting it.
      if(record.latest.revision!==intent.appleSnapshot.revision)return reconcile(record,{fetchApple:false});
      record=outgoing(record,toApple,snapshot);
      record=await deliver(record);
    }
    return record.latest.revision!==record.appleBase.revision?reconcile(record,{fetchApple:false}):record;
  }
  async function reconcile(record,{fetchApple=true,retrySource=false}={}) {
    if(record.tombstone)return record;
    try {
      if(record.outbox&&!record.outbox.create&&record.outbox.op==='put') {
        const observed=await request({...ref(record),op:'get'});
        record=replace(record,{latest:observed});
        if(!observed.missing&&observed.revision!==record.outbox.expectedRevision&&!attentionEqual(observed.fields,record.outbox.fields)) {
          if(!sources.active(record.ref))throw failure('Apple changed while a source update was pending; enter the project to reconcile');
          record=replace(record,{outbox:null});
        }
      }
      if(record.outbox)record=await deliver(record);
      if(record.tombstone)return record;
      if(fetchApple||!record.latest)record=replace(record,{latest:await request({...ref(record),op:'get'})});
      if(record.latest.missing)return replace(record,{status:'missing',message:'Bound item was not found in its selected collection; source kept'});
      if(!sources.active(record.ref))return replace(record,{status:!record.pendingSource&&attentionEqual(record.latest.fields,record.appleBase?.fields)?'synced':'pending-source',message:''});
      const snapshot=await sources.read(record);
      if(!snapshot)throw failure('Source identity is missing or ambiguous; no source has been changed','ESOURCE');
      record=replace(record,{sourceCurrent:snapshot});
      if(record.pendingSource) {
        const intent=record.pendingSource;
        if(intent.phase==='written'&&intent.afterRevision&&snapshot.revision===intent.afterRevision)return await completeSource(record,snapshot);
        if(attentionEqual(snapshot.fields,intent.fields))return await completeSource(record,snapshot);
        if(intent.phase!=='prepared'&&(!retrySource||snapshot.revision!==intent.beforeRevision))throw failure('Source write is unconfirmed or changed; inspect before retrying','EUNCERTAIN');
        // A rejected write, or an explicitly retried unchanged source, must
        // merge the newest Apple observation rather than replay old fields.
        record=replace(record,{pendingSource:null});
      }
      const merged=mergeAttentionFields(record.sourceBase.fields,record.appleBase.fields,snapshot.fields,record.latest.fields);
      if(merged.conflicts.length)return replace(record,{status:'conflict',conflicts:merged.conflicts,message:'Both sides changed the same fields'});
      if(!attentionEqual(merged.toSource,snapshot.fields)) {
        const intent={id:randomUUID(),phase:'writing',beforeRevision:snapshot.revision,fields:merged.toSource,
          toApple:merged.toApple,appleSnapshot:record.latest};
        record=replace(record,{pendingSource:intent,status:'pending-source',message:''});
        if(!sources.active(record.ref))return record;
        let result;
        try {result=await sources.write(record,snapshot,merged.toSource);}
        catch(error) {
          // Only this adapter call can prove that source validation rejected
          // the write before dispatch. A later read failure proves no such thing.
          if(error.code==='ESOURCE')record=replace(record,{pendingSource:{...intent,phase:'prepared'}});
          throw error;
        }
        onChange({files:[record.ref.file]});
        record=replace(record,{pendingSource:{...intent,phase:'written',afterRevision:result?.revision||null}});
        if(!sources.active(record.ref))return record;
        const written=await sources.read(record);
        if(!written||!(result?.revision&&written.revision===result.revision)&&!attentionEqual(written.fields,intent.fields))
          throw failure('Source changed after the write; inspect its receipt before resolving','EUNCERTAIN');
        return await completeSource(record,written);
      }
      if(!attentionEqual(merged.toApple,record.latest.fields))return await deliver(outgoing(record,merged.toApple,snapshot));
      return replace(record,{sourceBase:snapshot,appleBase:record.latest,status:'synced',message:'',conflicts:[]});
    } catch(error) {
      record=current(record.id)||record;
      // These helper errors occur before any write; enable/reconfigure may
      // safely retry the original creation. Transport failures stay uncertain.
      if(record.outbox?.create&&['EDISABLED','EAUTH','EINVAL','ENOCALENDAR','EACCES'].includes(error.code))
        record={...record,outbox:{...record.outbox,attempted:false}};
      return replace(record,{status:error.code==='ECONFLICT'?'conflict':'error',message:String(error.message||error),errorCode:error.code||'EIO'});
    }
  }
  const api={
    connectionChanged,
    list(){const snapshot=store.read();return {revision:snapshot.revision,connection:{...connection},items:snapshot.records.filter(r=>!r.tombstone).map(r=>({
      ...r,active:sources.active(r.ref),fields:r.latest?.fields||r.outbox?.fields||r.sourceBase.fields}))};},
    async collections(kind){return {...await request({op:'collections',kind}),timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};},
    promote(body){return run(async()=>{
      if(!['reminder','event'].includes(body.kind)||typeof body.calendarId!=='string')throw failure('Choose a Reminder list or Calendar');
      const collections=await request({op:'collections',kind:body.kind});
      if(!collections.collections?.some(c=>c.id===body.calendarId&&c.writable))throw failure('Selected Apple collection is not writable');
      const prepared=await sources.prepare(body);
      const duplicate=state.records.find(r=>!r.tombstone&&r.kind===body.kind&&r.calendarId===body.calendarId
        &&r.ref.file===prepared.ref.file&&r.ref.nativeId===prepared.ref.nativeId);
      if(duplicate)return reconcile(duplicate);
      const record={id:randomUUID(),kind:body.kind,calendarId:body.calendarId,ref:prepared.ref,options:prepared.options,
        window:prepared.window,sourceBase:prepared.snapshot,appleBase:null,latest:null,createdAt:now(),status:'pending-apple'};
      return reconcile(outgoing(put(record),prepared.snapshot.fields,prepared.snapshot));
    });},
    sync({files,fetchApple=true,retrySource=false,id}={}){return run(async()=>{
      for(const record of [...state.records])if(!record.tombstone&&(!id||record.id===id)&&(!files||files.includes(record.ref.file))) {
        await reconcile(current(record.id),{fetchApple,retrySource});
      }
      return api.list();
    });},
    remove({id,forget=false}){return run(async()=>{
      let record=current(id);if(!record||record.tombstone)throw failure('Attention binding is no longer active');
      if(forget)return replace(record,{tombstone:true,status:'unlinked',removedAt:now(),outbox:null,pendingSource:null});
      record=replace(record,{latest:await request({...ref(record),op:'get'})});
      if(record.latest.missing)throw failure('Inspect the missing Apple item or explicitly forget the binding');
      return reconcile(outgoing(record,null,record.sourceBase,'remove'),{fetchApple:false});
    });},
    resolve({id,choice}){return run(async()=>{
      if(!['source','apple'].includes(choice))throw failure('Choose source or apple');
      let record=current(id);if(!record||record.tombstone)throw failure('Unknown attention binding');
      if(!sources.active(record.ref))throw failure('Enter the source project before resolving a conflict');
      const snapshot=await sources.read(record),latest=await request({...ref(record),op:'get'});
      if(latest.missing)throw failure('Apple item is missing; inspect or forget the binding');
      record=replace(record,{latest,outbox:null,pendingSource:null,conflicts:[],message:''});
      if(choice==='source')return reconcile(outgoing(record,snapshot.fields,snapshot),{fetchApple:false});
      record=replace(record,{sourceBase:snapshot,appleBase:{...latest,fields:snapshot.fields}});
      return reconcile(record,{fetchApple:false});
    });},
    signal({files,fetchApple=true}={}) {
      if(closed)return;
      signalDirty=true;
      signalApple ||= fetchApple;
      if(files)for(const file of files)signalFiles.add(file);
      if(signalPending)return;
      signalPending=true;
      const drain=async()=>{
        const fetch=signalApple,changed=[...signalFiles];signalApple=false;signalFiles.clear();signalDirty=false;
        try {if(!closed)await api.sync({fetchApple:fetch,files:fetch||!changed.length?undefined:changed});}
        catch(error){if(!closed)onChange({error:String(error.message||error)});}
        finally {if(signalDirty&&!closed)queueMicrotask(drain);else signalPending=false;}
      };
      queueMicrotask(drain);
    },
    close(){if(!closing){closed=true;closing=queue.then(()=>store.close());}return closing;},
  };
  return api;
}
