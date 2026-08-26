// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package model

import (
	"errors"
	"fmt"
	"strings"

	"github.com/88250/lute/parse"
	"github.com/aaronhe/noema/kernel/conf"
	"github.com/aaronhe/noema/kernel/treenode"
)

// ErrMarkdownNativeDocumentTree marks operations whose contract is the
// SiYuan node-ID/.sy document tree. Repository-native Markdown documents use
// path/text and semantic-CAS APIs instead; sending their disposable blocktree
// projections through a native tree mutation could reformat source bytes or
// create invisible .sy files in the repository.
var ErrMarkdownNativeDocumentTree = errors.New("native document-tree operation is not supported for Markdown notebooks")

// RequireNativeDocumentTree rejects notebook IDs whose source of truth is
// repository-native Markdown. It is exported for API adapters that must stop
// before entering a legacy .sy-only filesystem traversal.
func RequireNativeDocumentTree(boxIDs ...string) error {
	return requireNativeDocumentTree(boxIDs...)
}

func requireNativeDocumentTree(boxIDs ...string) error {
	for _, boxID := range boxIDs {
		if conf.BoxKindMarkdown == GetBoxKind(boxID) {
			return fmt.Errorf("%w: notebook [%s]", ErrMarkdownNativeDocumentTree, boxID)
		}
	}
	return nil
}

// requireNativeBlockIDs rejects known block projections that belong to a
// repository-native Markdown notebook. Unknown/empty IDs are left to the
// caller's ordinary validation so AV operations that intentionally address a
// detached view keep their native compatibility behavior.
func requireNativeBlockIDs(blockIDs ...string) error {
	for _, blockID := range blockIDs {
		blockID = strings.TrimSpace(blockID)
		if "" == blockID {
			continue
		}
		if bt := treenode.GetBlockTree(blockID); nil != bt {
			if err := requireNativeDocumentTree(bt.BoxID); nil != err {
				return fmt.Errorf("block [%s]: %w", blockID, err)
			}
		}
	}
	return nil
}

// requireNativeAttributeViewMutation validates both the explicitly addressed
// blocks and every live carrier/mirror of an AV. AV mutations often fan out to
// all mirror blocks after changing the JSON model; preflighting the complete
// set prevents a mixed native/Markdown view from being only partly updated.
func requireNativeAttributeViewMutation(avID string, blockIDs ...string) error {
	ids := append([]string{}, blockIDs...)
	if "" != strings.TrimSpace(avID) {
		ids = append(ids, treenode.GetMirrorAttrViewBlockIDs(avID)...)
	}
	return requireNativeBlockIDs(ids...)
}

func validateNativeTransactions(transactions []*Transaction) error {
	for transactionIndex, transaction := range transactions {
		if nil == transaction {
			continue
		}
		for operationIndex, operation := range transaction.DoOperations {
			if nil == operation {
				continue
			}
			checkTree := func(tree *parse.Tree) error {
				if nil == tree {
					return nil
				}
				return requireNativeDocumentTree(tree.Box)
			}
			if tree, ok := operation.Data.(*parse.Tree); ok {
				if err := checkTree(tree); nil != err {
					return fmt.Errorf("transaction %d operation %d: %w", transactionIndex, operationIndex, err)
				}
			}
			if err := checkTree(operation.Tree); nil != err {
				return fmt.Errorf("transaction %d operation %d: %w", transactionIndex, operationIndex, err)
			}

			ids := []string{operation.ID, operation.RootID, operation.ParentID, operation.PreviousID, operation.NextID, operation.BlockID}
			ids = append(ids, operation.BlockIDs...)
			ids = append(ids, operation.SrcIDs...)
			for _, source := range operation.Srcs {
				if id, ok := source["id"].(string); ok {
					ids = append(ids, id)
				}
			}
			if err := requireNativeBlockIDs(ids...); nil != err {
				return fmt.Errorf("transaction %d operation %d: %w", transactionIndex, operationIndex, err)
			}
			if err := requireNativeAttributeViewMutation(operation.AvID); nil != err {
				return fmt.Errorf("transaction %d operation %d: %w", transactionIndex, operationIndex, err)
			}
			if err := requireNativeAttributeViewContents(operation.AvID); nil != err {
				return fmt.Errorf("transaction %d operation %d: %w", transactionIndex, operationIndex, err)
			}
		}
	}
	return nil
}
