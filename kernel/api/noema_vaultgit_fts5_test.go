//go:build fts5

package api

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/util"
)

func TestNoemaVaultGitRestorePreservesBytesAndReindexes(t *testing.T) {
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
	for _, directory := range []string{util.ConfDir, util.DataDir, util.HistoryDir, util.TempDir, util.QueueDir} {
		if err := os.MkdirAll(directory, 0o755); nil != err {
			t.Fatal(err)
		}
	}

	model.Conf = model.NewAppConf()
	model.Conf.Editor = conf.NewEditor()
	model.Conf.Export = conf.NewExport()
	model.Conf.FileTree = conf.NewFileTree()
	model.Conf.NotebookCrypto = conf.NewNotebookCrypto()
	model.Conf.Sync = conf.NewSync()
	model.Conf.Search = conf.NewSearch()
	boxID := "20260826025000-vaultft"
	box := &model.Box{ID: boxID}
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Vault Git restore FTS5 test"
	boxConf.Closed = false
	if err := box.SaveConf(boxConf); nil != err {
		t.Fatal(err)
	}

	repository := filepath.Join(util.DataDir, boxID, "private", "history")
	if err := os.MkdirAll(repository, 0o755); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "init", "--initial-branch=main")
	vaultGitExec(t, repository, "config", "user.name", "Historian")
	vaultGitExec(t, repository, "config", "user.email", "history@example.test")
	file := filepath.Join(repository, "page.md")
	first := "# Version one\n\nhistoricalrestoretoken\n"
	if err := os.WriteFile(file, []byte(first), 0o644); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "add", "page.md")
	vaultGitExec(t, repository, "commit", "-m", "first version")
	firstSHA := vaultGitExec(t, repository, "rev-parse", "HEAD")
	if err := os.WriteFile(file, []byte("# Version two\n\ncurrentonlytoken\n"), 0o644); nil != err {
		t.Fatal(err)
	}
	vaultGitExec(t, repository, "add", "page.md")
	vaultGitExec(t, repository, "commit", "-m", "second version")
	renamedPath := "renamed page.md"
	vaultGitExec(t, repository, "mv", "page.md", renamedPath)
	vaultGitExec(t, repository, "commit", "-m", "rename page")
	file = filepath.Join(repository, renamedPath)

	sql.InitDatabase(true)
	sql.InitHistoryDatabase(true)
	sql.InitAssetContentDatabase(true)
	t.Cleanup(sql.CloseDatabase)
	restoreResponse := vaultGitRequest(t, noemaVaultGitRestore, "/restore",
		`{"notebook":"`+boxID+`","path":"/private/history","filePath":"`+renamedPath+`","sha":"`+firstSHA+`"}`)
	if 0 != restoreResponse.Code {
		t.Fatalf("restore API failed: %s", restoreResponse.Msg)
	}
	var restored struct {
		Path, SHA, Source string
		Bytes             int
	}
	if err := json.Unmarshal(restoreResponse.Data, &restored); nil != err {
		t.Fatal(err)
	}
	if restored.Path != renamedPath || restored.SHA != firstSHA || restored.Source != "kernel-vaultgit" || restored.Bytes != len(first) {
		t.Fatalf("unexpected restore response: %+v", restored)
	}
	content, err := os.ReadFile(file)
	if nil != err {
		t.Fatal(err)
	}
	if string(content) != first {
		t.Fatalf("restore changed committed bytes: %q", content)
	}
	results, matched, _, _, _ := model.FullTextSearchBlock(
		"historicalrestoretoken", nil, nil, nil, nil, 0, 0, 0, 1, 32,
	)
	if matched != 1 || len(results) != 1 || results[0].Box != boxID || results[0].Path != "/private/history/"+renamedPath {
		t.Fatalf("restored version was not indexed: matched=%d results=%+v", matched, results)
	}
	_, currentMatched, _, _, _ := model.FullTextSearchBlock(
		"currentonlytoken", nil, nil, nil, nil, 0, 0, 0, 1, 32,
	)
	if currentMatched != 0 {
		t.Fatalf("superseded version remains searchable: %d", currentMatched)
	}
}
