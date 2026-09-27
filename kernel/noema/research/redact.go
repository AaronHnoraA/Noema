// Noema research secret redaction is Copyright (c) 2026 Aaron He and
// distributed under the AGPL-3.0-or-later terms of the Noema kernel.

package research

import (
	"regexp"
	"strings"
)

// RedactedSecret replaces a value that looks like a credential.
const RedactedSecret = "[REDACTED SECRET]"

// Adapted from Pisper's runtime/security/secret-redaction.mjs (MIT).  RE2 has
// no back-references or look-around, so quoted values are two alternatives
// and "already redacted" is checked in the replacement.  Redaction applies
// where Noema makes a copy that outlives the moment -- the history index and
// recorded failure reasons -- never to an agent's own transcript or to CAS
// evidence, which stay exact.
const secretKey = `(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|auth[_ -]?token|client[_ -]?secret|app[_ -]?secret|secret[_ -]?key|password|passwd|authorization|cookie|credentials?|x-api-key)`

var (
	quotedSecret = regexp.MustCompile(`(?i)(["']?` + secretKey + `["']?\s*[:=]\s*)(?:"([^"\r\n]*)"|'([^'\r\n]*)')`)
	plainSecret  = regexp.MustCompile(`(?im)((?:^|[\s,{;(])` + secretKey + `\s*[:=]\s*)([^\s,;}\]"']+)`)
	cliSecret    = regexp.MustCompile(`(?i)(--?` + secretKey + `(?:=|\s+))([^\s"']+)`)
	envSecret    = regexp.MustCompile(`(?m)(\b[A-Z][A-Z0-9_]*(?:API_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIALS?)\s*=\s*)([^\s"']+|"[^"\r\n]*"|'[^'\r\n]*')`)
	bearerToken  = regexp.MustCompile(`(?i)\b(Bearer\s+)([A-Za-z0-9._~+/=-]{12,})`)
	shapedToken  = regexp.MustCompile(`\b(?:(?:sk|rk|pk|ghp|gho|ghs|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16})\b`)
	privateKey   = regexp.MustCompile(`(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----`)
)

// RedactSecrets replaces credential-looking values in TEXT.
func RedactSecrets(text string) string {
	if text == "" {
		return text
	}
	text = privateKey.ReplaceAllString(text, RedactedSecret)
	text = quotedSecret.ReplaceAllStringFunc(text, func(match string) string {
		parts := quotedSecret.FindStringSubmatch(match)
		quote := `"`
		if parts[3] != "" || strings.HasSuffix(match, "'") {
			quote = "'"
		}
		return parts[1] + quote + RedactedSecret + quote
	})
	for _, pattern := range []*regexp.Regexp{plainSecret, cliSecret, envSecret, bearerToken} {
		text = pattern.ReplaceAllStringFunc(text, func(match string) string {
			parts := pattern.FindStringSubmatch(match)
			if strings.HasPrefix(parts[2], "[REDACTED") {
				return match
			}
			return parts[1] + RedactedSecret
		})
	}
	return shapedToken.ReplaceAllString(text, RedactedSecret)
}
