package wikisearch

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"unicode/utf16"
)

const referenceNote = "#+begin meta\ntitle: Working note\n#+end meta\n\n" +
	"# Setup {#setup-id}\n\nWe fix a field @@tag[field-choice] and `@@tag[in-code]`.\n\n" +
	"## Lease expiry\n\n$$ a = b \\tag{eq:lease} $$\n\n" +
	"```\n# not a heading\n@@tag[in-fence]\n```\n\n" +
	"#+begin theorem Uniqueness {#019fc7ae-c242-75af-8b5c-0a79480ef69d}\nIt is unique.\n#+end theorem\n\n" +
	"### 结论与展望 (v2)\n\n# Appendix\n\n## Lease expiry\n"

func references(t *testing.T, root, query string, change ...func(*Options)) *ReferenceResponse {
	t.Helper()
	options := Options{Query: query, Content: referenceNote, HasContent: true}
	for _, apply := range change {
		apply(&options)
	}
	response, err := References(root, options)
	if err != nil {
		t.Fatalf("%q: %v", query, err)
	}
	return response
}

func listed(response *ReferenceResponse) string {
	out := make([]string, 0, len(response.Items))
	for _, item := range response.Items {
		out = append(out, item.Kind+":"+item.Label)
	}
	return strings.Join(out, " | ")
}

// labelOf reads back the display text a surface would select.
func labelOf(t *testing.T, item Reference) string {
	t.Helper()
	if item.LabelRange == nil {
		return ""
	}
	units := utf16.Encode([]rune(item.Insert))
	return string(utf16.Decode(units[item.LabelRange[0]:item.LabelRange[1]]))
}

func TestOutlineFollowsThePage(t *testing.T) {
	var got []string
	for _, item := range outline(referenceNote) {
		switch item.kind {
		case "heading":
			got = append(got, "h"+itoa(item.level)+" "+item.label+" @"+strings.Join(item.path, "@"))
		default:
			got = append(got, item.kind+" "+item.label+" #"+item.fragment)
		}
	}
	want := []string{
		"h1 Setup @setup-id",
		"tag field-choice #field-choice",
		"h2 Lease expiry @setup-id@lease-expiry",
		"tag eq:lease #eq:lease",
		"block theorem: Uniqueness #019fc7ae-c242-75af-8b5c-0a79480ef69d",
		"h3 结论与展望 (v2) @setup-id@lease-expiry@结论与展望-v2",
		"h1 Appendix @appendix",
		"h2 Lease expiry @appendix@lease-expiry",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("outline:\n%s", strings.Join(got, "\n"))
	}
	// The page's two slug rules: a DOM target segment, and a "#hash".
	if domSlug("Krull–Schmidt: a [Theorem]!") != "krull–schmidt-a-theorem" || domSlug("a.b (c)") != "a-b-c" {
		t.Fatalf("DOM slug differs from the page's: %q %q", domSlug("Krull–Schmidt: a [Theorem]!"), domSlug("a.b (c)"))
	}
	if githubSlug("Krull–Schmidt: a Theorem!") != "krullschmidt-a-theorem" || githubSlug("！？") != "section" {
		t.Fatal("hash slug differs from the page's")
	}
	if encodeComponent("结 (a)@b#c") != "%E7%BB%93%20%28a%29%40b%23c" {
		t.Fatalf("component encoding: %s", encodeComponent("结 (a)@b#c"))
	}
}

