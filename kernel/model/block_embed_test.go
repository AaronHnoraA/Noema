// Copyright (c) 2026, peterq.cn (b3log.org)
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

package model

import (
	"testing"

	"github.com/88250/lute/ast"
	"github.com/aaronhe/noema/kernel/sql"
	"github.com/aaronhe/noema/kernel/treenode"
)

func TestFilterEmbedBlocksByAccess(t *testing.T) {
	const (
		publicDocID    = "20260725000001-public1"
		hiddenDocID    = "20260725000002-hidden1"
		forbiddenDocID = "20260725000003-forbid"
	)
	blocks := []*sql.Block{
		{ID: publicDocID},
		{ID: hiddenDocID},
		{ID: forbiddenDocID},
	}

	if filtered := filterEmbedBlocksByAccess(blocks, nil); len(filtered) != len(blocks) {
		t.Fatalf("a nil access checker should leave results unchanged: %+v", filtered)
	}

	inaccessible := map[string]bool{hiddenDocID: true, forbiddenDocID: true}
	accessChecker := func(blockID string) bool {
		return !inaccessible[blockID]
	}

	filtered := filterEmbedBlocksByAccess(blocks, accessChecker)
	if 1 != len(filtered) || publicDocID != filtered[0].ID {
		t.Fatalf("inaccessible embed results should be removed: %+v", filtered)
	}
}

func TestNewEmbeddedBlockIncludesSourceRootID(t *testing.T) {
	const (
		blockID = "20260729150000-block01"
		rootID  = "20260729150001-root001"
	)
	def := &ast.Node{
		ID:   blockID,
		Type: ast.NodeParagraph,
		Box:  "20260729150002-box0001",
		Path: "/" + rootID + ".sy",
	}
	blockTree := &treenode.BlockTree{
		RootID: rootID,
		HPath:  "/Source document",
	}

	block := newEmbeddedBlock(def, blockTree, "<div>content</div>", "content")
	if rootID != block.RootID {
		t.Fatalf("embedded block root ID = %q, want %q", block.RootID, rootID)
	}
}
