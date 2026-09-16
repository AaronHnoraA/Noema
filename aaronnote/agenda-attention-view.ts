export type AttentionOperation = 'collections'|'promote'|'sync'|'remove'|'resolve'|'visit';
export type AttentionItem = {
  id:string;kind:string;status:string;active:boolean;message?:string;conflicts?:string[];
  ref:{root:string};fields:Record<string,unknown>;sourceCurrent?:{fields:Record<string,unknown>};
};
export type AttentionSnapshot = {revision:number;connection?:{state:string;message:string};items:AttentionItem[]};
export type AttentionAction = (operation:AttentionOperation,body:Record<string,unknown>)=>Promise<unknown>;

export function renderAttention(snapshot:AttentionSnapshot|null, action:AttentionAction|undefined,
  refresh:()=>Promise<void>,status:(message:string)=>void):HTMLElement {
  const root=document.createElement('section');
  const summary=document.createElement('p');
  summary.textContent='Explicitly promoted tasks and time blocks. Inactive source projects stay closed.';
  root.append(summary);
  if(!snapshot){summary.textContent='Global attention unavailable';return root;}
  if(snapshot.connection&&snapshot.connection.state!=='connected'){
    const connection=document.createElement('p');connection.className='aaronnote-attention-connection';
    connection.textContent=`Showing saved receipts · ${snapshot.connection.message}`;root.append(connection);
  }
  if(!snapshot.items.length){const empty=document.createElement('p');empty.textContent='No promoted tasks. Use Promote on an Agenda task.';root.append(empty);}
  for(const item of snapshot.items){
    const row=document.createElement('article');row.className='aaronnote-attention-item';
    const title=document.createElement('h3');title.textContent=String(item.fields.title||'Untitled');
    const detail=document.createElement('p');detail.textContent=`${item.kind} · ${item.status} · ${item.active?'Active':'Inactive'} source · ${item.ref.root}`;
    row.append(title,detail);
    if(item.message){const message=document.createElement('p');message.textContent=item.message;row.append(message);}
    for(const field of item.conflicts||[]){
      const conflict=document.createElement('p');
      conflict.textContent=`${field}: source (last observed) ${JSON.stringify(item.sourceCurrent?.fields[field])}; Apple ${JSON.stringify(item.fields[field])}`;
      row.append(conflict);
    }
    const controls=document.createElement('div');controls.className='aaronnote-agenda-full-tabs';
    for(const [label,operation,body,enabled] of [
      ['Open source project','visit',{},true],['Sync / retry','sync',{},true],
      ['Keep source','resolve',{choice:'source'},item.active],['Use Apple','resolve',{choice:'apple'},item.active],
      ['Cancel promotion','remove',{},true],['Forget binding','remove',{forget:true},true],
    ] as Array<[string,AttentionOperation,Record<string,unknown>,boolean]>){
      const button=document.createElement('button');button.type='button';button.textContent=label;button.disabled=!action||!enabled;
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try{await action?.(operation,{id:item.id,...body});await refresh();}
        catch(error){status(error instanceof Error?error.message:String(error));button.disabled=!action||!enabled;}
      });
      controls.append(button);
    }
    row.append(controls);root.append(row);
  }
  return root;
}
