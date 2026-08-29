// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package identity

import (
	"crypto/sha512"
	"encoding/binary"
	"time"
)

// blockProjectionEpoch and blockProjectionWindow bound the instants a block key
// may claim. A century of seconds is ~31.6 bits, which is where most of this
// key's entropy comes from.
var blockProjectionEpoch = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)

const (
	blockProjectionWindowSeconds = int64(100 * 365.25 * 24 * 3600)
	blockProjectionAlphabet      = "0123456789abcdefghijklmnopqrstuvwxyz"
	blockProjectionSuffixLen     = 7
)

// BlockProjectionID mints a deterministic, disposable index key for a Markdown
// block that carries no anchor of its own.
//
// It cannot reuse ProjectionID. That function's 14-digit prefix is a *synthetic*
// stamp derived from the canonical identity, and a document with no {#uuid}
// anchor — which is nearly every Noema note — gets the constant
// "20000101000000". The prefix therefore contributes no entropy and the key is
// only as wide as its 28-bit hex suffix. That is ample for one key per document
// and far too narrow for one per block: a vault with 100k blocks would expect
// collisions outright, and a collision is not benign, because deleteBlocksByIDs
// would let one document's save remove another document's index row.
//
// So both halves are derived here, and the suffix uses the full lowercase
// alphanumeric alphabet the id shape allows rather than hex. That is ~68 bits
// inside the exact 22-character shape ast.IsNodeIDPattern requires.
//
// The stamp is date-shaped so util.TimeFromID and the ParseInLocation callers
// keep working, but — exactly like ProjectionID's "20000101000000" — it is an
// artifact of the key and never a creation time. Nothing may present it as one.
func BlockProjectionID(seed string) string {
	digest := sha512.Sum512([]byte("noema-block-projection\x00" + seed))

	offset := int64(binary.BigEndian.Uint64(digest[0:8]) % uint64(blockProjectionWindowSeconds))
	stamp := blockProjectionEpoch.Add(time.Duration(offset) * time.Second).Format("20060102150405")

	remainder := binary.BigEndian.Uint64(digest[8:16])
	suffix := make([]byte, blockProjectionSuffixLen)
	for i := blockProjectionSuffixLen - 1; i >= 0; i-- {
		suffix[i] = blockProjectionAlphabet[remainder%uint64(len(blockProjectionAlphabet))]
		remainder /= uint64(len(blockProjectionAlphabet))
	}
	return stamp + "-" + string(suffix)
}
