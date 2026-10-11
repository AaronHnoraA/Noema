// Noema Wiki search is Copyright (c) 2026 Aaron He and distributed under the
// AGPL-3.0-or-later terms of the Noema kernel.

// Package wikisearch answers Knowledge searches from wiki.db, the SQLite
// projection of the Wiki that the Node host maintains.  It is the one
// implementation behind the editor's search field, the Wiki pages and Emacs.
//
// A result is found in one of several ways and ranked by which: the title a
// person typed (MediaWiki's "go" match), a title that begins with it or
// contains its words, an alias or file name, a misspelled title, the page
// text, letters of the title typed in order (Obsidian's quick switcher), the
// text with a misspelled word corrected, and last a page that answers only
// part of the query.
package wikisearch

import (
	"database/sql"
	"errors"
	"math"
	"os"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode"
)

// Options is one search request.
type Options struct {
	Query                string
	Mode                 string // "suggest" while typing, otherwise results
	Limit, Cursor        int
	RepositoryID         string
	Partition, Namespace string
	Sort                 string // "recent" or by title, for a query without text
	AllowedRepositoryIDs []string
	Now                  time.Time
	// File and Content are the note a reference lookup is made from: its
	// absolute path, and its text when HasContent says the caller sent it
	// (an unsaved buffer differs from what the index holds).
	File       string
	Content    string
	HasContent bool
}

// Block is a labelled block of a page.
type Block struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	EnvKind string `json:"envKind"`
	Label   string `json:"label"`
	Offset  int64  `json:"offset"`
}

// Item is one page of a result, in the shape the Node host has always sent.
type Item struct {
	ID                 string   `json:"id"`
	PageKey            string   `json:"pageKey"`
	IdentityStatus     string   `json:"identityStatus"`
	Title              string   `json:"title"`
	Namespace          string   `json:"namespace"`
	QualifiedNamespace string   `json:"qualifiedNamespace"`
	QualifiedTitle     string   `json:"qualifiedTitle"`
	FullTitle          string   `json:"fullTitle"`
	NamespaceSource    string   `json:"namespaceSource"`
	Kind               string   `json:"kind"`
	File               string   `json:"file"`
	Path               string   `json:"path"`
	RepositoryPath     string   `json:"repositoryPath"`
	RepositoryID       string   `json:"repositoryId"`
	Repository         string   `json:"repository"`
	Partition          string   `json:"partition"`
	Private            bool     `json:"private"`
	RedirectTo         string   `json:"redirectTo"`
	MtimeMs            float64  `json:"mtimeMs"`
	CreatedMs          float64  `json:"createdMs"`
	Rank               float64  `json:"rank"`
	Excerpt            string   `json:"excerpt"`
	MatchedTerms       []string `json:"matchedTerms,omitempty"`
	Aliases            []string `json:"aliases"`
	Tags               []string `json:"tags"`
	Blocks             []Block  `json:"blocks"`
	Refs               []string `json:"refs"`
	Backlinks          []string `json:"backlinks"`
	UnresolvedLinks    []string `json:"unresolvedLinks"`
	// MatchKind says how the page was found: exact, title, alias, path,
	// fuzzy, content, corrected, partial, or listed for a filter without text.  Via is the alias or file name
	// that matched; TitleRanges are the matched runes of Title.
	MatchKind   string   `json:"matchKind"`
	Via         string   `json:"via,omitempty"`
	TitleRanges [][2]int `json:"titleRanges,omitempty"`
}

// Correction is a query answered after replacing words no page contains.
type Correction struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// CreateHint is the page a query names when no page has that title.
type CreateHint struct {
	Title     string `json:"title"`
	Namespace string `json:"namespace"`
}

// Response is the answer to one search.
type Response struct {
	OK         bool        `json:"ok"`
	Type       string      `json:"type"`
	Source     string      `json:"source"`
	Generation string      `json:"generation"`
	Items      []Item      `json:"items"`
	Total      int         `json:"total"`
	Match      string      `json:"match"`
	NextCursor *int        `json:"nextCursor"`
	Explain    []string    `json:"explain"`
	Corrected  *Correction `json:"corrected,omitempty"`
	Create     *CreateHint `json:"create,omitempty"`
}

const (
	tierExact = iota
	tierPrefix
	tierWords
	tierContains
	tierAlias
	tierPath
	tierTypo
	tierContent
	tierSubsequence
	tierCorrected
	tierPartial
	tierListed
)

