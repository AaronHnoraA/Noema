import { expect, test } from "@voidzero-dev/vite-plus-test";
import { appendRunEvents, mergeRunRef, runSnapshotMatches } from "../aaronnote/research-run-state.ts";

test("opening source or refreshing metadata preserves the active Run and session", () => {
  const ref = { runId: "run_new", sessionId: "session_new", sessionName: "read", agent: "opencode" };
  expect(mergeRunRef(ref, { runId: "", sessionId: "", sessionName: "", agent: "" })).toEqual(ref);
  expect(mergeRunRef(ref, { sessionId: "" })).toEqual(ref);
  expect(mergeRunRef(ref, { runId: "run_other", sessionId: "", agent: "codex" })).toMatchObject({
    runId: "run_other", sessionId: "", agent: "codex",
  });
});

test("late snapshots from the previous Run cannot update the current Run", () => {
  expect(runSnapshotMatches("run_new", { run: { id: "run_old" } })).toBe(false);
  expect(runSnapshotMatches("run_new", { run: { id: "run_new" } })).toBe(true);
  expect(runSnapshotMatches(undefined, {})).toBe(false);
});

test("replayed events and duplicates within a page are stored only once", () => {
  const previous = [{ seq: 1 }];
  expect(appendRunEvents(previous, [{ seq: 1 }])).toBe(previous);
  expect(appendRunEvents(previous, [{ seq: 2 }, { seq: 2 }, { seq: 3 }])).toEqual([{ seq: 1 }, { seq: 2 }, { seq: 3 }]);
});
