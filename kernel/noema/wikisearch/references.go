// Noema Wiki search is Copyright (c) 2026 Aaron He and distributed under the
// AGPL-3.0-or-later terms of the Noema kernel.

package wikisearch

import (
	"database/sql"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"unicode"
	"unicode/utf16"

	"github.com/aaronhe/noema/kernel/noema/bibliography"
	"github.com/aaronhe/noema/kernel/noema/markdown"
)

// Reference is one thing a note can refer to, and the text that refers to it.
// The kernel writes Insert so that every surface links the same way.
type Reference struct {
	// Kind is page, heading, anchor (a tag), block, file, cite or create.
	Kind   string `json:"kind"`
	Label  string `json:"label"`
	Detail string `json:"detail"`
	Group  string `json:"group"`
	Insert string `json:"insert"`
	// Target is the link's destination alone ("roam://ID#tag"), for a
	// surface completing a link whose brackets are already typed.
	Target string `json:"target,omitempty"`
	// PageID, Title and File name the page the reference is in; Fragment is
	// the part after "#", Line its 1-based line there and Level a heading's.
	PageID   string `json:"pageId,omitempty"`
	Title    string `json:"title,omitempty"`
	File     string `json:"file,omitempty"`
	Fragment string `json:"fragment,omitempty"`
	Line     int    `json:"line,omitempty"`
	Level    int    `json:"level,omitempty"`
	// LabelRange is where the display text sits inside Insert, in UTF-16
	// units as an editor counts them.  The label is only a default: after
	// inserting, a surface selects this range so that typing replaces it.
	// Absent when the link has no display text of its own.
	LabelRange *[2]int `json:"labelRange,omitempty"`
	// Equation marks a tag that numbers an equation.
	Equation bool `json:"equation,omitempty"`
	// MatchKind and TitleRanges are as in a search Item.
	MatchKind   string   `json:"matchKind,omitempty"`
	TitleRanges [][2]int `json:"titleRanges,omitempty"`
}

// ReferenceResponse answers one reference lookup.
type ReferenceResponse struct {
	OK         bool        `json:"ok"`
	Type       string      `json:"type"`
	Source     string      `json:"source"`
	Generation string      `json:"generation"`
	Items      []Reference `json:"items"`
	Total      int         `json:"total"`
	Explain    []string    `json:"explain"`
	// Scope is what the query asked for: here, tags, headings, page-tags,
	// page-headings, cite or files.
	Scope string `json:"scope"`
}

// anchor is a heading, a tag or an identified block of a page.
type anchor struct {
	kind     string // heading, tag or block
	label    string
	fragment string   // what follows "#": a tag, or a block's id
	path     []string // a heading's DOM path: its ancestors' slugs and its own
	labels   []string // the same path in words
	hash     string   // a heading's "#slug" for a page that has no id
	equation bool     // a tag that numbers an equation, not one written to be cited
	level    int
	line     int
}

var (
	headingRe     = regexp.MustCompile(`^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*$`)
	headingIDRe   = regexp.MustCompile(`[ \t]*\{#([^\s{}]+)[^{}]*\}$`)
	headingTailRe = regexp.MustCompile(`[ \t]+#+$`)
	inlineTagRe   = regexp.MustCompile(`@@tag\[([^\]\r\n]+)\]`)
	equationTagRe = regexp.MustCompile(`\\tag\*?\{([^{}\r\n]+)\}`)
	inlineCodeRe  = regexp.MustCompile("`[^`\n]*`")
	slugDropRe    = regexp.MustCompile(`[\p{P}\p{S}]`)
	spaceRunRe    = regexp.MustCompile(`\s+`)
	domDropRe     = regexp.MustCompile("[`*_~()\\[\\]{}#+.!<>:;,'\"@]")
)

// githubSlug is the page's heading slug (src/heading-slug.ts): lower case,
// punctuation and symbols dropped except "-" and "_", spaces to hyphens.
func githubSlug(text string) string {
	lowered := strings.ToLower(text)
	dropped := slugDropRe.ReplaceAllStringFunc(lowered, func(mark string) string {
		if mark == "-" || mark == "_" {
			return mark
		}
		return ""
	})
	slug := strings.Trim(spaceRunRe.ReplaceAllString(dropped, "-"), "-")
	if slug == "" {
		return "section"
	}
	return slug
}

