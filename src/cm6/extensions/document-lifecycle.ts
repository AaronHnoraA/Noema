/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/extensions/before-change-doc.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { StateEffect } from "@codemirror/state";
import { updateHasEffect } from "../utils/effects.ts";

export const beforeChangeDocumentEffect = StateEffect.define<void>();
export const hasBeforeChangeDocumentEffect = updateHasEffect(beforeChangeDocumentEffect);

