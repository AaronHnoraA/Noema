import { afterEach, describe, expect, test, vi } from "@voidzero-dev/vite-plus-test";

import { closeAgendaView, openAgendaView, refreshAgendaView } from "../aaronnote/agenda-view.ts";
import type { AgendaViewDeps } from "../aaronnote/agenda-view.ts";
import type { AgendaMsg } from "../aaronnote/api-client.ts";

const emptyAgenda: AgendaMsg = {
  type: "agenda",
  range: { from: "2026-07-07", to: "2026-07-07", today: "2026-07-07" },
  days: [{ date: "2026-07-07", entries: [] }],
  todos: [],
  lints: [],
  stats: { open: 0, doing: 0, done: 0, cancelled: 0, blocked: 0, overdue: 0 },
};

const projectAgenda: AgendaMsg = {
  type: "agenda",
  range: { from: "2026-07-07", to: "2026-07-07", today: "2026-07-07" },
  days: [{
    date: "2026-07-07",
    entries: [
      { kind: "scheduled", label: "Scheduled", todoId: "alpha-todo", date: "2026-07-07" },
      { kind: "scheduled", label: "Scheduled", todoId: "beta-todo", date: "2026-07-07" },
    ],
  }],
  todos: [
    {
      id: "alpha-todo",
      file: "alpha.md",
      noteTitle: "Alpha Note",
      text: "Alpha task",
      status: "todo",
      canon: { project: "alpha" },
    },
    {
      id: "beta-todo",
      file: "beta.md",
      noteTitle: "Beta Note",
      text: "Beta task",
      status: "todo",
      canon: { project: "beta" },
    },
  ],
  projectModel: [
    { key: "alpha", title: "Alpha Project", total: 1, open: 1, progress: 0, childTodoIds: ["alpha-todo"] },
    { key: "beta", title: "Beta Project", total: 1, open: 1, progress: 0, childTodoIds: ["beta-todo"] },
  ],
  clocktable: {
    tasks: [
      { todoId: "alpha-todo", text: "Alpha task", minutes: 60 },
      { todoId: "beta-todo", text: "Beta task", minutes: 30 },
    ],
    byProject: { alpha: 60, beta: 30 },
    byDay: { "2026-07-07": 90 },
    running: null,
  },
  gantt: {
    tasks: [
      { id: "alpha-todo", name: "Alpha task", project: "alpha", start: "2026-07-07", end: "2026-07-08" },
      { id: "beta-todo", name: "Beta task", project: "beta", start: "2026-07-07", end: "2026-07-08" },
    ],
    backlog: [],
    milestones: [
      { id: "alpha-ms", name: "Alpha milestone", project: "alpha", date: "2026-07-09" },
      { id: "beta-ms", name: "Beta milestone", project: "beta", date: "2026-07-09" },
    ],
    lanes: [
      { key: "alpha", name: "Alpha Project", childTaskIds: ["alpha-todo"] },
      { key: "beta", name: "Beta Project", childTaskIds: ["beta-todo"] },
    ],
  },
  lints: [
    { todoId: "alpha-todo", kind: "broken-ref", message: "Alpha lint" },
    { todoId: "beta-todo", kind: "broken-ref", message: "Beta lint" },
  ],
  stats: { open: 2, doing: 0, done: 0, cancelled: 0, blocked: 0, overdue: 0 },
};

function deps(): AgendaViewDeps {
  return {
    api: {
      notes: {
        agenda: async () => emptyAgenda,
        createTodo: async () => ({}),
        patchTodo: async () => ({}),
        todoDepRef: async () => ({}),
        clockIn: async () => ({}),
        clockOut: async () => ({}),
      },
    },
    jumpToTodo: () => {},
    setStatus: () => {},
  };
}