// domSlug is one segment of a roam DOM target, as the page computes it
// (slugDomTarget in aaronnote/main.ts): markup characters become spaces,
// spaces hyphens, letters lower case.
func domSlug(label string) string {
	cleaned := strings.Join(strings.Fields(strings.NewReplacer("[", " ", "]", " ", "\r", " ", "\n", " ").Replace(label)), " ")
	return strings.Join(strings.Fields(domDropRe.ReplaceAllString(strings.ToLower(cleaned), " ")), "-")
}

// outline lists the headings, tags and identified blocks of Markdown text in
// document order, as the page's own index does: nothing inside a code fence
// or the metadata block, and no tag inside inline code.  A heading's path is
// the roam DOM target the page resolves: the slugs of the headings above it.
func outline(text string) []anchor {
	var found []anchor
	hashes := map[string]int{}
	tags := map[string]bool{}
	headingLines := map[int]bool{}
	var stack, labels []string
	var levels []int
	fenced, meta := false, false
	var fence string
	for index, raw := range strings.Split(text, "\n") {
		line := strings.TrimRight(raw, "\r")
		trimmed := strings.TrimSpace(line)
		if marker := fenceOf(trimmed); marker != "" {
			if !fenced {
				fenced, fence = true, marker
			} else if strings.HasPrefix(marker, fence) {
				fenced = false
			}
			continue
		}
		lowered := strings.ToLower(trimmed)
		switch {
		case fenced:
			continue
		case strings.HasPrefix(lowered, "#+begin meta") || (index == 0 && trimmed == "---"):
			meta = true
			continue
		case meta:
			if strings.HasPrefix(lowered, "#+end meta") || trimmed == "---" {
				meta = false
			}
			continue
		}
		if match := headingRe.FindStringSubmatch(line); match != nil {
			title := headingTailRe.ReplaceAllString(match[2], "")
			slug := ""
			if id := headingIDRe.FindStringSubmatch(title); id != nil {
				slug = id[1]
				title = strings.TrimSpace(headingIDRe.ReplaceAllString(title, ""))
			}
			if title == "" {
				continue
			}
			base := githubSlug(title)
			hash := base
			if seen := hashes[base]; seen > 0 {
				hash = base + "-" + itoa(seen)
			}
			hashes[base]++
			if slug == "" {
				slug = domSlug(title)
			} else {
				hash = slug
			}
			// The path is the headings really above this one.  The page keeps
			// a looser stack (an earlier sibling can linger in it) but accepts
			// any path that is a suffix of its own, which the true one is.
			level := len(match[1])
			keep := len(levels)
			for keep > 0 && levels[keep-1] >= level {
				keep--
			}
			stack, labels = append(stack[:keep:keep], slug), append(labels[:keep:keep], title)
			levels = append(levels[:keep:keep], level)
			headingLines[index+1] = true
			found = append(found, anchor{
				kind: "heading", label: title, hash: hash, level: level, line: index + 1,
				path: append([]string{}, stack...), labels: append([]string{}, labels...),
			})
			continue
		}
		visible := inlineCodeRe.ReplaceAllStringFunc(line, func(code string) string { return strings.Repeat(" ", len(code)) })
		for _, pattern := range []*regexp.Regexp{inlineTagRe, equationTagRe} {
			for _, match := range pattern.FindAllStringSubmatch(visible, -1) {
				tag := strings.TrimPrefix(strings.Join(strings.Fields(match[1]), " "), "#")
				if key := strings.ToLower(tag); tag != "" && !tags[key] {
					tags[key] = true
					found = append(found, anchor{kind: "tag", label: tag, fragment: tag, line: index + 1, equation: pattern == equationTagRe})
				}
			}
		}
	}
	// Blocks that carry a stable id ({#uuid}), from the kernel's own scanner.
	for _, block := range markdown.Scan([]byte(text)).Definitions {
		if headingLines[block.Line] || headingLines[block.Line+1] {
			continue
		}
		label := strings.TrimSpace(block.Text)
		if label == "" {
			label = block.Kind
		} else if block.OrgEnv {
			label = block.Kind + ": " + label
		}
		if runes := []rune(label); len(runes) > 80 {
			label = string(runes[:79]) + "…"
		}
		found = append(found, anchor{kind: "block", label: label, fragment: block.CanonicalID, line: block.Line})
	}
	sort.SliceStable(found, func(i, j int) bool { return found[i].line < found[j].line })
	return found
}

