/* Runs inside MarginNote's own JavaScriptCore. No API proxy or business model. */
JSB.newAddon = function (mainPath) {
  var instances = [];
  var globalObject = Function("return this")();
  var bundled = JSON.parse(String(NSString.stringWithContentsOfFile(mainPath + "/connection.json")));
  var enabledKey = "noema.agent.enabled";
  function nil(value) { return value === null || value === undefined || String(value) === "[object NSNull]"; }

  function get(object, key) {
    if (!object) return null;
    var value = object[key];
    return typeof value === "function" ? value.call(object) : value;
  }
  function uuid() { return String(NSUUID.UUID().UUIDString()); }
  function nativeContext(owner) {
    var app = Application.sharedInstance();
    var study = app.studyController(owner.window);
    return { app: app, db: Database.sharedInstance(), window: owner.window, study: study,
      reader: study ? study.readerController : null, notebook: study ? study.notebookController : null };
  }
  function info(owner) {
    var c = nativeContext(owner);
    var document = c.reader && c.reader.currentDocumentController;
    return { appVersion: String(get(c.app, "appVersion") || ""), build: String(get(c.app, "build") || ""),
      addonVersion: "1.0.3", stage: owner._noemaRuntime && owner._noemaRuntime.stage,
      lastError: owner._noemaRuntime && owner._noemaRuntime.lastError,
      osType: get(c.app, "osType"), notebookId: get(c.notebook, "notebookId"), docMd5: get(document, "docMd5") };
  }
  function request(path, body, callback) {
    var req = NSMutableURLRequest.requestWithURL(NSURL.URLWithString(bundled.url + path));
    req.setHTTPMethod("POST");
    req.setTimeoutInterval(25);
    req.setAllHTTPHeaderFields({ "Content-Type": "application/json", Authorization: "Bearer " + bundled.token });
    req.setHTTPBody(NSData.dataWithStringEncoding(JSON.stringify(body), 4));
    NSURLConnection.sendAsynchronousRequestQueueCompletionHandler(req, NSOperationQueue.mainQueue(), function (response, data, error) {
      var payload;
      try {
        if (!nil(error)) throw new Error(String(get(error, "localizedDescription") || error));
        payload = JSON.parse(String(NSString.stringWithContentsOfData(data)));
        if (Number(get(response, "statusCode")) !== 200) throw new Error(payload.error || "HTTP " + get(response, "statusCode"));
      } catch (failure) { callback(failure, null); return; }
      callback(null, payload);
    });
  }
  function later(runtime, ms, callback) {
    var timer = NSTimer.scheduledTimerWithTimeInterval(ms / 1000, false, function () {
      runtime.timers = runtime.timers.filter(function (item) { return item !== timer; });
      if (!runtime.dead) callback();
    });
    runtime.timers.push(timer);
    return timer;
  }
  function inspect(object) {
    var levels = [], current = object;
    for (var i = 0; current && i < 8; i++, current = Object.getPrototypeOf(current)) {
      levels.push(Object.getOwnPropertyNames(current));
    }
    return { type: typeof object, properties: levels };
  }
  function execute(owner, runtime, task, done) {
    var logs = [], logBytes = 0;
    var settled = false, deferred = false;
    runtime.stage = "executing";
    var consoleProxy = {};
    ["log", "info", "warn", "error", "debug"].forEach(function (level) {
      consoleProxy[level] = function () {
        if (logs.length >= 200 || logBytes >= 64 * 1024) return;
        var text = Array.prototype.map.call(arguments, function (item) {
          try { return typeof item === "string" ? item : JSON.stringify(item); }
          catch (_) { return String(item); }
        }).join(" ").slice(0, 4096);
        logs.push({ level: level, text: text }); logBytes += text.length;
      };
    });
    function finish(ok, value, error) {
      if (runtime.dead || settled) return;
      settled = true;
      runtime.stage = "result-ready";
      try {
        var clean = value === undefined ? null : JSON.parse(JSON.stringify(value));
        if (JSON.stringify(clean).length > 1024 * 1024) throw new Error("Result exceeds 1 MiB; return file paths or read data in chunks");
        done({ id: task.id, ok: ok, value: clean, error: error || null, logs: logs });
      } catch (failure) { done({ id: task.id, ok: false, error: { name: "SerializationError", message: String(failure.message || failure) }, logs: logs }); }
    }
    try {
      if (Date.now() >= task.deadline) { done({ id: task.id, ok: false, error: { name: "Expired", message: "Task expired before execution" }, logs: logs }); return; }
      var c = nativeContext(owner);
      var bridge = { state: runtime.state, mainPath: mainPath, sessionId: runtime.id,
        globals: function () { return Object.getOwnPropertyNames(globalObject).sort(); },
        inspect: inspect,
        sleep: function (ms) { return new Promise(function (resolve) { later(runtime, ms, resolve); }); },
        defer: function () { deferred = true; },
        done: function (value) { finish(true, value); },
        fail: function (error) { rejected(error); } };
      function rejected(error) {
          finish(false, null, { name: String(error && error.name || "Error"), message: String(error && error.message || error), stack: String(error && error.stack || "") });
      }
      var parameters = ["args", "bridge", "app", "db", "window", "study", "reader", "notebook", "console", "self"];
      var run;
      try { run = Function.apply(null, parameters.concat(['"use strict";\n' + task.code])); }
      catch (syntaxError) {
        if (syntaxError.name !== "SyntaxError") throw syntaxError;
        run = Function.apply(null, parameters.concat(['"use strict"; return (async function () {\n' + task.code + '\n}).call(self);']));
      }
      var result = run.call(owner, task.args, bridge, c.app, c.db, c.window, c.study, c.reader, c.notebook, consoleProxy, owner);
      if (result && typeof result.then === "function") { runtime.stage = "awaiting-promise"; result.then(function (value) { finish(true, value); }, rejected); }
      else if (!deferred) finish(true, result);
      function pulse() {
        if (settled || runtime.dead) return;
        try { request("/heartbeat", { sessionId: runtime.id, info: info(owner) }, function () {}); } catch (_) {}
        later(runtime, 2000, pulse);
      }
      if (!settled) later(runtime, 2000, pulse);
    } catch (error) {
      finish(false, null, { name: String(error.name || "Error"), message: String(error.message || error), stack: String(error.stack || "") });
    }
  }
  function poll(owner, runtime) {
    if (runtime.dead) return;
    var completed = runtime.completed;
    function retry(error) {
      var message = String(error.message || error);
      if (runtime.lastError !== message) JSB.log("Noema Agent: %@", message);
      runtime.lastError = message;
      later(runtime, 3000, function () { poll(owner, runtime); });
    }
    try { request("/poll", { sessionId: runtime.id, info: info(owner), completed: completed }, function (error, payload) {
      if (runtime.dead) return;
      if (error) {
        retry(error);
        return;
      }
      runtime.lastError = "";
      if (runtime.completed === completed) runtime.completed = null;
      var task = payload.task;
      if (!task) { later(runtime, 100, function () { poll(owner, runtime); }); return; }
      // A retried response must never repeat a native side effect.
      if (runtime.results[task.id]) { runtime.completed = runtime.results[task.id]; poll(owner, runtime); return; }
      if (runtime.executingId) return;
      runtime.executingId = task.id;
      execute(owner, runtime, task, function (result) {
        runtime.executingId = null;
        runtime.results[task.id] = result;
        runtime.resultIds.push(task.id);
        while (runtime.resultIds.length > 32) delete runtime.results[runtime.resultIds.shift()];
        runtime.completed = result;
        runtime.stage = "polling";
        poll(owner, runtime);
      });
    }); } catch (error) { retry(error); }
  }
  function start(owner) {
    if (owner._noemaRuntime && !owner._noemaRuntime.dead) return;
    var runtime = { id: uuid(), timers: [], results: {}, resultIds: [], state: {}, dead: false, completed: null };
    owner._noemaRuntime = runtime;
    poll(owner, runtime);
  }
  function stop(owner) {
    var runtime = owner._noemaRuntime;
    if (!runtime || runtime.dead) return;
    runtime.dead = true;
    runtime.timers.forEach(function (timer) { timer.invalidate(); });
    runtime.timers = []; runtime.state = {}; runtime.results = {}; runtime.completed = null;
    try { request("/disconnect", { sessionId: runtime.id }, function () {}); } catch (_) {}
  }
  function enabled() { return NSUserDefaults.standardUserDefaults().objectForKey(enabledKey) !== false; }
  return JSB.defineClass("NoemaAgentAddon : JSExtension", {
    sceneWillConnect: function () { instances.push(self); if (enabled()) start(self); },
    sceneDidDisconnect: function () { var owner = self; stop(owner); instances = instances.filter(function (item) { return item !== owner; }); },
    sceneDidBecomeActive: function () { if (enabled()) start(self); },
    queryAddonCommandStatus: function () { return { image: "icon.png", object: self, selector: "toggleNoemaAgent:", checked: !!(self._noemaRuntime && !self._noemaRuntime.dead) }; },
    toggleNoemaAgent: function () {
      var owner = self, active = owner._noemaRuntime && !owner._noemaRuntime.dead;
      NSUserDefaults.standardUserDefaults().setObjectForKey(!active, enabledKey);
      instances.forEach(function (item) { if (active) stop(item); else start(item); });
      Application.sharedInstance().showHUD(active ? "Noema Agent 已断开" : "Noema Agent 正在连接", owner.window, 2);
      var study = Application.sharedInstance().studyController(owner.window);
      if (study) study.refreshAddonCommands();
    },
  }, {
    addonWillDisconnect: function () { instances.forEach(stop); instances = []; },
    applicationDidEnterBackground: function () {
      if (Number(get(Application.sharedInstance(), "osType")) !== 2) instances.forEach(stop);
    },
    applicationWillEnterForeground: function () { if (enabled()) instances.forEach(start); },
  });
};
