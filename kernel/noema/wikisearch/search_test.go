package wikisearch

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type fixturePage struct {
	repository, namespace, partition string
	path, title                      string
	aliases, tags                    []string
	body                             string
	links                            []string // titles this page links to
	mtime, created                   int64
}

var fixturePages = []fixturePage{
	{repository: "public/Math", namespace: "Math", partition: "public", path: "tensor.md", title: "tensor",
		tags: []string{"algebra"}, body: "A tensor is a multilinear map.\n\nThe tensor rank of a matrix is its rank.", mtime: 50},
	{repository: "public/Math", namespace: "Math", partition: "public", path: "Algebra/tensor_direct_sum.md",
		title: "Direct Sums of Tensors", tags: []string{"algebra"}, body: "The direct sum of two tensors.", links: []string{"tensor"}, mtime: 40},
	{repository: "public/Math", namespace: "Math", partition: "public", path: "Algebra/krull_schmidt.md",
		title: "Krull–Schmidt Theorem", tags: []string{"algebra"}, body: "Decomposition into indecomposables is unique.", mtime: 30},
	{repository: "public/CS", namespace: "CS", partition: "public", path: "Complexity/tensor_isomorphism.md",
		title: "Tensor Isomorphism", tags: []string{"complexity"},
		body: "#+begin meta\ntitle: Tensor Isomorphism\n#+end meta\n\n```\ntensor isomorphism in code\n```\n\nTensor isomorphism is as hard as graph isomorphism.", mtime: 60},
	{repository: "public/CS", namespace: "CS", partition: "public", path: "Complexity/colouring_gadgets.md",
		title: "Colouring Gadgets", tags: []string{"complexity"}, body: "A colouring gadget fixes vertex classes.", mtime: 20},
	{repository: "public/CS", namespace: "CS", partition: "public", path: "linear-code-equivalence.md",
		title: "Linear Code Equivalence", aliases: []string{"LCE", "线性码等价"}, tags: []string{"coding"},
		body: "Two linear codes are equivalent under a monomial map. 线性码等价问题。", mtime: 70, created: 1790000000000},
	{repository: "private/research", namespace: "research", partition: "private", path: "daily/Kobler.md",
		title: "Progress in Theoretical Computer Science", body: "Notes on graph isomorphism and tensor methods.", mtime: 10},
	{repository: "private/research", namespace: "Research/Quantum", partition: "private", path: "qc/state.md",
		title: "Quantum State", tags: []string{"qc"}, body: "A density operator describes a quantum state.", mtime: 80},
}

