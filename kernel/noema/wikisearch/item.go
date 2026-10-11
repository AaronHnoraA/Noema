// Noema Wiki search is Copyright (c) 2026 Aaron He and distributed under the
// AGPL-3.0-or-later terms of the Noema kernel.

package wikisearch

import (
	"strings"
	"unicode"
)

func qualifiedTitle(namespace, title string) string {
	if namespace == "" || title == "" {
		return title
	}
	return namespace + ":" + title
}

func (s *searcher) strings(query string, arg any) ([]string, error) {
	rows, err := s.db.Query(query, arg)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var value string
		if err = rows.Scan(&value); err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, rows.Err()
}

func orEmpty(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

func (s *searcher) item(found hit, words []string) (Item, error) {
	source := found.page
	repository := source.repositoryID
	if slash := strings.LastIndex(repository, "/"); slash >= 0 {
		repository = repository[slash+1:]
	}
	item := Item{
		ID: source.id, PageKey: source.key, IdentityStatus: source.identityStatus,
		Title: source.title, Namespace: source.namespace, QualifiedNamespace: source.qualified,
		QualifiedTitle:  qualifiedTitle(source.namespace, source.title),
		FullTitle:       qualifiedTitle(source.qualified, source.title),
		NamespaceSource: source.namespaceSource, Kind: source.kind, File: source.file,
		Path: source.workspacePath, RepositoryPath: source.repositoryPath,
		RepositoryID: source.repositoryID, Repository: repository, Partition: source.partition,
		Private: source.private, RedirectTo: source.redirectTo,
		MtimeMs: source.mtime, CreatedMs: source.created, Rank: -found.score,
		Aliases: orEmpty(source.aliases), Tags: orEmpty(source.tags),
		MatchKind: tierKinds[found.tier], Via: found.via, TitleRanges: found.ranges,
		MatchedTerms: found.matched, Blocks: []Block{},
	}
	if found.tier == tierPartial && len(found.matched) > 0 {
		words = found.matched
	}
	item.Excerpt = excerpt(s.body(source), words, s.post)

	blocks, err := s.db.Query(`SELECT block_id, kind, env_kind, label, source_offset FROM blocks WHERE page_key = ? ORDER BY source_offset`, source.key)
	if err != nil {
		return item, err
	}
	for blocks.Next() {
		var block Block
		if err = blocks.Scan(&block.ID, &block.Kind, &block.EnvKind, &block.Label, &block.Offset); err != nil {
			blocks.Close()
			return item, err
		}
		item.Blocks = append(item.Blocks, block)
	}
	blocks.Close()
	if item.Refs, err = s.strings(`SELECT target_id FROM links WHERE source_key = ? AND status = 'resolved' AND target_id IS NOT NULL`, source.key); err != nil {
		return item, err
	}
	if item.Backlinks, err = s.strings(`SELECT p.page_id FROM links l JOIN pages p ON p.page_key = l.source_key WHERE l.target_id = ?`, source.id); err != nil {
		return item, err
	}
	item.UnresolvedLinks, err = s.strings(`SELECT raw_target FROM links WHERE source_key = ? AND status IN ('missing', 'missing-fragment')`, source.key)
	return item, err
}

const (
	excerptLead   = 40
	excerptLength = 160
)

// excerpt is the stretch of a page's text that shows why it was found.  As
// MediaWiki's highlighter does, it prefers the line that holds the most of
// the query's words, and prose over code and metadata.  Hits are wrapped in
// [[ ]].  A page found by its title alone shows how its text begins.
func excerpt(body string, words []string, conditions []*node) string {
	type candidate struct {
		line  string
		count int
		prose bool
	}
	var best candidate
	var opening string
	fenced, meta := false, false
	for index, line := range strings.Split(body, "\n") {
		trimmed := strings.TrimSpace(line)
		switch {
		case strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~"):
			fenced = !fenced
			continue
		case strings.HasPrefix(strings.ToLower(trimmed), "#+begin meta") || (index == 0 && trimmed == "---"):
			meta = true
			continue
		case meta && (strings.HasPrefix(strings.ToLower(trimmed), "#+end meta") || trimmed == "---"):
			meta = false
			continue
		}
		if trimmed == "" || meta {
			continue
		}
		prose := !fenced && !strings.HasPrefix(trimmed, "#")
		if opening == "" && prose {
			opening = trimmed
		}
		lowered := strings.ToLower(trimmed)
		count := 0
		for _, word := range words {
			if word != "" && strings.Contains(lowered, word) {
				count++
			}
		}
		for _, condition := range conditions {
			if condition.pattern != nil && condition.field == "content" && condition.pattern.MatchString(trimmed) {
				count += 2
			}
		}
		if count > best.count || (count == best.count && count > 0 && prose && !best.prose) {
			best = candidate{line: trimmed, count: count, prose: prose}
		}
	}
	if best.count == 0 {
		return clip([]rune(opening), 0, excerptLength, nil)
	}
	runes := []rune(best.line)
	lowered := []rune(strings.ToLower(best.line))
	if len(lowered) != len(runes) {
		lowered = runes
	}
	var marks [][2]int
	first := -1
	for _, word := range words {
		want := []rune(word)
		if len(want) == 0 {
			continue
		}
		for start := 0; start+len(want) <= len(lowered); start++ {
			if string(lowered[start:start+len(want)]) == word {
				marks = append(marks, [2]int{start, start + len(want)})
				if first < 0 || start < first {
					first = start
				}
				start += len(want) - 1
			}
		}
	}
	for _, condition := range conditions {
		if condition.pattern == nil || condition.field != "content" {
			continue
		}
		if at := condition.pattern.FindStringIndex(best.line); at != nil {
			start, end := len([]rune(best.line[:at[0]])), len([]rune(best.line[:at[1]]))
			marks = append(marks, [2]int{start, end})
			if first < 0 || start < first {
				first = start
			}
		}
	}
	return clip(runes, max(first, 0), excerptLength, marks)
}

// clip cuts runes to a window of length around at, on word boundaries where
// it can, wrapping the marked ranges inside the window in [[ ]].
func clip(runes []rune, at, length int, marks [][2]int) string {
	from := max(0, at-excerptLead)
	for from > 0 && from > at-excerptLead-12 && !unicode.IsSpace(runes[from-1]) {
		from--
	}
	to := min(len(runes), from+length)
	inside := make([]int, len(runes)+1)
	for _, mark := range marks {
		for position := max(mark[0], from); position < min(mark[1], to); position++ {
			inside[position] = 1
		}
	}
	var out strings.Builder
	if from > 0 {
		out.WriteString("… ")
	}
	open := false
	for position := from; position < to; position++ {
		if inside[position] == 1 && !open {
			out.WriteString("[[")
			open = true
		} else if inside[position] == 0 && open {
			out.WriteString("]]")
			open = false
		}
		r := runes[position]
		if unicode.IsSpace(r) {
			r = ' '
		}
		out.WriteRune(r)
	}
	if open {
		out.WriteString("]]")
	}
	if to < len(runes) {
		out.WriteString(" …")
	}
	return out.String()
}
