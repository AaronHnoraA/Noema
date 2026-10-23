export function createTasksApiHandlers(coreTasks, { decorateTask = (task) => task } = {}) {
  return {
    "noema:api:tasks:list": (body) => ({ type: "core-tasks", ok: true, tasks: coreTasks.list(body || {}).map(decorateTask) }),
    "noema:api:tasks:get": (body) => ({ type: "core-task", ok: true, task: decorateTask(coreTasks.get(body?.id)) }),
    "noema:api:tasks:cancel": (body) => ({ type: "core-task-cancel", ...coreTasks.cancel(body?.id) }),
    "noema:api:tasks:retry": (body) => ({ type: "core-task-retry", ...coreTasks.retry(body?.id) }),
    "noema:api:tasks:close": (body) => ({ type: "core-task-close", ...coreTasks.close(body?.id) }),
  };
}
