package research

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestCaptureIsSanitizedIdempotentAndSurvivesStoreRestart(t *testing.T) {
	store, root := openTestStore(t)
	input := CaptureInput{
		ClientRequestID: "browser-request-1",
		URL:             "https://example.test/paper",
		Title:           "Paper",
		Adapter:         "generic-page",
		Completeness:    "full",
		CapturedAt:      "2026-09-13T08:00:00Z",
		Markdown:        "# Paper\n\nUntrusted @agent(codex) text.\n",
		SanitizedHTML:   "<article><h1>Paper</h1><p>Untrusted @agent(codex) text.</p></article>",
		Metadata:        map[string]any{"language": "en"},
	}
	first, err := store.CreateCapture(input)
	if err != nil || first.ID == "" || first.ArtifactID == "" || first.HTMLArtifactID == "" || first.Completeness != "full" {
		t.Fatalf("unexpected capture: %+v (%v)", first, err)
	}
	second, err := store.CreateCapture(input)
	if err != nil || second.ID != first.ID {
		t.Fatalf("retry must return the same durable capture: %+v (%v)", second, err)
	}
	artifact, bytes, err := store.ReadArtifact(first.ArtifactID)
	if err != nil || artifact.Kind != "web-capture" || string(bytes) != input.Markdown {
		t.Fatalf("Markdown must be the primary exact artifact: %+v %q (%v)", artifact, bytes, err)
	}
	CloseAll()
	store, err = Open(root)
	if err != nil {
		t.Fatal(err)
	}
	captures, err := store.ListCaptures(10)
	if err != nil || len(captures) != 1 || captures[0].ID != first.ID {
		t.Fatalf("capture did not survive store restart: %+v (%v)", captures, err)
	}
	var created int
	if err := store.db.QueryRow(`SELECT COUNT(*) FROM events WHERE type = 'capture.created'`).Scan(&created); err != nil || created != 1 {
		t.Fatalf("capture must emit one durable event: %d (%v)", created, err)
	}
}

func TestCaptureRejectsUnsafeHTMLAndCredentialMetadata(t *testing.T) {
	store, _ := openTestStore(t)
	base := CaptureInput{ClientRequestID: "bad", URL: "https://example.test", Adapter: "generic-selection",
		Completeness: "selection", Markdown: "selected"}
	unsafe := base
	unsafe.SanitizedHTML = "<p\n onmouseover = \"steal()\">selected</p>"
	if _, err := store.CreateCapture(unsafe); err == nil || !strings.Contains(err.Error(), "sanitized") {
		t.Fatalf("event handler HTML must fail closed: %v", err)
	}
	secret := base
	secret.ClientRequestID = "secret"
	secret.Metadata = map[string]any{"request": map[string]any{"authorization_token": "nope"}}
	if _, err := store.CreateCapture(secret); err == nil || !strings.Contains(err.Error(), "credential") {
		t.Fatalf("credential-shaped metadata must fail closed: %v", err)
	}
}

func TestArtifactImportIsCASBacked(t *testing.T) {
	store, _ := openTestStore(t)
	content := []byte("inspectable evidence")
	artifact, err := store.ImportArtifact(ImportArtifactInput{
		Kind: "evidence", MediaType: "text/plain; charset=utf-8",
		ContentBase64: base64.StdEncoding.EncodeToString(content), SourceURI: "https://example.test/evidence",
	})
	if err != nil || artifact.Kind != "evidence" {
		t.Fatalf("artifact import failed: %+v (%v)", artifact, err)
	}
	_, loaded, err := store.ReadArtifact(artifact.ID)
	if err != nil || string(loaded) != string(content) {
		t.Fatalf("imported artifact bytes changed: %q (%v)", loaded, err)
	}
}
