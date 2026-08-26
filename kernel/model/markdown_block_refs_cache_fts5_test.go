// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

//go:build fts5

package model

import (
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

// TestSaveBlockRefsMatchAlwaysParsing drives a long sequence of edits through
// SaveMarkdownDoc — which reuses the previous block list whenever the anchor
// signature is unchanged — and compares every response against parsing the
// same bytes outright. Any divergence means the signature is too weak.
func TestSaveBlockRefsMatchAlwaysParsing(t *testing.T) {
	boxID := blockRefsWorkspace(t)
	const path = "/notes/refs.md"

	anchor := func(n int) string {
		return fmt.Sprintf("0192f1a0-%04x-7000-8000-%012x", n&0xffff, n)
	}
	fragments := []func(int) string{
		func(n int) string { return fmt.Sprintf("# Heading %d {#%s}\n\n", n, anchor(n)) },
		func(n int) string { return fmt.Sprintf("### Deep heading %d {#%s}\n\n", n, anchor(n)) },
		func(n int) string { return fmt.Sprintf("Paragraph %d prose 中文 {#%s}\n\n", n, anchor(n)) },
		func(n int) string { return fmt.Sprintf("- list item %d {#%s}\n\n", n, anchor(n)) },
		func(n int) string { return fmt.Sprintf("> quoted %d {#%s}\n\n", n, anchor(n)) },
		func(n int) string { return fmt.Sprintf("#+begin note {#%s}\nbody %d\n#+end note\n\n", anchor(n), n) },
		func(n int) string { return fmt.Sprintf("Plain prose %d with no anchor at all.\n\n", n) },
		func(n int) string { return fmt.Sprintf("- plain item %d\n- another %d\n\n", n, n) },
		func(n int) string { return fmt.Sprintf("```go\nfunc f%d() {}\n```\n\n", n) },
		func(n int) string { return fmt.Sprintf("$$\nx_{%d} = %d\n$$\n\n", n, n) },
	}

	random := rand.New(rand.NewSource(20260826))
	for round := 0; round < 240; round++ {
		source := "# Document\n\n"
		for piece := 0; piece < 1+random.Intn(7); piece++ {
			source += fragments[random.Intn(len(fragments))](random.Intn(6))
		}

		_, got, err := SaveMarkdownDoc(boxID, path, source)
		if nil != err {
			t.Fatalf("round %d: save failed: %v", round, err)
		}
		want := markdownBlockRefs(filesys.LoadMarkdownTreeByData([]byte(source), boxID, path, util.NewLute()))

		gotStable, wantStable := stableBlockRefs(got), stableBlockRefs(want)
		if !reflect.DeepEqual(gotStable, wantStable) {
			t.Fatalf("round %d: save returned different blocks than a fresh parse\n got: %+v\nwant: %+v\nsource:\n%s",
				round, gotStable, wantStable, source)
		}
	}
}

// stableBlockRefs drops the entries whose IDs Lute regenerates on every parse.
// Those are ephemeral internal projections that are never equal between two
// parses of identical bytes, so they cannot be compared — and per
// MarkdownBlockLocation's contract they should not be crossing the API
// boundary in the first place.
func stableBlockRefs(blocks []MarkdownBlockRef) []MarkdownBlockRef {
	ret := []MarkdownBlockRef{}
	for _, block := range blocks {
		if 36 == len(block.ID) {
			ret = append(ret, block)
		}
	}
	return ret
}

func blockRefsWorkspace(t *testing.T) string {
	workspaceDir := t.TempDir()
	util.WorkspaceDir = workspaceDir
	util.ConfDir = filepath.Join(workspaceDir, "conf")
	util.DataDir = filepath.Join(workspaceDir, "data")
	util.HistoryDir = filepath.Join(workspaceDir, "history")
	util.TempDir = filepath.Join(workspaceDir, "temp")
	util.QueueDir = filepath.Join(util.TempDir, "queue")
	util.DBPath = filepath.Join(util.TempDir, util.DBName)
	util.HistoryDBPath = filepath.Join(util.TempDir, "history.db")
	util.AssetContentDBPath = filepath.Join(util.TempDir, "asset_content.db")
	util.BlockTreeDBPath = filepath.Join(util.TempDir, "blocktree.db")
	for _, dir := range []string{util.ConfDir, util.DataDir, util.HistoryDir, util.TempDir, util.QueueDir} {
		if err := os.MkdirAll(dir, 0755); nil != err {
			t.Fatal(err)
		}
	}
	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()
	boxID := "20260826210000-refs0001"
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Block refs"
	if err := (&Box{ID: boxID}).SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(func() {
		WaitMarkdownIndex()
		sql.CloseDatabase()
	})
	return boxID
}

// TestSaveBlockRefsSurviveIncrementalEdits is the case the generated-document
// test cannot reach: a document mutated one edit at a time, which is when the
// save path actually reuses the previous block list. Every response is compared
// against parsing the same bytes outright, so a signature that misses a
// structural change shows up here as a stale block list.
func TestSaveBlockRefsSurviveIncrementalEdits(t *testing.T) {
	boxID := blockRefsWorkspace(t)
	const path = "/notes/incremental.md"
	anchor := func(n int) string {
		return fmt.Sprintf("0192f1a0-%04x-7000-8000-%012x", n&0xffff, n)
	}

	source := "# Title {#" + anchor(1) + "}\n\nA paragraph. {#" + anchor(2) + "}\n\nPlain prose line.\n"
	edits := []struct {
		name string
		next func(string) string
	}{
		{"append prose", func(s string) string { return s + "More prose.\n" }},
		{"extend an unanchored line", func(s string) string {
			return strings.Replace(s, "Plain prose line.", "Plain prose line extended.", 1)
		}},
		{"prefix a bullet onto prose", func(s string) string {
			return strings.Replace(s, "Plain prose line extended.", "- Plain prose line extended.", 1)
		}},
		{"blank line splits a paragraph", func(s string) string {
			return strings.Replace(s, "More prose.\n", "More\n\nprose.\n", 1)
		}},
		{"wrap an anchor in a fence", func(s string) string {
			return strings.Replace(s, "A paragraph. {#", "```\nA paragraph. {#", 1)
		}},
		{"close the fence", func(s string) string {
			return strings.Replace(s, anchor(2)+"}\n", anchor(2)+"}\n```\n", 1)
		}},
		{"demote the heading", func(s string) string {
			return strings.Replace(s, "# Title {#", "### Title {#", 1)
		}},
		{"quote the heading", func(s string) string {
			return strings.Replace(s, "### Title {#", "> ### Title {#", 1)
		}},
		{"add a second anchor", func(s string) string {
			return s + "\nTail paragraph {#" + anchor(3) + "}\n"
		}},
		{"edit an anchored line's text", func(s string) string {
			return strings.Replace(s, "Tail paragraph {#", "Tail paragraph reworded {#", 1)
		}},
		{"remove an anchor", func(s string) string {
			return strings.Replace(s, " {#"+anchor(3)+"}", "", 1)
		}},
		{"indent an anchor into code", func(s string) string {
			return strings.Replace(s, "> ### Title {#", "    > ### Title {#", 1)
		}},
	}

	if _, _, err := SaveMarkdownDoc(boxID, path, source); nil != err {
		t.Fatal(err)
	}
	for _, edit := range edits {
		source = edit.next(source)
		_, got, err := SaveMarkdownDoc(boxID, path, source)
		if nil != err {
			t.Fatalf("%s: save failed: %v", edit.name, err)
		}
		want := markdownBlockRefs(filesys.LoadMarkdownTreeByData([]byte(source), boxID, path, util.NewLute()))
		if !reflect.DeepEqual(stableBlockRefs(got), stableBlockRefs(want)) {
			t.Fatalf("%s: reused block list is stale\n got: %+v\nwant: %+v\nsource:\n%s",
				edit.name, stableBlockRefs(got), stableBlockRefs(want), source)
		}
	}
}
