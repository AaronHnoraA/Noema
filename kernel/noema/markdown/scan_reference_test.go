// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package markdown

import (
	"fmt"
	"math/rand"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"unicode/utf16"

	noemaidentity "github.com/aaronhe/noema/kernel/noema/identity"
)

var referenceFencePattern = regexp.MustCompile("^[ \\t]{0,3}(`{3,}|~{3,})")

func referenceUTF16Length(value string) int {
	return len(utf16.Encode([]rune(value)))
}

func referenceMaskDelimited(line string, marker byte) string {
	masked := []byte(line)
	for i := 0; i < len(line); {
		if line[i] != marker || (0 < i && '\\' == line[i-1]) {
			i++
			continue
		}
		run := 1
		for i+run < len(line) && line[i+run] == marker {
			run++
		}
		end := strings.Index(line[i+run:], strings.Repeat(string(marker), run))
		if end < 0 {
			break
		}
		end += i + run
		for j := i; j < end+run; j++ {
			masked[j] = ' '
		}
		i = end + run
	}
	return string(masked)
}

func referenceScanLineReferences(line string, lineNumber int) (ret []Reference) {
	masked := referenceMaskDelimited(line, '`')
	masked = referenceMaskDelimited(masked, '$')
	for _, match := range blockRefPattern.FindAllStringSubmatchIndex(masked, -1) {
		canonical := strings.ToLower(masked[match[2]:match[3]])
		label := ""
		if 0 <= match[4] {
			label = line[match[4]:match[5]]
		} else if 0 <= match[6] {
			label = line[match[6]:match[7]]
		}
		ret = append(ret, Reference{
			CanonicalID:  canonical,
			ProjectionID: noemaidentity.ProjectionID(canonical, ""),
			Label:        unescapeLabel(label),
			Raw:          line[match[0]:match[1]],
			Line:         lineNumber,
		})
	}
	return
}

// referenceScan is the original whole-document-split implementation, kept as
// the oracle for the streaming rewrite that replaced it.
func referenceScan(source []byte) Projection {
	lines := strings.Split(strings.ReplaceAll(string(source), "\r\n", "\n"), "\n")
	lineOffsets := make([]int, len(lines))
	for index := 1; index < len(lines); index++ {
		lineOffsets[index] = lineOffsets[index-1] + referenceUTF16Length(lines[index-1]) + 1
	}
	ret := Projection{}
	definitionCounts := map[string]int{}
	fenceChar := byte(0)
	fenceLen := 0
	ignoredOrg := ""
	mathFence := false

	for index, line := range lines {
		lineNumber := index + 1
		trimmed := strings.TrimSpace(line)

		if 0 != fenceChar {
			if match := referenceFencePattern.FindStringSubmatch(line); nil != match && match[1][0] == fenceChar && len(match[1]) >= fenceLen {
				fenceChar, fenceLen = 0, 0
			}
			continue
		}
		if match := referenceFencePattern.FindStringSubmatch(line); nil != match {
			fenceChar, fenceLen = match[1][0], len(match[1])
			continue
		}
		if strings.HasPrefix(trimmed, "$$") {
			if 1 == strings.Count(trimmed, "$$") {
				mathFence = !mathFence
			}
			continue
		}
		if mathFence || strings.HasPrefix(line, "    ") || strings.HasPrefix(line, "\t") {
			continue
		}

		if "" != ignoredOrg {
			if match := orgAnyEndPattern.FindStringSubmatch(line); nil != match && strings.EqualFold(match[1], ignoredOrg) {
				ignoredOrg = ""
			}
			continue
		}
		if match := orgAnyBeginPattern.FindStringSubmatch(line); nil != match {
			kind := strings.ToLower(match[1])
			if nonSemanticOrgEnvs[kind] {
				ignoredOrg = kind
				continue
			}
		}

		if match := trailingBlockAnchorPattern.FindStringSubmatchIndex(line); nil != match {
			canonical := strings.ToLower(line[match[2]:match[3]])
			propertiesRaw := ""
			if 0 <= match[4] {
				propertiesRaw = line[match[4]:match[5]]
			}
			kind := "block"
			orgEnv := false
			text := strings.TrimSpace(line[:match[0]])
			if orgMatch := orgAnyBeginPattern.FindStringSubmatchIndex(line); nil != orgMatch {
				kind = strings.ToLower(line[orgMatch[2]:orgMatch[3]])
				orgEnv = true
				text = strings.TrimSpace(line[orgMatch[1]:match[0]])
			}
			definitionCounts[canonical]++
			ret.Definitions = append(ret.Definitions, Definition{
				CanonicalID: canonical, ProjectionID: noemaidentity.ProjectionID(canonical, ""),
				Line: lineNumber, Index: lineOffsets[index], Kind: kind, OrgEnv: orgEnv,
				Text: text, Properties: parseBlockProperties(propertiesRaw),
			})
		}

		ret.References = append(ret.References, referenceScanLineReferences(line, lineNumber)...)
	}

	for id, count := range definitionCounts {
		if 1 < count {
			ret.DuplicateDefinitionIDs = append(ret.DuplicateDefinitionIDs, id)
		}
	}
	sort.Strings(ret.DuplicateDefinitionIDs)
	return ret
}

