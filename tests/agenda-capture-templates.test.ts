import {describe,expect,test} from '@voidzero-dev/vite-plus-test';
// @ts-ignore Headless ESM service.
import {createAgendaCaptureTemplates} from '../server/lib/agenda-capture-templates.mjs';

describe('native capture profiles',()=>{
  test('builtins share required fields and refuse stale menus or missing scope',()=>{
    const profiles=createAgendaCaptureTemplates(), catalog=profiles.catalog();
    expect(catalog.templates.map((t:any)=>t.id)).toEqual(['task','deadline','event']);
    const base={templateId:'deadline',templateRevision:catalog.revision,scopeId:'knowledge',text:'Paper',ddl:'2026-09-20'};
    expect(profiles.expand(base)).toMatchObject({file:'inbox.md',prio:'B',ddl:'2026-09-20'});
    expect(()=>profiles.expand({...base,templateRevision:'old'})).toThrow('changed');
    expect(()=>profiles.expand({...base,scopeId:''})).toThrow('scope');
    expect(()=>profiles.expand({...base,ddl:''})).toThrow('deadline');
    expect(()=>profiles.expand({...base,ddl:'not a date'})).toThrow('Invalid deadline');
    expect(()=>profiles.expand({...base,prio:'Z'})).toThrow('priority');
    expect(()=>profiles.expand({...base,repeat:'sometimes'})).toThrow('repeater');
    expect(()=>profiles.expand({...base,sche:'2026-09-20 11:00',end:'2026-09-20 10:00'})).toThrow('after');
  });

  test('date destinations are resolved once for the reviewed menu and invalidate across midnight',()=>{
    let now=new Date(2026,8,16,12).getTime();
    const profiles=createAgendaCaptureTemplates([{id:'review',name:'Review',file:'daily/%Y-%m-%d.md',scope:'knowledge',fields:['text'],defaults:{text:'Review',effort:'30m'}}],{now:()=>now});
    const catalog=profiles.catalog(), body={templateId:'review',templateRevision:catalog.revision,scopeId:'knowledge'};
    expect(catalog.templates[0].file).toBe('daily/2026-09-16.md');
    expect(profiles.expand(body)).toMatchObject({file:'daily/2026-09-16.md',text:'Review',effort:'30m'});
    expect(()=>profiles.expand({...body,scopeId:'project:x'})).toThrow('scope');
    catalog.templates[0].defaults.text='Mutated client';
    expect(profiles.catalog().templates[0].defaults.text).toBe('Review');
    now+=86400000;
    expect(()=>profiles.expand(body)).toThrow('changed');
    expect(profiles.catalog().templates[0].file).toBe('daily/2026-09-17.md');
  });

  test('rejects executable or escaping templates, preserves ordinary capture API',()=>{
    for(const override of [{file:'../tasks.md'},{file:'/tmp/tasks.md'},{file:'.lake/tasks.md'},{file:'tasks.noema'},
      {file:'%s.md'},{scope:'project:/elsewhere'},{fields:['text','shell']},{required:{}},{defaults:{id:'force'}},{run:'shell'}]){
      expect(()=>createAgendaCaptureTemplates([{id:'t',name:'Task',...override}])).toThrow();
    }
    const body={text:'Ordinary task',scopeId:'project:active'};
    expect(createAgendaCaptureTemplates().expand(body)).toBe(body);
  });
});
