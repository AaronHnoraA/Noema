// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema's portable Pandoc preprocessing is Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

// Package latex owns the deterministic, side-effect-free part of Noema's
// Markdown-to-LaTeX pipeline. Process supervision for Pandoc, TeX, and coding
// agents deliberately remains in the shared Node host.
package latex

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

type Features struct {
	UsesSideComment bool `json:"usesSideComment"`
	UsesTikz        bool `json:"usesTikz"`
}

type PrepareResult struct {
	Meta     map[string]string `json:"meta"`
	Markdown string            `json:"markdown"`
	Warnings []string          `json:"warnings"`
	Features Features          `json:"features"`
}

type markSpec struct {
	Placement string
	Latex     string
}

var latexMarks = map[string]markSpec{
	"newline":     {"between", "\\\\"},
	"nbsp":        {"between", "~"},
	"allowbreak":  {"between", "\\allowbreak{}"},
	"noindent":    {"prefix", "\\noindent"},
	"newpage":     {"block", "\\newpage"},
	"clearpage":   {"block", "\\clearpage"},
	"nopagebreak": {"block", "\\nopagebreak[4]"},
	"keepnext":    {"block", "\\Needspace{4\\baselineskip}"},
	"appendix":    {"block-once", "\\appendix"},
}

var (
	orgOpenPattern        = regexp.MustCompile(`(?i)^#\+\s*begin\s+([A-Za-z0-9_-]+)\s*(.*)$`)
	orgClosePattern       = regexp.MustCompile(`(?i)^#\+\s*end\s+([A-Za-z0-9_-]+)\s*$`)
	metaOpenPattern       = regexp.MustCompile(`(?i)^#\+begin\s+meta\s*$`)
	metaClosePattern      = regexp.MustCompile(`(?i)^#\+end\s+meta\s*$`)
	metaPairPattern       = regexp.MustCompile(`^([A-Za-z0-9_-]+):\s*(.*)$`)
	yamlPairPattern       = regexp.MustCompile(`^([A-Za-z0-9_-]+)\s*:\s*(.*)$`)
	yamlStartPattern      = regexp.MustCompile(`^---\s*$`)
	yamlBoundaryPattern   = regexp.MustCompile(`^(?:---|\.\.\.)\s*$`)
	yamlCommentPattern    = regexp.MustCompile(`\s+#.*$`)
	semanticAtx           = regexp.MustCompile(`^( {0,3})(#{1,6})(?:[ \t]+(.*)|[ \t]*)$`)
	setextUnderline       = regexp.MustCompile(`^ {0,3}(?:=+|-+)[ \t]*$`)
	calloutPattern        = regexp.MustCompile(`^(\s*>\s*)\[!([A-Za-z]+)\](?:\s+(.+))?\s*$`)
	proofTitleWordPattern = regexp.MustCompile(`(?i)^proof\b`)
)

var defaultEnvironment = map[string]string{
	"definition": "definition", "define": "definition", "theorem": "theorem", "lemma": "lemma",
	"proposition": "proposition", "corollary": "corollary", "proof": "proof", "remark": "remark", "example": "example",
}

var defaultRemarkBlocks = map[string]bool{
	"comment": true, "summary": true, "note": true, "important": true, "warning": true, "attention": true, "fold": true,
}

var defaultHiddenBlocks = map[string]bool{"lean4": true, "src": true, "source": true, "meta": true}
var privateNames = map[string]bool{
	"todo": true, "itodo": true, "project": true, "milestone": true, "clock": true,
	"comment": true, "cell": true, "lean4": true, "note-code": true,
}

type orgBlock struct{ Kind, Title string }

func orgOpen(line string) *orgBlock {
	match := orgOpenPattern.FindStringSubmatch(line)
	if match == nil {
		return nil
	}
	return &orgBlock{Kind: strings.ToLower(match[1]), Title: strings.TrimSpace(match[2])}
}

func orgClose(line string) string {
	match := orgClosePattern.FindStringSubmatch(line)
	if match == nil {
		return ""
	}
	return strings.ToLower(match[1])
}

func yamlScalar(value string) string {
	raw := strings.TrimSpace(value)
	if len(raw) >= 2 && raw[0] == '"' && raw[len(raw)-1] == '"' {
		var decoded string
		if json.Unmarshal([]byte(raw), &decoded) == nil {
			return decoded
		}
	}
	if len(raw) >= 2 && raw[0] == '\'' && raw[len(raw)-1] == '\'' {
		return strings.ReplaceAll(raw[1:len(raw)-1], "''", "'")
	}
	if comment := yamlCommentPattern.FindStringIndex(raw); comment != nil {
		raw = raw[:comment[0]]
	}
	return strings.TrimSpace(raw)
}