function agendaWithTodo(id: string, text: string): AgendaMsg {
  return {
    ...emptyAgenda,
    days: [{
      date: "2026-07-07",
      entries: [{ kind: "scheduled", label: "Scheduled", todoId: id, date: "2026-07-07" }],
    }],
    todos: [{
      id,
      file: `${id}.md`,
      noteTitle: id,
      text,
      status: "todo",
      index: 1,
      source: `@@todo [${text}]`,
    }],
    stats: { open: 1, doing: 0, done: 0, cancelled: 0, blocked: 0, overdue: 0 },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  closeAgendaView();
});

describe("agenda keyboard handling", () => {
  test("does not treat Meta-q as the agenda q shortcut", async () => {
    await openAgendaView(deps());
    const overlay = document.querySelector<HTMLElement>(".aaronnote-agenda-full")!;

    const metaQ = new KeyboardEvent("keydown", {
      key: "q",
      code: "KeyQ",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(metaQ);
    expect(metaQ.defaultPrevented).toBe(false);
    expect(overlay.hidden).toBe(false);

    const plainQ = new KeyboardEvent("keydown", {
      key: "q",
      code: "KeyQ",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(plainQ);
    expect(plainQ.defaultPrevented).toBe(true);
    expect(overlay.hidden).toBe(true);
  });

  test("n creates a quick todo from the agenda", async () => {
    const d = deps();
    const createTodo = vi.fn(async () => ({ todo: { id: "new-todo" } }));
    d.api.notes.createTodo = createTodo;
    Object.defineProperty(window, "prompt", {
      value: vi.fn(() => "Write intro | ddl=today | prio=A"),
      configurable: true,
    });

    await openAgendaView(d);
    const key = new KeyboardEvent("keydown", {
      key: "n",
      code: "KeyN",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(key);
    await Promise.resolve();
    await Promise.resolve();

    expect(key.defaultPrevented).toBe(true);
    expect(createTodo).toHaveBeenCalledWith({ text: "Write intro", ddl: "today", prio: "A" });
  });

  test("refreshes from the header button and g shortcut", async () => {
    const d = deps();
    const agenda = vi.fn(async () => emptyAgenda);
    const setStatus = vi.fn();
    d.api.notes.agenda = agenda;
    d.setStatus = setStatus;

    await openAgendaView(d);
    expect(agenda).toHaveBeenCalledTimes(1);

    const refresh = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-header button")]
      .find((button) => button.textContent === "Refresh")!;
    refresh.click();
    await Promise.resolve();
    await Promise.resolve();
    expect(agenda).toHaveBeenCalledTimes(2);
    expect(setStatus).toHaveBeenLastCalledWith("Agenda refreshed");

    const key = new KeyboardEvent("keydown", {
      key: "g",
      code: "KeyG",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(key);
    await Promise.resolve();
    await Promise.resolve();

    expect(key.defaultPrevented).toBe(true);
    expect(agenda).toHaveBeenCalledTimes(3);
  });

  test("? opens the keyboard shortcut help in the agenda", async () => {
    await openAgendaView(deps());
    const overlay = document.querySelector<HTMLElement>(".aaronnote-agenda-full")!;

    const key = new KeyboardEvent("keydown", {
      key: "?",
      code: "Slash",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(key);

    expect(key.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-agenda-help]")).toBeTruthy();
    expect(document.body.textContent).toContain("Agenda shortcuts");
    expect(document.body.textContent).toContain("g");
    expect(document.body.textContent).toContain("Refresh");

    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(escape);

    expect(escape.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-agenda-help]")).toBeNull();
    expect(overlay.hidden).toBe(false);
  });

  test("? still opens help when the search field has focus", async () => {
    await openAgendaView(deps());
    const search = document.querySelector<HTMLInputElement>(".aaronnote-agenda-full-header input[type='search']")!;
    search.focus();

    const key = new KeyboardEvent("keydown", {
      key: "?",
      code: "Slash",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    search.dispatchEvent(key);

    expect(key.defaultPrevented).toBe(true);
    expect(document.querySelector("[data-agenda-help]")).toBeTruthy();
  });

  test("project filter supports Any and multi-select across the agenda", async () => {
    const d = deps();
    d.api.notes.agenda = async () => projectAgenda;
    await openAgendaView(d);

    expect(document.body.textContent).toContain("Alpha task");
    expect(document.body.textContent).toContain("Beta task");

    const projectButton = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-project-filter > button")]
      .find((button) => button.textContent === "Project: Any")!;
    projectButton.click();

    const alpha = document.querySelector<HTMLButtonElement>("[data-project-key='alpha']")!;
    alpha.click();
    expect(document.body.textContent).toContain("Project: Alpha Project");
    expect(document.body.textContent).toContain("Alpha task");
    expect(document.body.textContent).not.toContain("Beta task");
    expect(document.body.textContent).toContain("1 project · 1 open");

    const beta = document.querySelector<HTMLButtonElement>("[data-project-key='beta']")!;
    beta.click();
    expect(document.body.textContent).toContain("Projects: 2");
    expect(document.body.textContent).toContain("Alpha task");
    expect(document.body.textContent).toContain("Beta task");

    const any = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-project-menu button")]
      .find((button) => button.textContent === "Any")!;
    any.click();
    expect(document.body.textContent).toContain("Project: Any");
    expect(document.body.textContent).toContain("Alpha task");
    expect(document.body.textContent).toContain("Beta task");
  });

  test("project cards click into a single-project task analysis", async () => {
    const d = deps();
    d.api.notes.agenda = async () => projectAgenda;
    await openAgendaView(d);

    const projectsTab = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-tabs button")]
      .find((button) => button.textContent === "Projects")!;
    projectsTab.click();
    await Promise.resolve();
    await Promise.resolve();

    const alphaCard = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-project")]
      .find((button) => button.textContent?.includes("Alpha Project"))!;
    alphaCard.click();

    expect(document.body.textContent).toContain("Project: Alpha Project");
    expect(document.body.textContent).toContain("Alpha task");
    expect(document.body.textContent).not.toContain("Beta task");
    const listTab = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-tabs button")]
      .find((button) => button.textContent === "List")!;
    expect(listTab.className).toContain("is-active");
  });

  test("project filter is shared by gantt clocktable and lints views", async () => {
    const d = deps();
    d.api.notes.agenda = async () => projectAgenda;
    await openAgendaView(d);

    document.querySelector<HTMLButtonElement>(".aaronnote-agenda-full-project-filter > button")!.click();
    document.querySelector<HTMLButtonElement>("[data-project-key='alpha']")!.click();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    for (const label of ["Gantt", "Clock", "Lints"]) {
      const tab = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-tabs button")]
        .find((button) => button.textContent === label)!;
      tab.click();
      await Promise.resolve();
      await Promise.resolve();
      expect(document.body.textContent).toContain("Alpha");
      expect(document.body.textContent).not.toContain("Beta task");
      expect(document.body.textContent).not.toContain("Beta lint");
    }
  });

  test("project filter hides analysis-only zero-count project keys", async () => {
    const d = deps();
    d.api.notes.agenda = async () => ({
      ...emptyAgenda,
      gantt: {
        tasks: [{ id: "orphan-task", name: "orphan task", project: "Graph Tensor", start: "2026-07-07", end: "2026-07-08" }],
        backlog: [],
        milestones: [],
        lanes: [],
      },
      clocktable: {
        tasks: [],
        byProject: { "Graph Tensor": 30 },
        byDay: {},
        running: null,
      },
    });
    await openAgendaView(d);

    document.querySelector<HTMLButtonElement>(".aaronnote-agenda-full-project-filter > button")!.click();

    expect(document.body.textContent).toContain("No projects");
    expect(document.body.textContent).not.toContain("Graph Tensor (0/0)");
  });

  test("search input filters the body without replacing the focused input", async () => {
    const d = deps();
    d.api.notes.agenda = async () => projectAgenda;
    await openAgendaView(d);

    const search = document.querySelector<HTMLInputElement>(".aaronnote-agenda-full-header input[type='search']")!;
    search.focus();
    search.value = "Alpha";
    search.dispatchEvent(new Event("input", { bubbles: true }));

    expect(document.activeElement).toBe(search);
    expect(document.querySelector<HTMLInputElement>(".aaronnote-agenda-full-header input[type='search']")).toBe(search);
    expect(document.body.textContent).toContain("Alpha task");
    expect(document.body.textContent).not.toContain("Beta task");
    expect(document.body.textContent).toContain("1 open");
  });

  test("out-of-order agenda fetch responses do not replace newer data", async () => {
    const d = deps();
    const first = deferred<AgendaMsg>();
    const older = deferred<AgendaMsg>();
    const newer = deferred<AgendaMsg>();
    const agenda = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    d.api.notes.agenda = agenda;

    const opened = openAgendaView(d);
    first.resolve(agendaWithTodo("initial", "Initial task"));
    await opened;

    document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-nav button")[2].click();
    document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-nav button")[0].click();
    newer.resolve(agendaWithTodo("newer", "Newer task"));
    await flushAsync();
    expect(document.body.textContent).toContain("Newer task");

    older.resolve(agendaWithTodo("older", "Older stale task"));
    await flushAsync();
    expect(document.body.textContent).toContain("Newer task");
    expect(document.body.textContent).not.toContain("Older stale task");
  });

  test("bulk status batches patches and refetches once", async () => {
    const d = deps();
    const bulkAgenda: AgendaMsg = {
      ...emptyAgenda,
      days: [{
        date: "2026-07-07",
        entries: [
          { kind: "scheduled", label: "Scheduled", todoId: "one", date: "2026-07-07" },
          { kind: "scheduled", label: "Scheduled", todoId: "two", date: "2026-07-07" },
        ],
      }],
      todos: [
        { id: "one", file: "same.md", noteTitle: "Same", text: "One", status: "todo", index: 10, source: "@@todo [One]" },
        { id: "two", file: "same.md", noteTitle: "Same", text: "Two", status: "todo", index: 30, source: "@@todo [Two]" },
      ],
      stats: { open: 2, doing: 0, done: 0, cancelled: 0, blocked: 0, overdue: 0 },
    };
    const agenda = vi.fn(async (_body: Record<string, unknown>): Promise<AgendaMsg> => bulkAgenda);
    const patchTodo = vi.fn(async (_body: Record<string, unknown>) => ({}));
    d.api.notes.agenda = agenda;
    d.api.notes.patchTodo = patchTodo;
    Object.defineProperty(window, "prompt", {
      value: vi.fn(() => "done"),
      configurable: true,
    });

    await openAgendaView(d);
    document.querySelectorAll<HTMLElement>(".aaronnote-agenda-full-mark")[0].click();
    document.querySelectorAll<HTMLElement>(".aaronnote-agenda-full-mark")[1].click();
    document.querySelector<HTMLButtonElement>(".aaronnote-agenda-full-bulk")!.click();
    await flushAsync();

    expect(patchTodo).toHaveBeenCalledTimes(2);
    expect(patchTodo.mock.calls[0][0]).toMatchObject({ id: "one", index: 10, op: "complete" });
    expect(patchTodo.mock.calls[1][0]).toMatchObject({ id: "two", op: "complete" });
    expect(patchTodo.mock.calls[1][0]).not.toHaveProperty("index");
    expect(agenda).toHaveBeenCalledTimes(2);
  });

  test("SSE refresh immediately after a local mutation is suppressed", async () => {
    const d = deps();
    const agenda = vi.fn(async () => projectAgenda);
    const patchTodo = vi.fn(async () => ({}));
    d.api.notes.agenda = agenda;
    d.api.notes.patchTodo = patchTodo;

    await openAgendaView(d);
    document.querySelector<HTMLElement>(".aaronnote-agenda-full-status")!.click();
    await flushAsync();
    expect(patchTodo).toHaveBeenCalledTimes(1);
    expect(agenda).toHaveBeenCalledTimes(2);

    await refreshAgendaView();
    expect(agenda).toHaveBeenCalledTimes(2);
  });

  test("month view renders a real 6-week calendar grid with event pills", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00"));
    const d = deps();
    d.api.notes.agenda = async () => projectAgenda;
    await openAgendaView(d);

    const monthTab = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-tabs button")]
      .find((button) => button.textContent === "Month")!;
    monthTab.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelectorAll(".aaronnote-calendar-weekdays div")).toHaveLength(7);
    expect(document.querySelectorAll(".aaronnote-calendar-day")).toHaveLength(42);
    expect(document.querySelector<HTMLElement>(".aaronnote-calendar-head h2")?.textContent).toBe("2026-07");
    expect(document.querySelector<HTMLElement>("[data-date='2026-07-07']")?.className).toContain("is-today");

    const alpha = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-calendar-event")]
      .find((button) => button.textContent?.includes("Alpha task"))!;
    expect(alpha).toBeTruthy();
    expect(alpha.draggable).toBe(true);
    expect(alpha.className).toContain("kind-scheduled");
    expect(document.body.textContent).toContain("Beta task");
  });

  test("month event drag patches the scheduled date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00"));
    const d = deps();
    const patchTodo = vi.fn(async () => ({}));
    d.api.notes.agenda = async () => projectAgenda;
    d.api.notes.patchTodo = patchTodo;
    await openAgendaView(d);

    const monthTab = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-tabs button")]
      .find((button) => button.textContent === "Month")!;
    monthTab.click();
    await Promise.resolve();
    await Promise.resolve();

    const alpha = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-calendar-event")]
      .find((button) => button.textContent?.includes("Alpha task"))!;
    const dragStart = new Event("dragstart", { bubbles: true, cancelable: true });
    Object.defineProperty(dragStart, "dataTransfer", {
      value: { effectAllowed: "", setData: vi.fn() },
    });
    alpha.dispatchEvent(dragStart);

    const target = document.querySelector<HTMLElement>("[data-date='2026-07-08']")!;
    const drop = new Event("drop", { bubbles: true, cancelable: true });
    Object.defineProperty(drop, "dataTransfer", {
      value: { dropEffect: "" },
    });
    target.dispatchEvent(drop);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(patchTodo).toHaveBeenCalledWith(expect.objectContaining({
      id: "alpha-todo",
      file: "alpha.md",
      sche: "2026-07-08",
    }));
  });

  test("gantt view exposes scale controls and collapsible lanes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-07T12:00:00"));
    const d = deps();
    d.api.notes.agenda = async () => projectAgenda;
    await openAgendaView(d);

    const ganttTab = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-agenda-full-tabs button")]
      .find((button) => button.textContent === "Gantt")!;
    ganttTab.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".aaronnote-gantt-toolbar")?.textContent).toContain("Day");
    expect(document.querySelector(".aaronnote-gantt-toolbar")?.textContent).toContain("Week");
    expect(document.querySelector(".aaronnote-gantt-toolbar")?.textContent).toContain("Collapse all");
    const taskTitles = () => [...document.querySelectorAll<HTMLElement>(".aaronnote-gantt-line:not(.is-milestone) .aaronnote-gantt-task-title")]
      .map((node) => node.textContent || "");
    expect(taskTitles()).toContain("Alpha task");
    expect(taskTitles()).toContain("Beta task");

    const alphaLane = [...document.querySelectorAll<HTMLButtonElement>(".aaronnote-gantt-lane-toggle")]
      .find((button) => button.textContent?.includes("Alpha Project"))!;
    alphaLane.click();

    expect(taskTitles()).not.toContain("Alpha task");
    expect(taskTitles()).toContain("Beta task");
  });
});
