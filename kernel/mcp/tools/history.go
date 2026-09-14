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

package tools

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/aaronhe/noema/kernel/model"
	"github.com/aaronhe/noema/kernel/noema/research"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/aaronhe/noema/kernel/util"
)

var HistoryTool = &Tool{
	Name:        "history",
	Description: "History operations. Native research history uses search(query, root, projectRoot?, source?, limit?), peek(root, id, maxRunes?), and read(root, id). Legacy document history remains available through list/search/get/rollback/clear without root.",
	InputSchema: ToolSchema{
		Type: "object",
		Properties: map[string]Property{
			"action":      {Type: "string", Description: "Operation", Enum: []string{"list", "search", "peek", "read", "get", "rollback", "clear"}},
			"query":       {Type: "string", Description: "Search query (for list, search)"},
			"notebook":    {Type: "string", Description: "Notebook ID filter (for list, search)"},
			"op":          {Type: "string", Description: "Operation filter: delete/update/create (for list, search)"},
			"type":        {Type: "number", Description: "Search type: 0=name,1=content,2=asset,3=docID,4=database (default 1)"},
			"page":        {Type: "number", Description: "Page number (default 1)"},
			"path":        {Type: "string", Description: "History path relative to workspace directory (for get, rollback). Obtained from list/search output, e.g. history/2024-03-15-.../docid/..."},
			"root":        {Type: "string", Description: "Absolute Noema repository root. When present, search uses the repository's read-only native conversation index."},
			"projectRoot": {Type: "string", Description: "Exact project/cwd filter for native conversation history (defaults to root)."},
			"source":      {Type: "string", Description: "Native history source filter: magent, agent-shell, codex, claude, or noema-transcript."},
			"id":          {Type: "string", Description: "Stable hist_ record id returned by native history search (for peek/read)."},
			"limit":       {Type: "number", Description: "Maximum native history hits (1-100, default 20)."},
			"maxRunes":    {Type: "number", Description: "Maximum characters returned by peek (default 1200, maximum 8000)."},
		},
		Required: []string{"action"},
	},
	Handler: historyHandler,
	ActionEffects: map[string]ToolEffects{
		"list": {LocalRead: true}, "search": {LocalRead: true}, "peek": {LocalRead: true},
		"read": {LocalRead: true}, "get": {LocalRead: true},
		"rollback": {LocalWrite: true}, "clear": {LocalWrite: true},
	},
}

func init() {
	register(HistoryTool)
}

func historyHandler(args map[string]any) (CallToolResult, error) {
	action, _ := args["action"].(string)
	switch action {
	case "list":
		return historyList(args)
	case "search":
		if root, _ := args["root"].(string); strings.TrimSpace(root) != "" {
			return researchHistorySearch(args)
		}
		return historySearch(args)
	case "peek":
		return researchHistoryRead(args, true)
	case "read":
		return researchHistoryRead(args, false)
	case "get":
		return historyGet(args)
	case "rollback":
		return historyRollback(args)
	case "clear":
		return historyClear(args)
	}
	return CallToolResult{
		Content: []ContentItem{{Type: "text", Text: "unknown action '" + action + "', expected one of: [list, search, peek, read, get, rollback, clear]"}},
		IsError: true,
	}, nil
}

func researchHistorySearch(args map[string]any) (CallToolResult, error) {
	root, _ := args["root"].(string)
	query, _ := args["query"].(string)
	projectRoot, _ := args["projectRoot"].(string)
	if projectRoot == "" {
		projectRoot = root
	}
	source, _ := args["source"].(string)
	limit := 20
	if value, ok := args["limit"].(float64); ok {
		limit = int(value)
	}
	store, err := research.Open(root)
	if err != nil {
		return historyResearchError(err), nil
	}
	hits, err := store.SearchHistory(research.HistorySearchOptions{
		Query: query, ProjectRoot: projectRoot, Source: source, Limit: limit,
	})
	if err != nil {
		return historyResearchError(err), nil
	}
	return historyResearchJSON(map[string]any{"hits": hits})
}