func parseYAMLFrontMatter(lines []string) (map[string]string, int) {
	meta := map[string]string{}
	if len(lines) == 0 || !yamlStartPattern.MatchString(strings.TrimPrefix(lines[0], "\uFEFF")) {
		return meta, -1
	}
	end := -1
	for i := 1; i < len(lines); i++ {
		if yamlBoundaryPattern.MatchString(lines[i]) {
			end = i
			break
		}
	}
	if end < 0 {
		return meta, -1
	}
	valid := false
	for _, line := range lines[1:end] {
		if yamlPairPattern.MatchString(line) {
			valid = true
			break
		}
	}
	if !valid {
		return meta, -1
	}
	for i := 1; i < end; i++ {
		match := yamlPairPattern.FindStringSubmatch(lines[i])
		if match == nil {
			continue
		}
		key := strings.ToLower(match[1])
		if key != "title" && key != "date" {
			continue
		}
		if match[2] == ">" || match[2] == "|" {
			parts := []string{}
			for i+1 < end && (lines[i+1] == "" || lines[i+1][0] == ' ' || lines[i+1][0] == '\t') {
				i++
				parts = append(parts, strings.TrimSpace(lines[i]))
			}
			separator := "\n"
			if match[2] == ">" {
				separator = " "
			}
			meta[key] = strings.TrimSpace(strings.Join(parts, separator))
		} else {
			meta[key] = yamlScalar(match[2])
		}
	}
	return meta, end
}

func parseMeta(lines []string, initial map[string]string) map[string]string {
	meta := map[string]string{}
	for key, value := range initial {
		meta[key] = value
	}
	active := false
	for _, line := range lines {
		if metaOpenPattern.MatchString(line) {
			active = true
			continue
		}
		if active && metaClosePattern.MatchString(line) {
			break
		}
		if active {
			if match := metaPairPattern.FindStringSubmatch(line); match != nil {
				meta[strings.ToLower(match[1])] = strings.TrimSpace(match[2])
			}
		}
	}
	return meta
}

func ExtractMetadata(markdown string) map[string]string {
	lines := strings.Split(normalizeNewlines(markdown), "\n")
	yaml, _ := parseYAMLFrontMatter(lines)
	return parseMeta(lines, yaml)
}

func normalizeNewlines(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
}

func rawLatexInline(value string) string {
	longest := 0
	for i := 0; i < len(value); {
		if value[i] != '`' {
			i++
			continue
		}
		end := i
		for end < len(value) && value[end] == '`' {
			end++
		}
		if end-i > longest {
			longest = end - i
		}
		i = end
	}
	ticks := strings.Repeat("`", longest+1)
	return ticks + value + ticks + "{=latex}"
}

func rawLatexBlock(value string) string {
	return "\n\n```{=latex}\n" + value + "\n```\n\n"
}

type sourceRange struct{ From, To int }

func protectedInlineRanges(line string) []sourceRange {
	ranges := []sourceRange{}
	trimmed := strings.TrimLeft(line, " ")
	if len(line)-len(trimmed) <= 3 && strings.HasPrefix(trimmed, "[") {
		if close := strings.Index(trimmed, "]:"); close > 0 {
			ranges = append(ranges, sourceRange{0, len(line)})
		}
	}
	for i := 0; i < len(line); {
		if line[i] != '`' {
			i++
			continue
		}
		endTicks := i
		for endTicks < len(line) && line[endTicks] == '`' {
			endTicks++
		}
		ticks := line[i:endTicks]
		if close := strings.Index(line[endTicks:], ticks); close >= 0 {
			to := endTicks + close + len(ticks)
			ranges = append(ranges, sourceRange{i, to})
			i = to
		} else {
			i = endTicks
		}
	}
	for i := 0; i < len(line); i++ {
		if strings.HasPrefix(line[i:], "\\(") {
			if close := strings.Index(line[i+2:], "\\)"); close >= 0 {
				to := i + 2 + close + 2
				ranges = append(ranges, sourceRange{i, to})
				i = to - 1
			}
		} else if line[i] == '$' && !escapedAt(line, i) {
			for close := i + 1; close < len(line); close++ {
				if line[close] == '$' && !escapedAt(line, close) {
					ranges = append(ranges, sourceRange{i, close + 1})
					i = close
					break
				}
			}
		}
	}
	ranges = append(ranges, markdownLinkRanges(line)...)
	for i := 0; i < len(line); i++ {
		if line[i] == '<' {
			if close := strings.IndexByte(line[i+1:], '>'); close >= 0 {
				to := i + close + 2
				ranges = append(ranges, sourceRange{i, to})
				i = to - 1
			}
		}
	}
	return ranges
}

type linkSpan struct {
	LabelFrom       int
	LabelTo         int
	DestinationFrom int
	DestinationTo   int
}

func markdownLinkRanges(source string) []sourceRange {
	spans := markdownLinkSpans(source)
	ranges := make([]sourceRange, 0, len(spans))
	for _, span := range spans {
		ranges = append(ranges, sourceRange{span.DestinationFrom, span.DestinationTo})
	}
	return ranges
}

