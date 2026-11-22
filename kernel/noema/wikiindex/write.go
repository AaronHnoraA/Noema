package wikiindex

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"regexp"
	"strings"

	"golang.org/x/text/unicode/norm"
)

// SchemaVersion is wiki.db's PRAGMA user_version (WIKI_SCHEMA_VERSION in
// server/lib/wiki-workspace.mjs).
const SchemaVersion = 11

// Index is a built Wiki index: repositories, their files, their pages and the
// diagnostics, as Node's buildWikiIndex hands them to persistence.
type Index struct {
	Repositories []IndexRepository `json:"repositories"`
	Files        []IndexFile       `json:"files"`
	Notes        []IndexNote       `json:"notes"`
	Diagnostics  []Diagnostic      `json:"diagnostics"`
	Generation   string            `json:"generation"`
}

type IndexRepository struct {
	ID                 string   `json:"id"`
	UID                string   `json:"uid"`
	IdentityStatus     string   `json:"identityStatus"`
	Name               string   `json:"name"`
	Namespace          string   `json:"namespace"`
	QualifiedNamespace string   `json:"qualifiedNamespace"`
	NamespaceAliases   []string `json:"namespaceAliases"`
	Partition          string   `json:"partition"`
	Path               string   `json:"path"`
	HeadSHA            string   `json:"headSha"`
}

type IndexFile struct {
	RepositoryID   string  `json:"repositoryId"`
	RepositoryUID  string  `json:"repositoryUid"`
	RepositoryPath string  `json:"repositoryPath"`
	File           string  `json:"file"`
	Kind           string  `json:"kind"`
	Ext            string  `json:"ext"`
	Size           float64 `json:"size"`
	MtimeMs        float64 `json:"mtimeMs"`
	GitStatus      string  `json:"gitStatus"`
}

type Dependency struct {
	Kind   string `json:"kind"`
	Raw    string `json:"raw"`
	Path   string `json:"path"`
	Status string `json:"status"`
}

type IndexNote struct {
	Page
	Key             string       `json:"key"`
	PageKey         string       `json:"pageKey"`
	QualifiedTitle  string       `json:"qualifiedTitle"`
	NamespaceSource string       `json:"namespaceSource"`
	Tags            []string     `json:"tags"`
	Private         bool         `json:"private"`
	Path            string       `json:"path"`
	RepositoryUID   string       `json:"repositoryUid"`
	MtimeMs         float64      `json:"mtimeMs"`
	CreatedMs       float64      `json:"createdMs"`
	Dependencies    []Dependency `json:"dependencies"`
	SearchText      string       `json:"searchText"`

	duplicateBlockIDs []string
}

type Diagnostic struct {
	Code     string `json:"code"`
	Severity string `json:"severity"`
	Message  string `json:"message"`
	Path     string `json:"path"`
}

const wikiSchema = `
CREATE TABLE repositories (location_id text primary key, repository_id text not null, identity_status text not null, partition text not null, name text not null, namespace text not null, qualified_namespace text not null, namespace_aliases text not null, path text not null);
CREATE TABLE files (repository_id text not null, path text not null, file text not null unique, kind text not null, extension text not null, size integer not null, mtime real not null, git_status text not null, primary key(repository_id, path));
CREATE TABLE pages (page_key text primary key, page_id text not null, identity_status text not null, title text not null, namespace text not null, qualified_namespace text not null, namespace_source text not null, kind text not null, file text not null unique, workspace_path text not null, repository_path text not null, repository_id text not null, partition text not null, private integer not null, redirect_to text not null, mtime real not null, created real not null);
CREATE TABLE blocks (block_id text not null, page_key text not null, kind text not null, env_kind text not null, label text not null, source_offset integer not null, primary key(page_key, block_id));
CREATE TABLE aliases (page_key text not null, alias text not null);
CREATE TABLE tags (page_key text not null, tag text not null);
CREATE TABLE links (source_key text not null, raw_target text not null, target_id text, target_block_id text, target_title text not null, status text not null);
CREATE TABLE dependencies (source_key text not null, kind text not null, raw_target text not null, target_path text not null, status text not null);
CREATE TABLE diagnostics (code text not null, severity text not null, message text not null, path text not null);
CREATE TABLE wiki_meta (key text primary key, value text not null);
CREATE TABLE note_cache (repository_id text not null, path text not null, repository_uid text not null, size integer not null, mtime real not null, snapshot_json text not null, primary key(repository_id, path));
CREATE TABLE repository_index_state (repository_id text primary key, repository_uid text not null, head_sha text not null, scanned_at text not null);
CREATE VIRTUAL TABLE pages_fts USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE pages_fts_trigram USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='trigram case_sensitive 0');
CREATE TABLE page_bigrams (bigram text not null, page_key text not null, primary key(bigram, page_key)) WITHOUT ROWID;
CREATE INDEX wiki_page_bigrams_page_idx ON page_bigrams(page_key);
CREATE INDEX wiki_pages_id_idx ON pages(page_id);
CREATE INDEX wiki_pages_title_idx ON pages(title);
CREATE INDEX wiki_pages_namespace_idx ON pages(qualified_namespace, title);
CREATE INDEX wiki_pages_repository_idx ON pages(repository_id, repository_path);
CREATE INDEX wiki_aliases_alias_idx ON aliases(alias);
CREATE INDEX wiki_tags_tag_idx ON tags(tag);
CREATE INDEX wiki_blocks_id_idx ON blocks(block_id);
CREATE INDEX wiki_blocks_label_idx ON blocks(label);
CREATE INDEX wiki_links_target_idx ON links(target_id);
CREATE INDEX wiki_links_block_target_idx ON links(target_id, target_block_id);
CREATE INDEX wiki_links_raw_target_idx ON links(raw_target);
CREATE INDEX wiki_files_kind_idx ON files(kind, repository_id, path);
`

