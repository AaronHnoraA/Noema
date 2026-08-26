// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org

package model

import (
	"os"
	"path/filepath"

	"github.com/aaronhe/noema/kernel/treenode"
)

// restoreTestBlockTreeDatabase avoids reopening a prior test's automatically
// removed TempDir. Model tests share the process-global blocktree path, so a
// stale predecessor must mean "leave closed", not a process-fatal DB open.
func restoreTestBlockTreeDatabase(path string) {
	if path == "" {
		return
	}
	if _, err := os.Stat(filepath.Dir(path)); err != nil {
		return
	}
	treenode.InitBlockTree(false)
}
