// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.

package model

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	noemamarkdown "github.com/aaronhe/noema/kernel/noema/markdown"
	noemaplanning "github.com/aaronhe/noema/kernel/noema/planning"
	"github.com/aaronhe/noema/kernel/util"
)

// benchMarkdownDoc builds a note shaped like a real Noema note: headings,
// prose with CJK, lists, fenced code, math, and links.
func benchMarkdownDoc(sections int) string {
	var b strings.Builder
	b.WriteString("# Benchmark note\n\n")
	for i := 0; i < sections; i++ {
		fmt.Fprintf(&b, "## Section %d\n\n", i)
		fmt.Fprintf(&b, "这是第 %d 段中文正文，混合 English prose and `inline code` plus a [link](https://example.com/%d) and $E = mc^2$ math.\n\n", i, i)
		b.WriteString("- first item with **bold** and *emphasis*\n")
		b.WriteString("- second item with ~~strike~~ and a #tag\n")
		b.WriteString("- [ ] a task list item\n\n")
		fmt.Fprintf(&b, "```go\nfunc bench%d() int {\n\treturn %d\n}\n```\n\n", i, i)
		b.WriteString("> a blockquote line\n>\n> with a second paragraph\n\n")
		b.WriteString("$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n")
	}
	return b.String()
}

func benchMarkdownBox(b *testing.B) string {
	b.Helper()
	originalDataDir := util.DataDir
	util.DataDir = b.TempDir()
	b.Cleanup(func() { util.DataDir = originalDataDir })

	boxID := "20260826000000-benchmd1"
	boxConf := conf.NewBoxConf()
	boxConf.Kind = conf.BoxKindMarkdown
	boxConf.Name = "Markdown Bench"
	box := &Box{ID: boxID}
	if err := box.SaveConf(boxConf); nil != err {
		b.Fatalf("save box conf failed: %s", err)
	}
	return boxID
}

func BenchmarkNewLute(b *testing.B) {
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		_ = util.NewLute()
	}
}

func BenchmarkLoadMarkdownTreeByData(b *testing.B) {
	for _, sections := range []int{1, 16, 128} {
		source := []byte(benchMarkdownDoc(sections))
		b.Run(fmt.Sprintf("sections=%d/bytes=%d", sections, len(source)), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(source)))
			luteEngine := util.NewLute()
			for i := 0; i < b.N; i++ {
				_ = filesys.LoadMarkdownTreeByData(source, "box", "/bench.md", luteEngine)
			}
		})
	}
}

func BenchmarkLoadMarkdownDoc(b *testing.B) {
	for _, sections := range []int{1, 16, 128} {
		b.Run(fmt.Sprintf("sections=%d", sections), func(b *testing.B) {
			boxID := benchMarkdownBox(b)
			source := benchMarkdownDoc(sections)
			path := "/bench.md"
			absPath := filepath.Join(filesys.BoxRootPath(boxID), path)
			if err := os.MkdirAll(filepath.Dir(absPath), 0755); nil != err {
				b.Fatal(err)
			}
			if err := os.WriteFile(absPath, []byte(source), 0644); nil != err {
				b.Fatal(err)
			}
			b.ReportAllocs()
			b.SetBytes(int64(len(source)))
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if _, _, err := LoadMarkdownDoc(boxID, path); nil != err {
					b.Fatal(err)
				}
			}
		})
	}
}

// BenchmarkMarkdownProjections separates the CommonMark parse from the two
// line scanners so the load/save budget can be attributed.
func BenchmarkMarkdownProjections(b *testing.B) {
	source := []byte(benchMarkdownDoc(128))
	b.Run("lute-parse", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = filesys.LoadMarkdownTreeByData(source, "box", "/bench.md", util.NewLute())
		}
	})
	tree := filesys.LoadMarkdownTreeByData(source, "box", "/bench.md", util.NewLute())
	b.Run("block-refs", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = markdownBlockRefs(tree)
		}
	})
	b.Run("noema-scan", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = noemamarkdown.Scan(source)
		}
	})
	text := string(source)
	b.Run("planning-scan", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = noemaplanning.ScanDocument(text, "")
		}
	})
}