func fenceOf(trimmed string) string {
	for _, mark := range []string{"```", "~~~"} {
		if strings.HasPrefix(trimmed, mark) {
			run := len(trimmed) - len(strings.TrimLeft(trimmed, mark[:1]))
			return strings.Repeat(mark[:1], run)
		}
	}
	return ""
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for ; value > 0; value /= 10 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
	}
	return string(digits)
}

// labelMatch places label against the folded needle the way a title is
// placed, and reports whether it matches at all.
func labelMatch(label, needle string) (hit, bool) {
	if needle == "" {
		return hit{tier: tierListed}, true
	}
	candidate := &page{title: label, foldTitle: Fold(label)}
	candidate.foldFile = candidate.foldTitle
	if found := titleMatch(candidate, needle); found.tier < tierContent {
		return found, true
	}
	return fuzzyMatch(candidate, needle)
}

// encodeComponent is JavaScript's encodeURIComponent, which the page decodes,
// with parentheses encoded too so that a target cannot end a Markdown link.
func encodeComponent(value string) string {
	const hex = "0123456789ABCDEF"
	var out strings.Builder
	for index := 0; index < len(value); index++ {
		c := value[index]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9',
			c == '-', c == '_', c == '.', c == '!', c == '~', c == '*', c == '\'':
			out.WriteByte(c)
		default:
			out.WriteByte('%')
			out.WriteByte(hex[c>>4])
			out.WriteByte(hex[c&15])
		}
	}
	return out.String()
}

// stable reports whether a page can be named by id in a roam link.
func stable(target *page) bool {
	return target != nil && target.id != "" && target.identityStatus != "provisional"
}

// markdownLink writes "[label](target)" and says where the label is.
func markdownLink(label, target string) (string, *[2]int) {
	escaped := strings.NewReplacer("[", `\[`, "]", `\]`).Replace(label)
	return "[" + escaped + "](" + target + ")", &[2]int{1, 1 + len(utf16.Encode([]rune(escaped)))}
}

// anchorReference is how a heading, tag or block of owner is referred to, in
// roam's syntax: "roam://ID#tag" for a tag or a block, "roam://ID@a@b" for a
// heading by its DOM path.  A page without a stable id can only be linked
// from inside itself, by hash.
func anchorReference(owner *page, item anchor, here bool) Reference {
	kind := item.kind
	if kind == "tag" {
		kind = "anchor"
	}
	reference := Reference{Kind: kind, Label: item.label, Fragment: item.fragment, Line: item.line, Level: item.level, Equation: item.equation}
	if owner != nil {
		reference.PageID, reference.Title, reference.File = owner.id, owner.title, owner.file
	}
	suffix := ""
	if item.kind == "heading" {
		segments := make([]string, 0, len(item.path))
		for _, segment := range item.path {
			segments = append(segments, encodeComponent(segment))
		}
		suffix = "@" + strings.Join(segments, "@")
		reference.Fragment = strings.Join(item.path, "@")
	} else {
		suffix = "#" + encodeComponent(item.fragment)
	}
	switch {
	case stable(owner):
		reference.Target = "roam://" + owner.id + suffix
	case item.kind == "heading":
		reference.Target = "#" + encodeComponent(item.hash)
	default:
		reference.Target = suffix
	}
	reference.Insert, reference.LabelRange = markdownLink(item.label, reference.Target)

	where := ""
	if !here && owner != nil {
		where = " in " + qualifiedTitle(owner.namespace, owner.title)
	}
	switch item.kind {
	case "heading":
		reference.Detail = strings.Repeat("#", item.level)
		if len(item.labels) > 1 {
			reference.Detail += " " + strings.Join(item.labels[:len(item.labels)-1], " / ")
		}
		reference.Detail += where
	case "block":
		reference.Detail = "block" + where
	case "tag":
		reference.Detail = "tag" + where
		if item.equation {
			reference.Detail = "equation" + where
		}
	}
	return reference
}

