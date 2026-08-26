// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown session-state additions are Copyright (c) 2026 Aaron He and
// distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/siyuan-note/filelock"
)

const (
	markdownRecentNoteLimit     = 24
	markdownCursorPositionLimit = 240
)

var markdownSessionStateLock sync.Mutex
var markdownSessionNow = func() float64 { return float64(time.Now().UnixNano()) / 1e6 }

type MarkdownRecentNote struct {
	Notebook string  `json:"notebook"`
	Path     string  `json:"path"`
	OpenedAt float64 `json:"openedAt"`
}

type MarkdownCursorPosition struct {
	Notebook  string  `json:"notebook"`
	Path      string  `json:"path"`
	Client    string  `json:"client,omitempty"`
	Mode      string  `json:"mode"`
	From      float64 `json:"from"`
	To        float64 `json:"to"`
	ScrollY   float64 `json:"scrollY"`
	UpdatedAt float64 `json:"updatedAt"`
}

type MarkdownSessionState struct {
	Recent    []MarkdownRecentNote     `json:"recent"`
	Positions []MarkdownCursorPosition `json:"positions"`
	Source    string                   `json:"source,omitempty"`
}

func markdownSessionStatePath(boxID string) string {
	return filepath.Join(util.DataDir, "storage", "noema-session", boxID+".json")
}

func normalizeMarkdownSessionPath(boxID, path string) (string, error) {
	if boxID == "" || filepath.Base(boxID) != boxID || boxID == "." || strings.HasPrefix(boxID, ".") {
		return "", fmt.Errorf("invalid Markdown session notebook [%s]", boxID)
	}
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return "", fmt.Errorf("box [%s] is not a markdown box", boxID)
	}
	return normalizedMarkdownDocPath(boxID, path)
}

func normalizeMarkdownRecentNotes(boxID string, entries []MarkdownRecentNote) []MarkdownRecentNote {
	normalized := make([]MarkdownRecentNote, 0, len(entries))
	byPath := map[string]int{}
	for _, entry := range entries {
		path, err := normalizeMarkdownSessionPath(boxID, entry.Path)
		if err != nil || math.IsNaN(entry.OpenedAt) || math.IsInf(entry.OpenedAt, 0) {
			continue
		}
		entry.Notebook, entry.Path = boxID, path
		if index, ok := byPath[path]; ok {
			if entry.OpenedAt > normalized[index].OpenedAt {
				normalized[index] = entry
			}
			continue
		}
		byPath[path] = len(normalized)
		normalized = append(normalized, entry)
	}
	sort.SliceStable(normalized, func(i, j int) bool { return normalized[i].OpenedAt > normalized[j].OpenedAt })
	if len(normalized) > markdownRecentNoteLimit {
		normalized = normalized[:markdownRecentNoteLimit]
	}
	return normalized
}

func finiteNonNegative(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return 0
	}
	return value
}

func boundedMarkdownSessionClient(client string) string {
	runes := []rune(strings.TrimSpace(client))
	if len(runes) > 256 {
		runes = runes[:256]
	}
	return string(runes)
}

func normalizeMarkdownCursorPositions(boxID string, entries []MarkdownCursorPosition) []MarkdownCursorPosition {
	normalized := make([]MarkdownCursorPosition, 0, len(entries))
	bySlot := map[string]int{}
	for _, entry := range entries {
		path, err := normalizeMarkdownSessionPath(boxID, entry.Path)
		if err != nil {
			continue
		}
		entry.Notebook, entry.Path = boxID, path
		entry.Client = boundedMarkdownSessionClient(entry.Client)
		if entry.Mode != "source" {
			entry.Mode = "markdown"
		}
		entry.From = finiteNonNegative(entry.From)
		entry.To = finiteNonNegative(entry.To)
		entry.ScrollY = finiteNonNegative(entry.ScrollY)
		if math.IsNaN(entry.UpdatedAt) || math.IsInf(entry.UpdatedAt, 0) {
			entry.UpdatedAt = 0
		}
		slot := path + "\x00" + entry.Client
		if index, ok := bySlot[slot]; ok {
			if entry.UpdatedAt > normalized[index].UpdatedAt {
				normalized[index] = entry
			}
			continue
		}
		bySlot[slot] = len(normalized)
		normalized = append(normalized, entry)
	}
	sort.SliceStable(normalized, func(i, j int) bool { return normalized[i].UpdatedAt > normalized[j].UpdatedAt })
	if len(normalized) > markdownCursorPositionLimit {
		normalized = normalized[:markdownCursorPositionLimit]
	}
	return normalized
}

