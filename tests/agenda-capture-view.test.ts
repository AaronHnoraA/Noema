import {describe,expect,test} from '@voidzero-dev/vite-plus-test';
import {promptAgendaCapture,type CaptureCatalog} from '../aaronnote/agenda-capture-view.ts';
// @ts-ignore Headless ESM catalogue used by both clients.
import {createAgendaCaptureTemplates} from '../server/lib/agenda-capture-templates.mjs';
const scopes=[{id:'knowledge',kind:'knowledge',root:'/vault'},{id:'project:x',kind:'project',root:'/project'}];

describe('shared Web capture form',()=>{
  test('failed writes retain the draft and retry once with corrected values',async()=>{
    const attempts:Record<string,unknown>[]=[];
    let rejectWrite!:(error:Error)=>void;
    const firstWrite=new Promise<void>((_resolve,reject)=>{rejectWrite=reject;});
    const reply=promptAgendaCapture(createAgendaCaptureTemplates().catalog(),scopes,'project:x',new AbortController().signal,async body=>{
      attempts.push(body);if(attempts.length===1)await firstWrite;
    });
    const dialog=document.querySelector<HTMLDialogElement>('.aaronnote-agenda-capture')!;
    const text=dialog.querySelector<HTMLInputElement>('[name=text]')!;text.value='Keep my draft';
    const file=dialog.querySelector<HTMLInputElement>('[name=file]')!;file.value='archive/inbox.md';
    const form=dialog.querySelector('form')!;
    form.dispatchEvent(new Event('submit',{cancelable:true}));
    form.dispatchEvent(new Event('submit',{cancelable:true}));
    expect(attempts).toHaveLength(1);expect(text.disabled).toBe(true);
    rejectWrite(new Error('Capture destination is excluded'));
    await firstWrite.catch(()=>{});await Promise.resolve();
    expect(dialog.isConnected).toBe(true);expect(text.value).toBe('Keep my draft');expect(file.value).toBe('archive/inbox.md');
    expect(dialog.querySelector('[role=alert]')?.textContent).toBe('Capture destination is excluded');
    expect(text.disabled).toBe(false);
    file.value='inbox.md';form.dispatchEvent(new Event('submit',{cancelable:true}));
    expect(await reply).toMatchObject({text:'Keep my draft',file:'inbox.md',scopeId:'project:x'});
    expect(attempts).toHaveLength(2);expect(dialog.isConnected).toBe(false);
  });
  test('closing the owner during a write ignores a late rejection',async()=>{
    const controller=new AbortController();let rejectWrite!:(error:Error)=>void;
    const write=new Promise<void>((_resolve,reject)=>{rejectWrite=reject;});
    const reply=promptAgendaCapture(createAgendaCaptureTemplates().catalog(),scopes,'knowledge',controller.signal,()=>write);
    const dialog=document.querySelector<HTMLDialogElement>('.aaronnote-agenda-capture')!;
    dialog.querySelector<HTMLInputElement>('[name=text]')!.value='Pending';
    dialog.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
    controller.abort();expect(await reply).toBeNull();
    rejectWrite(new Error('Late failure'));await write.catch(()=>{});await Promise.resolve();
    expect(dialog.isConnected).toBe(false);expect(document.querySelector('[role=alert]')).toBeNull();
  });
  test('selects template/scope, preserves title and submits reviewed fields',async()=>{
    const controller=new AbortController(),catalog=createAgendaCaptureTemplates().catalog() as CaptureCatalog;
    const reply=promptAgendaCapture(catalog,scopes,'project:x',controller.signal);
    const dialog=document.querySelector<HTMLDialogElement>('.aaronnote-agenda-capture')!;
    (dialog.querySelector('[name=text]') as HTMLInputElement).value='Review';
    const template=dialog.querySelector<HTMLSelectElement>('[name=template]')!;template.value='deadline';template.dispatchEvent(new Event('change'));
    expect((dialog.querySelector('[name=text]') as HTMLInputElement).value).toBe('Review');
    expect((dialog.querySelector('[name=scope]') as HTMLSelectElement).value).toBe('project:x');
    (dialog.querySelector('[name=ddl]') as HTMLInputElement).value='2026-09-20';
    dialog.querySelector('form')!.dispatchEvent(new Event('submit',{cancelable:true}));
    expect(await reply).toEqual({templateId:'deadline',templateRevision:catalog.revision,scopeId:'project:x',file:'inbox.md',text:'Review',ddl:'2026-09-20',prio:'B'});
    expect(dialog.isConnected).toBe(false);
  });
  test('owner cancellation removes the form and cannot submit a delayed capture',async()=>{
    const controller=new AbortController();
    const reply=promptAgendaCapture(createAgendaCaptureTemplates().catalog(),scopes,'knowledge',controller.signal);
    controller.abort();expect(await reply).toBeNull();
    expect(document.querySelector('.aaronnote-agenda-capture')).toBeNull();
  });
});