func assertScanMatchesReference(t *testing.T, name, source string) {
	t.Helper()
	want := referenceScan([]byte(source))
	got := Scan([]byte(source))
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("%s:\n got %+v\nwant %+v\nsource:\n%s", name, got, want, source)
	}
}

func TestScanMatchesReference(t *testing.T) {
	id := func(n int) string { return fmt.Sprintf("0192f1a0-%04x-7000-8000-%012x", n&0xffff, n) }
	for name, source := range map[string]string{
		"empty":                    "",
		"single line no newline":   "# Note",
		"trailing newline":         "# Note\n",
		"blank lines":              "\n\n\n",
		"crlf":                     "# Note\r\n\r\nBody {#" + id(1) + "}\r\n",
		"anchor":                   "# Note {#" + id(2) + "}\n",
		"anchor with properties":   "# Note {#" + id(3) + " kind=\"task\" done=true}\n",
		"duplicate anchors":        "A {#" + id(4) + "}\nB {#" + id(4) + "}\n",
		"reference":                "See ((" + id(5) + ")) here.\n",
		"reference with label":     "See ((" + id(6) + " \"the label\")) here.\n",
		"reference in inline code": "See `((" + id(7) + "))` here.\n",
		"reference in inline math": "See $((" + id(8) + "))$ here.\n",
		"escaped backtick":         "See \\`((" + id(9) + ")) here.\n",
		"unterminated inline code": "See `((" + id(10) + ")) here.\n",
		"fenced code":              "```\n((" + id(11) + "))\n{#" + id(12) + "}\n```\n\nAfter {#" + id(13) + "}\n",
		"tilde fence":              "~~~\n{#" + id(14) + "}\n~~~\n\nAfter {#" + id(15) + "}\n",
		"indented fence":           "   ```\n{#" + id(16) + "}\n   ```\n",
		"over indented fence":      "    ```\n{#" + id(17) + "}\n",
		"longer closing fence":     "```\nx\n`````\n\nAfter {#" + id(18) + "}\n",
		"shorter closing fence":    "`````\nx\n```\nstill fenced {#" + id(19) + "}\n",
		"unclosed fence":           "```\n{#" + id(20) + "}\n",
		"indented code":            "    code {#" + id(21) + "}\n\nAfter {#" + id(22) + "}\n",
		"tab indented code":        "\tcode {#" + id(23) + "}\n",
		"math fence":               "$$\nx = 1 {#" + id(24) + "}\n$$\n\nAfter {#" + id(25) + "}\n",
		"inline display math":      "$$x$$\n\nAfter {#" + id(26) + "}\n",
		"org note env":             "#+begin note {#" + id(27) + "}\nBody {#" + id(28) + "}\n#+end note\n",
		"org comment env ignored":  "#+begin comment {#" + id(29) + "}\nHidden {#" + id(30) + "}\n#+end comment\n\nAfter {#" + id(31) + "}\n",
		"org env case insensitive": "#+BEGIN COMMENT\nHidden {#" + id(32) + "}\n#+END COMMENT\n\nAfter {#" + id(33) + "}\n",
		"unterminated org comment": "#+begin comment\nHidden {#" + id(34) + "}\n",
		"org marker without plus":  "# heading {#" + id(35) + "}\n",
		"cjk offsets":              "中文段落 {#" + id(36) + "}\n第二行 ((" + id(37) + "))\n",
		"astral plane offsets":     "emoji 🎉 line {#" + id(38) + "}\nnext ((" + id(39) + "))\n",
		"anchor not at line end":   "{#" + id(40) + "} leading anchor\n",
		"brace without anchor":     "text {# not an anchor}\n",
		"uppercase anchor":         "# Note {#0192F1A0-000A-7000-8000-00000000000A}\n",
		"paren without reference":  "text ( ( not a ref )\n",
		"nested org envs":          "#+begin comment\n#+begin note {#" + id(41) + "}\n#+end note\n#+end comment\n\nAfter {#" + id(42) + "}\n",
		// Aimed at the hand-coded trailing-anchor matcher.
		"two openers one anchor":     "text {# not this {#" + id(43) + "}\n",
		"anchor then trailing text":  "text {#" + id(44) + "} trailing\n",
		"trailing spaces after":      "text {#" + id(45) + "}   \n",
		"trailing tab after":         "text {#" + id(46) + "}\t\n",
		"whitespace only properties": "text {#" + id(47) + "   }\n",
		"properties with spaces":     "text {#" + id(48) + " a=1 b=\"two words\"}\n",
		"properties with brace":      "text {#" + id(49) + " a={1}}\n",
		"no space before properties": "text {#" + id(50) + "a=1}\n",
		"anchor missing closing":     "text {#" + id(51) + "\n",
		"id one char short":          "text {#0192f1a0-0000-7000-8000-00000000000}\n",
		"id one char long":           "text {#0192f1a0-0000-7000-8000-0000000000000}\n",
		"id wrong version":           "text {#0192f1a0-0000-6000-8000-000000000000}\n",
		"id wrong variant":           "text {#0192f1a0-0000-7000-c000-000000000000}\n",
		"id bad separator":           "text {#0192f1a0_0000-7000-8000-000000000000}\n",
		"two anchors same line":      "text {#" + id(52) + "} and {#" + id(53) + "}\n",
	} {
		assertScanMatchesReference(t, name, source)
	}
}

