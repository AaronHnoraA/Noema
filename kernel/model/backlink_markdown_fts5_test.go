// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

//go:build fts5

package model

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

// TestGetBacklinkFindsMarkdownBoxRefFromUnidentifiedCitingParagraph pins down two real
// gaps found while wiring backlinks up to markdown boxes, both silent (no error, just an
// empty result):
//
//  1. treenode.GetBlockRef only read n.TextMarkBlockRefID/TextMarkTextContent — the shape
//     lute produces for `.sy` (protyle) content after parse.NestedInlines2FlattedSpansHybrid
//     flattens it into a NodeTextMark. filesys.LoadTree's markdown box path calls the raw
//     parse.Parse primitive (see plan.md Phase 1 §1.1) and never runs that flattening pass,
//     so `((id "text"))` stays an unflattened ast.NodeBlockRef with the ID/anchor text on
//     NodeBlockRefID/NodeBlockRefText children instead. GetBlockRef returned "" for
//     everything, so sql.buildRef's ref never even had a DefBlockID and got filtered out
//     entirely by sql.insertBlockRefs's `"" == ref.DefBlockID` guard — no ref row at all.
//  2. Separately, sql.buildRef set Ref.BlockID (the citing side) from the citing
//     paragraph's own node ID — which is almost always empty for markdown boxes, since
//     under lazy IAL (§1.2) a plain paragraph mentioning another block has no persisted
//     `{: id=...}` of its own (that ephemeral parse-time ID gets zeroed by
//     filesys.StripEphemeralMarkdownBlockIDs before indexing). An empty BlockID makes
//     model/backlink.go's GetBacklinkInBox silently drop the ref (`refSQLBlocksCache[""]`
//     never matches). Fixed by falling back to the citing document's root ID (always
//     persisted) — same document-level-precision tradeoff already chosen for markdown-box
//     search (see plan.md §1.2), applied consistently here.
//
// Either bug alone is enough to make GetBacklink return nothing for the overwhelmingly
// common case: a plain paragraph, with no ID of its own, mentioning another block. Run
// like the other fts5 tests in this package:
//
//	go test -tags fts5 ./model/... -run TestGetBacklinkFindsMarkdownBoxRefFromUnidentifiedCitingParagraph
func TestGetBacklinkFindsMarkdownBoxRefFromUnidentifiedCitingParagraph(t *testing.T) {
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
			t.Fatalf("create test directory [%s] failed: %v", dir, err)
		}
	}

	Conf = NewAppConf()
	Conf.FileTree = conf.NewFileTree()
	Conf.NotebookCrypto = conf.NewNotebookCrypto()
	Conf.Sync = conf.NewSync()
	Conf.Search = conf.NewSearch()

	boxID := "20260825020000-backlinkfts5"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Backlink fts5 test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	targetID := "20260825020000-abc1234"
	targetSource := "Target paragraph with an explicit ID.\n{: id=\"" + targetID + "\"}\n"
	if _, _, err := SaveMarkdownDoc(boxID, "/target.md", targetSource); nil != err {
		t.Fatalf("save target.md failed: %s", err)
	}

	// The citing paragraph deliberately carries no `{: id=...}` of its own — this is
	// the common case under lazy IAL and the one both bugs above hit.
	citingSource := "This paragraph cites the target: ((" + targetID + " \"target text\")).\n"
	if _, _, err := SaveMarkdownDoc(boxID, "/citing.md", citingSource); nil != err {
		t.Fatalf("save citing.md failed: %s", err)
	}

	sql.FlushQueue()

	refs := sql.QueryRefsByDefIDInBox(targetID, false, "")
	if 1 != len(refs) {
		t.Fatalf("expected exactly one ref row for %s, got %+v", targetID, refs)
	}
	if "" == refs[0].BlockID {
		t.Fatalf("ref.BlockID is empty (citing block has no persisted ID and the markdown-box fallback to the document root did not kick in): %+v", refs[0])
	}

	_, linkPaths, _, linkRefsCount, _ := GetBacklink(targetID, "", "", 12, false)
	if 0 == linkRefsCount || 0 == len(linkPaths) {
		t.Fatalf("GetBacklink found no backlink from citing.md's unidentified paragraph to %s (linkRefsCount=%d, linkPaths=%+v)",
			targetID, linkRefsCount, linkPaths)
	}
}
