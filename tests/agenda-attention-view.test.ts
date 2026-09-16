import {describe,expect,test,vi} from '@voidzero-dev/vite-plus-test';
import {renderAttention} from '../aaronnote/agenda-attention-view.ts';
import type {AttentionSnapshot} from '../aaronnote/agenda-attention-view.ts';

function snapshot():AttentionSnapshot {
  return {revision:1,connection:{state:'unavailable',message:'Apple helper stopped'},items:[{
    id:'binding',kind:'reminder',status:'conflict',active:false,ref:{root:'/fs:lab:/project'},
    fields:{title:'<img src=x onerror=alert(1)>',completed:true},sourceCurrent:{fields:{title:'源标题',completed:false}},conflicts:['title'],
  }]};
}
const settle=async()=>{await Promise.resolve();await Promise.resolve();await Promise.resolve();};
describe('global attention controls',()=>{
  test('inactive receipts remain readable with literal titles and no implicit action',()=>{
    const action=vi.fn(),refresh=vi.fn();
    const view=renderAttention(snapshot(),action,refresh,vi.fn());
    expect(view.textContent).toContain('Showing saved receipts');
    expect(view.textContent).toContain('源标题');expect(view.querySelector('img')).toBeNull();
    const buttons=[...view.querySelectorAll('button')];
    expect(buttons.find(button=>button.textContent==='Use Apple')?.disabled).toBe(true);
    expect(buttons.find(button=>button.textContent==='Keep source')?.disabled).toBe(true);
    expect(action).not.toHaveBeenCalled();expect(refresh).not.toHaveBeenCalled();
  });
  test('visiting an inactive source requires an explicit binding action',async()=>{
    const action=vi.fn(async()=>({})),refresh=vi.fn(async()=>{});
    const view=renderAttention(snapshot(),action,refresh,vi.fn());
    [...view.querySelectorAll('button')].find(button=>button.textContent==='Open source project')!.click();
    await settle();expect(action).toHaveBeenCalledWith('visit',{id:'binding'});expect(refresh).toHaveBeenCalledTimes(1);
  });
  test('failed actions show the error and reenable their control',async()=>{
    const action=vi.fn(async()=>{throw new Error('Apple item changed');}),status=vi.fn();
    const view=renderAttention(snapshot(),action,vi.fn(),status);
    const button=[...view.querySelectorAll('button')].find(button=>button.textContent==='Sync / retry')!;
    button.click();expect(button.disabled).toBe(true);await settle();
    expect(status).toHaveBeenCalledWith('Apple item changed');expect(button.disabled).toBe(false);
  });
});