var tierKinds = [...]string{"exact", "title", "title", "title", "alias", "path", "fuzzy", "content", "fuzzy", "corrected", "partial", "listed"}

type hit struct {
	page    *page
	tier    int
	score   float64 // larger is better within a tier
	via     string
	ranges  [][2]int
	matched []string
}

// Search answers options from the wiki.db under root.
func Search(root string, options Options) (*Response, error) {
	file := DatabaseFile(root)
	response := &Response{OK: true, Type: "wiki-search", Source: "kernel-wiki", Items: []Item{}, Match: "full", Explain: []string{}}
	if _, err := os.Stat(file); errors.Is(err, os.ErrNotExist) {
		return response, nil
	}
	db, err := openDatabase(file)
	if err != nil {
		return nil, err
	}
	defer db.Close()
	index, err := loadCatalog(db, file)
	if err != nil {
		return nil, err
	}
	response.Generation = index.generation
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	limit := options.Limit
	if limit <= 0 {
		limit = 40
		if options.Mode == "suggest" {
			limit = 10
		}
	}
	limit = min(limit, 100)
	offset := max(options.Cursor, 0)

	query := Parse(options.Query, index.resolveNamespace)
	response.Explain = query.Explain()
	run := &searcher{db: db, index: index, query: query, options: options}
	hits, err := run.find()
	if err != nil {
		return nil, err
	}
	response.Total = len(hits)
	response.Corrected = run.corrected
	if run.partial {
		response.Match = "partial"
	}
	if offset < len(hits) {
		hits = hits[offset:min(len(hits), offset+limit)]
	} else {
		hits = nil
	}
	if next := offset + len(hits); next < response.Total {
		response.NextCursor = &next
	}
	words := query.positiveWords()
	if run.corrected != nil {
		words = append(words, strings.Fields(run.corrected.To)...)
	}
	for _, found := range hits {
		item, itemErr := run.item(found, words)
		if itemErr != nil {
			return nil, itemErr
		}
		response.Items = append(response.Items, item)
	}
	response.Create = run.create
	return response, nil
}

type searcher struct {
	db        *sql.DB
	index     *catalog
	query     *Query
	options   Options
	corrected *Correction
	partial   bool
	create    *CreateHint
	post      []*node // regex and line conditions checked against page text
	postNot   map[*node]bool
}

// scope is the filter every candidate passes: what the caller asked for and
// what a "Namespace:" prefix added.
func (s *searcher) scope() (string, []any) {
	var filters []string
	var args []any
	options := s.options
	if options.RepositoryID != "" {
		filters = append(filters, "p.repository_id = ?")
		args = append(args, options.RepositoryID)
	}
	if allowed := options.AllowedRepositoryIDs; len(allowed) > 0 {
		filters = append(filters, "p.repository_id IN (?"+strings.Repeat(",?", len(allowed)-1)+")")
		for _, id := range allowed {
			args = append(args, id)
		}
	}
	partition, namespace := options.Partition, options.Namespace
	if s.query.All {
		partition, namespace = "", ""
	}
	if s.query.Namespace != "" {
		namespace = s.query.Namespace
		if s.query.Partition != "" {
			partition = s.query.Partition
		}
	}
	if partition == "public" || partition == "private" {
		filters = append(filters, "p.partition = ?")
		args = append(args, partition)
	}
	if namespace != "" {
		// A namespace holds the namespaces nested under it.
		filters = append(filters, "(lower(p.namespace) = lower(?) OR lower(p.qualified_namespace) = lower(?) OR lower(p.namespace) LIKE lower(?) ESCAPE '\\')")
		args = append(args, namespace, namespace, likeEscape(namespace)+"/%")
	}
	if len(filters) == 0 {
		return "1", nil
	}
	return strings.Join(filters, " AND "), args
}

func likeEscape(value string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(value)
}

func likeContains(value string) string {
	return "%" + likeEscape(value) + "%"
}

func ftsPhrase(value string, prefix bool) string {
	quoted := `"` + strings.ReplaceAll(value, `"`, `""`) + `"`
	if prefix {
		return quoted + "*"
	}
	return quoted
}

func searchable(value string) bool {
	for _, r := range value {
		if unicode.IsLetter(r) || unicode.IsDigit(r) {
			return true
		}
	}
	return false
}

const ftsColumns = "title LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\'"

