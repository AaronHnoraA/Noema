// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createOfficialClient } from "../plugins/marginnote/official-client.mjs";

const source = readFileSync(new URL("../plugins/marginnote/main.js", import.meta.url), "utf8");
function host(config: {url:string;token:string} | null = { url: "http://127.0.0.1:3212/v1/marginnote", token: "t".repeat(43) }) {
  const requests: any[] = [], timers: any[] = [], documents = [{ docMd5: "pdf1", docTitle: "Native PDF" }];
  let methods: any, classMethods: any, sequence = 0, allowed = true, loads = 0;
  const db = { allDocuments: () => documents };
  const app = { appVersion: "4.4.6", build: "test", osType: 2, studyController: () => ({ notebookController: { notebookId: "book1" }, readerController: {} }), nativeValue: () => 7 };
  const owner: any = { window: { nativeWindow: true } };
  const panel: any = {view: {}, tornDown: false, floatingVisible: false,
    loadPanel() { loads++; return true; }, showFloatingIn() { throw new Error("Must never present UI"); },
    teardown() {this.tornDown=true;} };
  const context: any = vm.createContext({
    JSB: { log() {}, defineClass: (_name: string, instance: any, classes: any) => { methods = instance; classMethods = classes; return instance; } },
    NSString: { stringWithContentsOfFile: () => config === null ? null : JSON.stringify(config),
      stringWithContentsOfData: (data: unknown) => data, stringWithString: (value: string) => value },
    NSData: { dataWithStringEncoding: (value: string) => ({ text: value, length: () => Buffer.byteLength(value) }) },
    NSUUID: { UUID: () => ({ UUIDString: () => "session-" + ++sequence }) },
    NSUserDefaults: { standardUserDefaults: () => ({ objectForKey: () => true, setObjectForKey: () => {} }) },
    NSMutableURLRequest: { requestWithURL: (url: string) => ({ url, setHTTPMethod() {}, setTimeoutInterval() {}, setAllHTTPHeaderFields() {}, setHTTPBody(body: { text: string }) { requests.push({ url, body: JSON.parse(body.text) }); } }) },
    NSURLConnection: { sendAsynchronousRequestQueueCompletionHandler: (_request: any, _queue: any, callback: any) => { requests[requests.length - 1].callback = callback; } },
    NSOperationQueue: { mainQueue: () => ({}) }, NSURL: { URLWithString: (url: string) => url },
    NSTimer: { scheduledTimerWithTimeInterval: (_delay: number, _repeat: boolean, callback: any) => {
      const timer = { callback, invalid: false, invalidate() { this.invalid = true; } }; timers.push(timer); return timer;
    } },
    Application: { sharedInstance: () => app }, Database: { sharedInstance: () => db },
    Note: { customHostAPI: () => "all-native-APIs" }, self: owner, AddonWebPanel: {panel: () => { if (!allowed) return null; panel.tornDown=false; return panel; }},
  });
  vm.runInContext(source, context);
  vm.runInContext("JSB.newAddon('/addon')", context);
  methods.sceneWillConnect();
  function complete(task: any = null) {
    const request = requests.at(-1);
    // JSB returns a truthy NSNull wrapper for a successful native callback.
    request.callback({ statusCode: () => 200 }, JSON.stringify({ ok: true, task }), { toString: () => "[object NSNull]" });
  }
  async function execute(code: string, args = {}, id = "task1") {
    complete({ id, code, args, deadline: Date.now() + 10000 });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return requests.at(-1).body.completed;
  }
  return { context, owner, requests, timers, methods, classMethods, execute, complete, documents, panel, loads: () => loads, authorize: (value: boolean) => {allowed=value;} };
}

