// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema concurrent registry-maintenance tests are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package util

import (
	"io/fs"
	"os"
	"testing"
)

type disappearingDirEntry struct{}

func (disappearingDirEntry) Name() string               { return "removed-shadow" }
func (disappearingDirEntry) IsDir() bool                { return true }
func (disappearingDirEntry) Type() fs.FileMode          { return fs.ModeDir }
func (disappearingDirEntry) Info() (fs.FileInfo, error) { return nil, os.ErrNotExist }

func TestAccumulateDataSizeIgnoresEntryRemovedDuringWalk(t *testing.T) {
	var dataSize, assetsSize int64
	if err := accumulateDataSize(
		"/workspace/data/removed-shadow",
		disappearingDirEntry{},
		nil,
		&dataSize,
		&assetsSize,
	); nil != err {
		t.Fatalf("a concurrently removed entry must be ignored: %v", err)
	}
	if 0 != dataSize || 0 != assetsSize {
		t.Fatalf("a removed entry changed totals: data=%d assets=%d", dataSize, assetsSize)
	}
}