// textSQL is the condition "the page contains value" over every indexed
// field.  Latin words go to the word index and match by prefix.  Chinese has
// no word breaks: two characters are a lookup in page_bigrams, three or more
// go to the trigram index, and a single character scans.
func textSQL(value, column string, prefix bool, args *[]any) string {
	if !searchable(value) {
		*args = append(*args, likeContains(value))
		return "lower(p.title) LIKE ? ESCAPE '\\'"
	}
	runes := []rune(value)
	if hasCJK(value) {
		if column == "" && len(runes) == 2 && isCJK(runes[0]) && isCJK(runes[1]) {
			*args = append(*args, value)
			return "p.page_key IN (SELECT page_key FROM page_bigrams WHERE bigram = ?)"
		}
		if len(runes) >= 3 {
			match := ftsPhrase(value, false)
			if column != "" {
				match = column + " : " + match
			}
			*args = append(*args, match)
			return "p.page_key IN (SELECT page_key FROM pages_fts_trigram WHERE pages_fts_trigram MATCH ?)"
		}
		pattern := likeContains(value)
		if column != "" {
			*args = append(*args, pattern)
			return "p.page_key IN (SELECT page_key FROM pages_fts_trigram WHERE " + column + " LIKE ? ESCAPE '\\')"
		}
		*args = append(*args, pattern, pattern, pattern, pattern)
		return "p.page_key IN (SELECT page_key FROM pages_fts_trigram WHERE " + ftsColumns + ")"
	}
	match := ftsPhrase(value, prefix)
	if column != "" {
		match = column + " : " + match
	}
	*args = append(*args, match)
	return "p.page_key IN (SELECT page_key FROM pages_fts WHERE pages_fts MATCH ?)"
}

// compile turns a query into a SQL condition over pages p.  With relaxed,
// free text is not required: what remains is where the query looks, which is
// where a misspelled title is still looked for.
func (s *searcher) compile(n *node, relaxed bool, args *[]any) string {
	if n == nil {
		return "1"
	}
	switch n.kind {
	case kindAnd, kindOr:
		if len(n.children) == 0 {
			return "1"
		}
		parts := make([]string, 0, len(n.children))
		for _, child := range n.children {
			parts = append(parts, s.compile(child, relaxed, args))
		}
		joiner := " AND "
		if n.kind == kindOr {
			joiner = " OR "
		}
		return "(" + strings.Join(parts, joiner) + ")"
	case kindNot:
		child := n.children[0]
		if child.kind == kindRegex || child.kind == kindLine {
			if s.postNot == nil {
				s.postNot = map[*node]bool{}
			}
			if !s.postNot[child] {
				s.postNot[child] = true
				s.post = append(s.post, child)
			}
			return "1"
		}
		if relaxed && (child.kind == kindTerm || child.kind == kindPhrase) {
			return "1"
		}
		return "NOT " + s.compile(child, relaxed, args)
	case kindTerm, kindPhrase:
		if relaxed {
			return "1"
		}
		return textSQL(n.value, "", n.kind == kindTerm, args)
	case kindRegex:
		s.addPost(n)
		return "1"
	case kindLine:
		s.addPost(n)
		parts := []string{}
		for _, word := range strings.Fields(n.value) {
			parts = append(parts, textSQL(word, "body", true, args))
		}
		if len(parts) == 0 {
			return "1"
		}
		return "(" + strings.Join(parts, " AND ") + ")"
	}
	like := likeContains(n.value)
	switch n.field {
	case "title":
		*args = append(*args, like, like)
		return "(lower(p.title) LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM aliases a WHERE a.page_key = p.page_key AND lower(a.alias) LIKE ? ESCAPE '\\'))"
	case "alias":
		*args = append(*args, like)
		return "EXISTS (SELECT 1 FROM aliases a WHERE a.page_key = p.page_key AND lower(a.alias) LIKE ? ESCAPE '\\')"
	case "tag":
		*args = append(*args, like)
		return "EXISTS (SELECT 1 FROM tags t WHERE t.page_key = p.page_key AND lower(t.tag) LIKE ? ESCAPE '\\')"
	case "repo":
		*args = append(*args, like)
		return "lower(p.repository_id) LIKE ? ESCAPE '\\'"
	case "namespace":
		// An alias names its namespace exactly; anything else is looked for
		// inside the namespace names, as before.
		if namespace, partition, ok := s.index.resolveNamespace(n.value); ok {
			condition := "(lower(p.namespace) = lower(?) OR lower(p.namespace) LIKE lower(?) ESCAPE '\\')"
			*args = append(*args, namespace, likeEscape(namespace)+"/%")
			if partition != "" {
				condition = "(" + condition + " AND p.partition = ?)"
				*args = append(*args, partition)
			}
			return condition
		}
		*args = append(*args, like, like)
		return "(lower(p.namespace) LIKE ? ESCAPE '\\' OR lower(p.qualified_namespace) LIKE ? ESCAPE '\\')"
	case "path":
		*args = append(*args, like, like)
		return "(lower(p.workspace_path) LIKE ? ESCAPE '\\' OR lower(p.repository_path) LIKE ? ESCAPE '\\')"
	case "file":
		// The file name is what follows the last slash.
		*args = append(*args, like)
		return "lower(replace(p.repository_path, rtrim(p.repository_path, replace(p.repository_path, '/', '')), '')) LIKE ? ESCAPE '\\'"
	case "content":
		return textSQL(n.value, "body", true, args)
	case "kind":
		*args = append(*args, like)
		return "lower(p.kind) LIKE ? ESCAPE '\\'"
	case "linksto":
		*args = append(*args, like, like)
		return "EXISTS (SELECT 1 FROM links l WHERE l.source_key = p.page_key AND (lower(l.target_id) LIKE ? ESCAPE '\\' OR lower(l.target_title) LIKE ? ESCAPE '\\'))"
	case "is":
		switch n.value {
		case "orphan":
			return "(NOT EXISTS (SELECT 1 FROM links l WHERE l.source_key = p.page_key AND l.status = 'resolved') AND NOT EXISTS (SELECT 1 FROM links l WHERE l.target_id = p.page_id AND l.status = 'resolved'))"
		case "missing":
			return "EXISTS (SELECT 1 FROM links l WHERE l.source_key = p.page_key AND l.status IN ('missing', 'missing-fragment'))"
		case "private":
			return "p.private = 1"
		case "public":
			return "p.private = 0"
		case "redirect":
			return "p.redirect_to <> ''"
		}
		return "0"
	case "after", "before":
		bound, ok := dateBound(n.value, s.options.Now)
		if !ok {
			return "0"
		}
		*args = append(*args, bound)
		if n.field == "after" {
			return "p.mtime >= ?"
		}
		return "(p.mtime > 0 AND p.mtime < ?)"
	case "created":
		from, to, ok := datePeriod(n.value, s.options.Now)
		if !ok {
			return "0"
		}
		if to == 0 {
			*args = append(*args, from)
			return "p.created >= ?"
		}
		*args = append(*args, from, to)
		return "(p.created >= ? AND p.created < ?)"
	}
	return "1"
}

