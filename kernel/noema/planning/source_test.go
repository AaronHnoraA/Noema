package planning

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSourceTransformSharedFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "planning-mutation-fixtures.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string       `json:"name"`
		Input    string       `json:"input"`
		Selector Selector     `json:"selector"`
		Mutation Mutation     `json:"mutation"`
		Expected SourceResult `json:"expected"`
	}
	if err = json.Unmarshal(raw, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			got, err := TransformSource(f.Input, f.Selector, f.Mutation)
			if err != nil {
				t.Fatal(err)
			}
			want := f.Expected
			if got.Content != want.Content || got.From != want.From || got.To != want.To || got.Source != want.Source || got.NextSource != want.NextSource {
				t.Fatalf("source contract mismatch: %+v; want %+v", got, want)
			}
		})
	}
}

func TestSourceTransformCreatesWithCallerOwnedIdentity(t *testing.T) {
	mutation := Mutation{Type: "append-todo", Create: &TodoCreate{Title: "证明🚀", Attrs: map[string]string{"prio": "a"}}, InitialContent: "# 项目🚀\n"}
	if _, err := TransformSource("", Selector{}, mutation); err == nil {
		t.Fatal("source computation must not allocate an ID or discover other documents")
	}
	mutation.ID = "abc123"
	created, err := TransformSource("", Selector{}, mutation)
	if err != nil {
		t.Fatal(err)
	}
	if created.Node == nil || created.Node.Attrs["id"] != "abc123" || created.Node.Title != "证明🚀" || created.Node.Attrs["prio"] != "A" {
		t.Fatalf("lost native creation semantics: %+v", created)
	}
	if created.From != utf16Length("# 项目🚀\n\n") {
		t.Fatalf("wrong UTF16 offset: %d", created.From)
	}
	unchanged, err := TransformSource(created.Content, Selector{ID: "#abc123"}, Mutation{Type: "replace", Source: created.Node.Raw})
	if err != nil || unchanged.Changed {
		t.Fatalf("no-op was changed: %+v %v", unchanged, err)
	}
}

func TestSourceTransformExcludesMetaSummaryAndPreservesUnrelatedText(t *testing.T) {
	input := "#+begin meta\n#+begin summary\n@@todo [example] {id=hidden}\n#+end summary\n#+end meta\n\n🚀\n@@todo [real] {id=abc123}\n\nuntouched 尾部\n"
	if _, err := TransformSource(input, Selector{ID: "#hidden"}, Mutation{Type: "replace", Source: "bad"}); err == nil {
		t.Fatal("summary example became a mutable task")
	}
	status := "done"
	got, err := TransformSource(input, Selector{ID: "#abc123"}, Mutation{Type: "patch-todo", Todo: &TodoPatch{Status: &status}})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasSuffix(got.Content, "\n\nuntouched 尾部\n") || !strings.HasPrefix(got.Content, strings.Split(input, "@@todo [real]")[0]) {
		t.Fatalf("unrelated source changed: %q", got.Content)
	}
}

func TestSourceCaptureCannotEnterUnclosedFence(t *testing.T) {
	for _, mutation := range []Mutation{
		{Type: "append", Source: "@@todo [Captured]{id: capture}"},
		{Type: "append-todo", ID: "capture", Create: &TodoCreate{Title: "Captured"}},
	} {
		if result, err := TransformSource("```md\nExample", Selector{}, mutation); err == nil || result != nil {
			t.Fatalf("invisible capture accepted: %+v %v", result, err)
		}
	}
}

func TestSourceEditCannotBecomeInlineCode(t *testing.T) {
	source := "` @@todo [Live]{id: live}"
	if result, err := TransformSource(source, Selector{ID: "live"}, Mutation{Type: "replace", Source: "@@todo [Live `]{id: live}"}); err == nil || result != nil {
		t.Fatalf("task moved inside code: %+v %v", result, err)
	}
}

func TestSourceClockAtEOFReturnsInsertedNode(t *testing.T) {
	source := "@@todo [计时🚀]{id: task}"
	start, task := "2026-09-16 10:00", "#task"
	result, err := TransformSource(source, Selector{ID: "task"}, Mutation{Type: "insert-clock", Attrs: map[string]*string{"from": &start, "task": &task}})
	if err != nil {
		t.Fatal(err)
	}
	if result.Node == nil || result.Node.Kind != "clock" || result.Node.Span.From != utf16Length(source)+1 {
		t.Fatalf("missing EOF clock identity: %+v", result)
	}
	if !strings.HasPrefix(result.Content, source+"\n@@clock") || result.Node.Attrs["task"] != "#task" {
		t.Fatalf("clock lost source or task: %+v", result)
	}
}
