package wikiindex

import (
	"net/url"
	"path"
	"regexp"
	"sort"
	"strings"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// Page is one note as the relationship pass sees it: what Parse derives plus
// the facts its file and repository supply.
type Page struct {
	ID               string   `json:"id"`
	IdentityStatus   string   `json:"identityStatus"`
	Title            string   `json:"title"`
	Aliases          []string `json:"aliases"`
	Kind             string   `json:"kind"`
	RedirectTo       string   `json:"redirectTo"`
	Namespace        string   `json:"namespace"`
	QualifiedNS      string   `json:"qualifiedNamespace"`
	NamespaceAliases []string `json:"namespaceAliases"`
	FullTitle        string   `json:"fullTitle"`
	Repository       string   `json:"repository"`
	RepositoryID     string   `json:"repositoryId"`
	RepositoryPath   string   `json:"repositoryPath"`
	Partition        string   `json:"partition"`
	File             string   `json:"file"`
	Blocks           []Block  `json:"blocks"`
	WikiLinks        []Link   `json:"wikiLinks"`
}

// PageLinks are a page's resolved relationships, in input order.
type PageLinks struct {
	Refs            []string `json:"refs"`
	Backlinks       []string `json:"backlinks"`
	UnresolvedLinks []string `json:"unresolvedLinks"`
}

type Candidate struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	File     string `json:"file"`
	Location string `json:"location"`
}

type WantedReference struct {
	SourceID    string `json:"sourceId"`
	SourceTitle string `json:"sourceTitle"`
	SourceFile  string `json:"sourceFile"`
}

type Wanted struct {
	Title          string            `json:"title"`
	Namespace      string            `json:"namespace"`
	QualifiedTitle string            `json:"qualifiedTitle"`
	References     []WantedReference `json:"references"`
}

type Ambiguous struct {
	SourceID    string      `json:"sourceId"`
	SourceTitle string      `json:"sourceTitle"`
	Target      string      `json:"target"`
	Candidates  []Candidate `json:"candidates"`
}

type DuplicateTitle struct {
	Title      string      `json:"title"`
	Candidates []Candidate `json:"candidates"`
}

type DuplicateID struct {
	ID         string      `json:"id"`
	Candidates []Candidate `json:"candidates"`
}

type MissingFragment struct {
	SourceID   string `json:"sourceId"`
	SourceFile string `json:"sourceFile"`
	Target     string `json:"target"`
	Fragment   string `json:"fragment"`
}

// Reports are what the relationship pass tells the author. Similar-title
// pairs are not part of this contract yet; Node still computes them.
type Reports struct {
	Wanted           []Wanted          `json:"wanted"`
	Ambiguous        []Ambiguous       `json:"ambiguous"`
	Duplicates       []DuplicateTitle  `json:"duplicates"`
	DuplicateIDs     []DuplicateID     `json:"duplicateIds"`
	MissingFragments []MissingFragment `json:"missingFragments"`
}

type Relations struct {
	Pages   []PageLinks `json:"pages"`
	Reports Reports     `json:"reports"`
}

var (
	stableTargetRE = regexp.MustCompile(`(?i)^roam://(?:id/)?(.+)$`)
	markdownFileRE = regexp.MustCompile(`(?i)\.(?:md|markdown)$`)
	uuidV7RE       = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	proseColonRE   = regexp.MustCompile(`[:\x{ff1a}]`)
)

func canonicalTitle(value string) string {
	return strings.ToLower(strings.TrimSpace(norm.NFKC.String(value)))
}

// QualifiedTitle matches shared/wiki-link.mjs qualifiedWikiTitle.
func QualifiedTitle(namespace, title string) string {
	scope := NormalizeNamespace(namespace)
	name := strings.TrimSpace(norm.NFKC.String(title))
	if scope != "" && name != "" {
		return scope + ":" + name
	}
	return name
}

func splitFragment(value string) (string, string) {
	target := strings.TrimSpace(value)
	hash := strings.Index(target, "#")
	if hash < 0 {
		return target, ""
	}
	fragment := strings.TrimSpace(target[hash+1:])
	if decoded, err := url.PathUnescape(fragment); err == nil {
		fragment = decoded
	}
	return strings.TrimSpace(target[:hash]), fragment
}

type qualified struct {
	namespace, title string
	qualified        bool
}

func splitQualified(value string) qualified {
	target := strings.TrimSpace(norm.NFKC.String(value))
	colon := strings.Index(target, ":")
	if colon <= 0 || strings.HasPrefix(strings.ToLower(target), "roam://") {
		return qualified{title: target}
	}
	namespace := NormalizeNamespace(target[:colon])
	title := strings.TrimSpace(target[colon+1:])
	if namespace != "" && title != "" {
		return qualified{namespace: namespace, title: title, qualified: true}
	}
	return qualified{title: target}
}

