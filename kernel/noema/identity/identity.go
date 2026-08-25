// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

// Package identity owns Noema's portable UUIDv7 checks and the deterministic,
// disposable SiYuan-shaped keys used by the inherited kernel indexes.
package identity

import (
	"crypto/sha256"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var (
	uuidV7Pattern       = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	legacyNodeIDPattern = regexp.MustCompile(`^[0-9]{14}-[0-9a-z]{7}$`)
)

func IsUUIDv7(value string) bool {
	return uuidV7Pattern.MatchString(strings.TrimSpace(value))
}

func IsLegacyNodeID(value string) bool {
	return legacyNodeIDPattern.MatchString(strings.TrimSpace(value))
}

// ProjectionID maps a portable identity to the shape required by inherited
// SiYuan indexes. The result is deterministic and disposable: callers must
// never serialize it into Markdown or expose it as Noema identity.
//
// fallbackSeed is used only when canonical is empty (for provisional pages).
func ProjectionID(canonical, fallbackSeed string) string {
	canonical = strings.TrimSpace(canonical)
	seed := canonical
	stamp := "20000101000000"
	if "" == seed {
		seed = fallbackSeed
	} else if IsUUIDv7(canonical) {
		compact := strings.ReplaceAll(strings.ToLower(canonical), "-", "")
		if millis, err := strconv.ParseUint(compact[:12], 16, 64); nil == err {
			stamp = time.UnixMilli(int64(millis)).UTC().Format("20060102150405")
		}
	} else if IsLegacyNodeID(canonical) {
		stamp = canonical[:14]
	}
	digest := sha256.Sum256([]byte(seed))
	return stamp + "-" + fmt.Sprintf("%x", digest[:4])[:7]
}
