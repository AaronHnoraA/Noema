// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema's portable LaTeX inline conversion is Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package latex

import (
	"regexp"
	"strings"
)

type Options struct {
	Rules          Rules             `json:"rules,omitempty"`
	CitationKeyMap map[string]string `json:"citationKeyMap,omitempty"`
}

type Rules struct {
	EnvMap           map[string]string `json:"envMap,omitempty"`
	CommentBlocks    []string          `json:"commentBlocks,omitempty"`
	HiddenBlocks     []string          `json:"hiddenBlocks,omitempty"`
	PandocExtensions []string          `json:"pandocExtensions,omitempty"`
}

func escapeLatexText(value string) string {
	value = strings.ReplaceAll(value, "\\", "\\textbackslash{}")
	replacer := strings.NewReplacer(
		"#", "\\#", "$", "\\$", "%", "\\%", "&", "\\&", "_", "\\_", "{", "\\{", "}", "\\}",
		"^", "\\textasciicircum{}", "~", "\\textasciitilde{}",
	)
	return replacer.Replace(value)
}

func escapeLatexURL(value string) string {
	value = strings.ReplaceAll(strings.TrimSpace(value), "\\", "/")
	return strings.NewReplacer("%", "\\%", "#", "\\#", "{", "\\{", "}", "\\}").Replace(value)
}

func uniqueCommandKeys(value string) []string {
	seen := map[string]bool{}
	keys := []string{}
	for _, part := range strings.Split(value, ";") {
		key := strings.TrimSpace(part)
		if key == "" {
			return nil
		}
		if !seen[key] {
			seen[key] = true
			keys = append(keys, key)
		}
	}
	return keys
}