func writeFixture(t *testing.T, generation string, pages []fixturePage) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, ".noema"), 0o755); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite3", DatabaseFile(root))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, execErr := db.Exec(query, args...); execErr != nil {
			t.Fatalf("%s: %v", query, execErr)
		}
	}
	// The schema Node's createWikiSchema writes, for the tables a search reads.
	exec(`CREATE TABLE repositories (location_id text primary key, repository_id text not null, identity_status text not null, partition text not null, name text not null, namespace text not null, qualified_namespace text not null, namespace_aliases text not null, path text not null)`)
	exec(`CREATE TABLE pages (page_key text primary key, page_id text not null, identity_status text not null, title text not null, namespace text not null, qualified_namespace text not null, namespace_source text not null, kind text not null, file text not null unique, workspace_path text not null, repository_path text not null, repository_id text not null, partition text not null, private integer not null, redirect_to text not null, mtime real not null, created real not null)`)
	exec(`CREATE TABLE blocks (block_id text not null, page_key text not null, kind text not null, env_kind text not null, label text not null, source_offset integer not null, primary key(page_key, block_id))`)
	exec(`CREATE TABLE aliases (page_key text not null, alias text not null)`)
	exec(`CREATE TABLE tags (page_key text not null, tag text not null)`)
	exec(`CREATE TABLE links (source_key text not null, raw_target text not null, target_id text, target_block_id text, target_title text not null, status text not null)`)
	exec(`CREATE TABLE files (repository_id text not null, path text not null, file text not null unique, kind text not null, extension text not null, size integer not null, mtime real not null, git_status text not null, primary key(repository_id, path))`)
	exec(`INSERT INTO files VALUES ('public/Math', 'figures/tensor network.png', '/vault/public/Math/figures/tensor network.png', 'file', 'png', 1, 1, '')`)
	exec(`INSERT INTO files VALUES ('public/Math', 'data/ranks.csv', '/vault/public/Math/data/ranks.csv', 'file', 'csv', 1, 1, '')`)
	exec(`CREATE TABLE wiki_meta (key text primary key, value text not null)`)
	exec(`CREATE VIRTUAL TABLE pages_fts USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='unicode61 remove_diacritics 2')`)
	exec(`CREATE VIRTUAL TABLE pages_fts_trigram USING fts5(page_key UNINDEXED, title, aliases, tags, path, body, tokenize='trigram case_sensitive 0')`)
	exec(`CREATE TABLE page_bigrams (bigram text not null, page_key text not null, primary key(bigram, page_key)) WITHOUT ROWID`)
	exec(`INSERT INTO wiki_meta VALUES ('generation', ?), ('updated_at', ?)`, generation, generation)
	exec(`INSERT INTO repositories VALUES ('m', 'public/Math', 'ok', 'public', 'Math', 'Math', 'public/Math', '["Math","数学"]', 'public/Math')`)
	exec(`INSERT INTO repositories VALUES ('c', 'public/CS', 'ok', 'public', 'CS', 'CS', 'public/CS', '["CS"]', 'public/CS')`)
	exec(`INSERT INTO repositories VALUES ('r', 'private/research', 'ok', 'private', 'research', 'research', 'private/research', '["research"]', 'private/research')`)
	ids := map[string]string{}
	for index, item := range pages {
		ids[item.title] = fmt.Sprintf("id-%d", index)
	}
	for index, item := range pages {
		key := item.repository + ":" + item.path
		private := 0
		if item.partition == "private" {
			private = 1
		}
		exec(`INSERT INTO files VALUES (?, ?, ?, 'note', 'md', 1, ?, '')`, item.repository, item.path, "/vault/"+item.repository+"/"+item.path, item.mtime)
		exec(`INSERT INTO pages VALUES (?, ?, 'ok', ?, ?, ?, 'repository', 'page', ?, ?, ?, ?, ?, ?, '', ?, ?)`,
			key, fmt.Sprintf("id-%d", index), item.title, item.namespace, item.partition+"/"+item.namespace,
			"/vault/"+item.repository+"/"+item.path, item.repository+"/"+item.path, item.path, item.repository,
			item.partition, private, item.mtime, item.created)
		for _, alias := range item.aliases {
			exec(`INSERT INTO aliases VALUES (?, ?)`, key, alias)
		}
		for _, tag := range item.tags {
			exec(`INSERT INTO tags VALUES (?, ?)`, key, tag)
		}
		for _, target := range item.links {
			exec(`INSERT INTO links VALUES (?, ?, ?, NULL, ?, 'resolved')`, key, target, ids[target], target)
		}
		row := []any{key, item.title, strings.Join(item.aliases, " "), strings.Join(item.tags, " "), item.repository + "/" + item.path, item.body}
		exec(`INSERT INTO pages_fts VALUES (?, ?, ?, ?, ?, ?)`, row...)
		exec(`INSERT INTO pages_fts_trigram VALUES (?, ?, ?, ?, ?, ?)`, row...)
		seen := map[string]bool{}
		for _, text := range append([]string{item.title, item.body}, item.aliases...) {
			runes := []rune(text)
			for at := 0; at+1 < len(runes); at++ {
				if pair := string(runes[at : at+2]); isCJK(runes[at]) && isCJK(runes[at+1]) && !seen[pair] {
					seen[pair] = true
					exec(`INSERT INTO page_bigrams VALUES (?, ?)`, pair, key)
				}
			}
		}
	}
	return root
}

func search(t *testing.T, root, query string, change ...func(*Options)) *Response {
	t.Helper()
	options := Options{Query: query, Now: time.Date(2026, 10, 11, 12, 0, 0, 0, time.Local)}
	for _, apply := range change {
		apply(&options)
	}
	response, err := Search(root, options)
	if err != nil {
		t.Fatalf("%q: %v", query, err)
	}
	return response
}

func titles(response *Response) []string {
	out := make([]string, 0, len(response.Items))
	for _, item := range response.Items {
		out = append(out, item.Title)
	}
	return out
}

func kinds(response *Response) string {
	out := make([]string, 0, len(response.Items))
	for _, item := range response.Items {
		out = append(out, item.MatchKind+":"+item.Title)
	}
	return strings.Join(out, " | ")
}

func expectFirst(t *testing.T, response *Response, kind, title string) {
	t.Helper()
	if len(response.Items) == 0 || response.Items[0].Title != title || response.Items[0].MatchKind != kind {
		t.Fatalf("want first %s:%s, got %s", kind, title, kinds(response))
	}
}