func foldNamespace(value string) string {
	folded := strings.ToLower(NormalizeNamespace(value))
	for _, prefix := range []string{"public/", "private/"} {
		if strings.HasPrefix(folded, prefix) {
			return folded[len(prefix):]
		}
	}
	return folded
}

func splitWanted(value string, known []string) qualified {
	raw := strings.TrimSpace(value)
	parsed := splitQualified(raw)
	if !parsed.qualified {
		return parsed
	}
	scope := foldNamespace(parsed.namespace)
	for _, item := range known {
		if foldNamespace(item) == scope {
			return parsed
		}
	}
	loc := proseColonRE.FindStringIndex(raw)
	if loc != nil {
		colon := raw[loc[0]:loc[1]]
		next := raw[loc[1]:]
		if colon == "：" || (next != "" && strings.ContainsAny(next[:1], " \t\n\r\f\v")) {
			return qualified{title: raw}
		}
	}
	return parsed
}

type lookup struct {
	byTitle, byID, byFile map[string][]int
	namespaces            []string
}

func buildLookup(pages []Page) lookup {
	l := lookup{byTitle: map[string][]int{}, byID: map[string][]int{}, byFile: map[string][]int{}}
	seenNS := map[string]bool{}
	addNS := func(value string) {
		if value != "" && !seenNS[value] {
			seenNS[value] = true
			l.namespaces = append(l.namespaces, value)
		}
	}
	for index, page := range pages {
		if key := canonicalTitle(page.ID); key != "" {
			l.byID[key] = append(l.byID[key], index)
		}
		l.byFile[path.Clean(page.File)] = append(l.byFile[path.Clean(page.File)], index)
		addNS(page.Namespace)
		addNS(page.QualifiedNS)
		for _, alias := range page.NamespaceAliases {
			addNS(alias)
		}
		if page.Kind == "redirect" {
			continue
		}
		seen := map[string]bool{}
		for _, value := range append([]string{page.Title}, page.Aliases...) {
			key := canonicalTitle(value)
			if key == "" || seen[key] {
				continue
			}
			seen[key] = true
			l.byTitle[key] = append(l.byTitle[key], index)
		}
	}
	return l
}

func namespaceKeys(page Page) map[string]bool {
	keys := map[string]bool{}
	values := []string{page.Namespace, page.QualifiedNS, page.Repository, page.RepositoryID}
	values = append(values, page.NamespaceAliases...)
	for _, alias := range page.NamespaceAliases {
		values = append(values, page.Partition+"/"+NormalizeNamespace(alias))
	}
	for _, value := range values {
		if key := canonicalTitle(NormalizeNamespace(value)); key != "" {
			keys[key] = true
		}
	}
	return keys
}

func (l lookup) candidates(pages []Page, targetValue string, source int) []int {
	target, _ := splitFragment(targetValue)
	if target == "" || target == "." || target == "./" {
		return []int{source}
	}
	if markdownFileRE.MatchString(target) {
		decoded := target
		if value, err := url.PathUnescape(target); err == nil {
			decoded = value
		}
		return l.byFile[path.Clean(path.Join(path.Dir(pages[source].File), decoded))]
	}
	if stable := stableTargetRE.FindStringSubmatch(target); stable != nil {
		out := []int{}
		for _, index := range l.byID[canonicalTitle(stable[1])] {
			seen := map[string]bool{}
			current := index
			for pages[current].Kind == "redirect" && pages[current].RedirectTo != "" && !seen[pages[current].ID] {
				seen[pages[current].ID] = true
				next := stableTargetRE.FindStringSubmatch(pages[current].RedirectTo)
				if next == nil {
					break
				}
				found := l.byID[canonicalTitle(next[1])]
				if len(found) == 0 {
					break
				}
				current = found[0]
			}
			out = append(out, current)
		}
		return out
	}
	parsed := splitQualified(target)
	found := l.byTitle[canonicalTitle(parsed.title)]
	preferLocal := func(found []int) []int {
		local := []int{}
		for _, index := range found {
			if pages[index].RepositoryID == pages[source].RepositoryID {
				local = append(local, index)
			}
		}
		if len(local) == 1 {
			return local
		}
		return found
	}
	if !parsed.qualified {
		return preferLocal(found)
	}
	scope := canonicalTitle(parsed.namespace)
	scoped := []int{}
	for _, index := range found {
		if namespaceKeys(pages[index])[scope] {
			scoped = append(scoped, index)
		}
	}
	if len(scoped) > 0 {
		return scoped
	}
	return preferLocal(l.byTitle[canonicalTitle(target)])
}

func candidate(page Page) Candidate {
	full := page.FullTitle
	if full == "" {
		full = QualifiedTitle(page.QualifiedNS, page.Title)
	}
	return Candidate{ID: page.ID, Title: page.Title, File: page.File, Location: full + " · " + page.RepositoryPath}
}

func uniqueStrings(values []string) []string {
	out := []string{}
	seen := map[string]bool{}
	for _, value := range values {
		if !seen[value] {
			seen[value] = true
			out = append(out, value)
		}
	}
	return out
}

