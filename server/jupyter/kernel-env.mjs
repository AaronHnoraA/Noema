// Kernel process environment-variable construction.
// Ported concept from microsoft/vscode-jupyter (MIT)
// src/kernels/raw/launcher/kernelEnvVarsService.node.ts, trimmed to what
// aaronnote needs: unlike vscode-jupyter, kernelspecs here always carry a
// fully-resolved interpreter/executable path (see jupyter/kernel-templates/),
// so there is no separate Python-interpreter-activation step to merge in —
// just process.env + an optional runtime bin dir on PATH + the kernelspec's
// own `env`.

import path from "node:path";

const SUBST_REGEX = /\$\{([a-zA-Z_]\w*)\}/g;

function substituteEnvVars(value, vars) {
  if (typeof value !== "string" || !value.includes("$")) return value;
  return value.replace(SUBST_REGEX, (match, name) => (name in vars ? vars[name] : match));
}

/**
 * Build the environment for a kernel process: `process.env`, with an optional
 * runtime bin directory prepended to PATH and the kernelspec's own `env`
 * merged on top (kernel vars win), substituting any `${VAR}` references
 * against the merged result.
 */
export function buildKernelEnv({ kernelSpecEnv, runtimeBinDir, venvBinDir, pythonNoUserSite = true } = {}) {
  const merged = { ...process.env };
  const binDir = runtimeBinDir || venvBinDir;
  if (binDir) {
    merged.PATH = [binDir, merged.PATH].filter(Boolean).join(path.delimiter);
  }
  if (pythonNoUserSite) merged.PYTHONNOUSERSITE = "1";

  const specEnv = kernelSpecEnv || {};
  for (const [key, value] of Object.entries(specEnv)) {
    merged[key] = substituteEnvVars(value, merged);
  }
  return merged;
}