// benchAnchoredDoc mirrors benchMarkdownDoc but gives every heading and
// paragraph a canonical Noema {#uuid} block anchor, which is what a note that
// is actually referenced from elsewhere looks like on disk.
func benchAnchoredDoc(sections int) string {
	var b strings.Builder
	b.WriteString("# Benchmark note\n\n")
	for i := 0; i < sections; i++ {
		id := fmt.Sprintf("0192f1a0-%04x-7000-8000-%012x", i&0xffff, i)
		id2 := fmt.Sprintf("0192f1a1-%04x-7000-8000-%012x", i&0xffff, i)
		fmt.Fprintf(&b, "## Section %d {#%s}\n\n", i, id)
		fmt.Fprintf(&b, "这是第 %d 段中文正文，混合 English prose and `inline code` plus a [link](https://example.com/%d) and $E = mc^2$ math. {#%s}\n\n", i, i, id2)
		b.WriteString("- first item with **bold** and *emphasis*\n")
		b.WriteString("- second item with ~~strike~~ and a #tag\n")
		b.WriteString("- [ ] a task list item\n\n")
		fmt.Fprintf(&b, "```go\nfunc bench%d() int {\n\treturn %d\n}\n```\n\n", i, i)
		b.WriteString("> a blockquote line\n>\n> with a second paragraph\n\n")
		b.WriteString("$$\n\\int_0^1 x^2 \\, dx = \\frac{1}{3}\n$$\n\n")
	}
	return b.String()
}

// BenchmarkMarkdownLoadStages attributes the cost of one cold Markdown load
// across the pipeline stages in filesys.LoadMarkdownTreeByData.
func BenchmarkMarkdownLoadStages(b *testing.B) {
	for _, variant := range []struct {
		name   string
		source []byte
	}{
		{"plain", []byte(benchMarkdownDoc(128))},
		{"anchored", []byte(benchAnchoredDoc(128))},
	} {
		source := variant.source
		b.Run(variant.name+"/whole-pipeline", func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(source)))
			for i := 0; i < b.N; i++ {
				_ = filesys.LoadMarkdownTreeByData(source, "box", "/bench.md", util.NewLute())
			}
		})
		b.Run(variant.name+"/lute-only", func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(source)))
			options := util.NewLute().ParseOptions
			for i := 0; i < b.N; i++ {
				_ = parse.Parse("/bench.md", source, options)
			}
		})
		b.Run(variant.name+"/noema-projection", func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(source)))
			options := util.NewLute().ParseOptions
			trees := make([]*parse.Tree, b.N)
			for i := range trees {
				trees[i] = parse.Parse("/bench.md", source, options)
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				_ = filesys.ApplyNoemaBlockProjection(trees[i], source)
			}
		})
	}
}

// BenchmarkLuteOptionVariants measures what the SiYuan-shaped options cost on
// a portable Markdown box, whose block identity comes from Noema anchors and
// whose lute-generated IDs are stripped again right after parsing.
func BenchmarkLuteOptionVariants(b *testing.B) {
	source := []byte(benchMarkdownDoc(128))
	base := util.NewLute()
	b.Run("as-configured", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = parse.Parse("/bench.md", source, base.ParseOptions)
		}
	})
	noWYSIWYG := util.NewLute()
	noWYSIWYG.SetProtyleWYSIWYG(false)
	b.Run("no-protyle-wysiwyg", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = parse.Parse("/bench.md", source, noWYSIWYG.ParseOptions)
		}
	})
	noIAL := util.NewLute()
	noIAL.SetKramdownIAL(false)
	b.Run("no-kramdown-ial", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = parse.Parse("/bench.md", source, noIAL.ParseOptions)
		}
	})
	noTextMark := util.NewLute()
	noTextMark.SetTextMark(false)
	b.Run("no-text-mark", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = parse.Parse("/bench.md", source, noTextMark.ParseOptions)
		}
	})
	noSanitize := util.NewLute()
	noSanitize.SetSanitize(false)
	b.Run("no-sanitize", func(b *testing.B) {
		b.ReportAllocs()
		b.SetBytes(int64(len(source)))
		for i := 0; i < b.N; i++ {
			_ = parse.Parse("/bench.md", source, noSanitize.ParseOptions)
		}
	})
}
