import {isAbsolute,relative,sep} from 'node:path';
import {normalizeDateValue} from '../../shared/planning-values.mjs';
import {attentionEqual} from './agenda-attention.mjs';
const failure=(message)=>Object.assign(new Error(message),{code:'ESOURCE',statusCode:409});
const within=(root,file)=>{const rel=relative(root,file);return !rel||(rel!=='..'&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel));};
const nativeId=(todo)=>todo.workNodeId||todo.sourceRef.id;
function zone(value) {
  if(value==='floating')return value;
  try {return new Intl.DateTimeFormat('en',{timeZone:value}).resolvedOptions().timeZone;}
  catch {throw failure('Choose a valid time zone');}
}
function civil(value,timeZone) {
  if(!value)return null;
  if(normalizeDateValue(value)!==value)throw failure('Source date is not canonical');
  const [date,time]=value.split(' ');return {date,timeZone,...(time?{time}:{})};
}
function nativeDate(value,timeZone) {
  if(value===null)return null;
  if(!value||value.timeZone!==timeZone)throw failure('Apple changed the time zone; choose an explicit source time-zone policy before applying');
  const date=`${value.date}${value.time?' '+value.time:''}`;
  if(normalizeDateValue(date)!==date)throw failure('Apple date cannot be represented in the source');
  return date;
}
function project(todo,record) {
  const canon=todo.canon||{},title=String(todo.text||'');
  if(!title.trim()||Buffer.byteLength(title)>4096)throw failure('Task title must contain at most 4096 bytes');
  if(record.kind==='reminder')return {title,completed:['done','cancelled'].includes(todo.declaredStatus||todo.status),
    priority:!canon.prio?0:canon.prio==='A'?1:canon.prio==='B'?5:9,
    due:civil(canon[record.options.dateField],record.options.timeZone),recurring:false};
  const start=civil(canon.sche,record.options.timeZone),end=civil(canon.end,record.options.timeZone);
  if(!start||!end||!!start.time!==!!end.time||canon.end<=canon.sche)throw failure('Calendar promotion requires an explicit scheduled start and later end, both timed or both all-day');
  return {title,start,end,allDay:!start.time,recurring:false};
}

/** Native scope adapter. Binding snapshots contain only projected fields and
 * identities; raw Markdown, prompts and outputs never enter the journal. */
export function createAgendaAttentionSources({index,isProtected=async()=>false}) {
  const scopeFor=(ref)=>index.status().scopes.find(s=>s.root===ref.root)
    ||index.status().scopes.filter(s=>within(s.root,ref.file)).sort((a,b)=>b.root.length-a.root.length)[0];
  async function task(record) {
    const scope=scopeFor(record.ref);if(!scope)throw failure('Source project is inactive');
    const snapshot=await index.query({scopes:[scope.id]});
    const matches=snapshot.todos.filter(t=>t.file===record.ref.file&&nativeId(t)===record.ref.nativeId);
    if(matches.length!==1||matches[0].sourceRef.ambiguous)throw failure('Source identity is missing or ambiguous');
    return matches[0];
  }
  const snapshot=(todo,record)=>({fields:project(todo,record),revision:todo.sourceRef.revision,repeat:!!todo.canon?.repeat});
  return {
    active(ref){return !!scopeFor(ref);},
    async prepare(body) {
      let todo=await index.lookup(body);
      if(await isProtected(todo.file))throw failure('Save the modified source buffer before promoting');
      const options={timeZone:zone(body.timeZone||Intl.DateTimeFormat().resolvedOptions().timeZone),dateField:body.dateField||'ddl'};
      if(!['ddl','sche'].includes(options.dateField))throw failure('Reminder date field must be ddl or sche');
      const record={kind:body.kind,options};
      const fields=project(todo,record); // Validate before assigning a source ID.
      todo=await index.identify(body);
      const root=index.status().scopes.find(s=>s.id===todo.scopeId)?.root;
      if(!root)throw failure('Source project left during promotion');
      return {ref:{file:todo.file,nativeId:nativeId(todo),sourceKind:todo.sourceKind,root,scopeId:todo.scopeId,uid:todo.uid},options,
        snapshot:snapshot(todo,record),window:body.kind==='event'?{start:fields.start,end:fields.end}:undefined};
    },
    async read(record){return snapshot(await task(record),record);},
    async write(record,before,desired) {
      const todo=await task(record);
      if(todo.sourceRef.revision!==before.revision)throw failure('Source revision changed before Apple receipt could be applied');
      if(await isProtected(todo.file))throw failure('Source has unsaved Emacs edits; retry after saving');
      if(desired.recurring)throw failure('Apple recurrence must be resolved explicitly');
      const patch={};
      if(desired.title!==before.fields.title)patch.title=desired.title;
      if(record.kind==='reminder') {
        if(desired.completed!==before.fields.completed) {
          if(desired.completed)patch.op='complete';else patch.status='todo';
        }
        if(desired.priority!==before.fields.priority) {
          if(!Number.isInteger(desired.priority)||desired.priority<0||desired.priority>9)throw failure('Invalid Apple priority');
          patch.prio=desired.priority===0?null:desired.priority<5?'A':desired.priority===5?'B':'C';
        }
        if(!attentionEqual(desired.due,before.fields.due))patch[record.options.dateField]=nativeDate(desired.due,record.options.timeZone);
      } else if(!attentionEqual(desired,before.fields)) {
        if(!!desired.start?.time===desired.allDay||!!desired.end?.time===desired.allDay)throw failure('Invalid Apple all-day interval');
        patch.sche=nativeDate(desired.start,record.options.timeZone);patch.end=nativeDate(desired.end,record.options.timeZone);
        if(!patch.sche||!patch.end||patch.end<=patch.sche)throw failure('Apple event end must be after start');
      }
      if(!scopeFor(record.ref))throw failure('Source project left before applying the receipt');
      const result=await index.patch({uid:todo.uid,scopeId:todo.scopeId,revision:before.revision,patch});
      return {revision:String(result.contentRevision||result.revision||'').replace(/^sha256:/,'')||null};
    },
  };
}
