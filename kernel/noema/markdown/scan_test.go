// Copyright (c) 2026 Aaron He
// SPDX-License-Identifier: AGPL-3.0-or-later

package markdown

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/88250/lute/parse"
)

type blockPropertyFixtureDefinition struct {
	CanonicalID string            `json:"canonicalId"`
	Line        int               `json:"line"`
	Index       int               `json:"index"`
	Kind        string            `json:"kind"`
	OrgEnv      bool              `json:"orgEnv"`
	Text        string            `json:"text"`
	Properties  map[string]string `json:"properties"`
}

type blockPropertyFixtureProjection struct {
	Definitions            []blockPropertyFixtureDefinition `json:"definitions"`
	DuplicateDefinitionIDs []string                         `json:"duplicateDefinitionIds"`
}

func TestScanMatchesSharedBlockPropertyFixtures(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "shared", "block-property-fixtures.json"))
	if nil != err {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name     string                         `json:"name"`
		Source   string                         `json:"source"`
		Expected blockPropertyFixtureProjection `json:"expected"`
	}
	if err = json.Unmarshal(raw, &fixtures); nil != err {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			projection := Scan([]byte(fixture.Source))
			actual := blockPropertyFixtureProjection{DuplicateDefinitionIDs: projection.DuplicateDefinitionIDs}
			if nil == actual.DuplicateDefinitionIDs {
				actual.DuplicateDefinitionIDs = []string{}
			}
			for _, definition := range projection.Definitions {
				properties := definition.Properties
				if nil == properties {
					properties = map[string]string{}
				}
				actual.Definitions = append(actual.Definitions, blockPropertyFixtureDefinition{
					CanonicalID: definition.CanonicalID, Line: definition.Line, Index: definition.Index,
					Kind: definition.Kind, OrgEnv: definition.OrgEnv, Text: definition.Text, Properties: properties,
				})
			}
			if !reflect.DeepEqual(actual, fixture.Expected) {
				t.Fatalf("projection mismatch:\nactual:   %#v\nexpected: %#v", actual, fixture.Expected)
			}
		})
	}
}

const (
	blockIDOne = "0198fc34-7b32-7a11-8cb4-6c40e3b33d68"
	blockIDTwo = "0198fc34-7b32-7a11-8cb4-6c40e3b33d69"
)

func TestScanFindsNoemaDefinitionsAndReferences(t *testing.T) {
	source := []byte("Paragraph {#" + blockIDOne + "}\n\n" +
		"See ((" + blockIDOne + " \"a \\\"label\\\"\")) and ((" + blockIDTwo + ")).\n\n" +
		"#+begin note Result {#" + blockIDTwo + "}\nbody\n#+end note\n")
	projection := Scan(source)
	if 2 != len(projection.Definitions) {
		t.Fatalf("definition count mismatch: %#v", projection.Definitions)
	}
	if projection.Definitions[0].CanonicalID != blockIDOne || projection.Definitions[0].OrgEnv {
		t.Fatalf("ordinary definition mismatch: %#v", projection.Definitions[0])
	}
	if projection.Definitions[1].CanonicalID != blockIDTwo || !projection.Definitions[1].OrgEnv || projection.Definitions[1].Kind != "note" {
		t.Fatalf("org-env definition mismatch: %#v", projection.Definitions[1])
	}
	if 2 != len(projection.References) {
		t.Fatalf("reference count mismatch: %#v", projection.References)
	}
	if projection.References[0].Label != `a "label"` || projection.References[0].ProjectionID == blockIDOne {
		t.Fatalf("label/projection mismatch: %#v", projection.References[0])
	}
	if projection.References[1].Label != "" {
		t.Fatalf("bare reference gained a label: %#v", projection.References[1])
	}
}

func TestScanMasksLiteralSyntaxRegions(t *testing.T) {
	source := []byte("~~~\n" +
		"Fence {#" + blockIDOne + "}\n((" + blockIDOne + "))\n~~~\n" +
		"`((" + blockIDOne + "))` and $((" + blockIDOne + "))$\n" +
		"$$\n((" + blockIDOne + "))\n$$\n" +
		"#+begin comment\nComment {#" + blockIDOne + "}\n((" + blockIDOne + "))\n#+end comment\n" +
		"    Indented {#" + blockIDOne + "}\n")
	projection := Scan(source)
	if 0 != len(projection.Definitions) || 0 != len(projection.References) {
		t.Fatalf("literal regions leaked identities: %#v", projection)
	}
}

func TestScanReportsDuplicateDefinitions(t *testing.T) {
	projection := Scan([]byte("One {#" + blockIDOne + "}\n\nTwo {#" + blockIDOne + "}\n"))
	if 1 != len(projection.DuplicateDefinitionIDs) || projection.DuplicateDefinitionIDs[0] != blockIDOne {
		t.Fatalf("duplicate definition diagnostics mismatch: %#v", projection)
	}
}

func TestProjectionRoundTripsOnTreeWithoutGlobalRegistry(t *testing.T) {
	tree := parse.Parse("note.md", []byte("body"), parse.NewOptions())
	want := Scan([]byte("See ((" + blockIDOne + ")).\n"))
	AttachProjection(tree, want)
	got := ProjectionFromTree(tree)
	if 1 != len(got.References) || got.References[0].CanonicalID != blockIDOne {
		t.Fatalf("tree projection round trip mismatch: %#v", got)
	}
}