func TestTitleComesBeforeText(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	response := search(t, root, "tensor")
	want := []string{"tensor", "Tensor Isomorphism", "Direct Sums of Tensors", "Progress in Theoretical Computer Science"}
	if got := titles(response); strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("order: %s", kinds(response))
	}
	if response.Items[0].MatchKind != "exact" || response.Items[3].MatchKind != "content" {
		t.Fatalf("kinds: %s", kinds(response))
	}
	if response.Create != nil {
		t.Fatalf("an existing title offers no page to create: %+v", response.Create)
	}
	// The shorter title is the closer answer to a prefix.
	expectFirst(t, search(t, root, "tens"), "title", "tensor")
	if created := search(t, root, "tens").Create; created == nil || created.Title != "tens" {
		t.Fatalf("a title nobody has is offered for creation: %+v", created)
	}
}

func TestTitlesAreComparedFolded(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	for _, query := range []string{"Krull-Schmidt Theorem", "krull_schmidt theorem", "KRULL SCHMIDT THEOREM"} {
		expectFirst(t, search(t, root, query), "exact", "Krull–Schmidt Theorem")
	}
	expectFirst(t, search(t, root, "LCE"), "exact", "Linear Code Equivalence")
	if via := search(t, root, "lce").Items[0].Via; via != "LCE" {
		t.Fatalf("an alias hit names the alias, got %q", via)
	}
	expectFirst(t, search(t, root, "kobler"), "path", "Progress in Theoretical Computer Science")
}

func TestFuzzy(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	expectFirst(t, search(t, root, "krull schmit"), "fuzzy", "Krull–Schmidt Theorem")
	expectFirst(t, search(t, root, "tensr isomorphsm"), "fuzzy", "Tensor Isomorphism")
	// First letters of the title's words.
	expectFirst(t, search(t, root, "ti"), "title", "Tensor Isomorphism")
	expectFirst(t, search(t, root, "dsot"), "title", "Direct Sums of Tensors")
	if corrected := search(t, root, "dsot").Corrected; corrected != nil {
		t.Fatalf("a query that names a title is not corrected: %+v", corrected)
	}
	// Letters in order, as in Obsidian's quick switcher.
	expectFirst(t, search(t, root, "qntmst"), "fuzzy", "Quantum State")
	// Scattered letters are not a match.
	if response := search(t, root, "tqz"); response.Total != 0 {
		t.Fatalf("scattered letters matched: %s", kinds(response))
	}
	// A short word one letter away is another word.
	if response := search(t, root, "tensar"); response.Total == 0 {
		t.Fatal("a six-letter word tolerates one slip")
	}
	if _, ok := typoWords("cap", "map"); ok {
		t.Fatal("a three-letter word tolerates none")
	}
}

func TestMisspelledTextIsCorrected(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	response := search(t, root, "coloring")
	if response.Corrected == nil || response.Corrected.To != "colouring" {
		t.Fatalf("correction: %+v", response.Corrected)
	}
	expectFirst(t, response, "fuzzy", "Colouring Gadgets")
	response = search(t, root, "indecomposible")
	if response.Corrected == nil || len(response.Items) != 1 || response.Items[0].MatchKind != "corrected" {
		t.Fatalf("text-only correction: %+v %s", response.Corrected, kinds(response))
	}
	if !strings.Contains(response.Items[0].Excerpt, "[[indecomposables]]") {
		t.Fatalf("the corrected word is what the excerpt marks: %q", response.Items[0].Excerpt)
	}
}

func TestNamespacePrefix(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	for _, query := range []string{"Math:tensor", "math : tensor", "数学:tensor", "public/Math:tensor"} {
		response := search(t, root, query)
		if response.Total != 2 || response.Items[0].Title != "tensor" {
			t.Fatalf("%q: %s", query, kinds(response))
		}
		for _, item := range response.Items {
			if item.Namespace != "Math" {
				t.Fatalf("%q left its namespace: %s", query, kinds(response))
			}
		}
	}
	// A nested namespace belongs to its parent.
	if response := search(t, root, "research:quantum"); response.Total != 1 || response.Items[0].Title != "Quantum State" {
		t.Fatalf("nested namespace: %s", kinds(response))
	}
	// An unknown prefix is text, and a field keeps its meaning.
	if query := Parse("Nowhere:tensor", func(string) (string, string, bool) { return "", "", false }); query.Namespace != "" {
		t.Fatal("an unknown prefix must not narrow the search")
	}
	if response := search(t, root, "tag:algebra"); response.Total != 3 {
		t.Fatalf("tag: is a field: %s", kinds(response))
	}
	// all: lifts the scope the caller applied.
	scoped := func(options *Options) { options.Namespace = "CS" }
	if response := search(t, root, "tensor", scoped); response.Total != 1 {
		t.Fatalf("caller scope: %s", kinds(response))
	}
	if response := search(t, root, "all:tensor", scoped); response.Total != 4 {
		t.Fatalf("all: %s", kinds(response))
	}
	if created := search(t, root, "Math:Nothing Here").Create; created == nil || created.Namespace != "Math" || created.Title != "Nothing Here" {
		t.Fatalf("create hint keeps the namespace and the typed case: %+v", created)
	}
}