func loadMarkdownSessionStateUnlocked(boxID string) (*MarkdownSessionState, error) {
	state := &MarkdownSessionState{Recent: []MarkdownRecentNote{}, Positions: []MarkdownCursorPosition{}}
	raw, err := filelock.ReadFile(markdownSessionStatePath(boxID))
	if err != nil {
		if os.IsNotExist(err) {
			return state, nil
		}
		return nil, err
	}
	if err = json.Unmarshal(raw, state); err != nil {
		// Match the compatibility SessionManager: corrupted optional UI state is
		// ignored and replaced by the next successful touch.
		return &MarkdownSessionState{Recent: []MarkdownRecentNote{}, Positions: []MarkdownCursorPosition{}}, nil
	}
	state.Recent = normalizeMarkdownRecentNotes(boxID, state.Recent)
	state.Positions = normalizeMarkdownCursorPositions(boxID, state.Positions)
	return state, nil
}

func saveMarkdownSessionStateUnlocked(boxID string, state *MarkdownSessionState) error {
	state.Source = ""
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	statePath := markdownSessionStatePath(boxID)
	if err = os.MkdirAll(filepath.Dir(statePath), 0755); err != nil {
		return err
	}
	return filelock.WriteFile(statePath, raw)
}

func ReadMarkdownSession(boxID string) (*MarkdownSessionState, error) {
	if _, err := normalizeMarkdownSessionPath(boxID, "/session.md"); err != nil {
		return nil, err
	}
	markdownSessionStateLock.Lock()
	defer markdownSessionStateLock.Unlock()
	state, err := loadMarkdownSessionStateUnlocked(boxID)
	if err != nil {
		return nil, err
	}
	state.Source = "kernel-session"
	return state, nil
}

func TouchMarkdownRecentNote(entry MarkdownRecentNote) (*MarkdownSessionState, error) {
	boxID := strings.TrimSpace(entry.Notebook)
	path, err := normalizeMarkdownSessionPath(boxID, entry.Path)
	if err != nil {
		return nil, err
	}
	entry.Notebook, entry.Path = boxID, path
	if entry.OpenedAt == 0 || math.IsNaN(entry.OpenedAt) || math.IsInf(entry.OpenedAt, 0) {
		entry.OpenedAt = markdownSessionNow()
	}
	markdownSessionStateLock.Lock()
	defer markdownSessionStateLock.Unlock()
	state, err := loadMarkdownSessionStateUnlocked(boxID)
	if err != nil {
		return nil, err
	}
	state.Recent = normalizeMarkdownRecentNotes(boxID, append([]MarkdownRecentNote{entry}, state.Recent...))
	if err = saveMarkdownSessionStateUnlocked(boxID, state); err != nil {
		return nil, err
	}
	state.Source = "kernel-session"
	return state, nil
}

func TouchMarkdownCursorPosition(entry MarkdownCursorPosition) (*MarkdownSessionState, error) {
	boxID := strings.TrimSpace(entry.Notebook)
	path, err := normalizeMarkdownSessionPath(boxID, entry.Path)
	if err != nil {
		return nil, err
	}
	entry.Notebook, entry.Path = boxID, path
	entry.Client = boundedMarkdownSessionClient(entry.Client)
	if entry.UpdatedAt == 0 || math.IsNaN(entry.UpdatedAt) || math.IsInf(entry.UpdatedAt, 0) {
		entry.UpdatedAt = markdownSessionNow()
	}
	entries := []MarkdownCursorPosition{entry}
	if entry.Client != "" {
		fallback := entry
		fallback.Client = ""
		entries = append(entries, fallback)
	}
	markdownSessionStateLock.Lock()
	defer markdownSessionStateLock.Unlock()
	state, err := loadMarkdownSessionStateUnlocked(boxID)
	if err != nil {
		return nil, err
	}
	entries = append(entries, state.Positions...)
	state.Positions = normalizeMarkdownCursorPositions(boxID, entries)
	if err = saveMarkdownSessionStateUnlocked(boxID, state); err != nil {
		return nil, err
	}
	state.Source = "kernel-session"
	return state, nil
}