// markdownLinkSpans is the bracket-matched link scanner shared by the
// protected-range reader and the link-label rewriter. It reports the label and
// destination span of every [label](destination) / ![label](destination).
func markdownLinkSpans(source string) []linkSpan {
	spans := []linkSpan{}
	for start := 0; start < len(source); start++ {
		image := source[start] == '!' && start+1 < len(source) && source[start+1] == '['
		if !image && source[start] != '[' {
			continue
		}
		bracketStart := start
		if image {
			bracketStart++
		}
		depth, cursor, escaped := 1, bracketStart+1, false
		for ; cursor < len(source) && depth > 0; cursor++ {
			ch := source[cursor]
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
			} else if ch == '[' {
				depth++
			} else if ch == ']' {
				depth--
			}
		}
		if depth != 0 || cursor >= len(source) || source[cursor] != '(' {
			continue
		}
		destinationFrom := cursor
		depth, cursor, escaped = 1, cursor+1, false
		for ; cursor < len(source) && depth > 0; cursor++ {
			ch := source[cursor]
			if escaped {
				escaped = false
				continue
			}
			if ch == '\\' {
				escaped = true
			} else if ch == '(' {
				depth++
			} else if ch == ')' {
				depth--
			}
		}
		if depth == 0 {
			spans = append(spans, linkSpan{
				LabelFrom:       bracketStart + 1,
				LabelTo:         destinationFrom - 1,
				DestinationFrom: destinationFrom,
				DestinationTo:   cursor,
			})
			start = cursor - 1
		}
	}
	return spans
}

func rangeContains(ranges []sourceRange, at int) bool {
	for _, item := range ranges {
		if at >= item.From && at < item.To {
			return true
		}
	}
	return false
}

func stripPrivateCommandsFromLinkLabels(line string) string {
	spans := markdownLinkSpans(line)
	if len(spans) == 0 {
		return line
	}
	// One label at a time, right to left so earlier offsets stay valid. Scanning
	// for the first "](" mis-scoped a label that itself contains a bracketed
	// link, and the JavaScript side used to span two links at once.
	result := line
	for i := len(spans) - 1; i >= 0; i-- {
		span := spans[i]
		label := result[span.LabelFrom:span.LabelTo]
		stripped := label
		commands := scanInlineCommands(label)
		for c := len(commands) - 1; c >= 0; c-- {
			command := commands[c]
			if privateNames[command.Name] && !displayComment(command) {
				stripped = stripped[:command.FullFrom] + stripped[command.FullTo:]
			}
		}
		if stripped == label {
			continue
		}
		result = result[:span.LabelFrom] + stripped + result[span.LabelTo:]
	}
	return result
}

func visibleCommands(line string, predicate func(inlineCommand) bool) []inlineCommand {
	ranges := protectedInlineRanges(line)
	out := []inlineCommand{}
	for _, command := range scanInlineCommands(line) {
		if !rangeContains(ranges, command.FullFrom) && predicate(command) {
			out = append(out, command)
		}
	}
	return out
}

func visibleLatexMarks(line string) []inlineCommand {
	return visibleCommands(line, func(command inlineCommand) bool { return command.Name == "latexmk" })
}

func withoutVisibleLatexMarks(line string) string {
	commands := visibleLatexMarks(line)
	for i := len(commands) - 1; i >= 0; i-- {
		line = line[:commands[i].FullFrom] + line[commands[i].FullTo:]
	}
	return line
}

// exportedAnnotations are review marks that reach the exported document.
// Planning bookkeeping (project, milestone, clock) and machine blocks stay private.
var exportedAnnotations = map[string]bool{"todo": true, "itodo": true}

var (
	headingLineRe  = regexp.MustCompile(`^ {0,3}#{1,6}([ \t]|$)`)
	tableRowLineRe = regexp.MustCompile(`^ {0,3}\|`)
)

// \todo from todonotes cannot live in a moving argument or a tabular cell.
// Annotations on those lines degrade to an inline form so the document still
// compiles instead of failing the whole export.
func marginNoteSafeLine(content string) bool {
	return !headingLineRe.MatchString(content) && !tableRowLineRe.MatchString(content)
}

func annotationsEnabled(options Options) bool { return !options.DisableAnnotations }

func visiblePrivateCommands(line string) []inlineCommand {
	return visibleCommands(line, func(command inlineCommand) bool { return privateNames[command.Name] && !displayComment(command) })
}

func privateCommandLine(line string, options Options) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(strings.ToLower(trimmed), "@@") {
		return false
	}
	commands := scanInlineCommands(trimmed)
	if len(commands) == 0 {
		return false
	}
	if annotationsEnabled(options) && exportedAnnotations[commands[0].Name] {
		return false
	}
	return privateNames[commands[0].Name] && !displayComment(commands[0]) && commands[0].FullFrom == 0
}

type markContext struct {
	AtParagraphStart bool
	NextLineVisible  bool
	MarginSafe       bool
}

