// @vitest-environment node
import { describe, expect, it } from '@voidzero-dev/vite-plus-test';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createOfficialClient, validateOfficialConnection} from '../plugins/marginnote/official-client.mjs';

const config = {url:'http://127.0.0.1:42340/bridge/v1',token:'official-test',device:'mac' as const};
function fixture(handler: (action:string,payload:any)=>any) {
  const calls:any[] = [], results = new Map();
  const context = vm.createContext({noema:{
    request(id:string,action:string,payload:any) { calls.push({action,payload}); results.set(id,handler(action,payload)); return {state:'pending'}; },
    result(id:string) { return {state:'completed',value:results.get(id)}; }
  }});
  const transport:any[]=[];
  const fetchImpl:any = async (url:string, options:any) => {
    transport.push({url,options});
    return new Response(JSON.stringify({value:vm.runInContext('(function(){'+JSON.parse(options.body).js+'})()',context)}));
  };
  return {client:createOfficialClient(config,{fetchImpl,pause:async()=>{}}),calls,transport};
}
const status = {protocol:1,sessions:[{id:'native-session'}]};
describe('Noema official client',()=>{
  it('keeps the named device at its saved local destination',()=>{
    expect(validateOfficialConnection(config,'mac').device).toBe('mac');
    expect(validateOfficialConnection({url:'http://192.168.2.4:42340/bridge/v1',token:'ipad'},'ipad').device).toBe('ipad');
    for(const url of ['http://127.0.0.1:42340/bridge/v1?token=x','http://user@127.0.0.1:42340/bridge/v1','https://example.com/bridge/v1','http://192.168.1.4:42/bridge/v1'])
      expect(()=>validateOfficialConnection({url,token:'t'},'mac')).toThrow();
    expect(()=>validateOfficialConnection(config,'ipad')).toThrow();
    expect(()=>validateOfficialConnection({url:'http://192.168.attacker.example:42340/bridge/v1',token:'ipad'},'ipad')).toThrow();
  });
  it('passes arbitrary code as JSON data, pins the window, and fetches an async result without resubmitting',async()=>{
    const h=fixture((action)=>action==='status'?status:action==='submit'?{state:'running'}:{ok:true,state:'completed',value:42});
    expect(await h.client.call('/execute',{code:'return `中文 ${42}`; // \\"',requestId:'stable'})).toMatchObject({value:42});
    expect(h.calls.map(x=>x.action)).toEqual(['status','submit','result']);
    expect(h.calls[1].payload.sessionId).toBe('native-session');
    expect(h.transport.every(x=>x.url.startsWith(config.url+'/addons/noema.extension.agent/') && x.options.redirect==='error')).toBe(true);
    expect(h.transport.every(x=>x.options.headers.Authorization==='Bearer official-test')).toBe(true);
  });
  it('passes a previously pinned session to the native guard without re-reading status',async()=>{
    const h=fixture((_action,payload)=>({ok:false,state:'not_started',error:payload.sessionId==='old'?'Session changed':'unexpected'}));
    expect(await h.client.call('/execute',{code:'return 1',sessionId:'old'})).toMatchObject({state:'not_started',error:'Session changed'});
    expect(h.calls.map(x=>x.action)).toEqual(['submit']);
  });
  it('never automatically retries a failed submit',async()=>{
    const h=fixture(action=>{if(action==='status')return status;throw new Error('connection lost');});
    await expect(h.client.call('/execute',{code:'return 1',requestId:'known'})).rejects.toThrow('Request known: execution outcome unknown');
    expect(h.calls.map(x=>x.action)).toEqual(['status','submit']);
  });
  it('rejects an oversized execution envelope before any network call',async()=>{
    const h=fixture(()=>status);
    await expect(h.client.call('/execute',{code:'字'.repeat(100000)})).rejects.toThrow('not submitted');
    expect(h.transport).toHaveLength(0);
  });
  it('treats a native timeout as unknown and only queries when asked',async()=>{
    const h=fixture(action=>action==='status'?status:{ok:false,state:'timed_out',execution:'unknown'});
    expect(await h.client.call('/execute',{code:'return 1'})).toMatchObject({state:'timed_out'});
    expect(h.calls.map(x=>x.action)).toEqual(['status','submit']);
  });
  it('page cache treats prototype names as data and rejects oversized envelopes before fetch',async()=>{
    const html=readFileSync(new URL('../plugins/marginnote/panel.html',import.meta.url),'utf8');
    let nativeCalls=0;
    const context:any=vm.createContext({window:{},TextEncoder,AbortController,setTimeout,clearTimeout,fetch:async()=>{nativeCalls++;return {ok:true,json:async()=>({ok:true})};}});
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1],context);
    const page=context.window.noema;
    page.request('__proto__','status',{});page.request('__proto__','status',{});
    await new Promise(resolve=>setImmediate(resolve));
    expect(page.result('__proto__')).toMatchObject({state:'completed',value:{ok:true}});expect(nativeCalls).toBe(1);
    expect(()=>page.request('large','submit',{code:'字'.repeat(300000)})).toThrow('600 KiB');
  });
});
