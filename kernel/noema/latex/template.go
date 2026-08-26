// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema's portable LaTeX template planner is Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package latex

import (
	"fmt"
	"regexp"
)

type TemplatePlan struct {
	Segments     []string `json:"segments"`
	Placeholders []string `json:"placeholders"`
}

var templatePlaceholderPattern = regexp.MustCompile(`\{\{\s*([A-Za-z][A-Za-z0-9_-]*)\s*\}\}`)

// PlanTemplate parses and validates a LaTeX template once in Go. The Node host
// can then apply this immutable plan synchronously for Codex compile attempts
// without introducing a kernel round-trip into each attempt.
func PlanTemplate(template string, allowedKeys []string) (TemplatePlan, error) {
	allowed := map[string]bool{}
	for _, key := range allowedKeys {
		allowed[key] = true
	}
	plan := TemplatePlan{Segments: []string{}, Placeholders: []string{}}
	cursor := 0
	for _, match := range templatePlaceholderPattern.FindAllStringSubmatchIndex(template, -1) {
		key := template[match[2]:match[3]]
		if !allowed[key] {
			return TemplatePlan{}, fmt.Errorf("Unknown LaTeX template placeholder: {{%s}}", key)
		}
		plan.Segments = append(plan.Segments, template[cursor:match[0]])
		plan.Placeholders = append(plan.Placeholders, key)
		cursor = match[1]
	}
	plan.Segments = append(plan.Segments, template[cursor:])
	return plan, nil
}