func validateLatexMark(command inlineCommand, line string, context markContext) (string, markSpec, error) {
	key := strings.ToLower(strings.TrimSpace(command.SwitchValue))
	spec, ok := latexMarks[key]
	if !ok {
		if key == "" {
			key = "(empty)"
		}
		return key, spec, fmt.Errorf("Unknown @@latexmk mark: %s", key)
	}
	only := strings.TrimSpace(line) == line[command.FullFrom:command.FullTo]
	if (spec.Placement == "block" || spec.Placement == "block-once") && !only {
		return key, spec, fmt.Errorf("@@latexmk(%s) must be alone on its line", key)
	}
	if spec.Placement == "prefix" && (strings.TrimSpace(line[:command.FullFrom]) != "" || !context.AtParagraphStart) {
		return key, spec, fmt.Errorf("@@latexmk(%s) must appear at the start of a paragraph", key)
	}
	if spec.Placement == "between" {
		for _, other := range visibleLatexMarks(line) {
			if other.FullFrom == command.FullFrom {
				continue
			}
			adjacent := other.FullTo <= command.FullFrom && strings.TrimSpace(line[other.FullTo:command.FullFrom]) == "" ||
				other.FullFrom >= command.FullTo && strings.TrimSpace(line[command.FullTo:other.FullFrom]) == ""
			if adjacent {
				return key, spec, fmt.Errorf("@@latexmk(%s) must sit between visible inline content", key)
			}
		}
		before := strings.TrimSpace(withoutVisibleLatexMarks(line[:command.FullFrom]))
		after := strings.TrimSpace(withoutVisibleLatexMarks(line[command.FullTo:]))
		if before == "" || after == "" && !context.NextLineVisible {
			return key, spec, fmt.Errorf("@@latexmk(%s) must sit between visible inline content", key)
		}
	}
	return key, spec, nil
}

func transformInlineCommands(line string, options Options, context markContext, unresolved *[]string) (string, error) {
	line = stripPrivateCommandsFromLinkLabels(line)
	annotations := annotationsEnabled(options)
	margin := context.MarginSafe
	options.InlineOnly = !margin
	commands := visibleCommands(line, func(command inlineCommand) bool {
		return privateNames[command.Name] || command.Name == "scomment" || command.Name == "revision" || command.Name == "cite" || command.Name == "tag" || command.Name == "latexmk"
	})
	if len(commands) == 0 {
		return line, nil
	}
	var output strings.Builder
	cursor := 0
	for _, command := range commands {
		if command.FullFrom < cursor {
			continue
		}
		output.WriteString(line[cursor:command.FullFrom])
		if !annotations && (exportedAnnotations[command.Name] || command.Name == "scomment" ||
			command.Name == "revision" || command.Name == "comment") {
			// `annotations: none` in the note metadata strips every review mark.
			cursor = command.FullTo
			continue
		}
		switch command.Name {
		case "todo", "itodo":
			if title := convertInline(command.Context, options, true); title != "" {
				macro := "\\aarontodo"
				if !margin {
					macro = "\\aarontodoinline"
				}
				output.WriteString(rawLatexInline(macro + "{" + title + "}"))
			}
		case "scomment":
			macro := "\\sidecomment"
			if !margin {
				macro = "\\sidecommentinline"
			}
			output.WriteString(rawLatexInline(macro + "{" + convertInline(command.Context, options, true) + "}"))
		case "revision":
			output.WriteString(rawLatexInline(revisionLatex(command, options)))
		case "comment":
			output.WriteString(rawLatexInline("\\aaroncomment{" + convertInline(command.Context, options, true) + "}"))
		case "cite":
			citation := citeLatex(command, options)
			if citation == "" {
				namespace := strings.TrimSpace(command.SwitchValue)
				key := strings.TrimSpace(command.Context)
				if key == "" {
					key = "?"
				}
				visible := key
				if namespace != "" {
					visible = namespace + ":" + key
				}
				*unresolved = append(*unresolved, visible)
				output.WriteString(rawLatexInline("\\textnormal{[" + escapeLatexTitle(visible, options) + "]}"))
			} else {
				output.WriteString(rawLatexInline(citation))
			}
		case "tag":
			anchor := regexp.MustCompile(`[^A-Za-z0-9:_.-]+`).ReplaceAllString(strings.TrimSpace(command.Context), "-")
			if anchor != "" {
				output.WriteString(rawLatexInline("\\hypertarget{" + anchor + "}{}"))
			}
		case "latexmk":
			_, spec, err := validateLatexMark(command, line, context)
			if err != nil {
				return "", err
			}
			output.WriteString(rawLatexInline(spec.Latex))
		}
		cursor = command.FullTo
	}
	output.WriteString(line[cursor:])
	return output.String(), nil
}

type containerLine struct {
	Content    string
	Prefix     string
	QuoteDepth int
}

func markdownContainerLine(line string) containerLine {
	content := line
	depth := 0
	for {
		spaces := 0
		for spaces < len(content) && spaces < 3 && content[spaces] == ' ' {
			spaces++
		}
		if spaces >= len(content) || content[spaces] != '>' {
			break
		}
		consumed := spaces + 1
		if consumed < len(content) && (content[consumed] == ' ' || content[consumed] == '\t') {
			consumed++
		}
		content = content[consumed:]
		depth++
	}
	return containerLine{Content: content, Prefix: line[:len(line)-len(content)], QuoteDepth: depth}
}

type braceState struct {
	Depth int
	Quote byte
}

func scanPrivateBraces(text string, initial braceState) (braceState, int) {
	state := initial
	escaped := false
	for i := 0; i < len(text); i++ {
		ch := text[i]
		if escaped {
			escaped = false
			continue
		}
		if ch == '\\' {
			escaped = true
			continue
		}
		if state.Quote != 0 {
			if ch == state.Quote {
				state.Quote = 0
			}
			continue
		}
		if ch == '\'' || ch == '"' {
			state.Quote = ch
		} else if ch == '{' {
			state.Depth++
		} else if ch == '}' && state.Depth > 0 {
			state.Depth--
			if state.Depth == 0 {
				state.Quote = 0
				return state, i
			}
		}
	}
	return state, -1
}

