package planning

import (
	"sort"

	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

type sourceRange struct{ from, to int }

// This parser supplies source byte segments only. Lute continues to own the
// kernel's rendered document AST; native planning grammar stays in Scan.
// Unlike Lute nodes, these code nodes retain positions in the original input.
var documentParser = parser.NewParser(
	parser.WithBlockParsers(parser.DefaultBlockParsers()...),
	parser.WithInlineParsers(parser.DefaultInlineParsers()...),
	parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
)

func documentExcludedRanges(source string) []sourceRange {
	ranges := []sourceRange{}
	document := documentParser.Parse(text.NewReader([]byte(source)))
	add := func(segment text.Segment) { ranges = append(ranges, sourceRange{segment.Start, segment.Stop}) }
	ast.Walk(document, func(node ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch value := node.(type) {
		case *ast.CodeBlock, *ast.FencedCodeBlock:
			for i := 0; i < node.Lines().Len(); i++ {
				add(node.Lines().At(i))
			}
			if fence, ok := value.(*ast.FencedCodeBlock); ok && fence.Info != nil {
				add(fence.Info.Segment)
			}
			return ast.WalkSkipChildren, nil
		case *ast.CodeSpan:
			for child := value.FirstChild(); child != nil; child = child.NextSibling() {
				if literal, ok := child.(*ast.Text); ok {
					add(literal.Segment)
				}
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	if from, to, ok := metaSummaryUTF16Range(source, ranges); ok {
		start, _ := utf16OffsetToByte(source, from)
		end, _ := utf16OffsetToByte(source, to)
		ranges = append(ranges, sourceRange{start, end})
	}

	sort.Slice(ranges, func(i, j int) bool { return ranges[i].from < ranges[j].from })
	merged := ranges[:0]
	for _, r := range ranges {
		if len(merged) > 0 && r.from <= merged[len(merged)-1].to {
			if r.to > merged[len(merged)-1].to {
				merged[len(merged)-1].to = r.to
			}
		} else {
			merged = append(merged, r)
		}
	}
	return merged
}
