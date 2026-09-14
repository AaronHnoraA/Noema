#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

if [[ -n "${AARONNOTE_JUPYTER_STATE_ROOT:-}" ]]; then
  JUPYTER_STATE_ROOT="${AARONNOTE_JUPYTER_STATE_ROOT}"
elif [[ -n "${AARONNOTE_STATE_DIR:-}" ]]; then
  JUPYTER_STATE_ROOT="${AARONNOTE_STATE_DIR}/jupyter"
else
  JUPYTER_STATE_ROOT="${XDG_STATE_HOME:-${HOME}/.local/state}/noema/jupyter"
fi
export AARONNOTE_JUPYTER_STATE_ROOT="$JUPYTER_STATE_ROOT"

"${JUPYTER_ROOT}/bin/python-jupyter-kernel" -c \
  'import ipykernel, ipywidgets, jupyter_client, zmq; print("Python/ipykernel/ipywidgets/ZMQ: ready")'

if [[ -n "${AARONNOTE_SAGE:-}" ]] || command -v sage >/dev/null 2>&1; then
  "${JUPYTER_ROOT}/bin/sage-jupyter-kernel" --runtime-probe -c \
    'from sage.all import ZZ; print("SageMath: ready")'
else
  printf 'SageMath: optional, not found\n'
fi
