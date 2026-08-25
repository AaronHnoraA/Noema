// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema UUIDv7 block projection additions are Copyright (c) 2026 Aaron He
// and distributed under the same AGPL-3.0-or-later terms.

//go:build fts5

package model

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

func TestGetBacklinkFindsNoemaUUIDv7BlockRefWithoutSourceRewrite(t *testing.T) {
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

	boxID := "20260825114500-noemaref"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Noema UUIDv7 ref test"
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)

	const targetID = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	targetSource := "Target paragraph {#" + targetID + "}\n"
	_, targetBlocks, err := SaveMarkdownDoc(boxID, "/target.md", targetSource)
	if nil != err {
		t.Fatal(err)
	}
	foundCanonicalBlock := false
	for _, block := range targetBlocks {
		if block.ID == targetID {
			foundCanonicalBlock = true
		}
	}
	if !foundCanonicalBlock {
		t.Fatalf("load/save API exposed no canonical UUIDv7 block: %#v", targetBlocks)
	}

	citingSource := "This cites ((" + targetID + " \"target label\")).\n"
	if _, _, err = SaveMarkdownDoc(boxID, "/citing.md", citingSource); nil != err {
		t.Fatal(err)
	}
	sql.FlushQueue()

	projectedID := noemaidentity.ProjectionID(targetID, "")
	refs := sql.QueryRefsByDefIDInBox(projectedID, false, "")
	if 1 != len(refs) {
		t.Fatalf("expected one projected UUIDv7 ref, got %#v", refs)
	}
	if refs[0].Markdown != "(("+targetID+" \"target label\"))" || strings.Contains(refs[0].Markdown, projectedID) {
		t.Fatalf("SQL projection leaked internal ID or lost canonical source: %#v", refs[0])
	}
	if block := sql.GetBlock(projectedID); nil == block || !strings.Contains(block.IAL, targetID) {
		t.Fatalf("projected definition block lost canonical identity: %#v", block)
	}
	location, err := ResolveMarkdownBlock(targetID)
	if nil != err || location.ID != targetID || location.Notebook != boxID || location.Path != "/target.md" || location.Line != 1 {
		t.Fatalf("canonical block navigation mismatch: location=%#v err=%v", location, err)
	}

	_, linkPaths, _, linkRefsCount, _ := GetBacklink(targetID, "", "", 12, false)
	if 0 == linkRefsCount || 0 == len(linkPaths) {
		t.Fatalf("canonical UUIDv7 lookup found no backlink: count=%d paths=%#v", linkRefsCount, linkPaths)
	}
	relationships, err := ListMarkdownRelationships(boxID)
	if nil != err {
		t.Fatal(err)
	}
	if len(relationships) != 1 || relationships[0].FromPath != "/citing.md" || relationships[0].ToPath != "/target.md" {
		t.Fatalf("page relationship projection mismatch: %#v", relationships)
	}
	for path, want := range map[string]string{"/target.md": targetSource, "/citing.md": citingSource} {
		raw, readErr := os.ReadFile(filepath.Join(util.DataDir, boxID, path))
		if nil != readErr || string(raw) != want {
			t.Fatalf("identity indexing rewrote %s: bytes=%q err=%v", path, raw, readErr)
		}
		if strings.Contains(string(raw), "{: id=") {
			t.Fatalf("identity indexing injected a SiYuan IAL into %s: %s", path, raw)
		}
	}
}
