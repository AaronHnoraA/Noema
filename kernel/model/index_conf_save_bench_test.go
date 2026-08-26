// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/util"
)

// BenchmarkConfSave measures the per-call cost that the EvtSQLIndexChanged
// subscriber used to pay once per queued SQL operation.
func BenchmarkConfSave(b *testing.B) {
	originalConf := Conf
	originalConfDir := util.ConfDir
	root := b.TempDir()
	util.ConfDir = filepath.Join(root, "conf")
	if err := os.MkdirAll(util.ConfDir, 0755); nil != err {
		b.Fatal(err)
	}
	Conf = NewAppConf()
	b.Cleanup(func() {
		Conf = originalConf
		util.ConfDir = originalConfDir
	})

	b.Run("state-changed-writes", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			Conf.DataIndexState = i & 1
			Conf.Save()
		}
	})
	// The pre-change subscriber called Save() on every queued SQL operation.
	// All but the transitions landed here: marshal, re-parse, encrypt, marshal
	// again, read conf.json back, compare, discard.
	b.Run("state-unchanged-compare-only", func(b *testing.B) {
		Conf.DataIndexState = 1
		Conf.Save()
		b.ResetTimer()
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			Conf.Save()
		}
	})
}
