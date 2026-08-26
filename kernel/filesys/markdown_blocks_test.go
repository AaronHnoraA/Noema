// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package filesys

import (
	"fmt"
	"math/rand"
	"strings"
	"testing"

	"github.com/88250/lute/ast"
	"github.com/88250/lute/parse"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	"github.com/aaronhe/noema/kernel/util"
)

// referenceNoemaBlockProjection is the original, deliberately naive matcher:
// one full tree walk per definition, rebuilding every block's text each time.
// ApplyNoemaBlockProjection replaces it with a single indexed walk, so this
// stays as the differential oracle for that optimization.
func referenceNoemaBlockProjection(tree *parse.Tree, source []byte) map[*ast.Node]string {
	projection := noemamarkdown.Scan(source)
	assigned := map[*ast.Node]string{}
	if nil == tree || nil == tree.Root {
		return assigned
	}
	duplicates := map[string]bool{}
	for _, id := range projection.DuplicateDefinitionIDs {
		duplicates[id] = true
	}
	for _, definition := range projection.Definitions {
		if duplicates[definition.CanonicalID] {
			continue
		}
		literal := "{#" + definition.CanonicalID
		orgOpener := "+begin " + definition.Kind
		var best *ast.Node
		bestTextLen := int(^uint(0) >> 1)
		ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
			if !entering || n == tree.Root || !n.IsBlock() {
				return ast.WalkContinue
			}
			text := n.Text()
			lowerText := strings.ToLower(text)
			matches := strings.Contains(lowerText, literal)
			if definition.OrgEnv {
				matches = strings.Contains(lowerText, orgOpener) && strings.Contains(lowerText, definition.CanonicalID)
			}
			if !matches {
				return ast.WalkContinue
			}
			if len(text) < bestTextLen {
				best = n
				bestTextLen = len(text)
			}
			return ast.WalkContinue
		})
		if nil == best {
			continue
		}
		assigned[best] = definition.CanonicalID
	}
	return assigned
}

// nodeAddress names a node by its position in walk order so the two runs,
// which parse the same source into two distinct trees, can be compared.
func nodeAddresses(tree *parse.Tree) map[*ast.Node]int {
	ret := map[*ast.Node]int{}
	position := 0
	ast.Walk(tree.Root, func(n *ast.Node, entering bool) ast.WalkStatus {
		if entering {
			ret[n] = position
			position++
		}
		return ast.WalkContinue
	})
	return ret
}

func assertProjectionMatchesReference(t *testing.T, name, source string) {
	t.Helper()
	data := normalizeOrgEndBlankLines([]byte(source))

	referenceTree := parse.Parse("/diff.md", data, util.NewLute().ParseOptions)
	wantByAddress := map[int]string{}
	referenceAddresses := nodeAddresses(referenceTree)
	for node, canonical := range referenceNoemaBlockProjection(referenceTree, data) {
		wantByAddress[referenceAddresses[node]] = canonical
	}

	tree := parse.Parse("/diff.md", data, util.NewLute().ParseOptions)
	ApplyNoemaBlockProjection(tree, data)
	gotByAddress := map[int]string{}
	for node, position := range nodeAddresses(tree) {
		if canonical := node.IALAttr(markdownCanonicalIDAttr); "" != canonical {
			gotByAddress[position] = canonical
		}
	}

	if len(gotByAddress) != len(wantByAddress) {
		t.Fatalf("%s: assigned %d canonical IDs, reference assigned %d\ngot:  %v\nwant: %v",
			name, len(gotByAddress), len(wantByAddress), gotByAddress, wantByAddress)
	}
	for position, canonical := range wantByAddress {
		if gotByAddress[position] != canonical {
			t.Fatalf("%s: node at walk position %d has canonical ID %q, reference says %q",
				name, position, gotByAddress[position], canonical)
		}
	}
}

func TestApplyNoemaBlockProjectionMatchesReference(t *testing.T) {
	id := func(n int) string {
		return fmt.Sprintf("0192f1a0-%04x-7000-8000-%012x", n&0xffff, n)
	}
	for _, test := range []struct{ name, source string }{
		{"no anchors", "# Title\n\nJust prose.\n\n- a\n- b\n"},
		{"heading anchor", "# Title {#" + id(1) + "}\n\nBody.\n"},
		{"paragraph anchor", "# Title\n\nBody text. {#" + id(2) + "}\n"},
		{"nested list item anchor", "- outer\n  - inner {#" + id(3) + "}\n"},
		{"blockquote anchor", "> quoted line {#" + id(4) + "}\n"},
		{"two anchors one block tree", "# T {#" + id(5) + "}\n\nBody {#" + id(6) + "}\n"},
		{"duplicate anchors are skipped", "# A {#" + id(7) + "}\n\nB {#" + id(7) + "}\n"},
		{"uppercase hexadecimal anchor", "# Title {#0192F1A0-000A-7000-8000-00000000000A}\n\nBody.\n"},
		{"anchor inside fenced code is ignored", "```\nfenced {#" + id(8) + "}\n```\n\nBody.\n"},
		{"anchor inside inline code is ignored", "Text `code {#" + id(9) + "}` more.\n"},
		{"org env anchor", "#+begin note {#" + id(10) + "}\nSome text.\n#+end note\n"},
		{"org env plus block anchors", "#+begin note {#" + id(11) + "}\nInner. {#" + id(12) + "}\n#+end note\n\nAfter {#" + id(13) + "}\n"},
		{"non semantic org env is ignored", "#+begin comment {#" + id(14) + "}\nHidden.\n#+end comment\n\nAfter {#" + id(15) + "}\n"},
		{"anchor at document end without newline", "Body {#" + id(16) + "}"},
		{"truncated anchor opener", "Body {#0192f1a0-0000-7000-8000\n"},
		{"bare opener brace", "Body {# and more text\n"},
	} {
		assertProjectionMatchesReference(t, test.name, test.source)
	}
}

// TestApplyNoemaBlockProjectionMatchesReferenceOnGeneratedDocs exercises the
// combinations a handwritten table misses: many anchors per document, anchors
// on nested structures, and anchors that never resolve to a block.
func TestApplyNoemaBlockProjectionMatchesReferenceOnGeneratedDocs(t *testing.T) {
	random := rand.New(rand.NewSource(20260826))
	for round := 0; round < 40; round++ {
		var b strings.Builder
		b.WriteString("# Generated\n\n")
		for section := 0; section < 6; section++ {
			anchor := func() string {
				if random.Intn(3) == 0 {
					return ""
				}
				return fmt.Sprintf(" {#0192f1b%d-%04x-7000-8000-%012x}", round%10, random.Intn(0x10000), random.Intn(1<<24))
			}
			switch random.Intn(6) {
			case 0:
				fmt.Fprintf(&b, "## Heading %d%s\n\n", section, anchor())
			case 1:
				fmt.Fprintf(&b, "Paragraph %d with 中文 and *emphasis*%s\n\n", section, anchor())
			case 2:
				fmt.Fprintf(&b, "- item a%s\n- item b%s\n\n", anchor(), anchor())
			case 3:
				fmt.Fprintf(&b, "> quote %d%s\n\n", section, anchor())
			case 4:
				fmt.Fprintf(&b, "#+begin note%s\nbody %d%s\n#+end note\n\n", anchor(), section, anchor())
			case 5:
				fmt.Fprintf(&b, "```go\nfunc f%d() {} // {#0192f1c0-0000-7000-8000-000000000000}\n```\n\n", section)
			}
		}
		assertProjectionMatchesReference(t, fmt.Sprintf("generated round %d", round), b.String())
	}
}
