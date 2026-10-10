// SPDX-License-Identifier: GPL-3.0-or-later
//
// Translated from nanoMuse's memory recall, copyright the nanoMuse
// contributors, GPL-3.0-or-later:
//
//   https://github.com/nano-muse/nanoMuse
//   commit 1e08351843052ddcace724e8cac1e4aefbc1101c
//   nanomuse/memory/embeddings.py   standouts

// The entries whose score stands out from the crowd, best first.  Scores are
// corpus-dependent, so the cut is relative: above the mean, and with enough
// entries to tell, above the mean by a standard deviation.  SCORED is
// [{ score, ... }].
export function standouts(scored, limit) {
  if (!scored.length) return [];
  const values = scored.map((entry) => entry.score);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  let cut = mean;
  if (values.length >= 8) {
    const std = Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    cut = mean + std;
  }
  return scored.filter((entry) => entry.score >= cut).sort((a, b) => b.score - a.score).slice(0, limit);
}
