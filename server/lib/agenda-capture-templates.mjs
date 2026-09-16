import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {normalizeDateValue,parseDateValue,parseDuration,parseRepeater} from '../../shared/planning-values.mjs';

const fields = {
  text:{label:'Task',kind:'text'}, status:{label:'State',kind:'choice',choices:['todo','doing','blocked','done','cancelled']},
  sche:{label:'Scheduled',kind:'date'}, ddl:{label:'Deadline',kind:'date'}, end:{label:'End',kind:'date'},
  prio:{label:'Priority',kind:'choice',choices:['','A','B','C','D','E','F']},
  effort:{label:'Effort',kind:'text'}, repeat:{label:'Repeat',kind:'text'}, project:{label:'Project',kind:'text'},
  tags:{label:'Tags',kind:'text'}, warn:{label:'Deadline warning',kind:'text'},
};
const builtins = [
  {id:'task',key:'t',name:'Task',fields:['text']},
  {id:'deadline',key:'d',name:'Deadline',fields:['text','ddl','prio'],required:['ddl'],defaults:{prio:'B'}},
  {id:'event',key:'e',name:'Appointment',fields:['text','sche','end'],required:['sche','end']},
];
const fail = (message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const object = value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stringValue = value=>value===null?'':typeof value==='string'?value:typeof value==='number'&&Number.isFinite(value)?String(value):null;

/** Declarative capture profiles only; native task syntax and persistence stay
 * in the existing scoped writer. No file reads, project entry or executable templates. */
export function createAgendaCaptureTemplates(config = [], {now=Date.now} = {}) {
  if (!Array.isArray(config) || config.length>64) throw fail('Capture templates must be an array of at most 64 profiles');
  const ids=new Set(), keys=new Set();
  const templates=(config.length?config:builtins).map(raw=>{
    if(!object(raw)||typeof raw.id!=='string'||!/^[-a-z0-9_]{1,64}$/i.test(raw.id)||ids.has(raw.id))throw fail('Capture template IDs must be unique');
    if(Object.keys(raw).some(key=>!['id','key','name','file','scope','defaults','fields','required'].includes(key)))throw fail('Unsupported capture template property');
    const key=raw.key||raw.id;
    if(typeof key!=='string'||!/^[-a-z0-9_]{1,64}$/i.test(key)||keys.has(key))throw fail('Capture template keys must be unique');
    ids.add(raw.id);keys.add(key);
    if(typeof raw.name!=='string'||!raw.name.trim()||raw.name.length>160)throw fail('Capture template needs a short name');
    const file=raw.file||'inbox.md',scope=raw.scope||'selected';
    if(typeof file!=='string'||file.length>1024||isAbsolute(file)||file.includes('\\')||file.split('/').some(part=>!part||part.startsWith('.'))||!/\.(md|markdown)$/i.test(file)||/%(?![Ymd])/u.test(file))throw fail('Capture template file must be a relative Markdown path; date tokens are %Y/%m/%d');
    if(!['selected','knowledge'].includes(scope))throw fail('Capture templates cannot activate a project');
    const names=raw.fields||['text'];
    if(!Array.isArray(names)||!names.includes('text')||new Set(names).size!==names.length||names.some(name=>!Object.hasOwn(fields,name)))throw fail('Capture template fields must be known native fields, including text');
    if(!Array.isArray(raw.required||[]))throw fail('Required capture fields must be a list');
    const required=[...new Set(['text',...(raw.required||[])])];
    if(required.some(name=>!names.includes(name)))throw fail('Required capture fields must be prompted fields');
    const defaults={};
    if(raw.defaults!=null&&!object(raw.defaults))throw fail('Capture defaults must be a field map');
    for(const [name,value] of Object.entries(raw.defaults||{})){
      const text=stringValue(value);
      if(!Object.hasOwn(fields,name)||text===null||text.length>4096)throw fail('Invalid capture default field');
      const choice=fields[name].kind==='choice'&&text?(name==='prio'?text.toUpperCase():text.toLowerCase()):text;
      if(fields[name].kind==='choice'&&choice&&!fields[name].choices.includes(choice))throw fail('Invalid capture default choice');
      defaults[name]=choice;
    }
    return {id:raw.id,key,name:raw.name.trim(),file,scope,defaults,
      fields:names.map(name=>({name,...fields[name],required:required.includes(name)}))};
  });
  function catalog(){
    const date=new Date(now()), replacements={Y:String(date.getFullYear()).padStart(4,'0'),m:String(date.getMonth()+1).padStart(2,'0'),d:String(date.getDate()).padStart(2,'0')};
    const resolved=templates.map(template=>({...template,file:template.file.replace(/%([Ymd])/g,(_,key)=>replacements[key])}));
    return structuredClone({revision:createHash('sha256').update(JSON.stringify(resolved)).digest('hex'),templates:resolved});
  }
  function expand(body={}){
    if(!body.templateId)return body;
    const current=catalog();
    if(body.templateRevision!==current.revision)throw fail('Capture templates changed; reopen capture to review its destination',409);
    const template=current.templates.find(item=>item.id===body.templateId);
    if(!template)throw fail('Capture template is unavailable');
    if(typeof body.scopeId!=='string'||!body.scopeId||(template.scope==='knowledge'&&body.scopeId!=='knowledge'))throw fail('Select an active capture scope allowed by this template');
    const expanded={...template.defaults,...body,file:body.file||template.file};
    for(const field of template.fields){
      const value=stringValue(expanded[field.name]??'');
      if(value===null||value.length>4096||field.required&&!value.trim())throw fail(`Capture requires ${field.label.toLowerCase()}`);
      expanded[field.name]=value;
    }
    for(const [name,definition] of Object.entries(fields)){
      const value=String(expanded[name]??'').trim();
      if(!value)continue;
      if(definition.kind==='date'&&!normalizeDateValue(value))throw fail(`Invalid ${definition.label.toLowerCase()}`,422);
      if(definition.kind==='choice'){
        const normalized=name==='prio'?value.toUpperCase():value.toLowerCase();
        if(!definition.choices.includes(normalized))throw fail(`Invalid ${definition.label.toLowerCase()}`,422);
        expanded[name]=normalized;
      }
      if(name==='repeat'&&!parseRepeater(value))throw fail('Invalid capture repeater',422);
      if(name==='effort'&&parseDuration(value)===null)throw fail('Invalid capture effort',422);
    }
    if(expanded.sche&&expanded.end){
      const start=parseDateValue(normalizeDateValue(String(expanded.sche))), end=parseDateValue(normalizeDateValue(String(expanded.end)));
      if(!start||!end||end.time<=start.time)throw fail('Capture end must be after scheduled time',422);
    }
    return expanded;
  }
  return {catalog,expand};
}
