// Small async helpers ported from microsoft/vscode-jupyter (MIT)
// src/platform/common/utils/async.ts — trimmed to what the raw kernel stack needs.

export function noop() {}

/** Matches the `[aaronnote-jupyter] ...` prefix convention used across server/lib. */
export function makeLogger(stderr = process.stderr) {
  return {
    error(message, ex) {
      stderr.write(`[aaronnote-jupyter] ${message}${ex ? `: ${ex?.message || ex}` : ""}\n`);
    },
    warn(message) {
      stderr.write(`[aaronnote-jupyter] ${message}\n`);
    },
  };
}

export function sleep(timeout) {
  return new Promise((resolve) => setTimeout(() => resolve(timeout), timeout));
}

/** Resolves with the first of `promises` to settle, or `defaultValue` after `timeout` ms. */
export function raceTimeout(timeout, defaultValue, ...promises) {
  const isPromise = typeof defaultValue?.then === "function";
  const resolveValue = isPromise ? undefined : defaultValue;
  if (isPromise) promises.push(defaultValue);

  let resolveTimer;
  const timer = setTimeout(() => resolveTimer?.(resolveValue), timeout);
  return Promise.race([
    Promise.race(promises).finally(() => clearTimeout(timer)),
    new Promise((resolve) => (resolveTimer = resolve)),
  ]);
}

export function createDeferred() {
  let resolveFn;
  let rejectFn;
  let resolved = false;
  let rejected = false;
  let value;
  const promise = new Promise((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });
  return {
    get promise() {
      return promise;
    },
    get resolved() {
      return resolved;
    },
    get rejected() {
      return rejected;
    },
    get completed() {
      return resolved || rejected;
    },
    get value() {
      return value;
    },
    resolve(v) {
      value = v;
      resolved = true;
      resolveFn(v);
    },
    reject(reason) {
      rejected = true;
      rejectFn(reason);
    },
  };
}
