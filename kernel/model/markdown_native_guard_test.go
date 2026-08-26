// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/aaronhe/noema/kernel/av"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

func TestMarkdownBoxRejectsNativeDocumentTreeOperationsBeforeWrite(t *testing.T) {
	originalDataDir, originalConf := util.DataDir, Conf
	originalWorkspaceDir, originalHistoryDir := util.WorkspaceDir, util.HistoryDir
	originalBlockTreeDBPath := util.BlockTreeDBPath
	workspaceDir := t.TempDir()
	util.WorkspaceDir = workspaceDir
	util.DataDir = filepath.Join(workspaceDir, "data")
	util.HistoryDir = filepath.Join(workspaceDir, "history")
	util.BlockTreeDBPath = filepath.Join(workspaceDir, "blocktree.db")
	if err := os.MkdirAll(util.HistoryDir, 0o755); nil != err {
		t.Fatal(err)
	}
	Conf = NewAppConf()
	treenode.InitBlockTree(true)
	t.Cleanup(func() {
		treenode.CloseDatabase()
		util.WorkspaceDir = originalWorkspaceDir
		util.DataDir = originalDataDir
		util.HistoryDir = originalHistoryDir
		util.BlockTreeDBPath = originalBlockTreeDBPath
		Conf = originalConf
		if "" != originalBlockTreeDBPath {
			treenode.InitBlockTree(false)
		}
	})

	boxID := "20260826050000-native1"
	setupMarkdownBoxForIndexTest(t, boxID)
	box := &Box{ID: boxID}
	boxConf := box.GetConf()
	boxConf.Closed = false
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	const source = "#+begin meta\nid: 0198fc34-7b32-7a11-8cb4-6c40e3b33d71\n#+end meta\n\n# Note\n"
	sourcePath := filepath.Join(util.DataDir, boxID, "note.md")
	if err := os.WriteFile(sourcePath, []byte(source), 0644); nil != err {
		t.Fatal(err)
	}
	tree, err := filesys.LoadTree(boxID, "/note.md", util.NewLute())
	if nil != err {
		t.Fatal(err)
	}
	treenode.UpsertBlockTree(tree)
	t.Cleanup(func() { treenode.RemoveBlockTreesByRootID(boxID, tree.Root.ID) })

	const (
		mixedAVID  = "20260826045010-mixav01"
		mixedRowID = "20260826045011-mixrow1"
	)
	mixedBlockKey := &av.Key{ID: "20260826045013-mixkey1", Name: "Key", Type: av.KeyTypeBlock}
	mixedBlockValues := &av.KeyValues{Key: mixedBlockKey}
	mixedView := &av.View{
		ID: "20260826045014-mixview", Name: "Table", LayoutType: av.LayoutTypeTable, PageSize: 32,
		Table:   &av.LayoutTable{BaseLayout: &av.BaseLayout{ID: "20260826045015-mixlay1"}, Columns: []*av.ViewTableColumn{{BaseField: &av.BaseField{ID: mixedBlockKey.ID}}}},
		ItemIDs: []string{mixedRowID},
	}
	mixedAttrView := &av.AttributeView{
		Spec: 5, ID: mixedAVID, KeyValues: []*av.KeyValues{mixedBlockValues}, KeyIDs: []string{mixedBlockKey.ID},
		Views: []*av.View{mixedView},
	}
	mixedBlockValues.Values = append(mixedBlockValues.Values, &av.Value{
		ID: "20260826045012-mixval1", KeyID: mixedBlockValues.Key.ID, BlockID: mixedRowID,
		Type: av.KeyTypeBlock, Block: &av.ValueBlock{ID: tree.Root.ID},
	})
	if err = av.SaveAttributeView(mixedAttrView); nil != err {
		t.Fatal(err)
	}
	mixedAVPath := filepath.Join(util.DataDir, "storage", "av", mixedAVID+".json")
	mixedAVSource, err := os.ReadFile(mixedAVPath)
	if nil != err {
		t.Fatal(err)
	}
	mixedAVHistoryPath := filepath.Join(util.HistoryDir, "2026-08-26-082900-update", "storage", "av", mixedAVID+".json")
	if err = os.MkdirAll(filepath.Dir(mixedAVHistoryPath), 0o755); nil != err {
		t.Fatal(err)
	}
	if err = os.WriteFile(mixedAVHistoryPath, mixedAVSource, 0o644); nil != err {
		t.Fatal(err)
	}
	mixedAVHistoryRequest, err := filepath.Rel(util.WorkspaceDir, mixedAVHistoryPath)
	if nil != err {
		t.Fatal(err)
	}

	// Several AV query helpers perform legacy compatibility repair while
	// reading. They may still return a mixed/dangling view, but must not persist
	// those repairs when a live row is a Markdown projection.
	if _, _, _, _, err = GetAttributeViewPrimaryKeyValues(mixedAVID, "", nil, 1, 32); nil != err {
		t.Fatalf("read mixed attribute view primary key values: %v", err)
	}
	if got := GetAttributeViewItemKeys(mixedAVID, mixedRowID, ""); 1 != len(got) {
		t.Fatalf("read mixed attribute view item keys: got %d result(s)", len(got))
	}
	if afterRead, readErr := os.ReadFile(mixedAVPath); nil != readErr {
		t.Fatal(readErr)
	} else if string(afterRead) != string(mixedAVSource) {
		t.Fatal("read-only attribute view compatibility repair changed mixed AV storage")
	}
	staleTempPath := filepath.Join(util.DataDir, boxID, "keep.tmp")
	if err = os.WriteFile(staleTempPath, []byte("repository source"), 0o644); nil != err {
		t.Fatal(err)
	}
	staleTime := time.Now().Add(-time.Hour)
	if err = os.Chtimes(staleTempPath, staleTime, staleTime); nil != err {
		t.Fatal(err)
	}
	if _, _, err = box.Ls("/"); nil != err {
		t.Fatalf("list Markdown repository: %v", err)
	}
	if kept, readErr := os.ReadFile(staleTempPath); nil != readErr || string(kept) != "repository source" {
		t.Fatalf("Markdown listing removed stale-looking source temp file: bytes=%q err=%v", kept, readErr)
	}

	checks := []struct {
		name string
		run  func() error
	}{
		{name: "duplicate", run: func() error { return DuplicateDoc(tree) }},
		{name: "create by Markdown DOM", run: func() error {
			_, err := CreateDocByMd(boxID, "/ghost.sy", "Ghost", "# Ghost\n", nil, nil)
			return err
		}},
		{name: "create by human path", run: func() error {
			_, err := CreateWithMarkdown("", boxID, "/Ghost", "# Ghost\n", "", "", false, "", nil)
			return err
		}},
		{name: "daily note", run: func() error {
			_, _, err := CreateDailyNote(boxID)
			return err
		}},
		{name: "remove", run: func() error { return RemoveDoc(boxID, "/note.md") }},
		{name: "low-level box mkdir", run: func() error { return box.MkdirAll("/ghost") }},
		{name: "low-level box move", run: func() error { return box.Move("/note.md", "/moved.md") }},
		{name: "low-level box remove", run: func() error { return box.Remove("/note.md") }},
		{name: "rename", run: func() error { return RenameDoc(boxID, "/note.md", "Renamed") }},
		{name: "move target", run: func() error { return MoveDocs([]string{"/missing.sy"}, boxID, "/", nil) }},
		{name: "heading to document target", run: func() error {
			_, _, err := Heading2Doc("20260826050001-heading", boxID, "/", "", false)
			return err
		}},
		{name: "list item to document target", run: func() error {
			_, _, err := ListItem2Doc("20260826050002-listitm", boxID, "/", "", false)
			return err
		}},
		{name: "transaction create", run: func() error {
			transactions := []*Transaction{{DoOperations: []*Operation{{Action: "create", Data: tree}}}}
			return PerformTransactions(&transactions)
		}},
		{name: "export notebook as SY", run: func() error {
			_, err := ExportNotebookSY(boxID)
			return err
		}},
		{name: "export notebooks as SY", run: func() error {
			_, err := ExportNotebooksSY([]string{boxID})
			return err
		}},
		{name: "export documents as SY", run: func() error {
			_, err := ExportSYs([]string{tree.Root.ID})
			return err
		}},
		{name: "list native document tree", run: func() error {
			_, _, err := ListDocTree(boxID, "/", 0, false, false, 128)
			return err
		}},
		{name: "resolve native child document sort", run: func() error {
			_, err := ResolveDocTreeSortMode(boxID, "/")
			return err
		}},
		{name: "change native child document sort", run: func() error {
			return ChangeFileTreeSort(boxID, []string{"/note.md"})
		}},
		{name: "set native document sort mode", run: func() error {
			_, err := SetDocSortMode(tree.Root.ID, nil)
			return err
		}},
		{name: "set native file tree sort", run: func() error {
			_, err := SetFileTreeSort(nil, []*SortItem{{ID: tree.Root.ID, Sort: 1}})
			return err
		}},
		{name: "import SY document", run: func() error {
			return ImportSY(filepath.Join(t.TempDir(), "missing.sy.zip"), boxID, "/")
		}},
		{name: "auto-import SY document", run: func() error {
			_, _, err := ImportSYAuto(filepath.Join(t.TempDir(), "missing.sy.zip"), boxID, "/")
			return err
		}},
		{name: "import Markdown as native documents", run: func() error {
			return ImportFromLocalPath(boxID, filepath.Join(t.TempDir(), "missing.md"), "/")
		}},
		{name: "import Markdown children as native documents", run: func() error {
			return ImportFromLocalPathSkipRoot(boxID, filepath.Join(t.TempDir(), "missing"), "/")
		}},
		{name: "convert HTML with native asset extraction", run: func() error {
			_, _, err := HTML2Tree(`<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">`, util.NewLute(), boxID)
			return err
		}},
		{name: "insert native asset bytes", run: func() error {
			_, _, err := InsertAssetBytes(tree.Root.ID, "asset.txt", []byte("asset"))
			return err
		}},
		{name: "insert native local assets", run: func() error {
			_, err := InsertLocalAssets(tree.Root.ID, []string{filepath.Join(t.TempDir(), "missing.txt")}, true)
			return err
		}},
		{name: "store asset through native box path", run: func() error {
			_, err := StoreAssetForBox(boxID, filepath.Join(util.DataDir, boxID, "assets"), "asset.txt", []byte("asset"))
			return err
		}},
		{name: "download network assets through native tree", run: func() error {
			return NetAssets2LocalAssets(tree.Root.ID, false, "")
		}},
		{name: "generate image through native document asset pipeline", run: func() error {
			_, err := GenerateDocumentImage(context.Background(), GenerateDocumentImageRequest{DocumentID: tree.Root.ID, Prompt: "must not run"})
			return err
		}},
		{name: "create native document history", run: func() error {
			return CreateDocHistory(tree.Root.ID)
		}},
		{name: "format native document tree", run: func() error {
			return AutoSpace(tree.Root.ID)
		}},
		{name: "reset native flashcard tree", run: func() error {
			return ResetFlashcards("tree", tree.Root.ID, "", nil)
		}},
		{name: "create native attribute view storage", run: func() error {
			_, _, _, err := RenderAttributeViewWithTarget(tree.Root.ID, "20260826045000-avguard", "", "", 1, 32, nil,
				av.LayoutTypeTable, true, false, "", "")
			return err
		}},
		{name: "create native attribute view database block", run: func() error {
			_, err := CreateAttributeViewDatabase(tree.Root.ID, "", "", "Database", "Key", av.LayoutTypeTable, nil)
			return err
		}},
		{name: "mutate native attribute view storage", run: func() error {
			return SetAttrViewFilters("20260826045000-avguard", tree.Root.ID, nil)
		}},
		{name: "change native attribute view carrier", run: func() error {
			return SetDatabaseBlockView(tree.Root.ID, "20260826045000-avguard", "20260826045001-avview1")
		}},
		{name: "create native attribute view item", run: func() error {
			_, err := CreateAttributeViewItem("20260826045000-avguard", tree.Root.ID, "", "", "", "")
			return err
		}},
		{name: "bind Markdown projection into native attribute view", run: func() error {
			return AddAttributeViewBlock(nil, []map[string]any{{
				"itemID": "20260826045003-avitem01", "id": tree.Root.ID, "isDetached": false,
			}}, "20260826045000-avguard", "", "", "", "", false)
		}},
		{name: "remove Markdown projection from native attribute view", run: func() error {
			return RemoveAttributeViewBlock([]string{tree.Root.ID}, "20260826045000-avguard")
		}},
		{name: "replace native attribute view row with Markdown projection", run: func() error {
			return BatchReplaceAttributeViewBlocks("20260826045000-avguard", false,
				[]map[string]string{{"20260826045003-avitem01": tree.Root.ID}})
		}},
		{name: "update native attribute view cell for Markdown projection", run: func() error {
			_, err := UpdateAttributeViewCell(nil, "20260826045000-avguard", "20260826045004-avkey001", tree.Root.ID, map[string]any{})
			return err
		}},
		{name: "mutate native attribute view containing Markdown-bound row", run: func() error {
			return AppendAttributeViewDetachedBlocksWithValues(mixedAVID, nil)
		}},
		{name: "transaction against native attribute view containing Markdown-bound row", run: func() error {
			transactions := []*Transaction{{DoOperations: []*Operation{{
				Action: "setAttrViewName", ID: mixedAVID, AvID: mixedAVID, Data: "must not persist",
			}}}}
			return PerformTransactions(&transactions)
		}},
		{name: "restore native attribute view history containing Markdown-bound row", run: func() error {
			return RollbackAttributeViewHistory(mixedAVHistoryRequest)
		}},
		{name: "set native block attributes", run: func() error {
			return SetBlockAttrs(tree.Root.ID, map[string]string{"memo": "must not persist"})
		}},
		{name: "batch set native block attributes", run: func() error {
			return BatchSetBlockAttrs([]map[string]any{{"id": tree.Root.ID, "attrs": map[string]string{"memo": "must not persist"}}})
		}},
		{name: "transfer native block references", run: func() error {
			return TransferBlockRef(tree.Root.ID, tree.Root.ID, []string{tree.Root.ID})
		}},
		{name: "swap native block references", run: func() error {
			return SwapBlockRef(tree.Root.ID, tree.Root.ID, false)
		}},
		{name: "append native heading children", run: func() error {
			return AppendHeadingChildren(tree.Root.ID, "<div data-node-id=\"20260826045002-child01\" data-type=\"NodeParagraph\">child</div>")
		}},
		{name: "consume shorthands into native documents", run: func() error {
			_, err := MoveLocalShorthands(boxID)
			return err
		}},
		{name: "render native content template", run: func() error {
			_, _, err := RenderTemplate(filepath.Join(t.TempDir(), "missing.md"), tree.Root.ID, false)
			return err
		}},
		{name: "native find and replace", run: func() error {
			return FindReplace("Note", "Changed", map[string]bool{"docTitle": true}, []string{tree.Root.ID}, nil, nil, nil, nil, 0, 0, 0)
		}},
		{name: "native block update", run: func() error {
			_, _, err := PerformBlockUpdates([]BlockUpdateInput{{
				ID: tree.Root.ID, Data: "# Changed\n", DataType: "markdown",
			}})
			return err
		}},
		{name: "publish through native community exporter", run: func() error {
			return Export2Liandi(tree.Root.ID)
		}},
		{name: "upload assets through native cloud pipeline", run: func() error {
			_, err := UploadAssets2Cloud(tree.Root.ID, true)
			return err
		}},
		{name: "list native due flashcards", run: func() error {
			_, _, _, _, err := GetNotebookDueFlashcards(boxID, nil)
			return err
		}},
		{name: "shared tree write helper", run: func() error {
			return writeTreeUpsertQueue(tree)
		}},
		{name: "shared tree index-write helper", run: func() error {
			return indexWriteTreeIndexQueue(tree)
		}},
		{name: "shared tree upsert-write helper", run: func() error {
			return indexWriteTreeUpsertQueue(tree)
		}},
		{name: "shared tree rename-write helper", run: func() error {
			return renameWriteJSONQueue(tree)
		}},
	}
	for _, check := range checks {
		t.Run(check.name, func(t *testing.T) {
			if err := check.run(); !errors.Is(err, ErrMarkdownNativeDocumentTree) {
				t.Fatalf("expected Markdown native-tree rejection, got %v", err)
			}
		})
	}

	docs, err := ListMarkdownDocs(boxID)
	if nil != err {
		t.Fatal(err)
	}
	if 1 != len(docs) || "/note.md" != docs[0].Path {
		t.Fatalf("native operations changed the Markdown document set: %+v", docs)
	}
	if data, readErr := os.ReadFile(sourcePath); nil != readErr || source != string(data) {
		t.Fatalf("native operations changed Markdown source: %q, err=%v", data, readErr)
	}
	if entries, err := filepath.Glob(filepath.Join(util.DataDir, boxID, "*.sy")); nil != err || 0 != len(entries) {
		t.Fatalf("native operations leaked .sy files into Markdown notebook: %v, err=%v", entries, err)
	}
	if entries, err := filepath.Glob(filepath.Join(util.DataDir, boxID, ".siyuan", "sort.json")); nil != err || 0 != len(entries) {
		t.Fatalf("native operations leaked document-sort state into Markdown shadow: %v, err=%v", entries, err)
	}
	if entries, err := filepath.Glob(filepath.Join(util.DataDir, "storage", "av", "20260826045000-avguard.json")); nil != err || 0 != len(entries) {
		t.Fatalf("native operations leaked attribute-view storage for Markdown notebook: %v, err=%v", entries, err)
	}
	if data, readErr := os.ReadFile(mixedAVPath); nil != readErr || string(mixedAVSource) != string(data) {
		t.Fatalf("native operations changed mixed attribute-view fixture: %q, err=%v", data, readErr)
	}
}

func TestNativeDocumentTreeGuardKeepsSyNotebookCompatible(t *testing.T) {
	originalDataDir := util.DataDir
	util.DataDir = t.TempDir()
	t.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260826050000-native2"
	box := &Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindSy
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}
	if err := requireNativeDocumentTree(boxID); nil != err {
		t.Fatalf("native sy notebook was rejected: %v", err)
	}
}
