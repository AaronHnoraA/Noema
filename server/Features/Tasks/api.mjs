export function createTasksApiHandlers(coreTasks) {
  return {
    "aaronnote:api:tasks:list": (body) => ({ type: "core-tasks", ok: true, tasks: coreTasks.list(body || {}) }),
    "aaronnote:api:tasks:get": (body) => ({ type: "core-task", ok: true, task: coreTasks.get(body?.id) }),
    "aaronnote:api:tasks:cancel": (body) => ({ type: "core-task-cancel", ...coreTasks.cancel(body?.id) }),
    "aaronnote:api:tasks:retry": (body) => ({ type: "core-task-retry", ...coreTasks.retry(body?.id) }),
    "aaronnote:api:tasks:close": (body) => ({ type: "core-task-close", ...coreTasks.close(body?.id) }),
  };
}
