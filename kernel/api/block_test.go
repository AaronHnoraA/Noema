// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/88250/gulu"
	"github.com/aaronhe/noema/kernel/model"
	"github.com/gin-gonic/gin"
)

func TestParseBlockRefStringArrayEmptyHandling(t *testing.T) {
	arg := map[string]any{"ids": []any{}}

	requiredResult := gulu.Ret.NewResult()
	if _, ok := parseBlockRefStringArray(arg, "ids", requiredResult, true); ok || requiredResult.Code != -1 {
		t.Fatalf("expected an empty required array to be rejected, got code %d", requiredResult.Code)
	}

	optionalResult := gulu.Ret.NewResult()
	values, ok := parseBlockRefStringArray(arg, "ids", optionalResult, false)
	if !ok || optionalResult.Code != 0 || len(values) != 0 {
		t.Fatalf("expected an empty optional array to be accepted, got code %d and values %v", optionalResult.Code, values)
	}
}

func TestCheckBlockRefRejectsDeletedIDsOutsideIDs(t *testing.T) {
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.POST("/api/block/checkBlockRef", checkBlockRef)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/block/checkBlockRef", strings.NewReader(
		`{"scope":"blocks","ids":["20260804000000-checked"],"deletedIDs":["20260804000001-deleted"]}`))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)

	var response map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); nil != err {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	if -1 != int(response["code"].(float64)) ||
		"Field [deletedIDs] should be a subset of field [ids]" != response["msg"] {
		t.Fatalf("unexpected response: %#v", response)
	}
}

func TestGetDocBlocksOrdersArguments(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "missing document ID", body: `{}`},
		{name: "IDs only", body: `{"ids":[]}`},
		{name: "wrong document ID type", body: `{"id":1}`},
		{name: "invalid document ID", body: `{"id":"invalid"}`},
		{name: "null document ID", body: `{"id":null}`},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := postDocBlocksOrders(t, test.body)
			if -1 != response.Code {
				t.Fatalf("unexpected response code: expected -1, got %d, message %q", response.Code, response.Msg)
			}
		})
	}
}

type docBlocksOrdersResponse struct {
	Code int             `json:"code"`
	Msg  string          `json:"msg"`
	Data json.RawMessage `json:"data"`
}

func postDocBlocksOrders(t *testing.T, body string) *docBlocksOrdersResponse {
	t.Helper()

	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(func(c *gin.Context) {
		c.Set(model.RoleContextKey, model.RoleAdministrator)
		c.Next()
	})
	engine.POST("/api/block/getDocBlocksOrders", getDocBlocksOrders)

	recorder := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/block/getDocBlocksOrders", strings.NewReader(body))
	request.Header.Set("Content-Type", "application/json")
	engine.ServeHTTP(recorder, request)

	response := &docBlocksOrdersResponse{}
	if err := json.Unmarshal(recorder.Body.Bytes(), response); err != nil {
		t.Fatalf("unmarshal response failed: %v", err)
	}
	return response
}