func multilinePrivateStart(line string) (*inlineCommand, *braceState) {
	for _, command := range visiblePrivateCommands(line) {
		remainder := line[command.FullTo:]
		trimmed := strings.TrimLeft(remainder, " \t")
		if !strings.HasPrefix(trimmed, "{") {
			continue
		}
		state, _ := scanPrivateBraces(remainder, braceState{})
		if state.Depth > 0 {
			copy := command
			return &copy, &state
		}
	}
	return nil, nil
}

func continuePrivatePlanning(line string, state braceState) (bool, braceState, string) {
	container := markdownContainerLine(line)
	next, closeAt := scanPrivateBraces(container.Content, state)
	if closeAt < 0 {
		return false, next, ""
	}
	indentEnd := 0
	for indentEnd < closeAt && (container.Content[indentEnd] == ' ' || container.Content[indentEnd] == '\t') {
		indentEnd++
	}
	return true, braceState{}, container.Prefix + container.Content[:indentEnd] + container.Content[closeAt+1:]
}

func semanticMarkdownLevel(command inlineCommand) int {
	if command.Name == "part" {
		return 1
	}
	if command.Name != "section" {
		return 0
	}
	switch strings.ToLower(strings.TrimSpace(command.SwitchValue)) {
	case "", "sec", "section":
		return 2
	case "sub":
		return 3
	case "subsub":
		return 4
	case "subsubsub":
		return 5
	default:
		return 0
	}
}

func semanticCommandOnLine(line string) *inlineCommand {
	for _, command := range scanInlineCommands(line) {
		if (command.Name == "section" || command.Name == "part") && strings.TrimSpace(line[:command.FullFrom]) == "" && strings.TrimSpace(line[command.FullTo:]) == "" && semanticMarkdownLevel(command) > 0 {
			copy := command
			return &copy
		}
	}
	return nil
}

type fenceState struct {
	Char       byte
	Length     int
	QuoteDepth int
	Prefix     string
}

func fenceRun(content string, closeOnly bool) (byte, int, bool) {
	i := 0
	for i < len(content) && i < 3 && content[i] == ' ' {
		i++
	}
	if i >= len(content) || content[i] != '`' && content[i] != '~' {
		return 0, 0, false
	}
	ch := content[i]
	end := i
	for end < len(content) && content[end] == ch {
		end++
	}
	if end-i < 3 || closeOnly && strings.TrimSpace(content[end:]) != "" {
		return 0, 0, false
	}
	return ch, end - i, true
}

func displayMathBoundary(content string, open bool) bool {
	trimmed := strings.TrimSpace(content)
	if open {
		return trimmed == "\\[" || trimmed == "$$"
	}
	return trimmed == "\\]" || trimmed == "$$"
}

func containsSemanticOutline(lines []string, frontMatterEnd int, hiddenKinds map[string]bool, options Options) bool {
	var fence *fenceState
	displayMathDepth := -1
	hidden := ""
	hiddenDepth := 0
	var private *braceState
	for i := frontMatterEnd + 1; i < len(lines); i++ {
		line := lines[i]
		container := markdownContainerLine(line)
		if private != nil {
			closed, state, suffix := continuePrivatePlanning(line, *private)
			if !closed {
				private = &state
				continue
			}
			private = nil
			line = suffix
			container = markdownContainerLine(line)
			if strings.TrimSpace(container.Content) == "" {
				continue
			}
		}
		if hidden != "" {
			if begin := orgOpen(line); begin != nil && begin.Kind == hidden {
				hiddenDepth++
			}
			if orgClose(line) == hidden {
				hiddenDepth--
				if hiddenDepth == 0 {
					hidden = ""
				}
			}
			continue
		}
		if fence != nil && container.QuoteDepth != fence.QuoteDepth {
			fence = nil
		}
		if fence != nil {
			if ch, length, ok := fenceRun(container.Content, true); ok && ch == fence.Char && length >= fence.Length {
				fence = nil
			}
			continue
		}
		if ch, length, ok := fenceRun(container.Content, false); ok {
			fence = &fenceState{Char: ch, Length: length, QuoteDepth: container.QuoteDepth}
			continue
		}
		if displayMathDepth >= 0 && container.QuoteDepth != displayMathDepth {
			displayMathDepth = -1
		}
		if displayMathDepth >= 0 {
			if container.QuoteDepth == displayMathDepth && displayMathBoundary(container.Content, false) {
				displayMathDepth = -1
			}
			continue
		}
		if displayMathBoundary(container.Content, true) {
			displayMathDepth = container.QuoteDepth
			continue
		}
		if strings.HasPrefix(container.Content, "    ") || strings.HasPrefix(container.Content, "\t") {
			continue
		}
		if begin := orgOpen(line); begin != nil && hiddenKinds[begin.Kind] {
			hidden, hiddenDepth = begin.Kind, 1
			continue
		}
		if _, state := multilinePrivateStart(line); state != nil {
			private = state
			continue
		}
		if privateCommandLine(line, options) {
			continue
		}
		if semanticCommandOnLine(line) != nil {
			return true
		}
	}
	return false
}