describe("MarginNote plugin execution", () => {
  it("MN-C5: refuses remote connection configuration before issuing requests", () => {
    expect(() => host({ url: "http://example.com/v1/marginnote", token: "t".repeat(43) })).toThrow("Invalid local");
  });
  it("MN-C3: request IDs that name prototype properties still execute exactly once", async () => {
    const h = host();
    const code = "bridge.state.n=(bridge.state.n||0)+1; return bridge.state.n;";
    for (const id of ["constructor", "__proto__", "toString"]) {
      const first = await h.execute(code, {}, id);
      expect(first.ok).toBe(true);
      expect(await h.execute(code, {}, id)).toEqual(first);
    }
    expect(h.owner._noemaRuntime.state.n).toBe(3);
  });
  it("MN-C2: applies the result limit to UTF-8 bytes and bounds thrown errors", async () => {
    const h = host();
    expect(await h.execute("return '字'.repeat(400000)")).toMatchObject({ ok: false, error: { name: "SerializationError" } });
    expect(await h.execute("return '字'.repeat(100000)", {}, "small")).toMatchObject({ ok: true });
    const result = await h.execute("throw new Error('字'.repeat(1000000))", {}, "error");
    expect(result.ok).toBe(false);
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThan(200000);
  });
  it("MN-C1/C2: exposes every host global and direct native objects", async () => {
    const h = host();
    const result = await h.execute("console.log('native', app.nativeValue()); return { value: Note.customHostAPI(), docs: db.allDocuments(), args };", { test: true });
    expect(result).toMatchObject({ ok: true, value: { value: "all-native-APIs", docs: h.documents, args: { test: true } }, logs: [{ text: "native 7" }] });
  });
  it("MN-C2: awaits Promise results and retains native handles between calls", async () => {
    const h = host();
    expect(await h.execute("bridge.state.doc = db.allDocuments()[0]; return await Promise.resolve(bridge.state.doc.docMd5);")).toMatchObject({ ok: true, value: "pdf1" });
    expect(await h.execute("return bridge.state.doc.docTitle;", {}, "task2")).toMatchObject({ ok: true, value: "Native PDF" });
  });
  it("MN-C2/C3: native callbacks can settle deferred code and in-flight duplicates are ignored", async () => {
    const h = host();
    const task = { id: "deferred", code: "bridge.defer(); bridge.state.count=(bridge.state.count||0)+1; bridge.state.done=bridge.done;", args: {}, deadline: Date.now() + 10000 };
    h.complete(task);
    const pending = h.requests[0];
    pending.callback({ statusCode: () => 200 }, JSON.stringify({ task }), null);
    expect(h.owner._noemaRuntime.state.count).toBe(1);
    h.owner._noemaRuntime.state.done(8);
    expect(h.requests.at(-1).body.completed).toMatchObject({ ok: true, value: 8 });
  });
  it("MN-C2: returns syntax, async and serialization failures to the agent", async () => {
    const h = host();
    expect(await h.execute("return (;")).toMatchObject({ ok: false, error: { name: "SyntaxError" } });
    expect(await h.execute("await Promise.reject(new Error('native failure'));", {}, "task2")).toMatchObject({ ok: false, error: { message: "native failure" } });
    expect(await h.execute("const x = {}; x.x=x; return x;", {}, "task3")).toMatchObject({ ok: false, error: { name: "SerializationError" } });
  });
  it("MN-C3: does not repeat native mutations when a task response repeats", async () => {
    const h = host();
    const code = "bridge.state.count = (bridge.state.count || 0) + 1; return bridge.state.count;";
    expect(await h.execute(code)).toMatchObject({ value: 1 });
    expect(await h.execute(code)).toMatchObject({ value: 1 });
    expect(await h.execute("return bridge.state.count", {}, "task2")).toMatchObject({ value: 1 });
  });
  it("MN-C4: ignores in-flight callbacks after disconnect and invalidates timers", async () => {
    const h = host(); h.complete();
    const poll = h.requests[0];
    h.methods.sceneDidDisconnect();
    expect(h.timers.every((timer) => timer.invalid)).toBe(true);
    poll.callback({ statusCode: () => 200 }, JSON.stringify({ task: { id: "stale", code: "throw new Error('must not run')" } }), null);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(h.requests.at(-1).url).toMatch(/disconnect$/);
  });
  it("MN-C4: Mac focus changes do not stop agent access", () => {
    const h = host(); h.classMethods.applicationDidEnterBackground();
    expect(h.requests).toHaveLength(1);
    expect(h.owner._noemaRuntime.dead).toBe(false);
  });
});

