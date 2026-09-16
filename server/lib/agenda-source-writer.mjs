import { createHash } from 'node:crypto';
import { computeAgendaSource, generatePlanningId, initialTodoFileContent, todoCreateSemanticFromBody, todoSemanticMutation } from './runtime.mjs';
import { parseResearchNotebook, setResearchAgenda, setResearchRelation, validateResearchNotebook } from './research-notebook.mjs';
import { serializeNotebook } from './jupyter-notebook-format.mjs';
import { formatDateValue } from '../../shared/planning-values.mjs';

const hash=(content)=>createHash('sha256').update(content).digest('hex');
const conflict=(message)=>Object.assign(new Error(message),{statusCode:409});

/** Storage adapter for routed sources. Grammar stays in Go/shared WorkNode
 * functions. The native storage provider remains responsible for its box DB. */
export function createAgendaSourceWriter({ transport, native, compute=computeAgendaSource, now=Date.now }) {
  const queues=new Map();
  const serial=(file,run)=>{
    const task=(queues.get(file)||Promise.resolve()).catch(()=>{}).then(run);
    queues.set(file,task);
    task.finally(()=>{if(queues.get(file)===task)queues.delete(file);}).catch(()=>{});
    return task;
  };
  async function loaded(todo) {
    const document=await transport.read(todo.file);
    if(document.revision!==(todo.sourceRef?.revision||todo.revision)) throw conflict('Agenda source changed; refresh before editing');
    return document;
  }
  async function save(file,document,content,extra={}) {
    const result=await transport.write(file,content,document?.revision??null);
    const {content:_oldContent,...metadata}=extra;
    const {content:_readContent,...receipt}=result;
    return {...metadata,...receipt,ok:true,file,contentRevision:hash(content)};
  }
  const selector=(todo)=>({kind:'todo',index:todo.index,source:todo.source});
  async function transformed(todo,document,mutation) {
    const result=await compute({content:document.content,selector:selector(todo),mutation});
    if(result.source!==todo.source) throw conflict('Agenda source selector changed');
    return save(todo.file,document,result.content,result);
  }
  async function work(todo,document,apply) {
    const result=apply(parseResearchNotebook(document.content));
    const validation=validateResearchNotebook(result.notebook);
    if(!validation.ok) throw conflict(validation.errors.map((e)=>e.message).join('; '));
    return save(todo.file,document,serializeNotebook(result.notebook),result);
  }
  const routed={
    async mutate(todo,patch) {
      const doc=await loaded(todo);
      return todo.sourceKind==='work-node'
        ? work(todo,doc,(nb)=>setResearchAgenda(nb,todo.workNodeId,patch,now()))
        : transformed(todo,doc,todoSemanticMutation(patch,now()));
    },
    async ensureId(todo,{planningIds=[]}={}) {
      const doc=await loaded(todo);
      if(todo.id.startsWith('#')) return {changed:false,file:todo.file,id:todo.id,contentRevision:doc.revision};
      const id=await generatePlanningId(planningIds);
      return {...await transformed(todo,doc,todoSemanticMutation({id},now())),id:`#${id}`};
    },
    async create(body,{planningIds=[]}={}) {
      const doc=await transport.read(body.file).catch((error)=>{if(error.code==='ENOENT')return null;throw error;});
      const result=await compute({content:doc?.content||'',mutation:{type:'append-todo',id:await generatePlanningId(planningIds),
        create:todoCreateSemanticFromBody(body),initialContent:initialTodoFileContent(body.file)}});
      return save(body.file,doc,result.content,{...result,index:result.from,createdFile:!doc,todo:{id:`#${result.node.attrs.id}`}});
    },
    async linkNodes(source,target) {
      const doc=await loaded(source);
      return work(source,doc,(nb)=>setResearchRelation(nb,source.workNodeId,'depends',[...new Set([...(source.nativeDepends||[]),target.workNodeId])]));
    },
    async startClock(todo,options={}) {
      const doc=await loaded(todo), at=options.at||formatDateValue(now(),true);
      if(todo.sourceKind==='work-node') return work(todo,doc,(nb)=>setResearchAgenda(nb,todo.workNodeId,{op:'clock-in',clockId:options.clockId,at},now()));
      const id=todo.id.startsWith('#')?todo.id:`#${await generatePlanningId(options.planningIds||[])}`;
      let content=doc.content;
      if(!todo.id.startsWith('#')) content=(await compute({content,selector:selector(todo),mutation:todoSemanticMutation({id:id.slice(1)},now())})).content;
      const result=await compute({content,selector:{kind:'todo',id},mutation:{type:'insert-clock',attrs:{from:at,task:id,id:options.clockId}}});
      return save(todo.file,doc,result.content,{...result,todoId:id});
    },
    async stopClock(body,options={}) {
      const doc=await loaded(body), at=options.at||formatDateValue(now(),true);
      if(body.sourceKind==='work-node') return work(body,doc,(nb)=>setResearchAgenda(nb,body.workNodeId,{op:'clock-out',clockId:body.clockId,at},now()));
      const result=await compute({content:doc.content,selector:{kind:'clock',index:body.index,source:body.source},mutation:{type:'patch-node',attrs:{to:at}}});
      if(result.source!==body.source) throw conflict('Clock source changed');
      return save(body.file,doc,result.content,{...result,to:at});
    },
  };
  return Object.fromEntries(Object.keys(routed).map((method)=>[method,(...args)=>{
    const file=args[0].file;
    return transport.owns(file)?serial(file,()=>routed[method](...args)):native[method](...args);
  }]));
}