func canonicalMathForPandoc(line string) string {
	var out strings.Builder
	for cursor := 0; cursor < len(line); {
		if line[cursor] == '`' {
			endTicks := cursor
			for endTicks < len(line) && line[endTicks] == '`' {
				endTicks++
			}
			ticks := line[cursor:endTicks]
			close := strings.Index(line[endTicks:], ticks)
			end := len(line)
			if close >= 0 {
				end = endTicks + close + len(ticks)
			}
			out.WriteString(line[cursor:end])
			cursor = end
			continue
		}
		if strings.HasPrefix(line[cursor:], "\\(") {
			if close := strings.Index(line[cursor+2:], "\\)"); close >= 0 {
				end := cursor + 2 + close + 2
				out.WriteString(rawLatexInline(line[cursor:end]))
				cursor = end
				continue
			}
		}
		out.WriteByte(line[cursor])
		cursor++
	}
	return out.String()
}

func subparagraphLatex(rawTitle string, options Options) string {
	title := strings.TrimSpace(regexp.MustCompile(`[ \t]+#+[ \t]*$`).ReplaceAllString(rawTitle, ""))
	id := ""
	if match := regexp.MustCompile(`[ \t]+\{#([^}]+)\}[ \t]*$`).FindStringSubmatchIndex(title); match != nil {
		id = regexp.MustCompile(`[^A-Za-z0-9:_.-]+`).ReplaceAllString(title[match[2]:match[3]], "-")
		title = strings.TrimSpace(title[:match[0]])
	}
	result := "\\subparagraph{" + convertInline(title, options, true) + "}"
	if id != "" {
		result += "\\label{" + id + "}"
	}
	return result
}

func environmentOpen(kind, title string, options Options) (string, string) {
	env := strings.TrimSpace(options.Rules.EnvMap[kind])
	if env == "" {
		env = defaultEnvironment[kind]
	}
	heading := title
	isRemark := defaultRemarkBlocks[kind]
	for _, extra := range options.Rules.CommentBlocks {
		if strings.EqualFold(strings.TrimSpace(extra), kind) {
			isRemark = true
		}
	}
	if env == "" && isRemark {
		env = "remark"
		if kind != "fold" && heading == "" {
			heading = kind
		}
	}
	if env == "" {
		label := kind
		if title != "" {
			label += ": " + title
		}
		return "\\begin{quote}\n\\textbf{" + escapeLatexTitle(label, options) + "}\\par", "quote"
	}
	label := ""
	if heading != "" {
		label = escapeLatexTitle(heading, options)
	}
	if kind == "proof" && label != "" && !proofTitleWordPattern.MatchString(strings.TrimSpace(heading)) {
		direction := label
		if strings.TrimSpace(heading) == "=>" {
			direction = "\\(\\Rightarrow\\)"
		} else if strings.TrimSpace(heading) == "<=" {
			direction = "\\(\\Leftarrow\\)"
		}
		label = "Proof (" + direction + ")"
	}
	opened := "\\begin{" + env + "}"
	if label != "" {
		opened += "[" + label + "]"
	}
	return opened, env
}