func (s *searcher) addPost(n *node) {
	for _, known := range s.post {
		if known == n {
			return
		}
	}
	s.post = append(s.post, n)
}

func (s *searcher) keys(condition string, args []any) (map[string]bool, error) {
	scope, scopeArgs := s.scope()
	rows, err := s.db.Query("SELECT p.page_key FROM pages p WHERE "+scope+" AND "+condition, append(scopeArgs, args...)...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	found := map[string]bool{}
	for rows.Next() {
		var key string
		if err = rows.Scan(&key); err != nil {
			return nil, err
		}
		found[key] = true
	}
	return found, rows.Err()
}

func (s *searcher) body(item *page) string {
	var body sql.NullString
	if item.ftsRow == 0 || s.db.QueryRow(`SELECT body FROM pages_fts WHERE rowid = ?`, item.ftsRow).Scan(&body) != nil {
		return ""
	}
	return body.String
}

// passes checks the conditions SQL cannot: a regular expression, and words
// that must share a line.
func (s *searcher) passes(item *page) bool {
	for _, condition := range s.post {
		var matched bool
		switch {
		case condition.kind == kindLine:
			matched = lineWith(s.body(item), strings.Fields(condition.value)) != ""
		case condition.field == "title":
			matched = condition.pattern.MatchString(item.title)
		case condition.field == "path":
			matched = condition.pattern.MatchString(item.workspacePath)
		case condition.field == "file":
			matched = condition.pattern.MatchString(item.repositoryPath[strings.LastIndex(item.repositoryPath, "/")+1:])
		default:
			matched = condition.pattern.MatchString(s.body(item))
		}
		if matched == s.postNot[condition] {
			return false
		}
	}
	return true
}

func lineWith(body string, words []string) string {
	for _, line := range strings.Split(body, "\n") {
		lowered := strings.ToLower(line)
		all := true
		for _, word := range words {
			if !strings.Contains(lowered, word) {
				all = false
				break
			}
		}
		if all && len(words) > 0 {
			return line
		}
	}
	return ""
}

func (s *searcher) find() ([]hit, error) {
	var args []any
	condition := s.compile(s.query.root, false, &args)
	full, err := s.keys(condition, args)
	if err != nil {
		return nil, err
	}
	if len(s.post) > 0 {
		for key := range full {
			if item := s.index.byKey[key]; item == nil || !s.passes(item) {
				delete(full, key)
			}
		}
	}
	terms, plain := s.query.textTerms()
	needle := Fold(strings.Join(terms, " "))
	if needle == "" || !plain {
		return s.ordered(full, len(s.query.positiveWords()) > 0), nil
	}

	hits := map[string]*hit{}
	for key := range full {
		if item := s.index.byKey[key]; item != nil {
			found := titleMatch(item, needle)
			found.page = item
			hits[key] = &found
		}
	}
	// A misspelled or abbreviated title is in no index; look for it among the
	// pages the rest of the query allows.
	var relaxedArgs []any
	relaxed, err := s.keys(s.compile(s.query.root, true, &relaxedArgs), relaxedArgs)
	if err != nil {
		return nil, err
	}
	// A quoted phrase asks for those words in that order; a title that holds
	// them some other way, or nearly, is not what was asked for.
	quoted := s.query.hasPhrase()
	for key := range relaxed {
		item := s.index.byKey[key]
		if item == nil || hits[key] != nil || quoted {
			continue
		}
		if found := titleMatch(item, needle); found.tier < tierContent {
			if len(s.post) == 0 || s.passes(item) {
				found.page = item
				hits[key] = &found
			}
			continue
		}
		if found, ok := fuzzyMatch(item, needle); ok && (len(s.post) == 0 || s.passes(item)) {
			found.page = item
			hits[key] = &found
		}
	}
	s.rank(hits)

	exact := false
	for _, found := range hits {
		if found.tier == tierExact {
			exact = true
		}
	}
	if !exact && s.query.fieldFree() {
		s.create = &CreateHint{Title: s.query.typedTitle(), Namespace: s.query.Namespace}
	}

	// A word no page contains may be misspelled.  A query that already found
	// a title is not second-guessed: "dsot" is Direct Sums of Tensors, not
	// a slip for "dot".
	named := false
	for _, found := range hits {
		if found.tier <= tierPath {
			named = true
		}
	}
	if len(full) == 0 && !named && !quoted {
		if corrected, keys, correctErr := s.correct(terms); correctErr != nil {
			return nil, correctErr
		} else if len(keys) > 0 {
			s.corrected = corrected
			for key := range keys {
				if item := s.index.byKey[key]; item != nil && hits[key] == nil {
					hits[key] = &hit{page: item, tier: tierCorrected}
				}
			}
		}
	}
	if len(hits) == 0 && !quoted {
		partial, partialErr := s.partialMatches(terms)
		if partialErr != nil {
			return nil, partialErr
		}
		if len(partial) > 0 {
			s.partial = true
			return partial, nil
		}
	}

	ordered := make([]hit, 0, len(hits))
	for _, found := range hits {
		ordered = append(ordered, *found)
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		a, b := ordered[i], ordered[j]
		if a.tier != b.tier {
			return a.tier < b.tier
		}
		if a.score != b.score {
			return a.score > b.score
		}
		if a.page.mtime != b.page.mtime {
			return a.page.mtime > b.page.mtime
		}
		return a.page.key < b.page.key
	})
	return ordered, nil
}