func TestReferencesStartWithThisPage(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	own := func(options *Options) { options.File = "/vault/public/Math/tensor.md" }
	response := references(t, root, "", own)
	if got := listed(response); !strings.HasPrefix(got, "heading:Setup | anchor:field-choice | heading:Lease expiry | anchor:eq:lease | block:theorem: Uniqueness | heading:结论与展望 (v2) | heading:Appendix | heading:Lease expiry | page:Quantum State") {
		t.Fatalf("nothing typed lists this page in order, then recent pages: %s", got)
	}
	// roam's syntax: a heading by its DOM path, a tag or block after "#".
	want := map[int]string{
		0: "[Setup](roam://id-0@setup-id)",
		1: "[field-choice](roam://id-0#field-choice)",
		2: "[Lease expiry](roam://id-0@setup-id@lease-expiry)",
		3: "[eq:lease](roam://id-0#eq%3Alease)",
		4: "[theorem: Uniqueness](roam://id-0#019fc7ae-c242-75af-8b5c-0a79480ef69d)",
		5: "[结论与展望 (v2)](roam://id-0@setup-id@lease-expiry@%E7%BB%93%E8%AE%BA%E4%B8%8E%E5%B1%95%E6%9C%9B-v2)",
		7: "[Lease expiry](roam://id-0@appendix@lease-expiry)",
	}
	for index, insert := range want {
		if got := response.Items[index].Insert; got != insert {
			t.Fatalf("item %d: %s", index, got)
		}
	}
	first := response.Items[0]
	if first.Target != "roam://id-0@setup-id" || first.Group != "This page" || first.Line != 5 || labelOf(t, first) != "Setup" {
		t.Fatalf("a heading carries its target, place and the label to rewrite: %+v", first)
	}
	if got := response.Items[5].Detail; got != "### Setup / Lease expiry" {
		t.Fatalf("a heading shows what it is under: %q", got)
	}

	// A note the index does not know has no id: only a hash reaches a heading.
	unsaved := references(t, root, "")
	if got := unsaved.Items[7].Insert; got != "[Lease expiry](#lease-expiry-1)" || unsaved.Items[1].Insert != "[field-choice](#field-choice)" {
		t.Fatalf("without an id: %s, %s", got, unsaved.Items[1].Insert)
	}

	response = references(t, root, "lease", own)
	if got := listed(response); got != "heading:Lease expiry | heading:Lease expiry | anchor:eq:lease | create:Link to a new page “lease”" {
		t.Fatalf("typed text: %s", got)
	}
	// A heading is found through the heading above it.
	if got := listed(references(t, root, "appendix lease", own)); !strings.HasPrefix(got, "heading:Lease expiry") {
		t.Fatalf("by path: %s", got)
	}
	response = references(t, root, "tensor")
	if got := listed(response); got != "page:tensor | page:Tensor Isomorphism | page:Direct Sums of Tensors" {
		t.Fatalf("pages are offered by name, not for mentioning the text: %s", got)
	}
	if got := response.Items[0]; got.Insert != "[tensor](roam://id-0)" || got.Target != "roam://id-0" || labelOf(t, got) != "tensor" {
		t.Fatalf("a page is linked by its stable id: %+v", got)
	}
	for _, item := range references(t, root, "tensor", own).Items {
		if item.Kind == "page" && item.Label == "tensor" {
			t.Fatal("a page does not offer a link to itself")
		}
	}
	// With no name to offer, a page that mentions it is better than nothing.
	if got := listed(references(t, root, "indecomposables")); !strings.HasPrefix(got, "page:Krull–Schmidt Theorem") {
		t.Fatalf("text match as a fallback: %s", got)
	}
	if got := listed(references(t, root, "krull schmit")); !strings.HasPrefix(got, "page:Krull–Schmidt Theorem") {
		t.Fatalf("fuzzy page: %s", got)
	}
	if got := references(t, root, "Brand New Idea").Items; len(got) != 1 || got[0].Insert != "[[Brand New Idea]]" || got[0].LabelRange != nil {
		t.Fatalf("a title nobody has can still be linked: %+v", got)
	}
}

