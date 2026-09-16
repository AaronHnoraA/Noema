export type CaptureField = {name:string;label:string;kind:'text'|'date'|'choice';choices?:string[];required:boolean};
export type CaptureTemplate = {id:string;key:string;name:string;file:string;scope:'selected'|'knowledge';defaults:Record<string,string>;fields:CaptureField[]};
export type CaptureCatalog = {revision:string;templates:CaptureTemplate[]};
type CaptureScope = {id:string;root:string;kind:string};

/** One owned dialog, resolved by submit, cancel or its Agenda owner closing. */
export function promptAgendaCapture(catalog:CaptureCatalog,scopes:CaptureScope[],initialScope:string,signal:AbortSignal,save?:(body:Record<string,unknown>)=>Promise<void>):Promise<Record<string,unknown>|null> {
  if(signal.aborted)return Promise.resolve(null);
  if(!catalog.templates.length||!scopes.length)return Promise.reject(new Error('Wait for Agenda scopes and capture templates'));
  return new Promise(resolve=>{
    const dialog=document.createElement('dialog');dialog.className='aaronnote-agenda-capture';dialog.setAttribute('aria-label','Capture task');
    const form=document.createElement('form');form.method='dialog';
    const title=document.createElement('h2');title.textContent='Capture task';form.append(title);
    function control(label:string,element:HTMLInputElement|HTMLSelectElement){
      const wrapper=document.createElement('label');const caption=document.createElement('span');caption.textContent=label;wrapper.append(caption,element);return wrapper;
    }
    function select(options:Array<{value:string;label:string}>){
      const element=document.createElement('select');
      for(const item of options){const option=document.createElement('option');option.value=item.value;option.textContent=item.label;element.append(option);}
      return element;
    }
    const templateSelect=select(catalog.templates.map(template=>({value:template.id,label:`${template.key} · ${template.name}`})));
    templateSelect.name='template';form.append(control('Template',templateSelect));
    const scopeSelect=select([]);scopeSelect.name='scope';form.append(control('Scope',scopeSelect));
    const file=document.createElement('input');file.name='file';file.required=true;form.append(control('Markdown file',file));
    const inputs=document.createElement('div');inputs.className='aaronnote-agenda-capture-fields';form.append(inputs);
    const destination=document.createElement('p');destination.className='aaronnote-agenda-capture-destination';form.append(destination);
    const error=document.createElement('p');error.setAttribute('role','alert');error.hidden=true;form.append(error);
    const buttons=document.createElement('div');buttons.className='aaronnote-agenda-capture-buttons';
    const cancel=document.createElement('button');cancel.type='button';cancel.textContent='Cancel';
    const submit=document.createElement('button');submit.type='submit';submit.textContent='Capture';buttons.append(cancel,submit);form.append(buttons);dialog.append(form);
    let controls=new Map<string,HTMLInputElement|HTMLSelectElement>(),settled=false,pending=false;
    const template=()=>catalog.templates.find(item=>item.id===templateSelect.value)!;
    const showDestination=()=>{const scope=scopes.find(item=>item.id===scopeSelect.value);destination.textContent=scope?`${scope.root.replace(/\/$/,'')}/${file.value}`:'No active scope';submit.disabled=!scope;};
    const changeTemplate=()=>{
      const text=controls.get('text')?.value;
      const selected=scopeSelect.value||initialScope;
      scopeSelect.replaceChildren();
      for(const scope of scopes.filter(scope=>template().scope!=='knowledge'||scope.id==='knowledge')){
        const option=document.createElement('option');option.value=scope.id;option.textContent=scope.kind==='knowledge'?'Knowledge':scope.root;scopeSelect.append(option);
      }
      if([...scopeSelect.options].some(option=>option.value===selected))scopeSelect.value=selected;
      file.value=template().file;inputs.replaceChildren();controls=new Map();
      for(const field of template().fields){
        const input=field.kind==='choice'?select((field.choices||[]).map(value=>({value,label:value||'None'}))):document.createElement('input');
        input.name=field.name;input.required=field.required;
        input.value=field.name==='text'&&text!==undefined?text:template().defaults[field.name]||'';
        if(input instanceof HTMLInputElement&&field.kind==='date')input.placeholder='YYYY-MM-DD HH:mm or today';
        controls.set(field.name,input);inputs.append(control(field.label,input));
      }
      showDestination();
    };
    const finish=(body:Record<string,unknown>|null)=>{
      if(settled)return;settled=true;signal.removeEventListener('abort',abort);dialog.remove();resolve(body);
    };
    const abort=()=>finish(null);
    cancel.addEventListener('click',abort);
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(null);});
    dialog.addEventListener('close',abort);
    form.addEventListener('submit',async event=>{
      event.preventDefault();if(settled||pending||!form.reportValidity()||submit.disabled)return;
      const body={templateId:template().id,templateRevision:catalog.revision,scopeId:scopeSelect.value,file:file.value,
        ...Object.fromEntries([...controls].map(([key,input])=>[key,input.value]))};
      if(!save){finish(body);return;}
      pending=true;error.hidden=true;submit.textContent='Saving…';
      const editable=[templateSelect,scopeSelect,file,...controls.values(),submit];
      editable.forEach(input=>{input.disabled=true;});
      try{await save(body);finish(body);}
      catch(cause){
        if(!settled){error.textContent=cause instanceof Error?cause.message:'Capture failed';error.hidden=false;}
      }finally{
        pending=false;
        if(!settled){editable.forEach(input=>{input.disabled=false;});submit.textContent='Capture';showDestination();}
      }
    });
    templateSelect.addEventListener('change',changeTemplate);scopeSelect.addEventListener('change',showDestination);file.addEventListener('input',showDestination);
    signal.addEventListener('abort',abort,{once:true});changeTemplate();document.body.append(dialog);dialog.showModal();controls.get('text')?.focus();
  });
}