func (q *Query) hasPhrase() bool {
	found := false
	var walk func(*node)
	walk = func(n *node) {
		if n == nil {
			return
		}
		if n.kind == kindPhrase {
			found = true
		}
		for _, child := range n.children {
			walk(child)
		}
	}
	walk(q.root)
	return found
}

// fieldFree reports whether the query is free text only, so that it can be
// read as the title of a page to create.
func (q *Query) fieldFree() bool {
	free := true
	var walk func(*node)
	walk = func(n *node) {
		if n == nil {
			return
		}
		switch n.kind {
		case kindAnd:
			for _, child := range n.children {
				walk(child)
			}
		case kindTerm, kindPhrase:
		default:
			free = false
		}
	}
	walk(q.root)
	return free
}

// typedTitle is the free text as typed, case kept.
func (q *Query) typedTitle() string {
	var parts []string
	var walk func(*node)
	walk = func(n *node) {
		if n == nil {
			return
		}
		if n.kind == kindAnd {
			for _, child := range n.children {
				walk(child)
			}
		} else if n.kind == kindTerm || n.kind == kindPhrase {
			parts = append(parts, strings.TrimSpace(n.raw))
		}
	}
	walk(q.root)
	return strings.Join(parts, " ")
}

// ordered lists pages for a query without one typed title: a filter alone is
// listed by title or by recency, a query with OR by how well its text matches.
func (s *searcher) ordered(keys map[string]bool, text bool) []hit {
	tier := tierListed
	if text {
		tier = tierContent
	}
	hits := make([]hit, 0, len(keys))
	for key := range keys {
		if item := s.index.byKey[key]; item != nil {
			hits = append(hits, hit{page: item, tier: tier})
		}
	}
	scores := map[string]float64{}
	if text {
		scores = s.relevance()
	}
	recent := s.options.Sort == "recent"
	sort.SliceStable(hits, func(i, j int) bool {
		a, b := hits[i].page, hits[j].page
		if text && scores[a.key] != scores[b.key] {
			return scores[a.key] > scores[b.key]
		}
		if (recent || text) && a.mtime != b.mtime {
			return a.mtime > b.mtime
		}
		if left, right := strings.ToLower(a.title), strings.ToLower(b.title); left != right {
			return left < right
		}
		return a.key < b.key
	})
	return hits
}