func TestReferencesInRoamSyntax(t *testing.T) {
	pages := append([]fixturePage{}, fixturePages...)
	pages[0].body = "A tensor is a multilinear map.\n\n## Rank\n\nThe rank @@tag[tensor-rank] of a tensor.\n\n## Decomposition {#cp}\n\n### CP rank\n"
	root := writeFixture(t, "g1", pages)

	// "#" is tags and blocks, here and then everywhere.
	response := references(t, root, "#")
	if got := listed(response); got != "anchor:field-choice | anchor:eq:lease | block:theorem: Uniqueness | anchor:tensor-rank" || response.Scope != "tags" {
		t.Fatalf("#: %s", got)
	}
	// A tag written to be cited comes before another page's equation numbers.
	numbered := append([]fixturePage{}, pages...)
	numbered[1].body = "$$ x \\tag{1} $$\n\n$$ y \\tag{2} $$\n"
	if got := listed(references(t, writeFixture(t, "g1", numbered), "#", func(options *Options) { options.Content = "" })); got != "anchor:tensor-rank | anchor:1 | anchor:2" {
		t.Fatalf("equation numbers last: %s", got)
	}
	if got := references(t, root, "#rank").Items; len(got) != 1 || got[0].Insert != "[tensor-rank](roam://id-0#tensor-rank)" || got[0].Detail != "tag in Math:tensor" || got[0].Group != "Other pages" {
		t.Fatalf("#rank: %+v", got)
	}
	// "@" is headings.
	response = references(t, root, "@rank")
	if got := listed(response); got != "heading:Rank | heading:CP rank" || response.Scope != "headings" {
		t.Fatalf("@rank: %s", got)
	}
	if got := response.Items[1].Insert; got != "[CP rank](roam://id-0@cp@cp-rank)" {
		t.Fatalf("a heading elsewhere by its DOM path: %s", got)
	}
	if got := listed(references(t, root, "@lease")); got != "heading:Lease expiry | heading:Lease expiry" {
		t.Fatalf("@ starts with this page: %s", got)
	}

	// Inside one page, named by a search, by "roam://" or by its id.
	for _, query := range []string{"Math:tensor@", "tensr@", "roam://id-0@", "id-0@"} {
		response = references(t, root, query)
		if got := listed(response); got != "heading:Rank | heading:Decomposition | heading:CP rank" || response.Scope != "page-headings" {
			t.Fatalf("%s: %s", query, got)
		}
	}
	if got := listed(references(t, root, "roam://id-0#")); got != "anchor:tensor-rank" {
		t.Fatalf("Page#: %s", got)
	}
	if got := references(t, root, "tensor@cp@rank").Items; len(got) != 1 || got[0].Target != "roam://id-0@cp@cp-rank" {
		t.Fatalf("a deeper path is typed with @: %+v", got)
	}
	if response := references(t, root, "nowhere at all#x"); len(response.Items) != 0 || !strings.Contains(response.Explain[0], "no page answers") {
		t.Fatalf("an unknown page: %+v", response)
	}

	// Looked up from inside the page, its unsaved text is what counts.
	own := func(options *Options) {
		options.File = "/vault/public/Math/tensor.md"
		options.Content = "## Fresh heading\n"
	}
	if got := references(t, root, "", own).Items[0]; got.Insert != "[Fresh heading](roam://id-0@fresh-heading)" || got.PageID != "id-0" {
		t.Fatalf("unsaved text of the current page: %+v", got)
	}
	if got := references(t, root, "Math:tensor@", own).Items; len(got) != 1 || got[0].Label != "Fresh heading" {
		t.Fatalf("the current page named explicitly: %+v", got)
	}
}

