import {describe,expect,test} from '@voidzero-dev/vite-plus-test';
import {mkdtemp,mkdir,readFile,writeFile,rm,realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createResearchNotebook,createResearchCell,createResearchNotebookService,setResearchAgenda} from '../server/lib/research-notebook.mjs';
import {workAgendaPlanning} from '../shared/work-agenda.mjs';
// @ts-ignore Node service
import {createAgendaAttentionSources} from '../server/lib/agenda-attention-source.mjs';
// @ts-ignore Node index
import {createAgendaIndex} from '../server/lib/agenda-index.mjs';
// @ts-ignore Native Markdown provider
import {configure,agendaMarkdownDocument,buildAgendaFromPlanning,patchTodo,ensureTodoId} from '../server/lib/runtime.mjs';

async function fixture(run:(c:any)=>Promise<void>) {
  const root=await realpath(await mkdtemp(join(tmpdir(),'noema-attention-source-')));
  const knowledge=join(root,'knowledge'),project=join(root,'project');
  await mkdir(knowledge);await mkdir(project);
  configure({root:knowledge,workspaceRoot:root,stateRoot:join(root,'state'),tmpRoot:join(root,'tmp')});
  let protectedSource=false,parses=0;
  const notebooks=createResearchNotebookService();
  const index=createAgendaIndex({knowledgeRoot:knowledge,watch:null,
    parseDocument:(doc:any)=>{parses++;return doc.file.endsWith('.noema')?workAgendaPlanning(JSON.parse(doc.content),doc):agendaMarkdownDocument(doc);},
    evaluate:(planning:any,body:any,options:any)=>buildAgendaFromPlanning(planning,body,{...options,requireKernel:false}),
    ensureId:(todo:any,options:any)=>ensureTodoId({file:todo.file,index:todo.index,source:todo.source,
      expectedSource:todo.source,expectedRevision:todo.sourceRef.revision},options),
    mutate:(todo:any,patch:any)=>todo.sourceKind==='work-node'
      ?notebooks.setAgenda({file:todo.file,workNodeId:todo.workNodeId,expectedRevision:`sha256:${todo.sourceRef.revision}`,patch})
      :patchTodo({...patch,file:todo.file,index:todo.index,source:todo.source,selectorId:todo.id.startsWith('#')?todo.id:'',
        expectedSource:todo.source,expectedRevision:todo.sourceRef.revision}),
  });
  const sources=createAgendaAttentionSources({index,isProtected:async()=>protectedSource});
  const scope=await index.enter({root:project});
  const locate=async(file:string)=>{
    index.invalidate([file]);
    const todo=(await index.query({scopes:[scope.id]})).todos.find((todo:any)=>todo.file===file);
    return {uid:todo.uid,scopeId:scope.id,revision:todo.sourceRef.revision};
  };
  try {await run({root,project,index,sources,scope,locate,protect:(value:boolean)=>{protectedSource=value;},parses:()=>parses});}
  finally {index.close();await rm(root,{recursive:true,force:true});}
}

