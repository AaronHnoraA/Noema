import { basename } from "node:path";

const addTotals = (target, values) => {
  for (const [key, value] of Object.entries(values || {})) target[key] = (target[key] || 0) + Number(value || 0);
};

/** Merge already-evaluated scopes without resolving dependencies across
 * unrelated projects. Every display edge uses a file-qualified UID; source
 * IDs and source revisions remain available for semantic writes.
 */
export function mergeAgendaScopes(results, scopes, { version, errors = [], nowMs = Date.now() } = {}) {
  const output = { type: "noema-agenda", version, scopes: scopes.map(({ id, root, kind }) => ({ id, root, kind })),
    evaluationSource: results.every((item) => item.evaluationSource === "kernel-agenda") ? "kernel-agenda" : "node-agenda",
    range: results[0]?.range, todos: [], days: [], lints: [], stats: {}, logByDay: {}, errors,
  };
  const days = new Map();
  if (results.some((result) => result.projects)) {
    Object.assign(output, { projects: [], milestones: [], clocks: [], projectModel: [],
      clocktable: { tasks: [], byDay: {}, byProject: {}, running: null, runningClocks: [] } });
  }
  if (results.some((result) => result.gantt)) output.gantt = { tasks: [], backlog: [], milestones: [], lanes: [], lints: [] };
  if (results.some((result) => result.dag)) output.dag = { nodes: [], edges: [] };
  results.forEach((result, index) => {
    const scope = scopes[index];
    const label = scope.kind === "knowledge" ? "Knowledge" : basename(scope.root);
    const projectKey = (key) => key ? `${scope.id}::${key}` : "";
    const todosById = new Map(result.todos.map((todo) => [todo.id, todo]));
    const taskIds = new Map(result.todos.map((todo) => [todo.id, todo.uid]));
    const entities = new Map([...(result.projects || []), ...(result.milestones || []), ...(result.clocks || []), ...result.todos]
      .map((item) => [item.id, item.uid]));
    const taskId = (id) => taskIds.get(id) || id;
    const entityId = (id) => entities.get(id) || id;
    const dependencies = (todo, ids) => (ids || []).map((id) => taskId(todo.sourceKind === "work-node" ? `${todo.file}#${id}` : id));
    const source = (item) => item ? { file: item.file, index: item.index, line: item.line, source: item.source, text: item.text,
      uid: item.uid, scopeId: scope.id, revision: item.sourceRef?.revision, sourceKind: item.sourceKind } : null;
    const lint = (entry) => ({ ...entry, scopeId: scope.id, todoId: entityId(entry.todoId),
      ...(entry.candidates ? { candidates: entry.candidates.map((candidate) => ({ ...candidate, id: taskId(candidate.id) })) } : {}) });
    const taskProjects = new Map();
    for (const project of result.projectModel || []) for (const id of project.childTodoIds || []) taskProjects.set(id, project.key);
    for (const todo of result.todos) output.todos.push({ ...todo,
      projectKey: projectKey(todo.canon?.project || taskProjects.get(todo.id) || ""),
      deps: dependencies(todo, todo.deps), blockedBy: dependencies(todo, todo.blockedBy) });
    for (const day of result.days || []) {
      if (!days.has(day.date)) days.set(day.date, []);
      days.get(day.date).push(...(day.entries || []).map((entry) => ({ ...entry, todoId: taskId(entry.todoId) })));
    }
    output.lints.push(...(result.lints || []).map(lint));
    addTotals(output.stats, result.stats);
    addTotals(output.logByDay, result.logByDay);
    if (output.projects) {
      for (const kind of ["projects", "milestones", "clocks"]) output[kind].push(...(result[kind] || []).map((item) => ({ ...item, todoId: taskId(item.todoId) })));
      output.projectModel.push(...(result.projectModel || []).map((item) => ({ ...item, id: entityId(item.id), scopeId: scope.id,
        key: projectKey(item.key), sourceKey: item.key, title: results.length > 1 ? `${label} · ${item.title}` : item.title,
        childTodoIds: (item.childTodoIds || []).map(taskId) })));
      const clocks = result.clocktable;
      if (clocks) {
        output.clocktable.tasks.push(...(clocks.tasks || []).map((item) => ({ ...item, todoId: taskId(item.todoId) })));
        addTotals(output.clocktable.byDay, clocks.byDay);
        for (const [key, minutes] of Object.entries(clocks.byProject || {})) output.clocktable.byProject[projectKey(key)] = minutes;
        for (const clock of result.clocks || []) if (clock.args?.from && !clock.args?.to) {
          const running = { todoId: taskId(clock.todoId), text: clock.title || clock.text, file: clock.file, from: clock.args.from,
            minutesSoFar: Math.max(0, Math.floor((nowMs - new Date(clock.args.from.replace(" ", "T")).getTime()) / 60000)),
            ...source(clock) };
          output.clocktable.runningClocks.push(running);
        }
      }
    }
    if (output.gantt && result.gantt) {
      for (const kind of ["tasks", "backlog"]) output.gantt[kind].push(...(result.gantt[kind] || []).map((task) => {
        const todo = todosById.get(task.id);
        return { ...task, id: taskId(task.id), project: projectKey(task.project), dependencies: todo?.sourceKind === "work-node" ? dependencies(todo, todo.deps) : (task.dependencies || []).map(taskId),
          source: { ...task.source, ...source(todo) } };
      }));
      output.gantt.milestones.push(...(result.gantt.milestones || []).map((item) => ({ ...item, id: entityId(item.id), project: projectKey(item.project) })));
      output.gantt.lanes.push(...(result.gantt.lanes || []).map((item) => ({ ...item, id: entityId(item.id), key: projectKey(item.key),
        name: results.length > 1 ? `${label} · ${item.name}` : item.name, childTaskIds: (item.childTaskIds || []).map(taskId) })));
      output.gantt.lints.push(...(result.gantt.lints || []).map(lint));
    }
    if (output.dag && result.dag) {
      const dagTodoIds = result.dag.todoIds || {};
      const dagId = (id) => {
        const todoId = dagTodoIds[id] || (todosById.has(id) ? id : "");
        return todoId ? taskId(todoId) : `${scope.id}::dag:${id}`;
      };
      output.dag.nodes.push(...(result.dag.nodes || []).map((node) => ({
        ...node,
        id: dagId(node.id),
        todoId: node.todoId ? taskId(node.todoId) : undefined,
        scopeId: scope.id,
        scopeLabel: label,
        project: projectKey(node.project),
      })));
      output.dag.edges.push(...(result.dag.edges || []).map((edge) => ({
        ...edge,
        id: `${scope.id}::edge:${edge.id}`,
        from: dagId(edge.from),
        to: dagId(edge.to),
        scopeId: scope.id,
      })));
    }
  });
  output.days = [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, entries]) => ({ date,
    entries: entries.sort((a, b) => (a.time || "99:99").localeCompare(b.time || "99:99") || (b.urgency || 0) - (a.urgency || 0)) }));
  if (output.clocktable) output.clocktable.running = output.clocktable.runningClocks[0] || null;
  return output;
}

// The existing Web view keys its row map by `id`. Keep its full UI while
// moving its identity to the native UID; semantic source IDs are untouched.
export function webAgendaProjection(snapshot) {
  return { ...snapshot, type: "agenda", todos: snapshot.todos.map((todo) => ({ ...todo, id: todo.uid })) };
}