func TestOperators(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	count := func(query string, want int) {
		t.Helper()
		if response := search(t, root, query); response.Total != want {
			t.Fatalf("%q: want %d, got %s", query, want, kinds(response))
		}
	}
	count(`tensor -isomorphism`, 2)
	count(`colouring OR quantum`, 2)
	count(`tensor (direct OR rank)`, 2)
	count(`"direct sum"`, 1)
	count(`"sum direct"`, 0)
	count(`#algebra`, 3)
	count(`tag:algebra -tag:complexity file:tensor`, 2)
	count(`path:Complexity/`, 2)
	count(`content:monomial`, 1)
	count(`title:tensor`, 3)
	count(`alias:lce`, 1)
	count(`is:private`, 2)
	count(`linksto:tensor`, 1)
	count(`line:(tensor rank)`, 1)
	count(`line:(tensor multilinear rank)`, 0)
	count(`/iso\w+ism/`, 2)
	count(`-/iso\w+ism/ tag:complexity`, 1)
	count(`file:/^tensor/`, 3)
	count(`created:2026`, 1)
	count(`[tag:coding]`, 1)
	count(`线性码`, 1)
	count(`等价`, 1)
	if response := search(t, root, `[status:draft]`); len(response.Explain) == 0 || !strings.Contains(strings.Join(response.Explain, " "), "not indexed") {
		t.Fatalf("an unknown property is reported: %v", response.Explain)
	}
	if response := search(t, root, `/(/`); !strings.Contains(strings.Join(response.Explain, " "), "error parsing regexp") {
		t.Fatalf("a bad regular expression is reported: %v", response.Explain)
	}
	explained := strings.Join(search(t, root, `Math:tensor -"direct sum" tag:algebra`).Explain, "; ")
	if explained != `in namespace Math; a word beginning "tensor" and not the phrase "direct sum" and tag contains "algebra"` {
		t.Fatalf("explain: %s", explained)
	}
}

func TestFilterAloneIsListed(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	response := search(t, root, "tag:algebra")
	if got := strings.Join(titles(response), "|"); got != "Direct Sums of Tensors|Krull–Schmidt Theorem|tensor" {
		t.Fatalf("by title: %s", got)
	}
	response = search(t, root, "tag:algebra", func(options *Options) { options.Sort = "recent" })
	if got := strings.Join(titles(response), "|"); got != "tensor|Direct Sums of Tensors|Krull–Schmidt Theorem" || response.Items[0].MatchKind != "listed" {
		t.Fatalf("by recency: %s", kinds(response))
	}
	if response.Create != nil {
		t.Fatal("a filter names no page to create")
	}
	if explained := search(t, root, "").Explain; len(explained) != 0 {
		t.Fatalf("nothing typed explains nothing: %q", explained)
	}
	paged := search(t, root, "", func(options *Options) { options.Limit, options.Cursor = 3, 6 })
	if paged.Total != len(fixturePages) || len(paged.Items) != 2 || paged.NextCursor != nil {
		t.Fatalf("paging: total %d, %d items", paged.Total, len(paged.Items))
	}
}

func TestPartialAnswer(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	response := search(t, root, "monomial zebra")
	if response.Match != "partial" || len(response.Items) != 1 || response.Items[0].Title != "Linear Code Equivalence" {
		t.Fatalf("partial: %s %s", response.Match, kinds(response))
	}
	if got := strings.Join(response.Items[0].MatchedTerms, ","); got != "monomial" {
		t.Fatalf("matched terms: %s", got)
	}
	if response := search(t, root, "xyzzy plugh"); response.Total != 0 || response.Match != "full" {
		t.Fatalf("nothing matches nothing: %s", kinds(response))
	}
}

func TestExcerpt(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	response := search(t, root, "graph isomorphism tensor")
	var excerpt string
	for _, item := range response.Items {
		if item.Title == "Tensor Isomorphism" {
			excerpt = item.Excerpt
		}
	}
	// The prose line holding all three words, not the metadata or the code.
	if excerpt != "[[Tensor]] [[isomorphism]] is as hard as [[graph]] [[isomorphism]]." {
		t.Fatalf("excerpt: %q", excerpt)
	}
	// A page found by its title shows how its text begins.
	if got := search(t, root, "Colouring Gadgets").Items[0].Excerpt; got != "A [[colouring]] gadget fixes vertex classes." {
		t.Fatalf("opening: %q", got)
	}
	long := strings.Repeat("word ", 80) + "needle " + strings.Repeat("tail ", 80)
	if got := excerpt2(long, "needle"); !strings.HasPrefix(got, "… ") || !strings.HasSuffix(got, " …") || !strings.Contains(got, "[[needle]]") {
		t.Fatalf("window: %q", got)
	}
}

