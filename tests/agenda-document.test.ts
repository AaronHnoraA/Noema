import {afterEach,describe,expect,test} from '@voidzero-dev/vite-plus-test';
// @ts-ignore Headless ESM API.
import {inspectAgendaDocument} from '../server/lib/runtime.mjs';
// @ts-ignore Headless ESM configuration.
import {configurePlanningProvider} from '../server/lib/state.mjs';
import {scanPlanningDocument} from '../shared/planning-document.mjs';

afterEach(()=>configurePlanningProvider(null));

describe('read-only Agenda editor snapshot',()=>{
  test('parses unsaved remote text without reading paths, entering scopes or invoking a mutation',async()=>{
    const calls:any[]=[];
    configurePlanningProvider({
      owns(){throw new Error('No filesystem ownership query');},
      read(){throw new Error('No disk read');},
      mutate(){throw new Error('No source write');},
      async computeSource(body:any){calls.push(body);return {nodes:scanPlanningDocument(body.content)};},
    });
    const content='😀\n@@itodo(doing) [Unsaved]{due: 2026-09-20}\n\n```md\n@@todo [Example]\n```';
    const result=await inspectAgendaDocument({file:'/fs:unentered:/project/tasks.md',content,mutation:{type:'append'}});
    expect(calls).toEqual([{content}]);
    expect(result.todos).toHaveLength(1);
    expect(result.todos[0]).toMatchObject({text:'Unsaved',index:3,status:'doing',canon:{ddl:'2026-09-20'}});
    expect(result.todos[0].scopeId).toBeUndefined();
    expect(result.todos[0].sourceRef).toBeUndefined();
    expect(result.contentRevision).toMatch(/^[a-f0-9]{64}$/);
  });

  test('does not fall back to a separate parser when native computation is offline',async()=>{
    configurePlanningProvider(null);
    await expect(inspectAgendaDocument({file:'/tmp/tasks.md',content:'@@todo [Live]'})).rejects.toMatchObject({statusCode:503});
  });

  test('rejects malformed, non-Markdown and oversized source before computation',async()=>{
    configurePlanningProvider({computeSource(){throw new Error('Unexpected computation');}});
    for(const body of [{file:'work.noema',content:'@@todo [AI output]'}, {content:[]}, {file:null,content:''}]){
      await expect(inspectAgendaDocument(body)).rejects.toMatchObject({statusCode:400});
    }
    await expect(inspectAgendaDocument({file:'large.md',content:'😀'.repeat(4*1024*1024+1)})).rejects.toMatchObject({statusCode:413});
  });

  test('rejects a native result whose source positions disagree with the supplied snapshot',async()=>{
    configurePlanningProvider({computeSource:async()=>({nodes:scanPlanningDocument('@@todo [Different]')})});
    await expect(inspectAgendaDocument({content:'@@todo [Actual]'})).rejects.toMatchObject({statusCode:502});
  });
});
