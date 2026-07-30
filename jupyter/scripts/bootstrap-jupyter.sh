#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EMACS_ROOT="$(cd "${JUPYTER_ROOT}/../../../.." && pwd)"
RUNTIME_TOOL="${EMACS_ROOT}/scripts/aaronnote-runtime"

mkdir -p \
  "${JUPYTER_ROOT}/.jupyter/config" \
  "${JUPYTER_ROOT}/.jupyter/data" \
  "${JUPYTER_ROOT}/.jupyter/runtime" \
  "${JUPYTER_ROOT}/.jupyter/logs" \
  "${JUPYTER_ROOT}/.jupyter/ipython" \
  "${JUPYTER_ROOT}/.jupyter/tmp"

[[ -x "$RUNTIME_TOOL" ]] || { printf 'Missing runtime tool: %s\n' "$RUNTIME_TOOL" >&2; exit 1; }
"$RUNTIME_TOOL" python-env
"$RUNTIME_TOOL" sage-refresh
"$RUNTIME_TOOL" sage-packages

printf 'Noema Jupyter kernel server bootstrap complete:\n'
printf '  root: %s\n' "$JUPYTER_ROOT"
printf '  runtime metadata: %s\n' "${EMACS_ROOT}/var/aaronnote/runtime"
printf '  jupyter_data: %s\n' "${JUPYTER_ROOT}/.jupyter/data"
