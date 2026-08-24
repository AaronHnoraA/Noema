// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package filesys

import (
	"strings"
	"testing"

	"github.com/88250/lute/parse"
	"github.com/88250/lute/render"
	"github.com/aaronhe/noema/kernel/util"
)

// TestOrgEndAfterListSurvivesParseFormatRoundTrip 复现 Phase 1 Spike 1 发现的
// bug：#+begin/#+end body 以列表结尾、无空行分隔时，CommonMark 的列表懒续行
// 规则会把 #+end 行吞并进最后一个列表项并重新缩进。normalizeOrgEndBlankLines
// 在解析前插入空行阻断懒续行，这里验证修正后 parse.Parse -> FormatRenderer
// 的输出里 #+end 仍然是顶格、独立的一行，不再被列表吞并。
func TestOrgEndAfterListSurvivesParseFormatRoundTrip(t *testing.T) {
	luteEngine := util.NewLute()
	source := "#+begin note\nSome text.\n\n- a\n- b\n#+end note\n"

	normalized := normalizeOrgEndBlankLines([]byte(source))
	tree := parse.Parse("test", normalized, luteEngine.ParseOptions)
	rendered := string(render.NewFormatRenderer(tree, luteEngine.RenderOptions, luteEngine.ParseOptions).Render())

	if !strings.Contains(rendered, "\n#+end note\n") && !strings.HasSuffix(strings.TrimRight(rendered, "\n"), "#+end note") {
		t.Fatalf("expected #+end note on its own unindented line, got:\n%s", rendered)
	}
	if strings.Contains(rendered, "  #+end note") {
		t.Fatalf("#+end note was still swallowed/reindented into the list:\n%s", rendered)
	}
}

func TestOrgEndNormalizationSkipsFencedCodeBlocks(t *testing.T) {
	source := "- item\n```\n#+end note\n```\n"
	got := string(normalizeOrgEndBlankLines([]byte(source)))
	if got != source {
		t.Fatalf("normalization must not touch #+end-looking text inside a fenced code block:\ninput:\n%s\ngot:\n%s", source, got)
	}
}

func TestOrgEndNormalizationRepairsAlreadyIndentedMarker(t *testing.T) {
	// 模拟旧内核已经写坏（缩进吞并）的历史文件，读回时应能自我修复。
	corrupted := "- a\n- b\n  #+end note\n"
	got := string(normalizeOrgEndBlankLines([]byte(corrupted)))
	if !strings.Contains(got, "\n\n#+end note") {
		t.Fatalf("expected repaired output to have a blank line then unindented #+end note, got:\n%s", got)
	}
	if strings.Contains(got, "  #+end note") {
		t.Fatalf("repaired output still has the indented marker:\n%s", got)
	}
}
