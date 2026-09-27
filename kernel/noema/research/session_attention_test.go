package research

import (
	"testing"
	"time"
)

func TestSessionAttentionRules(t *testing.T) {
	finished := "2026-09-28T10:00:00.000Z"
	cases := []struct {
		status, readAt       string
		unread, failed, need bool
		reason               string
	}{
		{"running", "", false, false, false, ""},
		{"waiting_permission", "", false, false, true, "permission"},
		{"waiting_input", "", false, false, true, "input"},
		{"completed", "", true, false, false, ""},
		{"completed", "2026-09-28T10:00:01.000Z", false, false, false, ""},
		{"completed", "2026-09-28T09:59:59.000Z", true, false, false, ""},
		// Reading a failure is not resolving it.
		{"failed", "2026-09-28T10:00:01.000Z", false, true, true, "failed"},
		{"interrupted", "", true, true, true, "failed"},
		// A cancel is the person's own act.
		{"cancelled", "", false, false, false, ""},
	}
	for _, c := range cases {
		name := SessionName{ReadAt: c.readAt}
		sessionAttention(&name, Run{Status: c.status, FinishedAt: finished})
		if name.Unread != c.unread || name.Failed != c.failed || name.NeedsAttention != c.need || name.AttentionReason != c.reason {
			t.Errorf("%s read=%q: got unread=%v failed=%v need=%v reason=%q", c.status, c.readAt,
				name.Unread, name.Failed, name.NeedsAttention, name.AttentionReason)
		}
	}
}

func TestMarkSessionNameReadClearsUnreadOnly(t *testing.T) {
	store, root := openTestStore(t)
	session := promoteNamedTestSession(t, store, root, "native-attention", "")
	intent := &SessionNameIntent{Name: "attention", Agent: "codex", Origin: "user"}
	run, err := preparePromptRun(t, store, root, session.WorkstreamID, session.ID, intent)
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.GetSessionName("attention")
	if err != nil {
		t.Fatal(err)
	}
	finishedMs := time.Now().UTC().Add(-time.Second).UnixMilli()
	if _, err := store.db.Exec(`UPDATE runs SET status = 'failed', finished_at = ? WHERE id = ?`, finishedMs, run.ID); err != nil {
		t.Fatal(err)
	}
	name, err := store.GetSessionName("attention")
	if err != nil || !name.Unread || !name.Failed || name.AttentionReason != "failed" {
		t.Fatalf("a failed Run must be unread and need attention: %+v (%v)", name, err)
	}
	read, err := store.MarkSessionNameRead(ReadSessionNameInput{Name: "attention", Actor: "emacs"})
	if err != nil {
		t.Fatal(err)
	}
	if read.Unread || !read.Failed || !read.NeedsAttention || read.ReadAt == "" {
		t.Fatalf("reading clears unread but not the failure: %+v", read)
	}
	if read.UpdatedAt != before.UpdatedAt {
		t.Fatalf("reading is not activity: updated %s -> %s", before.UpdatedAt, read.UpdatedAt)
	}
	if _, err := store.MarkSessionNameRead(ReadSessionNameInput{Name: "missing"}); err == nil {
		t.Fatal("reading an unknown name must fail")
	}
}