describe('attention native source boundary',()=>{
  test('idless Markdown gets a stable native identity and versioned title/completion writes',()=>fixture(async(c:any)=>{
    const file=join(c.project,'task.md');await writeFile(file,'# Notes\n\n@@todo [证明]{ddl: 2026-09-18}\n\nKeep this prose.\n');
    const prepared=await c.sources.prepare({...await c.locate(file),kind:'reminder',timeZone:'floating'});
    expect(prepared.ref.nativeId).toMatch(/^#[a-z0-9]+$/);
    expect(prepared.snapshot.fields.due).toEqual({date:'2026-09-18',timeZone:'floating'});
    const record={...prepared,kind:'reminder'};
    const before=await c.sources.read(record);
    const receipt=await c.sources.write(record,before,{...before.fields,title:'新标题 ] 🚀',completed:true});
    const after=await c.sources.read(record);
    expect(after.revision).toBe(receipt.revision);
    expect(after.fields).toMatchObject({title:'新标题 ] 🚀',completed:true});
    expect(await readFile(file,'utf8')).toContain('Keep this prose.');
    await expect(c.sources.write(record,before,before.fields)).rejects.toThrow('revision changed');
    expect(JSON.stringify(prepared)).not.toContain('Keep this prose');
  }));

  test('WorkNode title/completion preserves all prompts, outputs, dependencies and source ownership',()=>fixture(async(c:any)=>{
    const first=createResearchCell(createResearchNotebook(),{kind:'work',title:'证明',source:'Private prompt'});
    const next=createResearchCell(first.notebook,{kind:'checkpoint',title:'Review',lineageParent:first.workNode.id});
    const notebook=setResearchAgenda(next.notebook,first.workNode.id,{ddl:'2026-09-18'}).notebook;
    notebook.cells[0].outputs=[{output_type:'stream',name:'stdout',text:'Private reply'}];
    const original=structuredClone(notebook),file=join(c.project,'work.noema');
    await writeFile(file,JSON.stringify(notebook));
    const record={...await c.sources.prepare({...await c.locate(file),kind:'reminder',timeZone:'floating'}),kind:'reminder'};
    const before=await c.sources.read(record);
    await c.sources.write(record,before,{...before.fields,title:'手机修改的证明',completed:true});
    const saved=JSON.parse(await readFile(file,'utf8'));
    expect(saved.cells[0].outputs).toEqual(original.cells[0].outputs);
    expect(saved.cells[0].metadata).toEqual(original.cells[0].metadata);
    expect(saved.cells[0].source).toContain('ddl: 2026-09-18');
    expect(saved.cells[0].source).toContain('done:');
    expect(saved.cells[0].source).toContain('Private prompt');
    expect(saved.metadata.noema_research.dependencies).toEqual(original.metadata.noema_research.dependencies);
    expect(saved.metadata.noema_research.work_nodes[0]).toMatchObject({id:first.workNode.id,title:'手机修改的证明',state:'done'});
    expect(saved.metadata.noema_research.work_nodes[1]).toEqual(original.metadata.noema_research.work_nodes[1]);
    expect(JSON.stringify(record)).not.toContain('Private');
  }));

  test('inactive sources perform no parsing or IO, and protected buffers reject writes',()=>fixture(async(c:any)=>{
    const file=join(c.project,'task.md');await writeFile(file,'@@todo [证明]{id: abc123}');
    const record={...await c.sources.prepare({...await c.locate(file),kind:'reminder',timeZone:'floating'}),kind:'reminder'};
    c.protect(true);const before=await c.sources.read(record);
    await expect(c.sources.write(record,before,{...before.fields,completed:true})).rejects.toThrow('unsaved');
    await c.index.leave({id:c.scope.id});await rm(c.project,{recursive:true});const count=c.parses();
    expect(c.sources.active(record.ref)).toBe(false);
    await expect(c.sources.read(record)).rejects.toThrow('inactive');
    await expect(c.sources.write(record,before,before.fields)).rejects.toThrow('inactive');
    expect(c.parses()).toBe(count);
  }));

  test('Calendar requires an explicit interval and rejects unsupported zone changes without touching source',()=>fixture(async(c:any)=>{
    const file=join(c.project,'task.md');await writeFile(file,'@@todo [会议]{ddl: 2026-09-18}');
    await expect(c.sources.prepare({...await c.locate(file),kind:'event',timeZone:'Australia/Sydney'})).rejects.toThrow('explicit scheduled start');
    expect(await readFile(file,'utf8')).not.toContain('id:');
    await writeFile(file,'@@todo [会议]{sche: 2026-09-18, end: 2026-09-19}');
    const record={...await c.sources.prepare({...await c.locate(file),kind:'event',timeZone:'Australia/Sydney'}),kind:'event'};
    expect(record.snapshot.fields).toMatchObject({allDay:true,start:{date:'2026-09-18'},end:{date:'2026-09-19'}});
    const before=await c.sources.read(record),bytes=await readFile(file,'utf8');
    await expect(c.sources.write(record,before,{...before.fields,start:{date:'2026-09-18',timeZone:'UTC'}})).rejects.toThrow('time zone');
    expect(await readFile(file,'utf8')).toBe(bytes);
  }));
});