func researchHistoryRead(args map[string]any, peek bool) (CallToolResult, error) {
	root, _ := args["root"].(string)
	id, _ := args["id"].(string)
	store, err := research.Open(root)
	if err != nil {
		return historyResearchError(err), nil
	}
	var record research.HistoryRecord
	if peek {
		maxRunes := 1200
		if value, ok := args["maxRunes"].(float64); ok {
			maxRunes = int(value)
		}
		record, err = store.PeekHistory(id, maxRunes)
	} else {
		record, err = store.ReadHistory(id)
	}
	if err != nil {
		return historyResearchError(err), nil
	}
	return historyResearchJSON(record)
}

func historyResearchJSON(value any) (CallToolResult, error) {
	data, err := json.Marshal(value)
	if err != nil {
		return CallToolResult{}, err
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: string(data)}}}, nil
}

func historyResearchError(err error) CallToolResult {
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: err.Error()}}, IsError: true}
}

func historyList(args map[string]any) (CallToolResult, error) {
	query, _ := args["query"].(string)
	notebook, _ := args["notebook"].(string)
	op, _ := args["op"].(string)
	typ := 1
	if v, ok := args["type"].(float64); ok {
		typ = int(v)
	}
	page := 1
	if v, ok := args["page"].(float64); ok {
		page = int(v)
	}

	results, pageCount, totalCount := model.FullTextSearchHistory(query, notebook, op, typ, page)
	if len(results) == 0 {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "no history found"}}}, nil
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("History (%d total, page %d/%d):\n\n", totalCount, page, pageCount))
	for _, ts := range results {
		items := model.FullTextSearchHistoryItems(ts, query, notebook, op, typ)
		sb.WriteString(fmt.Sprintf("--- %s (%d items) ---\n", ts, len(items)))
		for _, item := range items {
			sb.WriteString(fmt.Sprintf("  - [%s] %s (path: %s)\n", item.Op, item.Title, item.Path))
		}
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: sb.String()}}}, nil
}

func historyGet(args map[string]any) (CallToolResult, error) {
	path, _ := args["path"].(string)
	if path == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "path is required"}}, IsError: true}, nil
	}

	_, _, content, _, err := model.GetDocHistoryContent(path, "", false)
	if err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "get history failed: " + err.Error()}}, IsError: true}, nil
	}
	if content == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "no content"}}, IsError: true}, nil
	}

	return CallToolResult{Content: []ContentItem{{Type: "text", Text: content}}}, nil
}

func historySearch(args map[string]any) (CallToolResult, error) {
	query, _ := args["query"].(string)
	if query == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "query is required"}}, IsError: true}, nil
	}
	box, _ := args["notebook"].(string)
	op, _ := args["op"].(string)
	typ := 1
	if v, ok := args["type"].(float64); ok {
		typ = int(v)
	}
	page := 1
	if v, ok := args["page"].(float64); ok {
		page = int(v)
	}

	timestamps, pageCount, totalCount := model.FullTextSearchHistory(query, box, op, typ, page)
	if len(timestamps) == 0 {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: fmt.Sprintf("no history found for '%s'", query)}}}, nil
	}

	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Search '%s' (%d total, page %d/%d):\n\n", query, totalCount, page, pageCount))
	for _, ts := range timestamps {
		items := model.FullTextSearchHistoryItems(ts, query, box, op, typ)
		sb.WriteString(fmt.Sprintf("--- %s (%d items) ---\n", ts, len(items)))
		for _, item := range items {
			sb.WriteString(fmt.Sprintf("  - [%s] %s (path: %s)\n", item.Op, item.Title, item.Path))
		}
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: sb.String()}}}, nil
}

func historyRollback(args map[string]any) (CallToolResult, error) {
	path, _ := args["path"].(string)
	if path == "" {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "path is required"}}, IsError: true}, nil
	}
	if err := model.RollbackDocHistory(path); err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "rollback failed: " + err.Error()}}, IsError: true}, nil
	}
	docID := util.GetTreeID(path)
	if bt := treenode.GetBlockTree(docID); bt != nil {
		util.PushReloadProtyle(bt.RootID)
	}
	util.PushReloadFiletree()
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: "history rolled back: " + path}}}, nil
}

func historyClear(args map[string]any) (CallToolResult, error) {
	if err := model.ClearWorkspaceHistory(); err != nil {
		return CallToolResult{Content: []ContentItem{{Type: "text", Text: "clear history failed: " + err.Error()}}, IsError: true}, nil
	}
	return CallToolResult{Content: []ContentItem{{Type: "text", Text: "all history cleared"}}}, nil
}
