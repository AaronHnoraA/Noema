package agenda

import (
	"fmt"
	"testing"
)

func benchmarkEvaluateRequest(todoCount int) EvaluateRequest {
	todos := make([]Todo, todoCount)
	for index := range todos {
		canon := map[string]string{
			"sche":    "2026-08-26",
			"ddl":     "2026-09-02",
			"effort":  "45m",
			"project": fmt.Sprintf("project-%d", index%32),
		}
		if index > 0 && index%4 == 0 {
			canon["after"] = fmt.Sprintf("#todo%d", index-1)
		}
		todos[index] = Todo{
			ID:        fmt.Sprintf("#todo%d", index),
			Status:    "todo",
			Text:      fmt.Sprintf("Synthetic planning task %d", index),
			File:      fmt.Sprintf("notes/note-%d.md", index/20),
			NoteTitle: fmt.Sprintf("Note %d", index/20),
			Index:     index,
			Line:      index%20 + 1,
			Canon:     canon,
		}
	}
	return EvaluateRequest{
		Todos:   todos,
		TodayMs: 1787702400000,
		From:    "2026-08-26",
		Days:    14,
	}
}

func BenchmarkEvaluate(b *testing.B) {
	for _, todoCount := range []int{1000, 10000} {
		for _, profile := range []struct {
			name     string
			planning bool
			view     bool
		}{{name: "core"}, {name: "full", planning: true, view: true}} {
			request := benchmarkEvaluateRequest(todoCount)
			request.IncludePlanning = profile.planning
			request.IncludeView = profile.view
			b.Run(fmt.Sprintf("todos-%d/%s", todoCount, profile.name), func(b *testing.B) {
				b.ReportAllocs()
				b.ResetTimer()
				for range b.N {
					result := Evaluate(request)
					if len(result.Todos) != todoCount {
						b.Fatalf("got %d todos, want %d", len(result.Todos), todoCount)
					}
				}
			})
		}
	}
}