func Prepare(markdown string, options Options) (PrepareResult, error) {
	source := normalizeNewlines(markdown)
	lines := strings.Split(source, "\n")
	yaml, frontMatterEnd := parseYAMLFrontMatter(lines)
	meta := parseMeta(lines, yaml)
	hiddenKinds := map[string]bool{}
	for kind := range defaultHiddenBlocks {
		hiddenKinds[kind] = true
	}
	for _, kind := range options.Rules.HiddenBlocks {
		hiddenKinds[strings.ToLower(strings.TrimSpace(kind))] = true
	}
	// `annotations: none` restores the pre-annotation behaviour: every todo,
	// comment, side comment, and revision is dropped. An explicit request flag
	// wins, so a scope export can assert it from the whole document's metadata.
	options.DisableAnnotations = options.DisableAnnotations ||
		strings.EqualFold(strings.TrimSpace(meta["annotations"]), "none")
	hasSemanticOutline := containsSemanticOutline(lines, frontMatterEnd, hiddenKinds, options)
	output := []string{}
	type openedBlock struct{ Kind, Env string }
	stack := []openedBlock{}
	hidden := ""
	hiddenDepth := 0
	var fence *fenceState
	displayMathDepth := -1
	displayMathPrefix := ""
	rawTikz := false
	var private *braceState
	htmlComment := false
	singletons := map[string]bool{}
	unresolved := []string{}

	for index := 0; index < len(lines); index++ {
		line := lines[index]
		lineNumber := index + 1
		atParagraphStart := index == 0 || strings.TrimSpace(lines[index-1]) == ""
		context := markContext{
			AtParagraphStart: atParagraphStart,
			NextLineVisible:  index+1 < len(lines) && strings.TrimSpace(lines[index+1]) != "",
			MarginSafe:       marginNoteSafeLine(markdownContainerLine(line).Content),
		}
		container := markdownContainerLine(line)
		if index <= frontMatterEnd {
			continue
		}
		if private != nil {
			closed, state, suffix := continuePrivatePlanning(line, *private)
			if !closed {
				private = &state
				continue
			}
			private = nil
			line = suffix
			container = markdownContainerLine(line)
			if strings.TrimSpace(container.Content) == "" {
				continue
			}
		}
		if hidden != "" {
			if begin := orgOpen(line); begin != nil && begin.Kind == hidden {
				hiddenDepth++
			}
			if orgClose(line) == hidden {
				hiddenDepth--
				if hiddenDepth == 0 {
					hidden = ""
				}
			}
			continue
		}
		if rawTikz {
			if orgClose(line) == "tikz" {
				output = append(output, "\\end{tikzpicture}", "\\end{center}", "```", "")
				rawTikz = false
			} else {
				output = append(output, line)
			}
			continue
		}
		if fence != nil && container.QuoteDepth != fence.QuoteDepth {
			output = append(output, fence.Prefix+strings.Repeat(string(fence.Char), fence.Length))
			fence = nil
		}
		if fence != nil {
			if ch, length, ok := fenceRun(container.Content, true); ok && ch == fence.Char && length >= fence.Length {
				fence = nil
			}
			output = append(output, line)
			continue
		}
		if ch, length, ok := fenceRun(container.Content, false); ok {
			fence = &fenceState{Char: ch, Length: length, QuoteDepth: container.QuoteDepth, Prefix: container.Prefix}
			output = append(output, line)
			continue
		}
		if displayMathDepth >= 0 && container.QuoteDepth != displayMathDepth {
			output = append(output, displayMathPrefix+"$$")
			displayMathDepth = -1
		}
		if displayMathDepth < 0 && displayMathBoundary(container.Content, true) {
			displayMathDepth, displayMathPrefix = container.QuoteDepth, container.Prefix
			output = append(output, container.Prefix+"$$")
			continue
		}
		if displayMathDepth >= 0 && container.QuoteDepth == displayMathDepth && displayMathBoundary(container.Content, false) {
			displayMathDepth = -1
			output = append(output, container.Prefix+"$$")
			continue
		}
		if displayMathDepth >= 0 {
			output = append(output, line)
			continue
		}
		if strings.HasPrefix(container.Content, "    ") || strings.HasPrefix(container.Content, "\t") {
			output = append(output, line)
			continue
		}
		if htmlComment {
			if closeAt := strings.Index(line, "-->"); closeAt < 0 {
				output = append(output, line)
			} else {
				htmlComment = false
				comment := line[:closeAt+3]
				suffix, err := transformInlineCommands(line[closeAt+3:], options, context, &unresolved)
				if err != nil {
					return PrepareResult{}, err
				}
				output = append(output, comment+canonicalMathForPandoc(suffix))
			}
			continue
		}
		if openAt := strings.Index(line, "<!--"); openAt >= 0 && strings.Index(line[openAt+4:], "-->") < 0 {
			prefix, err := transformInlineCommands(line[:openAt], options, context, &unresolved)
			if err != nil {
				return PrepareResult{}, err
			}
			output = append(output, canonicalMathForPandoc(prefix)+line[openAt:])
			htmlComment = true
			continue
		}
		trimmed := strings.TrimSpace(line)
		if strings.EqualFold(trimmed, "[toc]") {
			continue
		}
		if command, state := multilinePrivateStart(line); state != nil {
			private = state
			visiblePrefix, err := transformInlineCommands(
				line[:command.FullTo], options,
				markContext{AtParagraphStart: atParagraphStart, MarginSafe: context.MarginSafe},
				&unresolved,
			)
			if err != nil {
				return PrepareResult{}, err
			}
			if strings.TrimSpace(markdownContainerLine(visiblePrefix).Content) != "" {
				output = append(output, canonicalMathForPandoc(visiblePrefix))
			}
			continue
		}
		if privateCommandLine(line, options) {
			continue
		}
		if semantic := semanticCommandOnLine(line); semantic != nil {
			level := semanticMarkdownLevel(*semantic)
			id := regexp.MustCompile(`[^A-Za-z0-9:_.-]+`).ReplaceAllString(strings.TrimSpace(semantic.Args["id"]), "-")
			mapped := strings.Repeat("#", level) + " " + strings.TrimSpace(semantic.Context)
			if id != "" {
				mapped += " {#" + id + "}"
			}
			output = append(output, mapped)
			continue
		}
		if hasSemanticOutline {
			if atx := semanticAtx.FindStringSubmatch(line); atx != nil {
				output = append(output, rawLatexBlock(subparagraphLatex(atx[3], options)))
				continue
			}
			if setextUnderline.MatchString(line) && index > 0 && strings.TrimSpace(lines[index-1]) != "" && outputLenVisibleHeadingCandidate(lines[index-1]) && len(output) > 0 {
				output = output[:len(output)-1]
				output = append(output, rawLatexBlock(subparagraphLatex(lines[index-1], options)))
				continue
			}
		}
		if begin := orgOpen(line); begin != nil {
			if hiddenKinds[begin.Kind] {
				hidden, hiddenDepth = begin.Kind, 1
				continue
			}
			if begin.Kind == "tikz" {
				output = append(output, "", "```{=latex}", "\\begin{center}", "\\begin{tikzpicture}")
				rawTikz = true
				continue
			}
			opened, env := environmentOpen(begin.Kind, begin.Title, options)
			stack = append(stack, openedBlock{begin.Kind, env})
			output = append(output, rawLatexBlock(opened))
			continue
		}
		if close := orgClose(line); close != "" {
			if len(stack) == 0 || stack[len(stack)-1].Kind != close {
				return PrepareResult{}, fmt.Errorf("Mismatched Noema block on line %d", lineNumber)
			}
			opened := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			output = append(output, rawLatexBlock("\\end{"+opened.Env+"}"))
			continue
		}
		for _, command := range visibleLatexMarks(line) {
			key, spec, err := validateLatexMark(command, line, context)
			if err != nil {
				return PrepareResult{}, err
			}
			if spec.Placement == "block-once" && singletons[key] {
				return PrepareResult{}, fmt.Errorf("@@latexmk(%s) may appear only once", key)
			}
			if spec.Placement == "block-once" {
				singletons[key] = true
			}
		}
		if callout := calloutPattern.FindStringSubmatch(line); callout != nil {
			label := callout[2]
			if callout[3] != "" {
				label = callout[3]
			}
			output = append(output, callout[1]+"**"+strings.TrimSpace(label)+"**")
			continue
		}
		transformed, err := transformInlineCommands(line, options, context, &unresolved)
		if err != nil {
			return PrepareResult{}, err
		}
		output = append(output, canonicalMathForPandoc(transformed))
	}
	if fence != nil {
		output = append(output, fence.Prefix+strings.Repeat(string(fence.Char), fence.Length))
	}
	if displayMathDepth >= 0 {
		return PrepareResult{}, errors.New("Unclosed display math")
	}
	if hidden != "" {
		return PrepareResult{}, fmt.Errorf("Unclosed hidden Noema block: %s", hidden)
	}
	if private != nil {
		return PrepareResult{}, errors.New("Unclosed Noema planning block")
	}
	if htmlComment {
		return PrepareResult{}, errors.New("Unclosed HTML comment")
	}
	if rawTikz {
		return PrepareResult{}, errors.New("Unclosed Noema block: tikz")
	}
	if len(stack) > 0 {
		return PrepareResult{}, fmt.Errorf("Unclosed Noema block: %s", stack[len(stack)-1].Kind)
	}
	warnings := []string{}
	seen := map[string]bool{}
	for _, key := range unresolved {
		if !seen[key] {
			seen[key] = true
			warnings = append(warnings, "Unresolved Noema citation kept visibly: "+key)
		}
	}
	joined := strings.Join(output, "\n")
	return PrepareResult{
		Meta: meta, Markdown: joined, Warnings: warnings,
		Features: Features{UsesSideComment: strings.Contains(joined, "\\sidecomment{"), UsesTikz: strings.Contains(joined, "tikzpicture")},
	}, nil
}

