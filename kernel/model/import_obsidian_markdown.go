// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema Markdown-native Obsidian import additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package model

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/filesys"
	"github.com/aaronhe/noema/kernel/util"
	"github.com/google/uuid"
	"github.com/siyuan-note/filelock"
)

// StartObsidianVaultMarkdownImport commits an analyzed Vault into an existing
// external Markdown box. The complete import is staged under the destination
// parent and exposed with one directory rename, so cancellation or conversion
// failure never leaves a half-imported tree in the note repository.
func StartObsidianVaultMarkdownImport(taskID, boxID, destination string) (*ObsidianVaultTask, error) {
	if conf.BoxKindMarkdown != GetBoxKind(boxID) {
		return nil, fmt.Errorf("box [%s] is not a Markdown box", boxID)
	}
	destination, err := normalizedObsidianMarkdownDestination(boxID, destination)
	if err != nil {
		return nil, err
	}

	obsidianTasksMu.Lock()
	task := obsidianTasks[taskID]
	if task == nil || task.State != ObsidianTaskStateReady || task.Context == nil {
		obsidianTasksMu.Unlock()
		return nil, errors.New(Conf.Language(332))
	}
	if time.Now().After(task.ExpiresAt) {
		finishObsidianTaskLocked(task, ObsidianTaskStateCancelled, "Analysis expired", "")
		obsidianTasksMu.Unlock()
		return nil, errors.New(Conf.Language(332))
	}
	ctx, cancel := context.WithCancel(context.Background())
	task.Cancel = cancel
	task.State = ObsidianTaskStateRevalidating
	task.Progress = 1
	task.Message = "Revalidating source files"
	ret := snapshotObsidianTask(task)
	obsidianTasksMu.Unlock()

	go importObsidianVaultMarkdownTask(ctx, taskID, boxID, destination)
	return ret, nil
}

func normalizedObsidianMarkdownDestination(boxID, destination string) (string, error) {
	clean, err := filesys.ValidateBoxRelativePath(boxID, destination)
	if err != nil {
		return "", err
	}
	clean = filepath.ToSlash(strings.Trim(clean, "/"))
	if clean == "" {
		return "", errors.New("Obsidian import destination must not be the repository root")
	}
	for _, part := range strings.Split(clean, "/") {
		if part == "" || strings.HasPrefix(part, ".") {
			return "", errors.New("Obsidian import destination must not contain hidden path components")
		}
	}
	return clean, nil
}