func TestReferencesToFiles(t *testing.T) {
	root := writeFixture(t, "g1", fixturePages)
	from := func(options *Options) { options.File = "/vault/public/Math/Algebra/krull_schmidt.md" }
	response := references(t, root, "/tensor net", from)
	if len(response.Items) != 1 || response.Scope != "files" {
		t.Fatalf("/: %s", listed(response))
	}
	image := response.Items[0]
	if image.Insert != "![tensor network.png](<../figures/tensor network.png>)" || labelOf(t, image) != "tensor network.png" {
		t.Fatalf("an image is embedded, by a path relative to the note: %+v", image)
	}
	if got := references(t, root, "/ranks", from).Items; len(got) != 1 || got[0].Insert != "[ranks.csv](../data/ranks.csv)" {
		t.Fatalf("a file is linked: %+v", got)
	}
	// A directory narrows it, and the note itself is not offered.
	if got := listed(references(t, root, "/complexity colouring", from)); got != "file:colouring_gadgets.md" {
		t.Fatalf("by directory: %s", got)
	}
	for _, item := range references(t, root, "/krull", from).Items {
		if item.File == "/vault/public/Math/Algebra/krull_schmidt.md" {
			t.Fatal("a note does not link to itself")
		}
	}
	if got := references(t, root, "/ranks").Items; len(got) != 1 || got[0].Target != "public/Math/data/ranks.csv" {
		t.Fatalf("without a note the path is the workspace's: %+v", got)
	}
}

func TestReferencesToCitations(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "notes", "bib"), 0o755); err != nil {
		t.Fatal(err)
	}
	note := filepath.Join(root, "notes", "n.md")
	bib := "@article{grochow2021,\n  title = {On the Complexity of {Isomorphism} Problems for Tensors},\n  author = {Grochow, Joshua and Qiao, Youming},\n  year = {2021}\n}\n" +
		"@book{lang2002,\n  title = {Algebra},\n  author = {Lang, Serge},\n  year = {2002}\n}\n"
	if err := os.WriteFile(filepath.Join(root, "notes", "bib", "refs.bib"), []byte(bib), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(note, []byte("# Note\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	at := func(options *Options) { options.File, options.HasContent = note, false }
	response := references(t, root, "@@", at)
	if got := listed(response); got != "cite:grochow2021 | cite:lang2002" || response.Scope != "cite" {
		t.Fatalf("@@ lists every key: %s", got)
	}
	first := references(t, root, "@@groch", at).Items
	if len(first) != 1 || !strings.HasPrefix(first[0].Insert, "@@cite(") || !strings.HasSuffix(first[0].Insert, ")[grochow2021]") || first[0].LabelRange != nil {
		t.Fatalf("key prefix: %+v", first)
	}
	if !strings.Contains(first[0].Detail, "On the Complexity of Isomorphism Problems for Tensors") || !strings.Contains(first[0].Detail, "2021") {
		t.Fatalf("a citation shows its title without braces, authors and year: %q", first[0].Detail)
	}
	// What a person remembers is the author or the title, not the key.
	if got := listed(references(t, root, "@@qiao", at)); got != "cite:grochow2021" {
		t.Fatalf("by author: %s", got)
	}
	if got := listed(references(t, root, "@@algbra", at)); got != "cite:lang2002" {
		t.Fatalf("by misspelled title: %s", got)
	}
	if got := references(t, root, "@@anything"); len(got.Items) != 0 {
		t.Fatalf("no note, no bibliography: %s", listed(got))
	}
}

func TestReferencesWithoutAnIndex(t *testing.T) {
	response := references(t, t.TempDir(), "setup")
	if got := listed(response); got != "heading:Setup" || response.Items[0].Insert != "[Setup](#setup-id)" {
		t.Fatalf("this page's outline needs no index: %s", got)
	}
	if got := listed(references(t, t.TempDir(), "@lease")); got != "heading:Lease expiry | heading:Lease expiry" {
		t.Fatalf("scopes work without an index too: %s", got)
	}
}

func TestLinkTextIsEscaped(t *testing.T) {
	link, at := markdownLink("a [nested] 𝒟 label", "roam://x")
	if link != `[a \[nested\] 𝒟 label](roam://x)` {
		t.Fatalf("brackets in a label are escaped: %s", link)
	}
	units := utf16.Encode([]rune(link))
	if got := string(utf16.Decode(units[at[0]:at[1]])); got != `a \[nested\] 𝒟 label` {
		t.Fatalf("the label range counts UTF-16 units: %q", got)
	}
}