var cjkRunRE = regexp.MustCompile(`[\x{2e80}-\x{9fff}\x{f900}-\x{faff}]+`)

// cjkPairs are the adjacent CJK character pairs of TEXTS, the terms the
// trigram index cannot answer (cjkPairs in server/lib/wiki-workspace.mjs).
func cjkPairs(texts ...string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, text := range texts {
		folded := strings.ToLower(norm.NFKC.String(text))
		for _, run := range cjkRunRE.FindAllString(folded, -1) {
			chars := []rune(run)
			for index := 0; index+1 < len(chars); index++ {
				pair := string(chars[index : index+2])
				if !seen[pair] {
					seen[pair] = true
					out = append(out, pair)
				}
			}
		}
	}
	return out
}

func noteKey(note IndexNote) string {
	if note.PageKey != "" {
		return note.PageKey
	}
	return note.Key
}

type linkRow struct {
	rawTarget, targetTitle, status string
	targetID, targetBlockID        sql.NullString
}

// linkRows are a page's rows in `links` (linkRowsForNote).
func linkRows(pages []Page, l lookup, source int) []linkRow {
	rows := []linkRow{}
	page := pages[source]
	for _, link := range page.WikiLinks {
		found := l.candidates(pages, link.Target, source)
		if len(found) != 1 {
			status := "missing"
			if len(found) > 1 {
				status = "ambiguous"
			}
			rows = append(rows, linkRow{rawTarget: link.Target, targetTitle: link.Target, status: status})
			continue
		}
		target := pages[found[0]]
		_, fragment := splitFragment(link.Target)
		status, blockID := "resolved", ""
		if fragment != "" {
			for _, block := range target.Blocks {
				if canonicalTitle(block.ID) == canonicalTitle(fragment) {
					blockID = block.ID
					break
				}
			}
			if blockID == "" && uuidV7RE.MatchString(strings.TrimSpace(fragment)) {
				status = "missing-fragment"
			}
		}
		if target.File == page.File && fragment == "" {
			continue
		}
		row := linkRow{rawTarget: link.Target, targetTitle: target.Title, status: status,
			targetID: sql.NullString{String: target.ID, Valid: true}}
		if blockID != "" {
			row.targetBlockID = sql.NullString{String: blockID, Valid: true}
		}
		rows = append(rows, row)
	}
	return rows
}

