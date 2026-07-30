#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
KERNEL_DATA="${JUPYTER_ROOT}/.jupyter/data/kernels"
TEMPLATE_ROOT="${JUPYTER_ROOT}/kernel-templates"
EMACS_ROOT="$(cd "${JUPYTER_ROOT}/../../../.." && pwd)"
SAGE_ENV="${EMACS_ROOT}/var/aaronnote/runtime/sage.env"

if [[ -r "$SAGE_ENV" ]]; then
  # shellcheck disable=SC1090
  source "$SAGE_ENV"
fi
SAGE_VERSION="${AARONNOTE_SAGE_VERSION:-current}"

mkdir -p "${KERNEL_DATA}/sagemath" "${KERNEL_DATA}/python3" "${KERNEL_DATA}/bash"
find "$KERNEL_DATA" -mindepth 1 -maxdepth 1 -type d -name 'sagemath-*' -exec rm -rf -- {} +
for kernel in sagemath python3 bash; do
  sed -e "s|@AARONNOTE_JUPYTER_ROOT@|${JUPYTER_ROOT}|g" \
      -e "s|@SAGE_VERSION@|${SAGE_VERSION}|g" \
      "${TEMPLATE_ROOT}/${kernel}/kernel.json" \
      >"${KERNEL_DATA}/${kernel}/kernel.json"
done

printf 'Installed kernelspecs under %s\n' "$KERNEL_DATA"
