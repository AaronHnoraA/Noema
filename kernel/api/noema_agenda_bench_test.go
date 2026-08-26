package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	noemaagenda "github.com/aaronhe/noema/kernel/noema/agenda"
	"github.com/gin-gonic/gin"
)

func benchmarkAgendaAPIRequest(todoCount int) []byte {
	todos := make([]noemaagenda.Todo, todoCount)
	for index := range todos {
		canon := map[string]string{"sche": "2026-08-26", "ddl": "2026-09-02", "effort": "45m"}
		if index > 0 && index%4 == 0 {
			canon["after"] = fmt.Sprintf("#todo%d", index-1)
		}
		todos[index] = noemaagenda.Todo{
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
	payload, err := json.Marshal(noemaagenda.EvaluateRequest{
		Todos:           todos,
		TodayMs:         1787702400000,
		IncludePlanning: true,
		IncludeView:     true,
		From:            "2026-08-26",
		Days:            14,
	})
	if err != nil {
		panic(err)
	}
	return payload
}

func BenchmarkEvaluateNoemaAgendaAPI(b *testing.B) {
	gin.SetMode(gin.ReleaseMode)
	engine := gin.New()
	engine.POST("/api/noema/agenda/evaluate", evaluateNoemaAgenda)
	for _, todoCount := range []int{1000, 10000} {
		payload := benchmarkAgendaAPIRequest(todoCount)
		b.Run(fmt.Sprintf("todos-%d", todoCount), func(b *testing.B) {
			b.ReportAllocs()
			b.SetBytes(int64(len(payload)))
			b.ResetTimer()
			for range b.N {
				recorder := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, "/api/noema/agenda/evaluate", bytes.NewReader(payload))
				request.Header.Set("Content-Type", "application/json")
				engine.ServeHTTP(recorder, request)
				if recorder.Code != http.StatusOK {
					b.Fatalf("status = %d", recorder.Code)
				}
			}
		})
	}
}
