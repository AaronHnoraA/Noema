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

package model

import (
	"github.com/aaronhe/noema/kernel/av"
	"github.com/aaronhe/noema/kernel/treenode"
	"github.com/gin-gonic/gin"
)

// Noema fork: the public-publish feature (model/publish_access.go,
// publish_resource_access.go, server/proxy/publish.go) is removed — Noema
// is single-user Emacs+Tauri and publishes through its own existing
// export/render pipeline, not a per-block public-visitor access-control
// layer. This file keeps every exported symbol the ~20 api/*.go and
// model/*.go call sites still reference, as always-allow / identity-filter
// stubs, so none of those call sites need editing.

type PublishAccessItem struct {
	ID       string `json:"id"`
	Visible  bool   `json:"visible"`
	Password string `json:"password"`
	Disable  bool   `json:"disable"`
}

type PublishAccess []*PublishAccessItem

type PublishAccessStatus int

const (
	PublishAccessAllowed PublishAccessStatus = iota
	PublishAccessPasswordRequired
	PublishAccessDenied
)

func GetPublishAccess() PublishAccess                                       { return PublishAccess{} }
func SetPublishAccess(PublishAccess) error                                  { return nil }
func GetInvisiblePublishAccess(PublishAccess) PublishAccess                 { return PublishAccess{} }
func GetDisablePublishAccess(PublishAccess) PublishAccess                   { return PublishAccess{} }
func IsEncryptedBoxDeniedByPublishAccess(string) bool                       { return false }
func PurgePublishAccess()                                                   {}
func CheckPathAccessableByPublishIgnore(string, string, PublishAccess) bool { return true }
func IsEncryptedPublishRuntimeTarget(string) bool                           { return false }
func IsEncryptedPublishAccessTarget(string) bool                            { return false }
func GetPathPasswordByPublishAccess(string, string, PublishAccess) (string, string) {
	return "", ""
}

func CheckBlockIdAccessableByPublishAccess(*gin.Context, PublishAccess, string) bool { return true }
func CheckBlockIdAccessableByPublishAccessInBox(*gin.Context, PublishAccess, string, string) bool {
	return true
}
func CheckBlockIdMetadataAccessableByPublishAccess(*gin.Context, PublishAccess, string) bool {
	return true
}
func CheckBlockIdMetadataAccessableByPublishAccessInBox(*gin.Context, PublishAccess, string, string) bool {
	return true
}
func CheckBlockTreeMetadataAccessableByPublishAccess(*gin.Context, PublishAccess, *treenode.BlockTree) bool {
	return true
}
func CheckBlockIdDiscoverableByPublishAccessInBox(PublishAccess, string, string) bool { return true }
func CheckBlockTreeDiscoverableByPublishAccess(PublishAccess, *treenode.BlockTree) bool {
	return true
}
func GetBlockTreePublishAccessStatus(*gin.Context, PublishAccess, *treenode.BlockTree) PublishAccessStatus {
	return PublishAccessAllowed
}
func SetPublishAuthCookie(*gin.Context, string, string)                              {}
func CheckPublishAuthCookie(*gin.Context, string, string) bool                       { return true }
func CheckAbsPathAccessableByPublishAccess(*gin.Context, string, PublishAccess) bool { return true }

func CheckAttributeViewAccessableByPublishAccess(*gin.Context, PublishAccess, string) bool {
	return true
}
func CheckAttributeViewBlockAccessableByPublishAccess(*gin.Context, PublishAccess, string, string) bool {
	return true
}

