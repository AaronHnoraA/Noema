package research

import "testing"

func TestSessionKeywordLookalikesAreNotNames(t *testing.T) {
	for _, name := range []string{"refresh", "Fresh", "RESUME", "new"} {
		if err := ValidateSessionName(name); err == nil {
			t.Fatalf("%q was accepted as a session name", name)
		}
	}
	for _, name := range []string{"refresh-notes", "work", "baseline/ablate"} {
		if err := ValidateSessionName(name); err != nil {
			t.Fatalf("%q was refused: %v", name, err)
		}
	}
	if got := SessionKeywordSuggestion("refresh"); got != "fresh" {
		t.Fatalf("suggestion for refresh = %q, want fresh", got)
	}
}