func citeLatex(command inlineCommand, options Options) string {
	namespace := strings.TrimSpace(command.SwitchValue)
	sourceKeys := uniqueCommandKeys(command.Context)
	if namespace == "" || len(sourceKeys) == 0 {
		return ""
	}
	keys := make([]string, 0, len(sourceKeys))
	seen := map[string]bool{}
	for _, sourceKey := range sourceKeys {
		key := options.CitationKeyMap[namespace+"\x00"+sourceKey]
		if key == "" || seen[key] {
			return ""
		}
		seen[key] = true
		keys = append(keys, key)
	}
	locator := strings.TrimSpace(firstNonEmpty(command.Args["locator"], command.Args["page"], command.Args["pages"]))
	optional := ""
	if locator != "" {
		escaped := escapeLatexText(locator)
		if strings.Contains(locator, "]") {
			escaped = "{" + escaped + "}"
		}
		optional = "[" + escaped + "]"
	}
	citation := "\\cite" + optional + "{" + strings.Join(keys, ",") + "}"
	if prefix := strings.TrimSpace(command.Args["prefix"]); prefix != "" {
		gap := " "
		if strings.ContainsRune("([{«“‘", lastRune(prefix)) {
			gap = ""
		}
		citation = escapeLatexText(prefix) + gap + citation
	}
	if suffix := strings.TrimSpace(command.Args["suffix"]); suffix != "" {
		gap := " "
		if strings.ContainsRune(",.;:!?)}]»”’", firstRune(suffix)) {
			gap = ""
		}
		citation += gap + escapeLatexText(suffix)
	}
	return citation
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func firstRune(value string) rune {
	for _, r := range value {
		return r
	}
	return 0
}

func lastRune(value string) rune {
	var last rune
	for _, r := range value {
		last = r
	}
	return last
}

func displayComment(command inlineCommand) bool {
	return command.Name == "comment" && strings.EqualFold(strings.TrimSpace(command.SwitchValue), "true")
}

func revisionLatex(command inlineCommand, options Options) string {
	original := strings.ReplaceAll(strings.ReplaceAll(command.Context, "\\]", "]"), "\\\\", "\\")
	advice := strings.ReplaceAll(command.Args["advice"], "\\\\", "\\")
	reason := strings.ReplaceAll(command.Args["reason"], "\\\\", "\\")
	return "\\aaronrevision{" + convertInline(original, options, true) + "}{" + convertInline(advice, options, true) + "}{" + convertInline(reason, options, true) + "}"
}

func commandAllowedForInline(name string) bool {
	switch name {
	case "todo", "comment", "scomment", "revision", "cite", "latexmk":
		return true
	default:
		return false
	}
}

func findSimpleClose(source string, from int, close string) int {
	if at := strings.Index(source[from:], close); at >= 0 {
		return from + at
	}
	return -1
}

func inlineTokenAt(source string, pos int, options Options) (length int, rendered string, ok bool) {
	rest := source[pos:]
	if strings.HasPrefix(rest, "\\(") {
		if close := findSimpleClose(source, pos+2, "\\)"); close >= 0 && !strings.ContainsAny(source[pos+2:close], "\r\n") {
			return close + 2 - pos, source[pos : close+2], true
		}
	}
	if strings.HasPrefix(rest, "`") {
		if close := strings.IndexByte(rest[1:], '`'); close >= 0 && !strings.ContainsAny(rest[1:close+1], "\r\n") {
			body := rest[1 : close+1]
			return close + 2, "\\texttt{" + escapeLatexText(body) + "}", true
		}
	}
	image := strings.HasPrefix(rest, "![")
	if image || strings.HasPrefix(rest, "[") {
		labelFrom := 1
		if image {
			labelFrom = 2
		}
		if labelEnd := strings.IndexByte(rest[labelFrom:], ']'); labelEnd >= 0 {
			labelEnd += labelFrom
			if labelEnd+1 < len(rest) && rest[labelEnd+1] == '(' {
				if destEnd := strings.IndexByte(rest[labelEnd+2:], ')'); destEnd >= 0 {
					destEnd += labelEnd + 2
					label := rest[labelFrom:labelEnd]
					if image && label == "" {
						label = "image"
					}
					return destEnd + 1, "\\href{" + escapeLatexURL(rest[labelEnd+2:destEnd]) + "}{" + convertInline(label, options, false) + "}", true
				}
			}
		}
	}
	for _, token := range []struct {
		open, close, command string
	}{
		{"**", "**", "textbf"}, {"__", "__", "textbf"}, {"*", "*", "emph"}, {"_", "_", "emph"},
	} {
		if !strings.HasPrefix(rest, token.open) {
			continue
		}
		if close := strings.Index(rest[len(token.open):], token.close); close >= 0 {
			close += len(token.open)
			body := rest[len(token.open):close]
			if body != "" && !strings.ContainsAny(body, "\r\n") {
				length := close + len(token.close)
				return length, "\\" + token.command + "{" + convertInline(body, options, true) + "}", true
			}
		}
	}
	return 0, "", false
}

func convertInline(text string, options Options, exportComments bool) string {
	source := strings.TrimSpace(text)
	commands := []inlineCommand{}
	for _, command := range scanInlineCommands(source) {
		if commandAllowedForInline(command.Name) {
			commands = append(commands, command)
		}
	}
	annotationIndex := 0
	var latex, plain strings.Builder
	flushPlain := func() {
		latex.WriteString(escapeLatexText(plain.String()))
		plain.Reset()
	}
	for pos := 0; pos < len(source); {
		for annotationIndex < len(commands) && commands[annotationIndex].FullTo <= pos {
			annotationIndex++
		}
		if annotationIndex < len(commands) && commands[annotationIndex].FullFrom == pos {
			flushPlain()
			command := commands[annotationIndex]
			switch command.Name {
			case "scomment":
				latex.WriteString("\\sidecomment{" + convertInline(command.Context, options, true) + "}")
			case "revision":
				latex.WriteString(revisionLatex(command, options))
			case "comment":
				if exportComments {
					latex.WriteString("\\aaroncomment{" + convertInline(command.Context, options, true) + "}")
				}
			case "cite":
				latex.WriteString(citeLatex(command, options))
			case "latexmk":
				if strings.EqualFold(command.SwitchValue, "newline") {
					trimmed := strings.TrimRight(latex.String(), " \t\r\n")
					latex.Reset()
					latex.WriteString(trimmed + "\\\\\n")
				}
			}
			pos = command.FullTo
			if command.Name == "latexmk" && strings.EqualFold(command.SwitchValue, "newline") {
				for pos < len(source) && (source[pos] == ' ' || source[pos] == '\t') {
					pos++
				}
			}
			annotationIndex++
			continue
		}
		if length, rendered, ok := inlineTokenAt(source, pos, options); ok {
			flushPlain()
			latex.WriteString(rendered)
			pos += length
			continue
		}
		plain.WriteByte(source[pos])
		pos++
	}
	flushPlain()
	return latex.String()
}

func escapeLatexTitle(value string, options Options) string {
	space := regexp.MustCompile(`\s+`)
	return strings.TrimSpace(space.ReplaceAllString(convertInline(value, options, true), " "))
}