func importObsidianVaultMarkdownTask(ctx context.Context, taskID, boxID, destination string) {
	obsidianTasksMu.Lock()
	task := obsidianTasks[taskID]
	if task == nil || task.Context == nil || isObsidianTerminalState(task.State) {
		obsidianTasksMu.Unlock()
		return
	}
	vault := task.Context
	obsidianTasksMu.Unlock()

	if err := revalidateObsidianVault(ctx, vault); err != nil {
		if !errors.Is(err, context.Canceled) {
			failObsidianTask(taskID, "revalidating", err, nil)
		}
		return
	}
	root := filesys.BoxRootPath(boxID)
	destinationAbs := filepath.Join(root, filepath.FromSlash(destination))
	if _, err := os.Lstat(destinationAbs); !errors.Is(err, os.ErrNotExist) {
		if err == nil {
			failObsidianTask(taskID, "staging", fmt.Errorf("destination already exists: %s", destination), nil)
		} else {
			failObsidianTask(taskID, "staging", err, nil)
		}
		return
	}
	if !updateObsidianTask(taskID, ObsidianTaskStateStaging, 10, "Converting Markdown") {
		return
	}
	parent := filepath.Dir(destinationAbs)
	if err := os.MkdirAll(parent, 0755); err != nil {
		failObsidianTask(taskID, "staging", err, nil)
		return
	}
	stage := filepath.Join(parent, ".noema-obsidian-"+taskID+".tmp")
	_ = os.RemoveAll(stage)
	if err := os.Mkdir(stage, 0755); err != nil {
		failObsidianTask(taskID, "staging", err, nil)
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.RemoveAll(stage)
		}
	}()

	blockIDs, err := allocateObsidianMarkdownBlockIDs(vault)
	if err != nil {
		failObsidianTask(taskID, "staging", err, nil)
		return
	}
	files := make([]*obsidianSourceFile, 0, len(vault.Files))
	for _, file := range vault.Files {
		files = append(files, file)
	}
	sort.Slice(files, func(i, j int) bool { return strings.ToLower(files[i].RelPath) < strings.ToLower(files[j].RelPath) })
	result := &ObsidianVaultImportResult{
		NotebookID: boxID, NotebookName: destination, Destination: destination, Source: "noema-markdown",
		MarkdownCount: vault.Analysis.MarkdownCount, ImportedAttachmentCount: len(vault.ImportAssets),
		UnreferencedFileCount:    vault.Analysis.UnreferencedFileCount,
		PreservedUnresolvedCount: vault.Analysis.MissingCount + vault.Analysis.UnsupportedCount,
		SkippedPathCount: vault.Analysis.SkippedHiddenCount + vault.Analysis.SkippedLinkCount +
			vault.Analysis.SkippedSpecialCount + vault.Analysis.SkippedNestedVaultCount,
	}
	indexPaths := []string{}
	for index, source := range files {
		if err = ctx.Err(); err != nil {
			return
		}
		destinationFile := filepath.Join(stage, filepath.FromSlash(source.RelPath))
		if err = os.MkdirAll(filepath.Dir(destinationFile), 0755); err != nil {
			failObsidianTask(taskID, "staging", err, nil)
			return
		}
		if source.IsMD {
			data, readErr := readStableObsidianFile(source)
			if readErr != nil {
				failObsidianTask(taskID, "staging", newObsidianReadUserError(source, readErr), nil)
				return
			}
			doc := vault.DocsByRel[obsidianPathKey(strings.TrimSuffix(source.RelPath, filepath.Ext(source.RelPath)))]
			converted, links, embeds := transformObsidianMarkdownNative(vault, doc, data, blockIDs)
			result.ConvertedLinkCount += links
			result.ConvertedEmbedCount += embeds
			if err = filelock.WriteFile(destinationFile, converted); err != nil {
				failObsidianTask(taskID, "staging", err, nil)
				return
			}
			indexPaths = append(indexPaths, boxID+"/"+path.Join(destination, filepath.ToSlash(source.RelPath)))
		} else {
			if err = copyStableObsidianFile(source, destinationFile); err != nil {
				failObsidianTask(taskID, "staging", newObsidianUserError(348, source.RelPath, err), nil)
				return
			}
		}
		updateObsidianTask(taskID, ObsidianTaskStateStaging, 10+(index+1)*70/maxInt(len(files), 1), "Staging Vault files")
	}
	if err = ctx.Err(); err != nil {
		return
	}
	if !updateObsidianTask(taskID, ObsidianTaskStateWriting, 84, "Committing Markdown import") {
		return
	}
	if err = filelock.Rename(stage, destinationAbs); err != nil {
		failObsidianTask(taskID, "writing", err, result)
		return
	}
	committed = true
	if !updateObsidianTask(taskID, ObsidianTaskStateIndexing, 92, "Indexing imported notes") {
		return
	}
	UpsertIndexes(indexPaths)
	util.PushReloadFiletree()

	obsidianTasksMu.Lock()
	if current := obsidianTasks[taskID]; current != nil && !isObsidianTerminalState(current.State) {
		current.Result = result
		finishObsidianTaskLocked(current, ObsidianTaskStateCompleted, "Markdown import completed", "")
	}
	obsidianTasksMu.Unlock()
}

func allocateObsidianMarkdownBlockIDs(vault *obsidianVaultContext) (map[string]map[string]string, error) {
	ret := map[string]map[string]string{}
	for _, doc := range vault.Docs {
		if doc.Synthetic || doc.Source == nil {
			continue
		}
		data, err := readStableObsidianFile(doc.Source)
		if err != nil {
			return nil, err
		}
		scan := scanObsidianSource(data)
		ids := map[string]string{}
		for _, legacy := range scan.BlockIDs {
			if scan.Duplicates[legacy] {
				continue
			}
			id, idErr := uuid.NewV7()
			if idErr != nil {
				return nil, idErr
			}
			ids[legacy] = id.String()
		}
		ret[obsidianPathKey(doc.RelPath)] = ids
	}
	return ret, nil
}

