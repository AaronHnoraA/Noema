#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -n "${AARONNOTE_JUPYTER_STATE_ROOT:-}" ]]; then
  JUPYTER_STATE_ROOT="${AARONNOTE_JUPYTER_STATE_ROOT}"
elif [[ "${AARONNOTE_HOST_MODE:-}" == "emacs" ]]; then
  JUPYTER_STATE_ROOT="${JUPYTER_ROOT}/.jupyter"
elif [[ -n "${AARONNOTE_STATE_DIR:-}" ]]; then
  JUPYTER_STATE_ROOT="${AARONNOTE_STATE_DIR}/jupyter"
elif [[ "$(uname -s)" == "Darwin" ]]; then
  JUPYTER_STATE_ROOT="${HOME}/Library/Application Support/com.noema.desktop/state/jupyter"
else
  JUPYTER_STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/noema/jupyter"
fi
export AARONNOTE_JUPYTER_STATE_ROOT="$JUPYTER_STATE_ROOT"

mkdir -p \
  "${JUPYTER_STATE_ROOT}/config" \
  "${JUPYTER_STATE_ROOT}/data" \
  "${JUPYTER_STATE_ROOT}/runtime" \
  "${JUPYTER_STATE_ROOT}/logs" \
  "${JUPYTER_STATE_ROOT}/ipython" \
  "${JUPYTER_STATE_ROOT}/tmp"

"${SCRIPT_DIR}/install-kernelspecs.sh"
"${JUPYTER_ROOT}/bin/python-jupyter-kernel" -c \
  'import ipykernel, zmq; print("Noema Python kernel ready")'

if [[ -n "${AARONNOTE_SAGE:-}" ]] || command -v sage >/dev/null 2>&1; then
  "${JUPYTER_ROOT}/bin/sage-jupyter-kernel" --runtime-probe -c \
    'from sage.all import ZZ; print("Noema Sage kernel ready")'
else
  printf 'SageMath not found; Sage kernels remain optional.\n'
fi

printf 'Noema Jupyter kernel bootstrap complete:\n'
printf '  root: %s\n' "$JUPYTER_ROOT"
printf '  state: %s\n' "$JUPYTER_STATE_ROOT"
printf '  jupyter_data: %s\n' "${JUPYTER_STATE_ROOT}/data"