// Resolve computes every page's links and the author's reports, as the Node
// indexer's resolveWikiRelationships does, pinned by
// shared/wiki-relationship-fixtures.json.
func Resolve(pages []Page) Relations {
	l := buildLookup(pages)
	links := make([]PageLinks, len(pages))
	backlinks := make([][]string, len(pages))
	reports := Reports{Wanted: []Wanted{}, Ambiguous: []Ambiguous{}, Duplicates: []DuplicateTitle{},
		DuplicateIDs: []DuplicateID{}, MissingFragments: []MissingFragment{}}
	firstByID := map[string]int{}
	for index, page := range pages {
		if page.ID == "" || page.IdentityStatus == "provisional" {
			continue
		}
		key := canonicalTitle(page.ID)
		if previous, ok := firstByID[key]; ok {
			reports.DuplicateIDs = append(reports.DuplicateIDs, DuplicateID{ID: page.ID,
				Candidates: []Candidate{candidate(pages[previous]), candidate(page)}})
		} else {
			firstByID[key] = index
		}
	}
	wanted := map[string]*Wanted{}
	wantedOrder := []string{}
	for index, page := range pages {
		refs, unresolved := []string{}, []string{}
		for _, link := range page.WikiLinks {
			found := l.candidates(pages, link.Target, index)
			switch {
			case len(found) == 1:
				target := pages[found[0]]
				_, fragment := splitFragment(link.Target)
				if fragment != "" {
					hasBlock := false
					for _, block := range target.Blocks {
						if canonicalTitle(block.ID) == canonicalTitle(fragment) {
							hasBlock = true
							break
						}
					}
					if !hasBlock && uuidV7RE.MatchString(strings.TrimSpace(fragment)) {
						unresolved = append(unresolved, link.Target)
						reports.MissingFragments = append(reports.MissingFragments, MissingFragment{
							SourceID: page.ID, SourceFile: page.File, Target: link.Target, Fragment: fragment})
						continue
					}
				}
				if target.File != page.File {
					refs = append(refs, target.ID)
					backlinks[found[0]] = append(backlinks[found[0]], page.ID)
				}
			case len(found) == 0:
				unresolved = append(unresolved, link.Target)
				parsed := splitWanted(link.Target, l.namespaces)
				namespace := parsed.namespace
				if namespace == "" {
					namespace = page.Namespace
				}
				key := canonicalTitle(QualifiedTitle(namespace, parsed.title))
				current := wanted[key]
				if current == nil {
					qualifiedTitle := QualifiedTitle(page.Namespace, link.Target)
					if parsed.qualified {
						qualifiedTitle = link.Target
					}
					current = &Wanted{Title: parsed.title, Namespace: namespace, QualifiedTitle: qualifiedTitle,
						References: []WantedReference{}}
					wanted[key] = current
					wantedOrder = append(wantedOrder, key)
				}
				current.References = append(current.References, WantedReference{
					SourceID: page.ID, SourceTitle: page.Title, SourceFile: page.File})
			default:
				candidates := []Candidate{}
				for _, i := range found {
					candidates = append(candidates, candidate(pages[i]))
				}
				reports.Ambiguous = append(reports.Ambiguous, Ambiguous{SourceID: page.ID,
					SourceTitle: page.Title, Target: link.Target, Candidates: candidates})
			}
		}
		links[index] = PageLinks{Refs: uniqueStrings(refs), UnresolvedLinks: uniqueStrings(unresolved)}
	}
	for index := range pages {
		links[index].Backlinks = uniqueStrings(backlinks[index])
	}
	collator := collate.New(language.Und)
	for _, key := range wantedOrder {
		reports.Wanted = append(reports.Wanted, *wanted[key])
	}
	sort.SliceStable(reports.Wanted, func(i, j int) bool {
		return collator.CompareString(reports.Wanted[i].Title, reports.Wanted[j].Title) < 0
	})
	byQualified := map[string][]int{}
	qualifiedOrder := []string{}
	for index, page := range pages {
		if page.Kind == "redirect" {
			continue
		}
		for _, value := range append([]string{page.Title}, page.Aliases...) {
			key := canonicalTitle(QualifiedTitle(page.QualifiedNS, value))
			if _, ok := byQualified[key]; !ok {
				qualifiedOrder = append(qualifiedOrder, key)
			}
			byQualified[key] = append(byQualified[key], index)
		}
	}
	for _, key := range qualifiedOrder {
		items := byQualified[key]
		files := map[string]bool{}
		for _, index := range items {
			files[pages[index].File] = true
		}
		if len(files) < 2 {
			continue
		}
		candidates := []Candidate{}
		for _, index := range items {
			candidates = append(candidates, candidate(pages[index]))
		}
		reports.Duplicates = append(reports.Duplicates, DuplicateTitle{Title: key, Candidates: candidates})
	}
	return Relations{Pages: links, Reports: reports}
}
