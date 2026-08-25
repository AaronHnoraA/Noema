// SiYuan - From thought to insight, with agents
// Copyright (c) 2020-present, b3log.org
//
// Noema external markdown-box routing additions are Copyright (c) 2026
// Aaron He and distributed under the same AGPL-3.0-or-later terms.

package filesys

import (
	"path/filepath"
	"strings"

	"github.com/aaronhe/noema/kernel/util"
)

// BoxRootProvider is injected by model for external Markdown boxes. Keeping
// the callback here avoids a filesys -> model import cycle. An empty or
// relative provider result is rejected and falls back to SiYuan's canonical
// workspace data directory.
var BoxRootProvider func(boxID string) string

// BoxRootPath returns the physical content root for a box. For normal .sy and
// workspace-owned Markdown boxes this is <DataDir>/<boxID>. External Markdown
// boxes keep only a shadow configuration there; their content remains at the
// registered absolute repository path.
func BoxRootPath(boxID string) string {
	if nil != BoxRootProvider {
		if root := strings.TrimSpace(BoxRootProvider(boxID)); "" != root && filepath.IsAbs(root) {
			return filepath.Clean(root)
		}
	}
	return filepath.Join(util.DataDir, boxID)
}