func TestScanMatchesReferenceOnGeneratedDocs(t *testing.T) {
	fragments := []string{
		"# Heading {#0192f1a0-0001-7000-8000-000000000001}",
		"## Sub heading",
		"Plain prose paragraph with English words.",
		"中文段落，包含标点。",
		"emoji paragraph 🎉🎉 with astral runes",
		"Body with anchor {#0192f1a0-0002-7000-8000-000000000002}",
		"Body with ref ((0192f1a0-0003-7000-8000-000000000003)) inline",
		"Body with labelled ref ((0192f1a0-0004-7000-8000-000000000004 \"label\"))",
		"Body with `code ((0192f1a0-0005-7000-8000-000000000005))` span",
		"Body with $math {#0192f1a0-0006-7000-8000-000000000006}$ span",
		"- list item {#0192f1a0-0007-7000-8000-000000000007}",
		"> quote {#0192f1a0-0008-7000-8000-000000000008}",
		"```",
		"~~~",
		"`````",
		"    indented code line",
		"\ttab indented line",
		"$$",
		"#+begin note {#0192f1a0-0009-7000-8000-000000000009}",
		"#+end note",
		"#+begin comment",
		"#+end comment",
		"#+begin summary",
		"#+end summary",
		"",
		"   ```",
		"{#0192f1a0-000a-7000-8000-00000000000a}",
		"trailing text {# malformed}",
	}
	random := rand.New(rand.NewSource(20260826))
	for round := 0; round < 300; round++ {
		var b strings.Builder
		for line := 0; line < 1+random.Intn(14); line++ {
			b.WriteString(fragments[random.Intn(len(fragments))])
			if random.Intn(12) != 0 {
				b.WriteString("\n")
			}
		}
		assertScanMatchesReference(t, fmt.Sprintf("generated round %d", round), b.String())
	}
}
