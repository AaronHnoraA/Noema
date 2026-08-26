#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TEMPLATE_ROOT="${JUPYTER_ROOT}/kernel-templates"

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

KERNEL_DATA="${JUPYTER_STATE_ROOT}/data/kernels"
SAGE_ENV="${AARONNOTE_SAGE_RUNTIME_ENV:-${AARONNOTE_RUNTIME_ENV:-}}"

if [[ -n "$SAGE_ENV" && -r "$SAGE_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$SAGE_ENV"
fi
SAGE_VERSION="${AARONNOTE_SAGE_VERSION:-current}"

mkdir -p "${KERNEL_DATA}/sagemath" "${KERNEL_DATA}/python3" "${KERNEL_DATA}/bash"
find "$KERNEL_DATA" -mindepth 1 -maxdepth 1 -type d -name 'sagemath-*' -exec rm -rf -- {} +
for kernel in sagemath python3 bash; do
  sed -e "s|@AARONNOTE_JUPYTER_ROOT@|${JUPYTER_ROOT}|g" \
      -e "s|@AARONNOTE_JUPYTER_STATE_ROOT@|${JUPYTER_STATE_ROOT}|g" \
      -e "s|@NOEMA_USER_HOME@|${HOME}|g" \
      -e "s|@SAGE_VERSION@|${SAGE_VERSION}|g" \
      "${TEMPLATE_ROOT}/${kernel}/kernel.json" \
      >"${KERNEL_DATA}/${kernel}/kernel.json"
done

printf 'Installed kernelspecs under %s\n' "$KERNEL_DATA"
