export function createJupyterApiHandlers(service) {
  return {
    "aaronnote:api:jupyter-cell:kernels": () => service.kernels(),
    "aaronnote:api:jupyter-cell:execute": (body) => service.execute(body || {}),
    "aaronnote:api:jupyter-cell:open-script": (body) => service.openScript(body || {}),
    "aaronnote:api:jupyter-cell:read-script-cell": (body) => service.readScriptCell(body || {}),
    "aaronnote:api:jupyter-cell:execute-script-cell": (body) => service.executeScriptCell(body || {}),
    "aaronnote:api:jupyter-cell:clear-script-cell-output": (body) => service.clearScriptCellOutput(body || {}),
    "aaronnote:api:jupyter-cell:delete-script-cell": (body) => service.deleteScriptCell(body || {}),
    "aaronnote:api:jupyter-cell:save-script-cell-output-ui": (body) => service.saveScriptCellOutputUi(body || {}),
    "aaronnote:api:jupyter-cell:clear-all-outputs": (body) => service.clearAllOutputs(body || {}),
    "aaronnote:api:jupyter-cell:variables": (body) => service.variables(body || {}),
    "aaronnote:api:jupyter-cell:kernel-status": (body) => service.kernelStatus(body || {}),
    "aaronnote:api:jupyter-cell:restart": (body) => service.restart(body || {}),
    "aaronnote:api:jupyter-cell:interrupt": (body) => service.interrupt(body || {}),
    "aaronnote:api:jupyter-cell:shutdown": (body) => service.shutdownKernel(body || {}),
    "aaronnote:api:jupyter-cell:tasks": () => service.listTasks(),
    "aaronnote:api:jupyter-cell:cleanup": (body) => service.cleanup(body || {}),
  };
}
