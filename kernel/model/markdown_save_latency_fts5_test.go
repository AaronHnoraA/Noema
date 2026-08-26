// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build fts5

package model

import (
	"fmt"
	"sort"
	"testing"
	"time"
)

// TestReportSaveLatency reports the latency a debounced editor actually sees:
// each save is a distinct edit, and the background indexer is given the same
// idle gap a real typist leaves between debounced saves. Run with -v.
func TestReportSaveLatency(t *testing.T) {
	boxID := blockRefsWorkspace(t)
	for _, sections := range []int{1, 16, 128} {
		base := benchAnchoredDoc(sections)
		path := fmt.Sprintf("/notes/latency-%d.md", sections)
		if _, _, err := SaveMarkdownDoc(boxID, path, base); nil != err {
			t.Fatal(err)
		}
		WaitMarkdownIndex()

		const rounds = 60
		samples := make([]time.Duration, 0, rounds)
		for round := 0; round < rounds; round++ {
			source := fmt.Sprintf("%s\nedit %d\n", base, round)
			start := time.Now()
			if _, _, err := SaveMarkdownDoc(boxID, path, source); nil != err {
				t.Fatal(err)
			}
			samples = append(samples, time.Since(start))
			// A debounced editor saves a few times a second at most; settle the
			// deferred index work between saves the way an idle gap would.
			WaitMarkdownIndex()
		}
		sort.Slice(samples, func(i, j int) bool { return samples[i] < samples[j] })
		t.Logf("bytes=%6d  median=%8s  p90=%8s  max=%8s",
			len(base), samples[len(samples)/2], samples[len(samples)*9/10], samples[len(samples)-1])
	}
}