func outputLenVisibleHeadingCandidate(line string) bool {
	trimmed := strings.TrimSpace(line)
	if trimmed == "" {
		return false
	}
	for _, prefix := range []string{"#", ">", "- ", "+ ", "* ", "@@", "#+"} {
		if strings.HasPrefix(trimmed, prefix) {
			return false
		}
	}
	if len(trimmed) > 2 && trimmed[0] >= '0' && trimmed[0] <= '9' {
		if at := strings.IndexAny(trimmed, ".)"); at > 0 && at+1 < len(trimmed) && trimmed[at+1] == ' ' {
			return false
		}
	}
	return true
}

// PostprocessPandocLatex normalizes Pandoc's prose whitespace while preserving
// every byte inside code-like LaTeX environments.
func PostprocessPandocLatex(value string) string {
	environments := []string{"verbatim", "verbatim*", "Verbatim", "BVerbatim", "LVerbatim", "SaveVerbatim", "lstlisting", "minted", "Highlighting"}
	blocks := []string{}
	protected := value
	for {
		bestAt, bestEnv := -1, ""
		for _, env := range environments {
			at := strings.Index(protected, "\\begin{"+env+"}")
			if at >= 0 && (bestAt < 0 || at < bestAt) {
				bestAt, bestEnv = at, env
			}
		}
		if bestAt < 0 {
			break
		}
		endMarker := "\\end{" + bestEnv + "}"
		relEnd := strings.Index(protected[bestAt:], endMarker)
		if relEnd < 0 {
			break
		}
		end := bestAt + relEnd + len(endMarker)
		token := "\uE100AARONNOTECODEBLOCK" + strconv.Itoa(len(blocks)) + "\uE101"
		blocks = append(blocks, protected[bestAt:end])
		protected = protected[:bestAt] + token + protected[end:]
	}
	protected = regexp.MustCompile(`\n{3,}`).ReplaceAllString(protected, "\n\n")
	lines := strings.Split(protected, "\n")
	for i := range lines {
		lines[i] = strings.TrimRight(lines[i], " \t")
	}
	normalized := strings.TrimSpace(strings.Join(lines, "\n")) + "\n"
	for index, block := range blocks {
		token := "\uE100AARONNOTECODEBLOCK" + strconv.Itoa(index) + "\uE101"
		normalized = strings.ReplaceAll(normalized, token, block)
	}
	return normalized
}
