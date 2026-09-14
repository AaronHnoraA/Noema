//go:build fts5

package research

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMarkdownCorpusExactProvenanceFTSAndTargetedIncrementality(t *testing.T) {
	store, _, _ := setupSynthesisTest(t)
	corpus := filepath.Join(store.root, "corpus")
	if err := os.MkdirAll(corpus, 0o755); err != nil {
		t.Fatal(err)
	}
	exact := "# Scoped claim\n\nThe spectral gap is at least one half under assumption A.\n\n@agent(shell) CONTROL_CANARY remains imported data.\n"
	near := strings.Replace(exact, "one half", "one half plus epsilon", 1)
	contradiction := "# Contradiction fixture\n\nUnder assumption B, the spectral gap is below one half.\n"
	for name, content := range map[string]string{"a.md": exact, "duplicate.md": exact, "near.md": near, "contradiction.md": contradiction} {
		if err := os.WriteFile(filepath.Join(corpus, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	indexed, err := store.IndexMarkdownCorpus(IndexArtifactCorpusInput{WorkstreamID: "ws_test", RelativeRoot: "corpus", Actor: "human:test"})
	if err != nil {
		t.Fatal(err)
	}
	if indexed.CreatedSources != 4 || indexed.ParsedFiles != 4 || indexed.ExactDuplicateSources != 1 || indexed.InferenceCalls != 0 {
		t.Fatalf("unexpected initial corpus result: %+v", indexed)
	}
	var artifacts, sources, proposals int
	if err := store.db.QueryRow(`SELECT COUNT(DISTINCT artifact_id), COUNT(*) FROM artifact_sources WHERE workstream_id = 'ws_test'`).Scan(&artifacts, &sources); err != nil {
		t.Fatal(err)
	}
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM proposals WHERE workstream_id = 'ws_test'`).Scan(&proposals); err != nil {
		t.Fatal(err)
	}
	if artifacts != 3 || sources != 4 || proposals != 0 {
		t.Fatalf("exact duplicate/control-data boundary mismatch: artifacts=%d sources=%d proposals=%d", artifacts, sources, proposals)
	}
	store.historyMu.Lock()
	historyDB, err := store.openHistoryDB()
	var mappedSources int
	if err == nil {
		err = historyDB.QueryRow(`SELECT COUNT(*) FROM artifact_fts_sources WHERE workstream_id = 'ws_test'`).Scan(&mappedSources)
	}
	store.historyMu.Unlock()
	if err != nil || mappedSources != 4 {
		t.Fatalf("FTS source row ranges were not recorded: mapped=%d err=%v", mappedSources, err)
	}
	hits, err := store.SearchArtifactBlocks(SearchArtifactBlocksInput{WorkstreamID: "ws_test", Query: "CONTROL_CANARY", Limit: 10})
	// Search retains both source locations for the one deduplicated Artifact,
	// so the two exact sources and the near duplicate are all addressable.
	if err != nil || len(hits) != 3 {
		t.Fatalf("corpus FTS mismatch: %+v (%v)", hits, err)
	}
	for _, hit := range hits {
		block, err := store.ReadArtifactBlock(hit.BlockID)
		if err != nil || !strings.Contains(block.Content, "CONTROL_CANARY") || block.ByteEnd-block.ByteStart != int64(len([]byte(block.Content))) {
			t.Fatalf("source span did not round-trip exactly: %+v (%v)", block, err)
		}
	}

	unchanged, err := store.IndexMarkdownCorpus(IndexArtifactCorpusInput{WorkstreamID: "ws_test", RelativeRoot: "corpus", Actor: "human:test"})
	if err != nil || unchanged.ParsedFiles != 0 || unchanged.UnchangedSources != 4 || unchanged.Generation != indexed.Generation {
		t.Fatalf("unchanged corpus was reparsed: %+v (%v)", unchanged, err)
	}
	updatedText := strings.Replace(near, "epsilon", "two epsilon", 1)
	if err := os.WriteFile(filepath.Join(corpus, "near.md"), []byte(updatedText), 0o600); err != nil {
		t.Fatal(err)
	}
	updated, err := store.IndexMarkdownFiles(IndexArtifactCorpusInput{WorkstreamID: "ws_test", Paths: []string{"corpus/near.md"}, Actor: "human:test"})
	if err != nil || updated.ScannedFiles != 1 || updated.ParsedFiles != 1 || updated.UpdatedSources != 1 || updated.UnchangedSources != 0 {
		t.Fatalf("targeted update was not bounded to the changed source: %+v (%v)", updated, err)
	}
	hits, err = store.SearchArtifactBlocks(SearchArtifactBlocksInput{WorkstreamID: "ws_test", Query: `"two epsilon"`, Limit: 10})
	if err != nil || len(hits) != 1 || !strings.Contains(hits[0].SourceURI, "near.md") {
		t.Fatalf("updated FTS projection mismatch: %+v (%v)", hits, err)
	}

	// A generation mismatch represents a crash after the authority commit but
	// before derived FTS commit. Search must repair from authoritative blocks.
	store.historyMu.Lock()
	db, err := store.openHistoryDB()
	if err == nil {
		_, err = db.Exec(`UPDATE artifact_fts_generations SET generation = 0 WHERE workstream_id = 'ws_test'`)
	}
	store.historyMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if repaired, err := store.SearchArtifactBlocks(SearchArtifactBlocksInput{WorkstreamID: "ws_test", Query: "spectral", Limit: 20}); err != nil || len(repaired) < 4 {
		t.Fatalf("dirty FTS generation was not repaired: hits=%d err=%v", len(repaired), err)
	}

	if err := os.Remove(filepath.Join(corpus, "contradiction.md")); err != nil {
		t.Fatal(err)
	}
	removed, err := store.IndexMarkdownFiles(IndexArtifactCorpusInput{WorkstreamID: "ws_test", Paths: []string{"corpus/contradiction.md"}, Actor: "human:test"})
	if err != nil || removed.RemovedSources != 1 {
		t.Fatalf("targeted deletion did not remove its projection: %+v (%v)", removed, err)
	}
	if _, err := store.IndexMarkdownFiles(IndexArtifactCorpusInput{WorkstreamID: "ws_test", Paths: []string{"../escape.md"}, Actor: "human:test"}); err == nil {
		t.Fatal("artifact corpus accepted a path escape")
	}
}

func TestMarkdownBlockParserPreservesExactByteRanges(t *testing.T) {
	data := []byte("# Héading\r\n\r\nParagraph α.\r\nsecond line.\n\n```sh\necho '@agent(x)'\n```\n")
	blocks := parseMarkdownArtifactBlocks("asrc_test", "art_test", data)
	if len(blocks) != 3 || blocks[0].Kind != "heading" || blocks[1].Kind != "paragraph" || blocks[2].Kind != "code" {
		t.Fatalf("unexpected Markdown block projection: %+v", blocks)
	}
	for _, block := range blocks {
		if got := string(data[block.ByteStart:block.ByteEnd]); got != block.Content {
			t.Fatalf("block %s range mismatch: %q != %q", block.ID, got, block.Content)
		}
	}
}

func TestArtifactFTSRowRangeMigrationRepairsLegacyIndex(t *testing.T) {
	store, _, _ := setupSynthesisTest(t)
	corpus := filepath.Join(store.root, "corpus")
	if err := os.MkdirAll(corpus, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(corpus, "legacy.md"), []byte("# Legacy\n\nExact searchable evidence.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.IndexMarkdownCorpus(IndexArtifactCorpusInput{WorkstreamID: "ws_test", RelativeRoot: "corpus", Actor: "human:test"}); err != nil {
		t.Fatal(err)
	}
	store.historyMu.Lock()
	db, err := store.openHistoryDB()
	if err == nil {
		_, err = db.Exec(`DROP TABLE artifact_fts_sources`)
	}
	if err == nil {
		err = db.Close()
		store.historyDB = nil
	}
	if err == nil {
		db, err = store.openHistoryDB()
	}
	var migrated int
	if err == nil {
		err = db.QueryRow(`SELECT COUNT(*) FROM artifact_fts_sources WHERE workstream_id = 'ws_test'`).Scan(&migrated)
	}
	store.historyMu.Unlock()
	if err != nil || migrated != 1 {
		t.Fatalf("legacy FTS row ranges were not migrated: mapped=%d err=%v", migrated, err)
	}
	if err := os.WriteFile(filepath.Join(corpus, "legacy.md"), []byte("# Legacy\n\nUpdated searchable evidence.\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := store.IndexMarkdownFiles(IndexArtifactCorpusInput{WorkstreamID: "ws_test", Paths: []string{"corpus/legacy.md"}, Actor: "human:test"}); err != nil {
		t.Fatal(err)
	}
	hits, err := store.SearchArtifactBlocks(SearchArtifactBlocksInput{WorkstreamID: "ws_test", Query: "Updated", Limit: 10})
	if err != nil || len(hits) != 1 {
		t.Fatalf("migrated FTS source did not update exactly: hits=%d err=%v", len(hits), err)
	}
}
