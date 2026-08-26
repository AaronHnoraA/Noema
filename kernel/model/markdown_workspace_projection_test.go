// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
)

func BenchmarkMarkdownWorkspaceProjection(b *testing.B) {
	originalDataDir := util.DataDir
	util.DataDir = b.TempDir()
	boxID := "workspace-projection-benchmark"
	b.Cleanup(func() {
		resetMarkdownBoxCatalog(boxID)
		util.DataDir = originalDataDir
	})
	boxDir := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(boxDir, 0o755); nil != err {
		b.Fatal(err)
	}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Workspace projection benchmark"
	if err := (&Box{ID: boxID}).SaveConf(boxConf); nil != err {
		b.Fatal(err)
	}
	for index := 0; index < 500; index++ {
		source := fmt.Sprintf("---\nid: note-%03d\ntitle: Note %03d\ntags: planning benchmark\nproject: Noema\n---\n# Note %03d\n\n@@todo(doing) [Task %03d] {id=task-%03d, ddl=tomorrow}\n\nClaim %03d {#0198fc34-7b32-7a11-8cb4-%012x status=draft owner=Go}\n", index, index, index, index, index, index, index)
		if err := os.WriteFile(filepath.Join(boxDir, fmt.Sprintf("note-%03d.md", index)), []byte(source), 0o644); nil != err {
			b.Fatal(err)
		}
	}
	if _, err := ListMarkdownWorkspaceProjection(boxID, true); nil != err {
		b.Fatal(err)
	}

	b.Run("warm", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			if _, err := ListMarkdownWorkspaceProjection(boxID, true); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("restart-persistent", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			resetMarkdownBoxCatalog(boxID)
			if _, err := ListMarkdownWorkspaceProjection(boxID, true); nil != err {
				b.Fatal(err)
			}
		}
	})
	b.Run("cold-source", func(b *testing.B) {
		b.ReportAllocs()
		for index := 0; index < b.N; index++ {
			resetMarkdownBoxCatalog(boxID)
			if err := os.Remove(markdownIndexCachePath(boxID)); nil != err && !os.IsNotExist(err) {
				b.Fatal(err)
			}
			if _, err := ListMarkdownWorkspaceProjection(boxID, true); nil != err {
				b.Fatal(err)
			}
		}
	})
}