func excerpt2(body, word string) string { return excerpt(body, []string{word}, nil) }

func TestCatalogFollowsTheIndex(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	if response := search(t, root, "Fresh Page"); response.Total != 0 {
		t.Fatalf("not there yet: %s", kinds(response))
	}
	db, err := sql.Open("sqlite3", DatabaseFile(root))
	if err != nil {
		t.Fatal(err)
	}
	key := "public/Math:fresh.md"
	for _, statement := range []string{
		`INSERT INTO pages VALUES ('` + key + `', 'id-new', 'ok', 'Fresh Page', 'Math', 'public/Math', 'repository', 'page', '/vault/fresh.md', 'public/Math/fresh.md', 'fresh.md', 'public/Math', 'public', 0, '', 99, 0)`,
		`INSERT INTO pages_fts VALUES ('` + key + `', 'Fresh Page', '', '', 'public/Math/fresh.md', 'Just written.')`,
		`UPDATE wiki_meta SET value = 'g2' WHERE key = 'generation'`,
	} {
		if _, err = db.Exec(statement); err != nil {
			t.Fatal(err)
		}
	}
	db.Close()
	expectFirst(t, search(t, root, "Fresh Page"), "exact", "Fresh Page")
}

func TestNoIndexIsAnEmptyAnswer(t *testing.T) {
	response, err := Search(t.TempDir(), Options{Query: "anything"})
	if err != nil || !response.OK || response.Total != 0 || response.Items == nil {
		t.Fatalf("missing wiki.db: %+v %v", response, err)
	}
}

func TestDates(t *testing.T) {
	now := time.Date(2026, 10, 11, 15, 0, 0, 0, time.Local)
	day := func(year int, month time.Month, date int) int64 {
		return time.Date(year, month, date, 0, 0, 0, 0, time.Local).UnixMilli()
	}
	for value, want := range map[string]int64{
		"2026": day(2026, 1, 1), "2026-10": day(2026, 10, 1), "2026-10-09": day(2026, 10, 9),
		"7d": day(2026, 10, 4), "2w": day(2026, 9, 27), "3m": day(2026, 7, 11), "1y": day(2025, 10, 11),
	} {
		if got, ok := dateBound(value, now); !ok || got != want {
			t.Fatalf("%s: got %d want %d", value, got, want)
		}
	}
	for _, value := range []string{"2026-13", "2026-02-30", "soon", ""} {
		if _, ok := dateBound(value, now); ok {
			t.Fatalf("%q is not a date", value)
		}
	}
	if from, to, ok := datePeriod("2026-10", now); !ok || from != day(2026, 10, 1) || to != day(2026, 11, 1) {
		t.Fatalf("a month is a period: %d %d", from, to)
	}
	if _, to, ok := datePeriod("7d", now); !ok || to != 0 {
		t.Fatal("an age has no end")
	}
}

func TestFold(t *testing.T) {
	for input, want := range map[string]string{
		"Krull–Schmidt Theorem": "krull schmidt theorem", "krull_schmidt": "krull schmidt",
		"  Ｔｅｎｓｏｒ  Product ": "tensor product", "Café": "cafe", "线性码等价": "线性码等价", "a.b/c:d": "a b c d",
	} {
		if got := Fold(input); got != want {
			t.Fatalf("Fold(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestSubsequencePrefersRunsAndWordStarts(t *testing.T) {
	score := func(query, candidate string) int {
		value, _, ok := subsequence([]rune(query), []rune(candidate))
		if !ok {
			return -1
		}
		return value
	}
	if score("dn", "Daily notes") <= score("dn", "Undone") {
		t.Fatal("word starts beat letters inside a word")
	}
	if score("ten", "Tensor") <= score("ten", "The Even Number") {
		t.Fatal("a run beats the same letters apart")
	}
	if score("xyz", "Tensor") != -1 {
		t.Fatal("letters that are absent do not match")
	}
	if _, positions, _ := subsequence([]rune("dn"), []rune("Daily notes")); len(positions) != 2 || positions[0] != 0 || positions[1] != 6 {
		t.Fatalf("positions: %v", positions)
	}
}
