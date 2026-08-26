// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package metadata

import (
	"errors"
	"strings"
	"testing"
)

const testUUID = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"

func testOptions() Options {
	return Options{
		Today: "2026-08-26",
		NewID: func() (string, error) { return testUUID, nil },
	}
}

func stringPtr(value string) *string        { return &value }
func stringsPtr(values ...string) *[]string { return &values }

func TestPatchCreatesPortableMetaWithUUIDv7AndPreservesLineEndings(t *testing.T) {
	source := "# Paper\r\n\r\nBody\r\n"
	project := "iso-2026"
	result, err := Patch(source, "paper.md", Request{
		Action: ActionAdd, Tags: stringsPtr("TCS", "#pcp", "tcs"), Project: &project,
	}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	wantPrefix := "#+begin meta\r\nid: " + testUUID + "\r\ntitle: Paper\r\ndate: 2026-08-26\r\nkind: default\r\nproject: iso-2026\r\ntags: pcp, tcs\r\nrefs:\r\n#+end meta\r\n\r\n"
	if !result.Changed || !strings.HasPrefix(result.Markdown, wantPrefix) || !strings.HasSuffix(result.Markdown, source) {
		t.Fatalf("unexpected created metadata:\n%q\n%+v", result.Markdown, result)
	}
	if result.ID != testUUID || result.Title != "Paper" || result.Kind != "default" {
		t.Fatalf("unexpected projection: %+v", result)
	}
}

func TestPatchTagPreservesExtensionFieldsAndNestedSummary(t *testing.T) {
	source := strings.Join([]string{
		"#+begin meta",
		"id: legacy-page",
		"title: Paper",
		"date: 2026-01-01",
		"kind: theorem",
		"plugin-field: preserve exactly  ",
		"tags:",
		"  - old",
		"#+begin summary",
		"tags: prose, not-metadata",
		"#+end summary",
		"refs: theorem-1",
		"#+end meta",
		"",
		"# Paper",
		"",
	}, "\n")
	result, err := Patch(source, "paper.md", Request{Action: ActionTag, Tags: stringsPtr("new", "OLD")}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if !result.Changed || !strings.Contains(result.Markdown, "plugin-field: preserve exactly  \n") ||
		!strings.Contains(result.Markdown, "tags:\n  - new\n  - old\n#+begin summary\ntags: prose, not-metadata\n#+end summary") {
		t.Fatalf("targeted tag patch changed unrelated metadata:\n%s", result.Markdown)
	}
	if strings.Count(result.Markdown, "id: legacy-page") != 1 || strings.Contains(result.Markdown, testUUID) {
		t.Fatalf("legacy identity was not preserved:\n%s", result.Markdown)
	}
}

func TestPatchHideAndActivateRoamAllocateIdentityOnlyWhenActivated(t *testing.T) {
	source := "#+begin meta\ntitle: Private\ndate: 2026-08-01\nkind: default\ntags:\nrefs:\n#+end meta\n\n# Private\n"
	hidden, err := Patch(source, "private.md", Request{Action: ActionHideRoam}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(hidden.Markdown, "id:") || !strings.Contains(hidden.Markdown, "roam: off\n") {
		t.Fatalf("hide-roam created an identity or missed the flag:\n%s", hidden.Markdown)
	}
	active, err := Patch(hidden.Markdown, "private.md", Request{Action: ActionActivateRoam}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(active.Markdown, "id: "+testUUID+"\n") || strings.Contains(active.Markdown, "roam: off") {
		t.Fatalf("activate-roam did not mint identity/remove flag:\n%s", active.Markdown)
	}
}

func TestPatchIgnoresLiteralMetaInsideCodeFence(t *testing.T) {
	source := "```text\n#+begin meta\ntitle: Fake\n#+end meta\n```\n\n# Real\n"
	result, err := Patch(source, "real.md", Request{Action: ActionAdd}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(result.Markdown, "#+begin meta\nid: "+testUUID+"\ntitle: Real\n") ||
		strings.Count(result.Markdown, "title: Fake") != 1 {
		t.Fatalf("fenced literal was treated as live metadata:\n%s", result.Markdown)
	}
}

func TestPatchRemoveAndUnsupportedAction(t *testing.T) {
	source := "#+begin meta\nid: old\n#+end meta\n\n# Body\n"
	removed, err := Patch(source, "body.md", Request{Action: ActionRemove}, testOptions())
	if err != nil || removed.Markdown != "# Body\n" {
		t.Fatalf("unexpected remove result: %+v, %v", removed, err)
	}
	_, err = Patch(source, "body.md", Request{Action: "rewrite-all"}, testOptions())
	if err == nil || !strings.Contains(err.Error(), "unsupported metadata action") {
		t.Fatalf("expected unsupported action rejection, got %v", err)
	}
	brokenOptions := testOptions()
	brokenOptions.NewID = func() (string, error) { return "", errors.New("entropy unavailable") }
	_, err = Patch("# New\n", "new.md", Request{Action: ActionAdd}, brokenOptions)
	if err == nil || err.Error() != "entropy unavailable" {
		t.Fatalf("expected allocator failure, got %v", err)
	}
}

func TestPatchRejectsMalformedOrAmbiguousLiveMeta(t *testing.T) {
	for _, source := range []string{
		"#+begin meta\ntitle: Missing close\n# Body\n",
		"#+begin meta\ntitle: One\n#+end meta\n\n#+begin meta\ntitle: Two\n#+end meta\n",
	} {
		result, err := Patch(source, "broken.md", Request{Action: ActionTag, Tags: stringsPtr("new")}, testOptions())
		if err == nil || result.Markdown != "" {
			t.Fatalf("expected malformed metadata rejection, got %+v, %v", result, err)
		}
	}
}

func TestPatchKeepsUserScalarsOnOneMetadataLine(t *testing.T) {
	title := "Safe title\nroam: off"
	result, err := Patch("# Body\n", "body.md", Request{
		Action: ActionAdd, Title: &title, Tags: stringsPtr("safe\nproject: injected"),
	}, testOptions())
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(result.Markdown, "\nroam: off\n") || strings.Contains(result.Markdown, "\nproject: injected\n") ||
		!strings.Contains(result.Markdown, "title: Safe title roam: off\n") {
		t.Fatalf("metadata scalar escaped its field:\n%s", result.Markdown)
	}
}
