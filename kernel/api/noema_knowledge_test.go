package api

import (
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/aaronhe/noema/kernel/noema/wikisearch"
	"github.com/aaronhe/noema/kernel/util"
)

func TestNoemaKnowledgeSearchAPI(t *testing.T) {
	boxID := setupVaultGitAPITest(t)
	root := filepath.Join(util.DataDir, boxID)
	if err := os.MkdirAll(filepath.Join(root, ".noema"), 0o755); nil != err {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", wikisearch.DatabaseFile(root))
	if nil != err {
		t.Fatal(err)
	}
	for _, statement := range []string{
		`CREATE TABLE repositories (location_id text primary key, repository_id text not null, identity_status text not null, partition text not null, name text not null, namespace text not null, qualified_namespace text not null, namespace_aliases text not null, path text not null)`,
		`CREATE TABLE pages (page_key text primary key, page_id text not null, identity_status text not null, title text not null, namespace text not null, qualified_namespace text not null, namespace_source text not null, kind text not null, file text not null unique, workspace_path text not null, repository_path text not null, repository_id text not null, partition text not null, private integer not null, redirect_to text not null, mtime real not null, created real not null)`,
		`CREATE TABLE blocks (block_id text not null, page_key text not null, kind text not null, env_kind text not null, label text not null, source_offset integer not null, primary key(page_key, block_id))`,
		`CREATE TABLE aliases (page_key text not null, alias text not null)`,
		`CREATE TABLE tags (page_key text not null, tag text not null)`,
		`CREATE TABLE links (source_key text not null, raw_target text not null, target_id text, target_block_id text, target_title text not null, status text not null)`,
		`CREATE TABLE wiki_meta (key text primary key, value text not null)`,
		`CREATE VIRTUAL TABLE pages_fts USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='unicode61 remove_diacritics 2')`,
		`CREATE VIRTUAL TABLE pages_fts_trigram USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='trigram case_sensitive 0')`,
		`CREATE TABLE page_bigrams (bigram text not null, page_key text not null, primary key(bigram, page_key)) WITHOUT ROWID`,
		`INSERT INTO wiki_meta VALUES ('generation', 'g1'), ('updated_at', 'now')`,
		`INSERT INTO repositories VALUES ('r', 'public/README', 'ok', 'public', 'README', 'README', 'public/README', '["README"]', 'public/README')`,
		`INSERT INTO pages VALUES ('k', 'id-1', 'ok', 'maintain', 'README', 'public/README', 'repository', 'page', '/vault/maintain.md', 'public/README/maintain.md', 'maintain.md', 'public/README', 'public', 0, '', 1, 0)`,
		`INSERT INTO pages_fts VALUES ('k', 'maintain', '', '', 'public/README/maintain.md', 'How this vault is kept.')`,
		`INSERT INTO pages_fts_trigram VALUES ('k', 'maintain', '', '', 'public/README/maintain.md', 'How this vault is kept.')`,
	} {
		if _, err = db.Exec(statement); nil != err {
			t.Fatalf("%s: %v", statement, err)
		}
	}
	db.Close()

	response := vaultGitRequest(t, noemaKnowledgeSearch, "/search",
		`{"notebook":"`+boxID+`","query":"readme: maintian","mode":"suggest"}`)
	if 0 != response.Code {
		t.Fatalf("search API failed: %s", response.Msg)
	}
	var answer wikisearch.Response
	if err = json.Unmarshal(response.Data, &answer); nil != err {
		t.Fatal(err)
	}
	if answer.Source != "kernel-wiki" || answer.Total != 1 || answer.Items[0].Title != "maintain" || answer.Items[0].MatchKind != "fuzzy" {
		t.Fatalf("a misspelled title under a namespace prefix is found: %+v", answer)
	}
	if answer.Create == nil || answer.Create.Namespace != "README" {
		t.Fatalf("the page the query names: %+v", answer.Create)
	}

	if missing := vaultGitRequest(t, noemaKnowledgeSearch, "/search", `{"query":"x"}`); 0 == missing.Code {
		t.Fatal("a search names its notebook")
	}
	if unknown := vaultGitRequest(t, noemaKnowledgeSearch, "/search", `{"notebook":"20260101000000-nowhere","query":"x"}`); 0 == unknown.Code {
		t.Fatal("an unknown notebook is refused")
	}
}
