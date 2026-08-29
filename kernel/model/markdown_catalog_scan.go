// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"sync"

	"github.com/aaronhe/noema/kernel/filesys"
)

// markdownCatalogScanConcurrency bounds the fan-out used to build a catalog
// projection from source.
//
// The Node host scanned the vault with `mapLimit(files, 16)`; the Go takeover
// replaced that with a plain `for path := range docs`, so a cold catalog build
// read, parsed and projected the whole vault on a single goroutine while the
// other eleven cores idled. Every one of these paths is an independent
// read-then-parse, and markdownSnapshots is a sync.Map whose projections are
// each guarded by a sync.Once, so they fan out safely.
//
// 16 matches the Node default (AARONNOTE_SCAN_CONCURRENCY): enough to keep the
// parse busy behind the reads without turning a cold start into a thundering
// herd of open files on a small machine.
const markdownCatalogScanConcurrency = 16

func markdownCatalogScanWorkers(items int) int {
	workers := markdownCatalogScanConcurrency
	if cpus := runtime.GOMAXPROCS(0); cpus < workers {
		workers = cpus
	}
	if items < workers {
		workers = items
	}
	if workers < 1 {
		workers = 1
	}
	return workers
}

// sortedMarkdownDocPaths gives the catalog loops a deterministic order to build
// and merge in. Go's map iteration order is randomised, and a projection that
// aborts partway through a cold build would otherwise leave a different subset
// populated on every attempt.
func sortedMarkdownDocPaths(docs map[string]MarkdownDocSummary) []string {
	paths := make([]string, 0, len(docs))
	for path := range docs {
		paths = append(paths, path)
	}
	sort.Strings(paths)
	return paths
}

// markdownDocScan is what one worker resolves for one path: either a hit on the
// persistent index cache, or a freshly loaded snapshot to project from.
type markdownDocScan struct {
	path string
	// entry is the persistent cache row, valid only when cached is true.
	entry    markdownIndexCacheEntry
	cached   bool
	snapshot *markdownSnapshot
	// missing marks a path that disappeared between the directory walk and the
	// read. The catalog skips it, matching the sequential loops this replaced.
	missing bool
}

// scanMarkdownDocPaths resolves every path concurrently and returns the results
// in `paths` order, so the caller can merge them into the catalog maps and the
// persistent index cache with a single writer and no extra locking.
//
// `cacheable` decides whether a persistent entry can serve this projection
// (each projection caches a different field of the row). It is only ever read
// here; the persistent cache is not written until the caller merges.
func scanMarkdownDocPaths(
	boxID string,
	paths []string,
	persistent *markdownIndexCache,
	cacheable func(markdownIndexCacheEntry) bool,
) ([]markdownDocScan, error) {
	results := make([]markdownDocScan, len(paths))
	boxRoot := filesys.BoxRootPath(boxID)

	var (
		next     int
		nextLock sync.Mutex
		errLock  sync.Mutex
		firstErr error
		wait     sync.WaitGroup
	)
	claim := func() int {
		nextLock.Lock()
		defer nextLock.Unlock()
		if next >= len(paths) {
			return -1
		}
		index := next
		next++
		return index
	}
	fail := func(err error) {
		errLock.Lock()
		if nil == firstErr {
			firstErr = err
		}
		errLock.Unlock()
	}
	failed := func() bool {
		errLock.Lock()
		defer errLock.Unlock()
		return nil != firstErr
	}

	workers := markdownCatalogScanWorkers(len(paths))
	wait.Add(workers)
	for worker := 0; worker < workers; worker++ {
		go func() {
			defer wait.Done()
			for {
				index := claim()
				if index < 0 || failed() {
					return
				}
				path := paths[index]
				results[index].path = path
				if entry, ok := persistent.Entries[path]; ok && cacheable(entry) {
					if info, statErr := os.Stat(filepath.Join(boxRoot, path)); nil == statErr && entry.matchesSource(info) {
						results[index].entry = entry
						results[index].cached = true
						continue
					}
				}
				snapshot, loadErr := loadMarkdownSnapshot(boxID, path)
				if nil != loadErr {
					if os.IsNotExist(loadErr) {
						results[index].missing = true
						continue
					}
					fail(loadErr)
					return
				}
				results[index].snapshot = snapshot
			}
		}()
	}
	wait.Wait()
	if nil != firstErr {
		return nil, firstErr
	}
	return results, nil
}