// relevance is each page's BM25 score for the query's words, title weighted
// over aliases, tags, path and text.  Larger is better.
func (s *searcher) relevance() map[string]float64 {
	var parts []string
	for _, word := range s.query.positiveWords() {
		if !hasCJK(word) && searchable(word) {
			parts = append(parts, ftsPhrase(word, true))
		}
	}
	scores := map[string]float64{}
	if len(parts) == 0 {
		return scores
	}
	rows, err := s.db.Query(`SELECT page_key, bm25(pages_fts, 0, 12, 5, 4, 3, 1) FROM pages_fts WHERE pages_fts MATCH ?`, strings.Join(parts, " OR "))
	if err != nil {
		return scores
	}
	defer rows.Close()
	for rows.Next() {
		var key string
		var rank float64
		if rows.Scan(&key, &rank) == nil {
			scores[key] = -rank
		}
	}
	return scores
}

func (s *searcher) rank(hits map[string]*hit) {
	scores := s.relevance()
	for key, found := range hits {
		if found.tier == tierContent || found.tier == tierCorrected {
			found.score = scores[key]
		}
	}
}

// wordPrefixes reports whether every word of needle begins some word of text.
func wordPrefixes(needle, text string) bool {
	words := strings.Fields(text)
	for _, want := range strings.Fields(needle) {
		found := false
		for _, word := range words {
			if strings.HasPrefix(word, want) {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}

// initials reports whether needle is the first letters of consecutive words
// of text: "ti" for "tensor isomorphism", "lce" for "linear code equivalence".
func initials(needle, text string) bool {
	letters := []rune(strings.ReplaceAll(needle, " ", ""))
	words := strings.Fields(text)
	if len(letters) < 2 || len(letters) > len(words) {
		return false
	}
	for start := 0; start+len(letters) <= len(words); start++ {
		matched := true
		for offset, letter := range letters {
			if first := []rune(words[start+offset]); first[0] != letter {
				matched = false
				break
			}
		}
		if matched {
			return true
		}
	}
	return false
}

// titleMatch places a page by how its title, aliases and file name answer
// the folded needle.  A shorter title is the closer answer to a prefix.
func titleMatch(item *page, needle string) hit {
	closeness := func(text string) float64 { return -float64(len([]rune(text))) }
	if item.foldTitle == needle {
		return hit{tier: tierExact, ranges: [][2]int{{0, len([]rune(item.title))}}}
	}
	for index, alias := range item.foldAliases {
		if alias == needle {
			return hit{tier: tierExact, via: item.aliases[index]}
		}
	}
	switch {
	case strings.HasPrefix(item.foldTitle, needle):
		return hit{tier: tierPrefix, score: closeness(item.foldTitle), ranges: titleRanges(item.title, needle)}
	case wordPrefixes(needle, item.foldTitle):
		return hit{tier: tierWords, score: closeness(item.foldTitle), ranges: titleRanges(item.title, needle)}
	case initials(needle, item.foldTitle):
		return hit{tier: tierWords, score: closeness(item.foldTitle) - 0.5}
	// Two letters are inside most titles; from three on it means something.
	case len([]rune(needle)) >= 3 && strings.Contains(item.foldTitle, needle):
		return hit{tier: tierContains, score: closeness(item.foldTitle), ranges: titleRanges(item.title, needle)}
	}
	for index, alias := range item.foldAliases {
		if strings.HasPrefix(alias, needle) || wordPrefixes(needle, alias) {
			return hit{tier: tierAlias, score: closeness(alias), via: item.aliases[index]}
		}
	}
	if item.foldFile != item.foldTitle && (strings.HasPrefix(item.foldFile, needle) || wordPrefixes(needle, item.foldFile)) {
		return hit{tier: tierPath, score: closeness(item.foldFile), via: item.repositoryPath}
	}
	return hit{tier: tierContent}
}

// titleRanges finds each word of needle in title for highlighting.  It gives
// nothing when folding changed the title's length, since positions would lie.
func titleRanges(title, needle string) [][2]int {
	lowered := []rune(strings.ToLower(title))
	if len(lowered) != len([]rune(title)) {
		return nil
	}
	var positions []int
	for _, word := range strings.Fields(needle) {
		want := []rune(word)
		for start := 0; start+len(want) <= len(lowered); start++ {
			if string(lowered[start:start+len(want)]) == word && (start == 0 || !unicode.IsLetter(lowered[start-1])) {
				for offset := range want {
					positions = append(positions, start+offset)
				}
				break
			}
		}
	}
	sort.Ints(positions)
	return ranges(positions)
}

// fuzzyMatch finds needle in a page's title, aliases or file name as a
// misspelling, or as letters typed in order.
func fuzzyMatch(item *page, needle string) (hit, bool) {
	if len([]rune(needle)) >= 4 && !hasCJK(needle) {
		best, via, ok := 0, "", false
		try := func(candidate, label string) {
			if slips, matched := typoWords(needle, candidate); matched && (!ok || slips < best) {
				best, via, ok = slips, label, true
			}
		}
		try(item.foldTitle, "")
		for index, alias := range item.foldAliases {
			try(alias, item.aliases[index])
		}
		if ok {
			// Among equal slips the shorter title is the closer one.
			return hit{tier: tierTypo, score: -float64(best) - float64(len(item.foldTitle))/1000, via: via}, true
		}
	}
	letters := []rune(strings.ReplaceAll(needle, " ", ""))
	if len(letters) < 2 {
		return hit{}, false
	}
	bestScore, bestHit := 0, hit{}
	try := func(candidate, via string, own bool) {
		runes := []rune(candidate)
		score, positions, ok := subsequence(letters, runes)
		if !ok || score < subsequenceWorth(len(letters)) || score <= bestScore {
			return
		}
		bestScore = score
		bestHit = hit{tier: tierSubsequence, score: float64(score), via: via}
		if own {
			bestHit.ranges = ranges(positions)
		}
	}
	try(item.title, "", true)
	for _, alias := range item.aliases {
		try(alias, alias, false)
	}
	if item.foldFile != item.foldTitle {
		try(item.foldFile, item.repositoryPath, false)
	}
	return bestHit, bestScore > 0
}

// correct replaces each word no page contains with the nearest word the
// index knows, and answers the corrected query.  "coloring" finds
// "colouring"; a word that is merely rare is left alone.
func (s *searcher) correct(terms []string) (*Correction, map[string]bool, error) {
	vocabulary := s.index.vocabulary(s.db)
	if len(vocabulary) == 0 {
		return nil, nil, nil
	}
	replaced := map[string]string{}
	for _, term := range terms {
		for _, word := range strings.Fields(term) {
			if hasCJK(word) || !searchable(word) {
				continue
			}
			wanted := []rune(word)
			limit := typoLimit(len(wanted))
			if limit == 0 {
				continue
			}
			known, bestTerm, bestSlips, bestDocs := false, "", limit+1, 0
			for _, entry := range vocabulary {
				if strings.HasPrefix(entry.term, word) {
					known = true
					break
				}
				if entry.term[0] != word[0] {
					continue // the first letter is rarely the slip
				}
				slips := editDistance(wanted, []rune(entry.term), limit)
				if slips < bestSlips || (slips == bestSlips && slips <= limit && entry.docs > bestDocs) {
					bestTerm, bestSlips, bestDocs = entry.term, slips, entry.docs
				}
			}
			if !known && bestSlips <= limit {
				replaced[word] = bestTerm
			}
		}
	}
	if len(replaced) == 0 {
		return nil, nil, nil
	}
	fix := func(text string) string {
		words := strings.Fields(text)
		for index, word := range words {
			if better, ok := replaced[word]; ok {
				words[index] = better
			}
		}
		return strings.Join(words, " ")
	}
	var args []any
	keys, err := s.keys(s.compile(rewrite(s.query.root, fix), false, &args), args)
	if err != nil || len(keys) == 0 {
		return nil, nil, err
	}
	return &Correction{From: strings.Join(terms, " "), To: fix(strings.Join(terms, " "))}, keys, nil
}

func rewrite(n *node, fix func(string) string) *node {
	if n == nil {
		return nil
	}
	copied := *n
	if n.kind == kindTerm || n.kind == kindPhrase {
		copied.value = fix(n.value)
	}
	copied.children = nil
	for _, child := range n.children {
		copied.children = append(copied.children, rewrite(child, fix))
	}
	return &copied
}

var wordRe = regexp.MustCompile(`[\p{L}\p{N}]+`)

// tokens are the words (two characters or more) and adjacent Chinese
// character pairs of text, the units a partial match counts.
func tokens(text string) []string {
	seen := map[string]bool{}
	var out []string
	add := func(token string) {
		if !seen[token] {
			seen[token] = true
			out = append(out, token)
		}
	}
	for _, word := range wordRe.FindAllString(strings.ToLower(text), -1) {
		runes := []rune(word)
		var latin []rune
		flush := func() {
			if len(latin) > 1 {
				add(string(latin))
			}
			latin = nil
		}
		for index, r := range runes {
			if !isCJK(r) {
				latin = append(latin, r)
				continue
			}
			flush()
			if index+1 < len(runes) && isCJK(runes[index+1]) {
				add(string(runes[index : index+2]))
			}
		}
		flush()
	}
	return out
}

const partialMaxResults = 20

// partialMatches answers a query no page answers in full with the pages
// that answer part of it.  Each word or character pair counts by how few
// pages carry it, and only pages whose score stands out are kept.
func (s *searcher) partialMatches(terms []string) ([]hit, error) {
	parts := tokens(strings.Join(terms, " "))
	if len(parts) > 16 {
		parts = parts[:16]
	}
	if len(parts) < 2 {
		return nil, nil
	}
	var relaxedArgs []any
	allowed, err := s.keys(s.compile(s.query.root, true, &relaxedArgs), relaxedArgs)
	if err != nil || len(allowed) == 0 {
		return nil, err
	}
	found := map[string]*hit{}
	for _, token := range parts {
		var args []any
		rows, queryErr := s.db.Query("SELECT p.page_key FROM pages p WHERE "+textSQL(token, "", false, &args), args...)
		if queryErr != nil {
			return nil, queryErr
		}
		var keys []string
		for rows.Next() {
			var key string
			if rows.Scan(&key) == nil && allowed[key] {
				keys = append(keys, key)
			}
		}
		rows.Close()
		if len(keys) == 0 {
			continue
		}
		weight := math.Log(float64(len(allowed)+1) / float64(len(keys)))
		for _, key := range keys {
			entry := found[key]
			if entry == nil {
				entry = &hit{page: s.index.byKey[key], tier: tierPartial}
				found[key] = entry
			}
			entry.score += weight
			entry.matched = append(entry.matched, token)
		}
	}
	var scored []hit
	var total float64
	for _, entry := range found {
		if entry.page != nil && entry.score > 0 && (len(s.post) == 0 || s.passes(entry.page)) {
			scored = append(scored, *entry)
			total += entry.score
		}
	}
	if len(scored) == 0 {
		return nil, nil
	}
	// The cut is relative to the candidates' own scores: above the mean, and
	// from eight candidates on above it by a standard deviation.
	mean := total / float64(len(scored))
	cut := mean
	if len(scored) >= 8 {
		var variance float64
		for _, entry := range scored {
			variance += (entry.score - mean) * (entry.score - mean)
		}
		cut = mean + math.Sqrt(variance/float64(len(scored)))
	}
	sort.SliceStable(scored, func(i, j int) bool {
		if scored[i].score != scored[j].score {
			return scored[i].score > scored[j].score
		}
		return scored[i].page.key < scored[j].page.key
	})
	kept := scored[:0:0]
	for _, entry := range scored {
		if entry.score >= cut-1e-9 {
			kept = append(kept, entry)
		}
	}
	return kept[:min(len(kept), partialMaxResults)], nil
}
