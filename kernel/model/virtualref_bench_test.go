package model

import (
	"fmt"
	"strings"
	"testing"
)

func benchmarkVirtualRefCorpus(keywordCount int) ([]string, string) {
	keywords := make([]string, keywordCount)
	for index := range keywords {
		keywords[index] = fmt.Sprintf("reference-keyword-%05d", index)
	}
	var content strings.Builder
	for index := 0; index < keywordCount; index += 100 {
		content.WriteString("Prose mentioning ")
		content.WriteString(keywords[index])
		content.WriteString(" among ordinary words. ")
	}
	return keywords, content.String()
}

func BenchmarkVirtualRefMatchPlan(b *testing.B) {
	keywords, content := benchmarkVirtualRefCorpus(5000)
	b.Run("compile-and-search", func(b *testing.B) {
		b.ReportAllocs()
		for range b.N {
			plan := newVirtualRefMatchPlan(keywords, false)
			if hits := plan.matcher.Search(strings.ToLower(content)); len(hits) == 0 {
				b.Fatal("expected virtual-reference matches")
			}
		}
	})
	b.Run("shared-search", func(b *testing.B) {
		plan := newVirtualRefMatchPlan(keywords, false)
		normalized := strings.ToLower(content)
		b.ReportAllocs()
		b.ResetTimer()
		for range b.N {
			if hits := plan.matcher.Search(normalized); len(hits) == 0 {
				b.Fatal("expected virtual-reference matches")
			}
		}
	})
}