func pageReference(found *page) Reference {
	reference := Reference{
		Kind: "page", Label: found.title, Detail: found.namespace + " · " + found.repositoryPath,
		PageID: found.id, Title: found.title, File: found.file,
	}
	if stable(found) {
		reference.Target = "roam://" + found.id
		reference.Insert, reference.LabelRange = markdownLink(found.title, reference.Target)
	} else {
		reference.Insert = "[[" + found.title + "]]"
	}
	return reference
}

// matchAnchors keeps the anchors of owner that answer needle, best first; with
// no needle all of them in document order.  kinds limits what is offered.
func matchAnchors(owner *page, anchors []anchor, needle, group string, here bool, kinds ...string) []Reference {
	type scored struct {
		reference Reference
		found     hit
		order     int
	}
	wanted := map[string]bool{}
	for _, kind := range kinds {
		wanted[kind] = true
	}
	var kept []scored
	for order, item := range anchors {
		if len(wanted) > 0 && !wanted[item.kind] {
			continue
		}
		found, ok := labelMatch(item.label, needle)
		if words := strings.Fields(needle); !ok && item.kind == "heading" && len(item.labels) > 1 && len(words) > 1 {
			// "setup install" finds Install under Setup: the last word names
			// the heading, the words before it the headings above.
			above := strings.Join(item.labels[:len(item.labels)-1], " ")
			if own, named := labelMatch(item.label, words[len(words)-1]); named {
				if _, under := labelMatch(above, strings.Join(words[:len(words)-1], " ")); under {
					found, ok = own, true
					found.ranges = nil
				}
			}
		}
		if !ok {
			continue
		}
		reference := anchorReference(owner, item, here)
		reference.Group, reference.MatchKind, reference.TitleRanges = group, tierKinds[found.tier], found.ranges
		kept = append(kept, scored{reference, found, order})
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].found.tier != kept[j].found.tier {
			return kept[i].found.tier < kept[j].found.tier
		}
		if kept[i].found.score != kept[j].found.score {
			return kept[i].found.score > kept[j].found.score
		}
		return kept[i].order < kept[j].order
	})
	out := make([]Reference, 0, len(kept))
	for _, item := range kept {
		out = append(out, item.reference)
	}
	return out
}

// anchorsOf is every heading, tag and block of every indexed page, read once
// per index generation: a lookup across the Wiki must not parse each page
// again on every key.
func (c *catalog) anchorsOf(db *sql.DB) map[string][]anchor {
	c.anchorOnce.Do(func() {
		c.anchors = map[string][]anchor{}
		rows, err := db.Query(`SELECT page_key, body FROM pages_fts`)
		if err != nil {
			return
		}
		defer rows.Close()
		for rows.Next() {
			var key string
			var body sql.NullString
			if rows.Scan(&key, &body) == nil && body.Valid {
				if found := outline(body.String); len(found) > 0 {
					c.anchors[key] = found
				}
			}
		}
	})
	return c.anchors
}

// scopeOf reads what a lookup asks for, in roam's own syntax.
//
//	text          this note's headings, tags and blocks, then pages
//	#text         tags and blocks: this note's, then every page's
//	@text         headings: this note's, then every page's
//	Page#text     tags and blocks of the page the left part names
//	Page@text     headings of that page
//	@@text        citation keys of the bibliographies this note can see
//	/text         files of the workspace, by path
//
// A leading "roam://" is ignored and the left part may be a page id, so the
// same lookup completes a link someone began to type by hand.
func scopeOf(query string) (scope, pagePart, rest string) {
	query = strings.TrimPrefix(strings.TrimSpace(query), "roam://")
	switch {
	case strings.HasPrefix(query, "@@"):
		return "cite", "", strings.TrimSpace(query[2:])
	case strings.HasPrefix(query, "/"):
		return "files", "", strings.TrimSpace(query[1:])
	case strings.HasPrefix(query, "#"):
		return "tags", "", query[1:]
	case strings.HasPrefix(query, "@"):
		return "headings", "", query[1:]
	}
	if at := strings.IndexAny(query, "#@"); at > 0 {
		scope = "page-tags"
		if query[at] == '@' {
			scope = "page-headings"
		}
		return scope, strings.TrimSpace(query[:at]), query[at+1:]
	}
	return "here", "", query
}

