/*
 * Adapted from Overleaf:
 * services/web/frontend/js/features/source-editor/utils/effects.ts
 * upstream commit 28ad3b03b71cb4311decdcb55c36b33ec10d72db
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { StateEffectType, Transaction } from "@codemirror/state";
import type { ViewUpdate } from "@codemirror/view";

export const transactionHasEffect =
  <T>(effectType: StateEffectType<T>) =>
  (transaction: Transaction): boolean =>
    transaction.effects.some((effect) => effect.is(effectType));

export const updateHasEffect =
  <T>(effectType: StateEffectType<T>) =>
  (update: ViewUpdate): boolean =>
    update.transactions.some(transactionHasEffect(effectType));

