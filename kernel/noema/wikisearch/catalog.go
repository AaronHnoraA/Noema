// Noema Wiki search is Copyright (c) 2026 Aaron He and distributed under the
// AGPL-3.0-or-later terms of the Noema kernel.

package wikisearch

import (
	"database/sql"
	"encoding/json"
	"path"
	"path/filepath"
	"strings"
	"sync"
)

// page is one row of wiki.db's pages table with what title matching needs
// worked out once.
type page struct {
	key, id, identityStatus string
	title, kind             string
	namespace, qualified    string
	namespaceSource         string
	file, workspacePath     string
	repositoryPath          string
	repositoryID, partition string
	private                 bool
	redirectTo              string
	mtime, created          float64
	aliases, tags           []string
	foldTitle, foldFile     string
	foldAliases             []string
	ftsRow                  int64
}

type vocabTerm struct {
	term string
	docs int
}

// catalog is everything about the pages of one wiki.db generation that a
// search reads before it reads any page text.  wiki.db is a projection Node
// rebuilds; the catalog is rebuilt whenever its generation or update time
// changes.
type catalog struct {
	stamp      string
	generation string
	pages      []*page
	byKey      map[string]*page
	namespaces map[string][2]string // folded name -> namespace, partition
	vocabOnce  sync.Once
	vocab      []vocabTerm
	anchorOnce sync.Once
	anchors    map[string][]anchor
}

var (
	catalogMu sync.Mutex
	catalogs  = map[string]*catalog{}
)

// DatabaseFile is where Node keeps the Wiki projection of a workspace.
func DatabaseFile(root string) string {
	return filepath.Join(root, ".noema", "wiki.db")
}

func openDatabase(file string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", "file:"+file+"?mode=ro&_busy_timeout=3000")
	if err != nil {
		return nil, err
	}
	// The vocabulary table lives in this connection's temp schema.
	db.SetMaxOpenConns(1)
	return db, nil
}

func loadCatalog(db *sql.DB, file string) (*catalog, error) {
	meta := map[string]string{}
	rows, err := db.Query(`SELECT key, value FROM wiki_meta WHERE key IN ('generation', 'updated_at')`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var key, value string
		if err = rows.Scan(&key, &value); err != nil {
			rows.Close()
			return nil, err
		}
		meta[key] = value
	}
	rows.Close()
	stamp := meta["generation"] + "\x00" + meta["updated_at"]

	catalogMu.Lock()
	cached := catalogs[file]
	catalogMu.Unlock()
	if cached != nil && cached.stamp == stamp {
		return cached, nil
	}

	fresh := &catalog{stamp: stamp, generation: meta["generation"], byKey: map[string]*page{}, namespaces: map[string][2]string{}}
	rows, err = db.Query(`SELECT page_key, page_id, identity_status, title, namespace, qualified_namespace,
		namespace_source, kind, file, workspace_path, repository_path, repository_id, partition, private,
		redirect_to, mtime, created FROM pages`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		item := &page{}
		var private int
		if err = rows.Scan(&item.key, &item.id, &item.identityStatus, &item.title, &item.namespace, &item.qualified,
			&item.namespaceSource, &item.kind, &item.file, &item.workspacePath, &item.repositoryPath,
			&item.repositoryID, &item.partition, &private, &item.redirectTo, &item.mtime, &item.created); err != nil {
			rows.Close()
			return nil, err
		}
		item.private = private != 0
		item.foldTitle = Fold(item.title)
		base := path.Base(item.repositoryPath)
		item.foldFile = Fold(strings.TrimSuffix(base, path.Ext(base)))
		fresh.pages = append(fresh.pages, item)
		fresh.byKey[item.key] = item
		fresh.addNamespace(item.namespace, item.namespace, "")
		fresh.addNamespace(item.qualified, item.namespace, item.partition)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}

	each := func(query string, apply func(*page, string)) error {
		found, queryErr := db.Query(query)
		if queryErr != nil {
			return queryErr
		}
		defer found.Close()
		for found.Next() {
			var key, value string
			if scanErr := found.Scan(&key, &value); scanErr != nil {
				return scanErr
			}
			if item := fresh.byKey[key]; item != nil {
				apply(item, value)
			}
		}
		return found.Err()
	}
	if err = each(`SELECT page_key, alias FROM aliases ORDER BY alias`, func(item *page, alias string) {
		item.aliases = append(item.aliases, alias)
		item.foldAliases = append(item.foldAliases, Fold(alias))
	}); err != nil {
		return nil, err
	}
	if err = each(`SELECT page_key, tag FROM tags ORDER BY tag`, func(item *page, tag string) {
		item.tags = append(item.tags, tag)
	}); err != nil {
		return nil, err
	}
	rowids, err := db.Query(`SELECT rowid, page_key FROM pages_fts`)
	if err != nil {
		return nil, err
	}
	for rowids.Next() {
		var rowid int64
		var key string
		if err = rowids.Scan(&rowid, &key); err != nil {
			rowids.Close()
			return nil, err
		}
		if item := fresh.byKey[key]; item != nil {
			item.ftsRow = rowid
		}
	}
	rowids.Close()

	repositories, err := db.Query(`SELECT namespace, qualified_namespace, namespace_aliases, partition FROM repositories`)
	if err != nil {
		return nil, err
	}
	for repositories.Next() {
		var namespace, qualified, aliases, partition string
		if err = repositories.Scan(&namespace, &qualified, &aliases, &partition); err != nil {
			repositories.Close()
			return nil, err
		}
		fresh.addNamespace(namespace, namespace, "")
		fresh.addNamespace(qualified, namespace, partition)
		var names []string
		if json.Unmarshal([]byte(aliases), &names) == nil {
			for _, name := range names {
				fresh.addNamespace(name, namespace, "")
				fresh.addNamespace(partition+"/"+name, namespace, partition)
			}
		}
	}
	repositories.Close()

	catalogMu.Lock()
	catalogs[file] = fresh
	catalogMu.Unlock()
	return fresh, nil
}

func namespaceKey(name string) string {
	parts := strings.Split(strings.TrimSpace(name), "/")
	for index, part := range parts {
		parts[index] = strings.ToLower(strings.Join(strings.Fields(part), " "))
	}
	return strings.Join(parts, "/")
}

// addNamespace records a name a person may type for a namespace.  The first
// meaning of a name stands: a repository's own name is recorded before any
// alias that happens to repeat it.
func (c *catalog) addNamespace(name, namespace, partition string) {
	key := namespaceKey(name)
	if key == "" || namespace == "" {
		return
	}
	if _, taken := c.namespaces[key]; !taken {
		c.namespaces[key] = [2]string{namespace, partition}
	}
}

func (c *catalog) resolveNamespace(prefix string) (namespace, partition string, ok bool) {
	found, ok := c.namespaces[namespaceKey(strings.ReplaceAll(prefix, "_", " "))]
	return found[0], found[1], ok
}

// vocabulary is every word the index knows with the number of pages that
// carry it, for correcting a word no page contains.
func (c *catalog) vocabulary(db *sql.DB) []vocabTerm {
	c.vocabOnce.Do(func() {
		if _, err := db.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp.wiki_vocab USING fts5vocab('main', 'pages_fts', 'row')`); err != nil {
			return
		}
		rows, err := db.Query(`SELECT term, doc FROM temp.wiki_vocab`)
		if err != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var item vocabTerm
			if rows.Scan(&item.term, &item.docs) == nil {
				c.vocab = append(c.vocab, item)
			}
		}
	})
	return c.vocab
}
