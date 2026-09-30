let currentRuntime = null;
export function withPgfMathRuntime(runtime, fn) {
    const previous = currentRuntime;
    currentRuntime = runtime;
    try {
        return fn();
    }
    finally {
        currentRuntime = previous;
    }
}
export function getCurrentPgfMathRuntime() {
    return currentRuntime;
}
