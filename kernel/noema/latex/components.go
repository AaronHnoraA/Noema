package latex

import (
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
)

type componentHeader struct {
	Name, Kind, Title string
	Properties        map[string]string
}

var componentName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,47}$`)
var componentLength = regexp.MustCompile(`^\d+(?:\.\d+)?(?:px|ch|em|rem|%|vw|vh)?$`)
var componentText = regexp.MustCompile(`^[^\x00-\x1f{}]+$`)
var componentFence = regexp.MustCompile("^ {0,3}(`{3,}|~{3,})(.*)$")
var componentCandidate = regexp.MustCompile(`(?im)^#\+[ \t]*begin[ \t]+component\b`)

var componentWidthProperties = []string{"align", "width"}
var componentProperties = map[string][]string{
	"box":      {"surface", "padding", "text-align"},
	"card":     {"description", "accent", "text-align", "icon"},
	"home-box": {"description", "accent", "text-align", "surface"},
	"panel":    {"status", "variant", "focus", "accent"},
}
var componentCalloutKinds = []string{"note", "tip", "important", "warning", "caution", "info", "danger"}
var componentCalloutProperties = []string{"collapsible", "open", "background", "border-left-width"}
var componentChoices = map[string][]string{
	"align":      {"left", "center", "right"},
	"text-align": {"left", "center", "right", "start", "end", "justify"},
	"accent":     {"neutral", "primary", "info", "success", "important", "warning", "danger"},
	"surface":    {"none", "paper", "quiet", "raised"},
	"background": {"quote", "quiet", "raised", "none"},
	"variant":    {"default", "flat"},
	"icon":       {"link", "file", "check", "info"},
}

func componentPropertiesValid(kind string, props map[string]string) bool {
	properties, frame := componentProperties[kind]
	callout := slices.Contains(componentCalloutKinds, kind)
	if !frame && !callout {
		return false
	}
	for key, value := range props {
		if frame && !slices.Contains(properties, key) && !slices.Contains(componentWidthProperties, key) ||
			callout && !slices.Contains(componentCalloutProperties, key) {
			return false
		}
		switch key {
		case "width", "padding", "border-left-width":
			if !componentLength.MatchString(value) {
				return false
			}
		case "description", "status":
			if !componentText.MatchString(value) || len(utf16.Encode([]rune(value))) > 256 {
				return false
			}
		case "collapsible", "open", "focus":
			if !strings.EqualFold(value, "true") && !strings.EqualFold(value, "false") {
				return false
			}
		default:
			if !slices.Contains(componentChoices[key], strings.ToLower(value)) {
				return false
			}
		}
	}
	return true
}

func parseComponentHeader(source string) *componentHeader {
	source = strings.TrimSpace(widgetAnchorPattern.ReplaceAllString(source, ""))
	title, properties := splitWidgetAttrs(source, []string{"kind", "use"})
	if properties == nil {
		return nil
	}
	kind, use := properties["kind"], properties["use"]
	delete(properties, "kind")
	delete(properties, "use")
	if kind != "" && use == "" && componentName.MatchString(title) && componentPropertiesValid(kind, properties) {
		return &componentHeader{Name: title, Kind: kind, Properties: properties}
	}
	if use != "" && kind == "" && componentName.MatchString(use) {
		return &componentHeader{Name: use, Title: title, Properties: properties}
	}
	return nil
}

func collectDocumentComponents(source string, lines []string, from int) map[string]*componentHeader {
	definitions := map[string]*componentHeader{}
	if !componentCandidate.MatchString(source) {
		return definitions
	}
	type frame struct {
		kind, title string
		from, to    int
	}
	var opened []*frame
	byKind := map[string][]*frame{}
	var fence string
	comment := false
	for index := from; index < len(lines); index++ {
		line := lines[index]
		if fence != "" {
			match := componentFence.FindStringSubmatch(line)
			if match != nil && match[1][0] == fence[0] && len(match[1]) >= len(fence) && strings.TrimSpace(match[2]) == "" {
				fence = ""
			}
			continue
		}
		if comment {
			comment = !strings.Contains(line, "-->")
			continue
		}
		trimmed := strings.TrimLeft(line, " ")
		if len(line)-len(trimmed) > 3 {
			continue
		}
		if strings.HasPrefix(trimmed, "<!--") {
			comment = !strings.Contains(line, "-->")
			continue
		}
		if match := componentFence.FindStringSubmatch(line); match != nil && (match[1][0] == '~' || !strings.Contains(match[2], "`")) {
			fence = match[1]
			continue
		}
		if close := orgClose(trimmed); close != "" {
			peers := byKind[close]
			if len(peers) > 0 {
				peers[len(peers)-1].to = index
				byKind[close] = peers[:len(peers)-1]
			}
		} else if open := orgOpen(trimmed); open != nil {
			block := &frame{kind: open.Kind, title: open.Title, from: index, to: -1}
			byKind[open.Kind] = append(byKind[open.Kind], block)
			opened = append(opened, block)
		}
	}
	through := -1
	for _, block := range opened {
		if block.from <= through || block.to < 0 {
			continue
		}
		through = block.to
		if block.kind != "component" || !strings.HasPrefix(lines[block.from], "#+") {
			continue
		}
		header := parseComponentHeader(block.title)
		if header == nil || header.Kind == "" || definitions[header.Name] != nil {
			continue
		}
		if !slices.ContainsFunc(lines[block.from+1:block.to], func(line string) bool { return strings.TrimSpace(line) != "" }) {
			definitions[header.Name] = header
		}
	}
	return definitions
}
