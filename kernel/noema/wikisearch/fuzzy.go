// Noema Wiki search is Copyright (c) 2026 Aaron He and distributed under the
// AGPL-3.0-or-later terms of the Noema kernel.

package wikisearch

import (
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

// Fold returns text as titles are compared: compatibility forms unified,
// lower case, accents dropped, and every run of dashes, underscores, dots or
// spaces one space.  "Krull–Schmidt", "krull_schmidt" and "Krull Schmidt"
// fold to the same string, as MediaWiki's near match treats case variants of
// one title as that title.
func Fold(text string) string {
	var out strings.Builder
	space := false
	for _, r := range norm.NFKD.String(text) {
		switch {
		case unicode.Is(unicode.Mn, r):
			continue
		case unicode.IsSpace(r), unicode.Is(unicode.Pd, r), r == '_', r == '.', r == '/', r == ':':
			space = out.Len() > 0
			continue
		}
		if space {
			out.WriteByte(' ')
			space = false
		}
		out.WriteRune(unicode.ToLower(r))
	}
	return out.String()
}

func isCJK(r rune) bool {
	return (r >= 0x2e80 && r <= 0x9fff) || (r >= 0xf900 && r <= 0xfaff)
}

func hasCJK(text string) bool {
	for _, r := range text {
		if isCJK(r) {
			return true
		}
	}
	return false
}

// editDistance is the optimal string alignment distance between a and b
// (insert, delete, substitute, swap neighbours), or limit+1 once it is known
// to exceed limit.
func editDistance(a, b []rune, limit int) int {
	if len(a)-len(b) > limit || len(b)-len(a) > limit {
		return limit + 1
	}
	previous2 := make([]int, len(b)+1)
	previous := make([]int, len(b)+1)
	current := make([]int, len(b)+1)
	for column := range previous {
		previous[column] = column
	}
	for row := 1; row <= len(a); row++ {
		current[0] = row
		best := current[0]
		for column := 1; column <= len(b); column++ {
			cost := 1
			if a[row-1] == b[column-1] {
				cost = 0
			}
			value := min(previous[column]+1, current[column-1]+1, previous[column-1]+cost)
			if row > 1 && column > 1 && a[row-1] == b[column-2] && a[row-2] == b[column-1] {
				value = min(value, previous2[column-2]+1)
			}
			current[column] = value
			best = min(best, value)
		}
		if best > limit {
			return limit + 1
		}
		previous2, previous, current = previous, current, previous2
	}
	return previous[len(b)]
}

// typoLimit is how many slips a word of this length may contain.  A short
// word one letter away is another word ("map", "cap"), so it gets none.
func typoLimit(length int) int {
	switch {
	case length < 4:
		return 0
	case length < 8:
		return 1
	default:
		return 2
	}
}

// typoWords reports whether every query word is a misspelling, or the
// misspelled beginning, of some word of the candidate, and the total number
// of slips.  Both are folded text.
func typoWords(query, candidate string) (slips int, ok bool) {
	words := strings.Fields(candidate)
	for _, want := range strings.Fields(query) {
		wanted := []rune(want)
		limit := typoLimit(len(wanted))
		best := limit + 1
		for _, word := range words {
			have := []rune(word)
			best = min(best, editDistance(wanted, have, limit))
			// Typing is unfinished: compare with as much of the word as was typed.
			if len(have) > len(wanted) {
				best = min(best, editDistance(wanted, have[:len(wanted)], limit))
			}
		}
		if best > limit {
			return 0, false
		}
		slips += best
	}
	return slips, true
}

const (
	scoreMatch       = 16
	scoreConsecutive = 12
	scoreBoundary    = 10
	scoreGap         = 2
)

// subsequence scores query as letters of candidate taken in order, skipping
// some, the way Obsidian's quick switcher matches "dn" to "Daily notes".
// Letters that follow one another or begin a word score more; a skipped
// letter costs.  It returns the best score and the matched rune positions.
func subsequence(query, candidate []rune) (score int, positions []int, ok bool) {
	n, m := len(query), len(candidate)
	if n == 0 || n > m {
		return 0, nil, false
	}
	const none = -1 << 30
	// best[i][j]: best score with query[:i+1] matched and query[i] at candidate[j].
	best := make([][]int, n)
	from := make([][]int, n)
	boundary := func(j int) bool {
		return j == 0 || candidate[j-1] == ' ' || (unicode.IsLower(candidate[j-1]) && unicode.IsUpper(candidate[j]))
	}
	lower := func(r rune) rune { return unicode.ToLower(r) }
	for i := 0; i < n; i++ {
		best[i] = make([]int, m)
		from[i] = make([]int, m)
		for j := 0; j < m; j++ {
			best[i][j], from[i][j] = none, -1
			if lower(candidate[j]) != lower(query[i]) {
				continue
			}
			bonus := scoreMatch
			if boundary(j) {
				bonus += scoreBoundary
			}
			if i == 0 {
				best[i][j] = bonus - scoreGap*min(j, 3)
				continue
			}
			for k := i - 1; k < j; k++ {
				if best[i-1][k] == none {
					continue
				}
				value := best[i-1][k] + bonus
				if k == j-1 {
					value += scoreConsecutive
				} else {
					value -= scoreGap * min(j-k-1, 6)
				}
				if value > best[i][j] {
					best[i][j], from[i][j] = value, k
				}
			}
		}
	}
	end, top := -1, none
	for j := 0; j < m; j++ {
		if best[n-1][j] > top {
			top, end = best[n-1][j], j
		}
	}
	if end < 0 {
		return 0, nil, false
	}
	positions = make([]int, n)
	for i, j := n-1, end; i >= 0; i-- {
		positions[i] = j
		j = from[i][j]
	}
	return top, positions, true
}

// subsequenceWorth is the least score a subsequence match of n letters must
// reach.  Letters scattered through a long title with no run and no word
// start are an accident, not a match.
func subsequenceWorth(n int) int {
	return n*scoreMatch + (n-1)*scoreConsecutive/3 + scoreBoundary
}

// ranges turns sorted rune positions into [from, to) ranges.
func ranges(positions []int) [][2]int {
	var out [][2]int
	for _, position := range positions {
		if len(out) > 0 && out[len(out)-1][1] == position {
			out[len(out)-1][1]++
			continue
		}
		out = append(out, [2]int{position, position + 1})
	}
	return out
}
