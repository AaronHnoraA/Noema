package planning

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestPlanningDocumentSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "planning-document-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name, Input string
		Expected    []string
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			t.Parallel()
			nodes := ScanDocument(fixture.Input, "")
			actual := []string{}
			for _, node := range nodes {
				actual = append(actual, node.Raw)
				if expected := utf16Length(fixture.Input[:strings.Index(fixture.Input, node.Raw)]); node.Span.From != expected {
					t.Fatalf("source offset %d, want %d", node.Span.From, expected)
				}
			}
			if !reflect.DeepEqual(actual, fixture.Expected) {
				t.Fatalf("got %#v; want %#v", actual, fixture.Expected)
			}
		})
	}
}

func TestPlanningCodeMutationRejected(t *testing.T) {
	task := "@@todo [Example]{id: example}"
	source := "```md\n" + task + "\n```\n"
	index := strings.Index(source, task)
	if _, err := TransformSource(source, Selector{Kind: "todo", ID: "example", Source: task, Index: &index}, Mutation{Type: "replace", Source: "bad"}); err == nil {
		t.Fatal("code example was writable")
	}
}

func BenchmarkPlanningDocument(b *testing.B) {
	for _, n := range []int{100, 1000} {
		source := strings.Repeat("Paragraph 😀 with `code`\n\n@@todo [Task]{id: task}\n\n```md\n@@todo [example]\n```\n\n", n)
		b.Run(strconv.Itoa(n)+"-tasks", func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(source)))
			for b.Loop() {
				ScanDocument(source, "")
			}
		})
	}
}