func FilterViewByPublishAccess(_ *gin.Context, _ PublishAccess, viewable av.Viewable) av.Viewable {
	return viewable
}
func FilterAttributeViewByPublishAccess(_ *gin.Context, _ PublishAccess, _, _ string, viewable av.Viewable) av.Viewable {
	return viewable
}
func FilterBlockAttributeViewKeysByPublishAccess(_ *gin.Context, _ PublishAccess, keys []*BlockAttributeViewKeys) []*BlockAttributeViewKeys {
	return keys
}
func FilterAttributeViewBacklinksByPublishAccess(_ *gin.Context, _ PublishAccess, backlinks *AttributeViewBacklinks) *AttributeViewBacklinks {
	return backlinks
}
func FilterBlockInfoByPublishAccess(_ *gin.Context, _ PublishAccess, info *BlockInfo) *BlockInfo {
	return info
}
func FilterContentByPublishAccess(_ *gin.Context, _ PublishAccess, _ string, _ string, content string, _ bool) string {
	return content
}
func FilterContentByPublishAccessWithStatus(_ *gin.Context, _ PublishAccess, _ string, _ string, content string, _ bool) (string, PublishAccessStatus) {
	return content, PublishAccessAllowed
}
func FilterEmbedBlocksByPublishAccess(_ *gin.Context, _ PublishAccess, embedBlocks []*EmbedBlock) []*EmbedBlock {
	return embedBlocks
}
func FilterPathsByPublishAccess(_ *gin.Context, _ PublishAccess, paths []*Path) []*Path { return paths }
func FilterBlocksByPublishAccess(_ *gin.Context, _ PublishAccess, blocks []*Block) []*Block {
	return blocks
}
func FilterSearchDocsByPublishAccess(_ *gin.Context, _ PublishAccess, docs []map[string]string) []map[string]string {
	return docs
}
func FilterRefDefsByPublishAccess(_ *gin.Context, _ PublishAccess, refDefs []*RefDefs) ([]*RefDefs, map[string]string) {
	return refDefs, map[string]string{}
}
func FilterRefIDsByPublishAccess(_ *gin.Context, _ PublishAccess, refIDs []string) []string {
	return refIDs
}
func FilterGraphByPublishAccess(_ *gin.Context, _ PublishAccess, nodes []*GraphNode, links []*GraphLink) ([]*GraphNode, []*GraphLink) {
	return nodes, links
}
func FilterTagsByPublishAccess(_ *gin.Context, _ PublishAccess, tags *Tags) *Tags { return tags }
func FilterLocalStorageByPublishAccess(localStorage map[string]any) map[string]any {
	return localStorage
}
func FilterAssetContentByPublishAccess(_ *gin.Context, _ PublishAccess, assetContent []*AssetContent) []*AssetContent {
	return assetContent
}
func FilterRecentDocsByPublishAccess(_ *gin.Context, _ PublishAccess, recentDocs []*RecentDoc) []*RecentDoc {
	return recentDocs
}
func FilterCriteriaByPublishAccess(_ *gin.Context, _ PublishAccess, criteria []*Criterion) []*Criterion {
	return criteria
}

// publish_resource_access.go's exports (theme/plugin/widget/snippet/emoji
// resources referenced from published pages).
func CheckSnippetAccessableInPublish(string, string) (found, accessable bool) { return true, true }
func CheckPluginAccessableInPublish(string) bool                              { return true }
func CheckWidgetAccessableInPublish(string) bool                              { return true }
func CheckWidgetAccessableByPublishAccess(*gin.Context, string, PublishAccess) bool {
	return true
}
func CheckEmojiAccessableByPublishAccess(*gin.Context, string, PublishAccess) bool { return true }

// isPetalAccessableInPublish's isPublish gate (model/plugin.go's loadPetals)
// is always false now since IsReadOnlyRoleContext always returns false, so
// this is unreachable in practice; kept only so loadPetals still compiles.
func isPetalAccessableInPublish(*Petal, bool, bool) bool { return true }

// invalidateEncryptedPublishAccessCache was an unconditional cache-bust
// hook called from model/box.go and model/crypto.go whenever an encrypted
// notebook's mount state changed, so PublishAccess's encrypted-box listing
// stayed fresh. No-op now that PublishAccess itself is a stub.
func invalidateEncryptedPublishAccessCache() {}