describe("MarginNote official panel execution", () => {
  function official() {
    const h = host(null);
    const sessionId = h.panel.onMessage('status', {}).sessions[0].id;
    const submit = (requestId: string, code: string, extra = {}) => h.panel.onMessage('submit', {requestId,code,sessionId,...extra});
    const result = (requestId: string) => h.panel.onMessage('result', {requestId,sessionId});
    return {...h,submit,result,sessionId};
  }
  it("uses no host connection or recurring timer while idle", () => {
    const h = official(); expect(h.requests).toHaveLength(0); expect(h.timers).toHaveLength(0);
    expect(h.panel.onMessage('status', {})).toMatchObject({protocol:1,scope:'active-panel',sessions:[{info:{transport:'official',addonVersion:'1.0.8',ui:'none',backgroundReady:true}}]});
  });
  it("starts ready without a click and reuses the invisible page on activation and capsule", () => {
    const h = official();
    expect(h.loads()).toBe(1); expect(h.panel.floatingVisible).toBe(false);
    h.methods.sceneDidBecomeActive(); h.classMethods.applicationWillEnterForeground(); h.methods.openNoemaPanel();
    expect(h.loads()).toBe(1); expect(h.timers).toHaveLength(0);
    expect(h.methods.queryAddonCommandStatus().checked).toBe(true);
  });
  it("rebuilds a torn-down page and defers denied activation to a later host lifecycle event", () => {
    const h = official(); h.panel.teardown(); h.authorize(false);
    h.methods.sceneDidBecomeActive();
    expect(h.owner._noemaPanel).toBeNull(); expect(h.loads()).toBe(1);
    expect(h.owner._noemaRuntime.lastError).toMatch(/authorize/);
    expect(h.timers).toHaveLength(0); expect(h.methods.queryAddonCommandStatus().checked).toBe(false);
    h.authorize(true); h.methods.sceneDidBecomeActive();
    expect(h.loads()).toBe(2); expect(h.panel.floatingVisible).toBe(false);
    expect(h.owner._noemaRuntime.lastError).toBe("");
  });
  it("releases the iPad background session and restores it without UI on foreground", () => {
    const h = official(); vm.runInContext("Application.sharedInstance().osType=1",h.context);
    h.classMethods.applicationDidEnterBackground();
    expect(h.panel.tornDown).toBe(true); expect(h.owner._noemaRuntime.dead).toBe(true);
    h.classMethods.applicationWillEnterForeground();
    expect(h.owner._noemaRuntime.dead).toBe(false); expect(h.loads()).toBe(2);
    expect(h.owner._noemaRuntime.id).not.toBe(h.sessionId);
    expect(h.panel.floatingVisible).toBe(false); expect(h.requests).toHaveLength(0);
  });
  it("rejects addon-wide fallback routing when multiple native windows are connected", () => {
    const h = official();
    h.context.self = {window: {nativeWindow: "second"}};
    h.methods.sceneWillConnect();
    expect(h.panel.onMessage('status', {})).toMatchObject({ok:false,state:'not_started'});
    expect(h.submit('wrong-window','bridge.state.n=1;')).toMatchObject({ok:false,state:'not_started'});
    expect(h.timers).toHaveLength(0);
  });
  it("pins the native session and does not execute code in the URL callback", () => {
    const h = official();
    expect(h.submit('a','bridge.state.n=1;', {sessionId:'another-window'})).toMatchObject({ok:false,state:'not_started'});
    expect(h.submit('a','bridge.state.n=1; return 7;')).toMatchObject({state:'running'});
    expect(h.owner._noemaRuntime.state.n).toBeUndefined(); h.timers[0].callback();
    expect(h.result('a')).toMatchObject({ok:true,state:'completed',value:7});
    expect(h.requests).toHaveLength(0);
  });
  it("deduplicates matching requests, rejects conflicting IDs and serializes async work", () => {
    const h = official(), code = 'bridge.defer(); bridge.state.done=bridge.done; bridge.state.n=(bridge.state.n||0)+1;';
    h.submit('__proto__',code); h.timers[0].callback();
    expect(h.submit('__proto__',code)).toMatchObject({state:'running'});
    expect(h.submit('__proto__','return 2;')).toMatchObject({state:'conflict'});
    expect(h.submit('second','return 2;')).toMatchObject({state:'not_started'});
    h.owner._noemaRuntime.state.done(9);
    expect(h.submit('__proto__',code)).toMatchObject({value:9}); expect(h.owner._noemaRuntime.state.n).toBe(1);
  });
  it("timeout is unknown until a late native callback finishes", () => {
    const h = official(); h.submit('late','bridge.defer(); bridge.state.done=bridge.done;'); h.timers[0].callback();
    h.owner._noemaRuntime.jobs.late.deadline = Date.now()-1;
    expect(h.result('late')).toMatchObject({state:'timed_out',execution:'unknown'});
    expect(h.submit('next','return 2;')).toMatchObject({state:'not_started'});
    h.owner._noemaRuntime.state.done(5);
    expect(h.result('late')).toMatchObject({state:'completed',value:5,completedAfterDeadline:true});
  });
  it("does not replay an evicted result and bounds retained payload bytes", () => {
    const h = official();
    for (let i=0;i<12;i++) { h.submit('job'+i,"return 'x'.repeat(900000);"); h.timers.at(-1).callback(); }
    expect(h.owner._noemaRuntime.jobBytes).toBeLessThanOrEqual(8*1024*1024);
    expect(h.result('job0')).toMatchObject({state:'result_evicted'});
    expect(h.submit('job0','throw new Error("must not execute")')).toMatchObject({state:'result_evicted'});
  });
  it("closing the scene ends the session and tears down the panel without sending network requests", () => {
    const h = official(); h.submit('a','throw new Error("must not start")');
    h.methods.sceneDidDisconnect(); h.timers[0].callback();
    expect(h.panel.tornDown).toBe(true); expect(h.owner._noemaRuntime.dead).toBe(true); expect(h.requests).toHaveLength(0);
  });
  it("runs the shipped client, page and native executor together and recovers a stable request", async () => {
    const h = official();
    const html=readFileSync(new URL('../plugins/marginnote/panel.html',import.meta.url),'utf8');
    const page:any=vm.createContext({window:{},TextEncoder,AbortController,setTimeout,clearTimeout,
      fetch:async(url:string,options:any)=>({ok:true,json:async()=>h.panel.onMessage(url.slice('/addon/'.length),JSON.parse(options.body))})});
    vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)![1],page);
    page.noema=page.window.noema;
    const client=createOfficialClient({url:'http://127.0.0.1:42340/bridge/v1',token:'official-test',device:'mac'}, {
      pause:async()=>{await new Promise(resolve=>setImmediate(resolve));},
      fetchImpl:async(_url:any,options:any)=>{
        for(const timer of h.timers) if(!timer.ran){timer.ran=true;timer.callback();}
        const value=vm.runInContext('(function(){'+JSON.parse(options.body).js+'})()',page);
        return new Response(JSON.stringify({value}));
      }
    });
    const payload={sessionId:h.sessionId,requestId:'real-contract',code:'bridge.state.n=(bridge.state.n||0)+1; return await Promise.resolve(bridge.state.n);'};
    expect(await client.call('/execute',payload)).toMatchObject({state:'completed',value:1});
    for (let i=0;i<24;i++) expect(await client.status()).toMatchObject({ok:true});
    expect(await client.call('/execute',payload)).toMatchObject({state:'completed',value:1});
    expect(await client.call('/requests/real-contract',{sessionId:h.sessionId})).toMatchObject({value:1});
    expect(h.owner._noemaRuntime.state.n).toBe(1); expect(h.requests).toHaveLength(0);
  });
});
