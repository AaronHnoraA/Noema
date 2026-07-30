#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
JUPYTER_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
EMACS_ROOT="$(cd "${JUPYTER_ROOT}/../../../.." && pwd)"

exec "${EMACS_ROOT}/scripts/aaronnote-runtime" doctor
