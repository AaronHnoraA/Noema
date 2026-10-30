// @vitest-environment node
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "@voidzero-dev/vite-plus-test";

const source = readFileSync(new URL("../plugins/marginnote/main.js", import.meta.url), "utf8");
function host() {
  const requests: any[] = [], timers: any[] = [], documents = [{ docMd5: "pdf1", docTitle: "Native PDF" }];
  let methods: any, classMethods: any, sequence = 0;
  const db = { allDocuments: () => documents };
  const app = { appVersion: "4.4.6", build: "test", osType: 2, studyController: () => ({ notebookController: { notebookId: "book1" }, readerController: {} }), nativeValue: () => 7 };
  const owner: any = { window: { nativeWindow: true } };
  const context: any = vm.createContext({
    JSB: { log() {}, defineClass: (_name: string, instance: any, classes: any) => { methods = instance; classMethods = classes; return instance; } },
    NSString: { stringWithContentsOfFile: () => JSON.stringify({ url: "http://127.0.0.1:3212/v1/marginnote", token: "test" }),
      stringWithContentsOfData: (data: unknown) => data, stringWithString: (value: string) => value },
    NSData: { dataWithStringEncoding: (value: string) => value },
    NSUUID: { UUID: () => ({ UUIDString: () => "session-" + ++sequence }) },
    NSUserDefaults: { standardUserDefaults: () => ({ objectForKey: () => true, setObjectForKey: () => {} }) },
    NSMutableURLRequest: { requestWithURL: (url: string) => ({ url, setHTTPMethod() {}, setTimeoutInterval() {}, setAllHTTPHeaderFields() {}, setHTTPBody(body: string) { requests.push({ url, body: JSON.parse(body) }); } }) },
    NSURLConnection: { sendAsynchronousRequestQueueCompletionHandler: (_request: any, _queue: any, callback: any) => { requests[requests.length - 1].callback = callback; } },
    NSOperationQueue: { mainQueue: () => ({}) }, NSURL: { URLWithString: (url: string) => url },
    NSTimer: { scheduledTimerWithTimeInterval: (_delay: number, _repeat: boolean, callback: any) => {
      const timer = { callback, invalid: false, invalidate() { this.invalid = true; } }; timers.push(timer); return timer;
    } },
    Application: { sharedInstance: () => app }, Database: { sharedInstance: () => db },
    Note: { customHostAPI: () => "all-native-APIs" }, self: owner,
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
  return { context, owner, requests, timers, methods, classMethods, execute, complete, documents };
}

describe("MarginNote plugin execution", () => {
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