// WriteDatabase builds a complete wiki.db for IDX at PATH, a file that must
// not exist yet: it never replaces an index, so it can be compared with the
// one Node builds before it is trusted with the real file.
func WriteDatabase(db *sql.DB, idx Index, now string) error {
	var count int
	if err := db.QueryRow("SELECT count(*) FROM sqlite_master").Scan(&count); err != nil {
		return err
	}
	if count != 0 {
		return errors.New("wikiindex: refusing to write into a database that already has tables")
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.Exec(wikiSchema + fmt.Sprintf("PRAGMA user_version=%d;", SchemaVersion)); err != nil {
		return err
	}
	insert := map[string]string{}
	emit(idx, now, func(table string, values ...any) {
		if err != nil {
			return
		}
		query, ok := insert[table]
		if !ok {
			verb := "INSERT"
			if table == "page_bigrams" {
				verb = "INSERT OR IGNORE"
			}
			query = verb + " INTO " + table + " VALUES (" + strings.TrimSuffix(strings.Repeat("?, ", len(values)), ", ") + ")"
			insert[table] = query
		}
		_, err = tx.Exec(query, values...)
	})
	exec := func(query string, args ...any) {
		if err == nil {
			_, err = tx.Exec(query, args...)
		}
	}
	for _, meta := range [][2]string{{"generation", idx.Generation}, {"updated_at", now}, {"last_mode", "full"},
		{"last_reason", "kernel"}, {"last_error", ""}, {"last_changed_files", "[]"}, {"last_full_at", now}} {
		exec("INSERT INTO wiki_meta VALUES (?, ?)", meta[0], meta[1])
	}
	if err != nil {
		return err
	}
	return tx.Commit()
}

// emit hands PUT every row a full build of IDX writes, table by table: the
// one description WriteDatabase inserts and ApplyIndex reconciles against.
func emit(idx Index, now string, put func(table string, values ...any)) {
	for _, repo := range idx.Repositories {
		uid := repo.UID
		if uid == "" {
			uid = repo.ID
		}
		status := repo.IdentityStatus
		if status == "" {
			status = "legacy"
		}
		namespace := repo.Namespace
		if namespace == "" {
			namespace = repo.Name
		}
		qualified := repo.QualifiedNamespace
		if qualified == "" {
			qualified = repo.Partition + "/" + repo.Name
		}
		aliases := repo.NamespaceAliases
		if aliases == nil {
			aliases = []string{}
		}
		aliasJSON, _ := json.Marshal(aliases)
		put("repositories", repo.ID, uid, status, repo.Partition, repo.Name, namespace, qualified, string(aliasJSON), repo.Path)
		put("repository_index_state", repo.ID, uid, repo.HeadSHA, now)
	}
	for _, file := range idx.Files {
		gitStatus := file.GitStatus
		if gitStatus == "" {
			gitStatus = "clean"
		}
		put("files", file.RepositoryID, file.RepositoryPath,
			file.File, file.Kind, file.Ext, int64(file.Size), file.MtimeMs, gitStatus)
	}
	pages := make([]Page, len(idx.Notes))
	for index, note := range idx.Notes {
		pages[index] = note.Page
	}
	l := buildLookup(pages)
	for index, note := range idx.Notes {
		key := noteKey(note)
		namespace := note.Namespace
		if namespace == "" {
			namespace = note.Repository
		}
		qualified := note.QualifiedNS
		if qualified == "" {
			qualified = note.Partition + "/" + namespace
		}
		source := note.NamespaceSource
		if source == "" {
			source = "repository"
		}
		kind := note.Kind
		if kind == "" {
			kind = "page"
		}
		private := 0
		if note.Private {
			private = 1
		}
		put("pages", key, note.ID, note.IdentityStatus, note.Title, namespace, qualified, source, kind, note.File,
			note.Path, note.RepositoryPath, note.RepositoryID, note.Partition, private, note.RedirectTo,
			note.MtimeMs, note.CreatedMs)
		for _, block := range note.Blocks {
			label := block.Label
			if label == "" {
				label = block.ID
			}
			put("blocks", block.ID, key, block.Kind, block.EnvKind, label, block.Offset)
		}
		for _, alias := range note.Aliases {
			put("aliases", key, alias)
		}
		for _, tag := range note.Tags {
			put("tags", key, tag)
		}
		for _, row := range linkRows(pages, l, index) {
			put("links", key, row.rawTarget, row.targetID, row.targetBlockID, row.targetTitle, row.status)
		}
		for _, dep := range note.Dependencies {
			put("dependencies", key, dep.Kind, dep.Raw, dep.Path, dep.Status)
		}
		searchAliases := []string{}
		for _, value := range append([]string{note.QualifiedTitle, note.FullTitle}, note.Aliases...) {
			if value != "" {
				searchAliases = append(searchAliases, value)
			}
		}
		aliasText := strings.Join(searchAliases, " ")
		tagText := strings.Join(note.Tags, " ")
		pathText := note.RepositoryID + "/" + note.RepositoryPath
		put("pages_fts", key, note.Title, aliasText, tagText, pathText, note.SearchText)
		put("pages_fts_trigram", key, note.Title, aliasText, tagText, pathText, note.SearchText)
		for _, pair := range cjkPairs(note.Title, aliasText, tagText, note.SearchText) {
			put("page_bigrams", pair, key)
		}
	}
	for _, diagnostic := range idx.Diagnostics {
		put("diagnostics", diagnostic.Code, diagnostic.Severity, diagnostic.Message, diagnostic.Path)
	}
}