// References answers a reference lookup made from the note options.File with
// text options.Content (its unsaved state; the indexed text when absent).
func References(root string, options Options) (*ReferenceResponse, error) {
	response := &ReferenceResponse{OK: true, Type: "wiki-references", Source: "kernel-wiki", Items: []Reference{}, Explain: []string{}}
	file := DatabaseFile(root)
	limit := options.Limit
	if limit <= 0 {
		limit = 30
	}
	limit = min(limit, 100)
	scope, pagePart, rest := scopeOf(options.Query)
	response.Scope = scope
	// A deeper DOM path is typed with "@" between its parts.
	needle := Fold(strings.ReplaceAll(rest, "@", " "))

	if scope == "cite" {
		response.Items = citations(root, options, rest, limit)
		response.Total = len(response.Items)
		response.Explain = []string{"citation keys"}
		return response, nil
	}
	if _, err := os.Stat(file); err != nil {
		// No index yet: this note's own outline still works.
		if options.HasContent && (scope == "here" || scope == "tags" || scope == "headings") {
			response.Items = clipReferences(matchAnchors(nil, outline(options.Content), needle, "This page", true, kindsOf(scope)...), limit)
			response.Total = len(response.Items)
		}
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
	run := &searcher{db: db, index: index, options: options}

	var current *page
	if options.File != "" {
		wanted := filepath.Clean(options.File)
		for _, candidate := range index.pages {
			if candidate.file == wanted {
				current = candidate
				break
			}
		}
	}
	content := options.Content
	if !options.HasContent && current != nil {
		content = run.body(current)
	}
	here := outline(content)

	switch scope {
	case "files":
		response.Explain = []string{"files, by path"}
		items, filesErr := run.files(rest, limit)
		if filesErr != nil {
			return nil, filesErr
		}
		response.Items = items

	case "tags", "headings":
		response.Explain = []string{map[string]string{"tags": "tags and blocks", "headings": "headings"}[scope] + " of this page, then of every page"}
		items := matchAnchors(current, here, needle, "This page", true, kindsOf(scope)...)
		var elsewhere []Reference
		for key, anchors := range index.anchorsOf(db) {
			owner := index.byKey[key]
			if owner == nil || owner == current || !stable(owner) {
				continue
			}
			elsewhere = append(elsewhere, matchAnchors(owner, anchors, needle, "Other pages", false, kindsOf(scope)...)...)
		}
		sort.SliceStable(elsewhere, func(i, j int) bool {
			a, b := elsewhere[i], elsewhere[j]
			// A tag someone wrote to be cited before "(3)" of some page.
			if a.Equation != b.Equation {
				return !a.Equation
			}
			if a.MatchKind != b.MatchKind {
				return matchOrder(a.MatchKind) < matchOrder(b.MatchKind)
			}
			if a.Title != b.Title {
				return a.Title < b.Title
			}
			return a.Line < b.Line
		})
		response.Items = clipReferences(append(items, elsewhere...), limit)

	case "page-tags", "page-headings":
		owner := index.pageNamed(pagePart)
		if owner == nil {
			found, searchErr := Search(root, Options{Query: pagePart, Mode: "suggest", Limit: 1, Now: options.Now})
			if searchErr != nil {
				return nil, searchErr
			}
			if len(found.Items) > 0 {
				owner = index.byKey[found.Items[0].PageKey]
			}
		}
		if owner == nil {
			response.Explain = []string{"no page answers " + pagePart}
			break
		}
		text, isHere := run.body(owner), owner == current
		if isHere {
			text = content
		}
		name := qualifiedTitle(owner.namespace, owner.title)
		what := "tags and blocks"
		if scope == "page-headings" {
			what = "headings"
		}
		response.Explain = []string{what + " of " + name}
		response.Items = clipReferences(matchAnchors(owner, outline(text), needle, name, isHere, kindsOf(scope)...), limit)

	default:
		items := matchAnchors(current, here, needle, "This page", true)
		if needle != "" {
			response.Explain = []string{"headings, tags and blocks of this page, then pages"}
		}
		pageOptions := Options{Query: rest, Mode: "suggest", Limit: limit, Now: options.Now}
		if needle == "" {
			pageOptions.Mode, pageOptions.Sort, pageOptions.Limit = "", "recent", 8
		}
		found, searchErr := Search(root, pageOptions)
		if searchErr != nil {
			return nil, searchErr
		}
		group := "Pages"
		if needle == "" {
			group = "Recent pages"
		}
		// A link is made to a page by its name.  Pages that merely mention
		// the text are offered only when no name answers.
		named := false
		for _, item := range found.Items {
			if matchOrder(item.MatchKind) < tierContent {
				named = true
			}
		}
		for _, item := range found.Items {
			owner := index.byKey[item.PageKey]
			if owner == nil || owner == current {
				continue
			}
			if named && needle != "" && matchOrder(item.MatchKind) >= tierContent && item.MatchKind != "fuzzy" {
				continue
			}
			reference := pageReference(owner)
			reference.Group, reference.MatchKind, reference.TitleRanges = group, item.MatchKind, item.TitleRanges
			if item.Via != "" {
				reference.Detail = "↳ " + item.Via + " · " + reference.Detail
			}
			items = append(items, reference)
		}
		items = clipReferences(items, limit)
		if found.Create != nil {
			title := found.Create.Title
			if found.Create.Namespace != "" {
				title = found.Create.Namespace + ":" + title
			}
			items = append(items, Reference{
				Kind: "create", Label: "Link to a new page “" + title + "”", Group: "New page",
				Detail: "the page is created when the link is followed", Insert: "[[" + title + "]]", Title: title,
			})
		}
		response.Items = items
	}
	response.Total = len(response.Items)
	return response, nil
}

// kindsOf is which anchors a scope lists; none means all.
func kindsOf(scope string) []string {
	switch scope {
	case "tags", "page-tags":
		return []string{"tag", "block"}
	case "headings", "page-headings":
		return []string{"heading"}
	}
	return nil
}

// pageNamed finds a page by its id, as a hand-typed "roam://ID#" names it.
func (c *catalog) pageNamed(id string) *page {
	if id == "" {
		return nil
	}
	for _, candidate := range c.pages {
		if candidate.id == id {
			return candidate
		}
	}
	return nil
}

func matchOrder(kind string) int {
	for order, name := range tierKinds {
		if name == kind {
			return order
		}
	}
	return len(tierKinds)
}

func clipReferences(items []Reference, limit int) []Reference {
	if items == nil {
		return []Reference{}
	}
	return items[:min(len(items), limit)]
}

var imageExtensions = map[string]bool{"png": true, "jpg": true, "jpeg": true, "gif": true, "svg": true, "webp": true, "avif": true}

// files lists the workspace's indexed files that answer needle by name or
// path, written as a link relative to the note the lookup is made from.
func (s *searcher) files(needle string, limit int) ([]Reference, error) {
	rows, err := s.db.Query(`SELECT repository_id, path, file, kind, extension FROM files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	type scored struct {
		reference Reference
		found     hit
	}
	folded := Fold(needle)
	from := ""
	if s.options.File != "" {
		from = filepath.Dir(s.options.File)
	}
	var kept []scored
	for rows.Next() {
		var repository, relative, absolute, kind, extension string
		if err = rows.Scan(&repository, &relative, &absolute, &kind, &extension); err != nil {
			return nil, err
		}
		if absolute == s.options.File {
			continue
		}
		name := relative[strings.LastIndex(relative, "/")+1:]
		found, ok := labelMatch(name, folded)
		if !ok {
			// A directory name narrows it: "meeting setup".
			if also, matched := labelMatch(repository+"/"+relative, folded); matched {
				found, ok = also, true
				found.tier += tierContent
				found.ranges = nil
			}
		}
		if !ok {
			continue
		}
		target := repository + "/" + relative
		if from != "" {
			if link, relErr := filepath.Rel(from, absolute); relErr == nil {
				target = filepath.ToSlash(link)
			}
		}
		if strings.ContainsAny(target, " ()") {
			target = "<" + target + ">"
		}
		reference := Reference{Kind: "file", Label: name, Detail: repository + "/" + relative, Group: "Files", File: absolute, Target: target,
			MatchKind: tierKinds[min(found.tier, len(tierKinds)-1)], TitleRanges: found.ranges}
		reference.Insert, reference.LabelRange = markdownLink(name, target)
		if imageExtensions[strings.ToLower(strings.TrimPrefix(extension, "."))] {
			reference.Insert = "!" + reference.Insert
			reference.LabelRange = &[2]int{reference.LabelRange[0] + 1, reference.LabelRange[1] + 1}
		}
		kept = append(kept, scored{reference, found})
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].found.tier != kept[j].found.tier {
			return kept[i].found.tier < kept[j].found.tier
		}
		if kept[i].found.score != kept[j].found.score {
			return kept[i].found.score > kept[j].found.score
		}
		return kept[i].reference.Detail < kept[j].reference.Detail
	})
	out := make([]Reference, 0, min(len(kept), limit))
	for _, item := range kept[:min(len(kept), limit)] {
		out = append(out, item.reference)
	}
	return out, rows.Err()
}

// citations lists the keys of the bibliographies the note can see, matched
// against its key, title, author and year.
func citations(root string, options Options, needle string, limit int) []Reference {
	if options.File == "" {
		return []Reference{}
	}
	relative, err := filepath.Rel(root, options.File)
	if err != nil || strings.HasPrefix(relative, "..") {
		return []Reference{}
	}
	content := options.Content
	if !options.HasContent {
		if data, readErr := os.ReadFile(options.File); readErr == nil {
			content = string(data)
		}
	}
	library, err := bibliography.Load(root, filepath.ToSlash(relative), content)
	if err != nil {
		return []Reference{}
	}
	type scored struct {
		reference Reference
		found     hit
	}
	folded := Fold(needle)
	var kept []scored
	for _, source := range library.Files {
		namespace := source.ShortNamespace
		if namespace == "" {
			namespace = source.Namespace
		}
		for _, entry := range source.Entries {
			title := cleanField(entry.Fields["title"])
			author := cleanField(entry.Fields["author"])
			year := cleanField(entry.Fields["year"])
			found, ok := labelMatch(entry.Key, folded)
			if !ok {
				// The key is what gets inserted; the title and authors are
				// what a person remembers.
				if also, matched := labelMatch(strings.Join([]string{title, author, year}, " "), folded); matched {
					found, ok = also, true
					found.tier += tierContent
					found.ranges = nil
				}
			}
			if !ok {
				continue
			}
			detail := strings.Trim(strings.Join([]string{author, year}, " "), " ")
			if title != "" {
				detail = strings.Trim(title+" — "+detail, " —")
			}
			kept = append(kept, scored{Reference{
				Kind: "cite", Label: entry.Key, Detail: detail, Group: "Citations (" + namespace + ")",
				Insert: "@@cite(" + namespace + ")[" + entry.Key + "]", File: entry.File,
				MatchKind: tierKinds[min(found.tier, len(tierKinds)-1)], TitleRanges: found.ranges,
			}, found})
		}
	}
	sort.SliceStable(kept, func(i, j int) bool {
		if kept[i].found.tier != kept[j].found.tier {
			return kept[i].found.tier < kept[j].found.tier
		}
		if kept[i].found.score != kept[j].found.score {
			return kept[i].found.score > kept[j].found.score
		}
		return kept[i].reference.Label < kept[j].reference.Label
	})
	out := make([]Reference, 0, min(len(kept), limit))
	for _, item := range kept[:min(len(kept), limit)] {
		out = append(out, item.reference)
	}
	return out
}

// cleanField is a BibTeX field without its braces and line breaks.
func cleanField(value string) string {
	cleaned := strings.Map(func(r rune) rune {
		if r == '{' || r == '}' {
			return -1
		}
		if unicode.IsSpace(r) {
			return ' '
		}
		return r
	}, value)
	return strings.Join(strings.Fields(cleaned), " ")
}
