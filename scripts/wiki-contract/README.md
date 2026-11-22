# Wiki index contract fixtures

The Node indexer and the Go kernel (`kernel/noema/wikiindex`) are held to the
same answers (docs/noema/design/wiki-workspace.md, "Index ownership"):

| Script | Writes | Held by |
| --- | --- | --- |
| `gen-fixtures.mjs` | `shared/wiki-note-parse-fixtures.json` | `parse_test.go`, `tests/wiki-note-parse-contract.test.ts` |
| `gen-rel.mjs` | `shared/wiki-relationship-fixtures.json` | `relations_test.go`, same JS test |
| `gen-db.mjs` | `shared/wiki-db-fixtures.json` | `write_test.go`, same JS test |

A deliberate change to what the index derives starts here: change Node, run
`node scripts/wiki-contract/<script>`, review the fixture diff, then make the
kernel pass it.
