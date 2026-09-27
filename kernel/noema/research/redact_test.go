package research

import (
	"strings"
	"testing"
)

func TestRedactSecrets(t *testing.T) {
	cases := map[string]string{
		`export OPENAI_API_KEY=sk-proj-abcdefghijklmnop`:         `export OPENAI_API_KEY=[REDACTED SECRET]`,
		`{"api_key": "abc123def456"}`:                          `{"api_key": "[REDACTED SECRET]"}`,
		`password: hunter2hunter2`:                             `password: [REDACTED SECRET]`,
		`curl -H "Authorization: Bearer abcdefghijklmnop1234"`: `curl -H "Authorization: Bearer [REDACTED SECRET]"`,
		`gh --token ghp_abcdefghijklmnopqrstu`:                 `gh --token [REDACTED SECRET]`,
		`uses AKIAABCDEFGHIJKLMNOP here`:                       `uses [REDACTED SECRET] here`,
		`401 Unauthorized: invalid api key`:                    `401 Unauthorized: invalid api key`,
		`the token budget is 4000 tokens`:                      `the token budget is 4000 tokens`,
	}
	for input, want := range cases {
		if got := RedactSecrets(input); got != want {
			t.Errorf("RedactSecrets(%q) = %q, want %q", input, got, want)
		}
	}
	key := "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----"
	if got := RedactSecrets("key:\n" + key); strings.Contains(got, "AAAA") {
		t.Errorf("private key survived: %q", got)
	}
	if again := RedactSecrets(RedactSecrets(`password: "x"`)); again != `password: "[REDACTED SECRET]"` {
		t.Errorf("redaction must be idempotent: %q", again)
	}
}