func transformObsidianMarkdownNative(vault *obsidianVaultContext, current *obsidianDocPlan, source []byte,
	blockIDs map[string]map[string]string) (ret []byte, convertedLinks, convertedEmbeds int) {
	if current == nil {
		return source, 0, 0
	}
	scan := scanObsidianSource(source)
	ret = append([]byte(nil), source...)
	for index := len(scan.Wikis) - 1; index >= 0; index-- {
		token := scan.Wikis[index]
		replacement, converted := nativeObsidianWikiReplacement(vault, current, token, blockIDs)
		if !converted {
			continue
		}
		ret = append(append(append([]byte{}, ret[:token.Start]...), replacement...), ret[token.End:]...)
		convertedLinks++
		if token.Embed {
			convertedEmbeds++
		}
	}
	ids := blockIDs[obsidianPathKey(current.RelPath)]
	matches := obsidianBlockIDPattern.FindAllSubmatchIndex(ret, -1)
	for index := len(matches) - 1; index >= 0; index-- {
		match := matches[index]
		if len(match) < 4 {
			continue
		}
		legacy := string(ret[match[2]:match[3]])
		canonical := ids[legacy]
		if canonical == "" {
			continue
		}
		ret = append(append(append([]byte{}, ret[:match[2]-1]...), []byte("{#"+canonical+"}")...), ret[match[3]:]...)
	}
	return ret, convertedLinks, convertedEmbeds
}

func nativeObsidianWikiReplacement(vault *obsidianVaultContext, current *obsidianDocPlan, token obsidianWikiToken,
	blockIDs map[string]map[string]string) ([]byte, bool) {
	if hash := strings.Index(token.Target, "#^"); hash >= 0 {
		docTarget := strings.TrimSuffix(token.Target[:hash], filepath.Ext(token.Target[:hash]))
		doc, status := resolveObsidianDocument(vault, current, docTarget)
		if (status == "resolved" || status == "ambiguous") && doc != nil {
			legacy := strings.TrimSpace(token.Target[hash+2:])
			if canonical := blockIDs[obsidianPathKey(doc.RelPath)][legacy]; canonical != "" {
				label := strings.TrimSpace(token.Alias)
				if label == "" {
					label = doc.Title
				}
				return []byte("((" + canonical + " \"" + strings.ReplaceAll(label, "\"", "\\\"") + "\"))"), true
			}
		}
		return nil, false
	}
	resolved := resolveObsidianTarget(vault, current, token.Target)
	label := strings.TrimSpace(token.Alias)
	if resolved.Doc != nil && resolved.Status == "resolved" && resolved.Doc.Source != nil {
		if label == "" {
			label = resolved.Doc.Title
		}
		destination := relativeObsidianMarkdownDestination(current.Source.RelPath, resolved.Doc.Source.RelPath)
		if hash := strings.Index(token.Target, "#"); hash >= 0 && hash+1 < len(token.Target) {
			destination += "#" + url.PathEscape(strings.TrimSpace(token.Target[hash+1:]))
		}
		return []byte("[" + escapeMarkdownLinkLabel(label) + "](" + destination + ")"), true
	}
	if resolved.Asset != nil && resolved.Status == "resolved" {
		if label == "" {
			label = path.Base(resolved.Asset.Source.RelPath)
		}
		destination := relativeObsidianMarkdownDestination(current.Source.RelPath, resolved.Asset.Source.RelPath)
		prefix := ""
		if token.Embed && markdownImageExtensions[strings.ToLower(path.Ext(resolved.Asset.Source.RelPath))] {
			prefix = "!"
		}
		return []byte(prefix + "[" + escapeMarkdownLinkLabel(label) + "](" + destination + ")"), true
	}
	return nil, false
}

func relativeObsidianMarkdownDestination(source, target string) string {
	rel, err := filepath.Rel(filepath.Dir(filepath.FromSlash(source)), filepath.FromSlash(target))
	if err != nil {
		rel = filepath.FromSlash(target)
	}
	encoded := url.PathEscape(filepath.ToSlash(rel))
	return strings.ReplaceAll(encoded, "%2F", "/")
}

func escapeMarkdownLinkLabel(value string) string {
	return strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]").Replace(value)
}
