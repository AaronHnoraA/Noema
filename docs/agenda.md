# Agenda / Planning DSL

Canonical reference for the `@@todo`/`@@itodo`/`@@project`/`@@milestone`/`@@clock`
planning DSL and the server-side agenda engine built on top of it. This is
the "grammar spec" referenced from `server/lib/runtime.mjs`'s agenda-engine
header comment.

## Layering

| Layer | File | Owns |
|---|---|---|
| Structure | `shared/planning-dsl.mjs` | `@@kind(status) [title]{attrs}` parsing (inline/block shapes, bracket-less titles), diagnostics, patch/serialize helpers. |
| Values | `shared/planning-values.mjs` (browser facade: `src/planning-values.ts`) | Date/duration/repeater/lead-time/dep-ref parsing, canonical-key aliasing, status normalization. Shared by the server and the editor widgets so both validate identically. |
| Engine | `server/lib/runtime.mjs` | Dependency resolution, urgency, day-bucketed agenda view-model, clock aggregation, project rollup, Gantt model, canonical-key patching. |

The structure layer never rejects a malformed value outright — bad dates,
repeaters, or unknown keys become `diagnostics`/`lints` entries so a typo
never makes a planning item vanish from the vault.

## Kinds

```
PLANNING_KINDS = todo | itodo | project | milestone | clock
```

- **`todo`** — the primary task kind. Statuses: `todo` (open), `doing`,
  `done`, `blocked` (manual), `cancelled`.
- **`itodo`** — an alternate spelling of `todo`: identical grammar, status
  set, and canonical keys. The agenda engine and dependency resolution treat
  `todo` and `itodo` as the same kind everywhere (a query for kind `"todo"`
  matches both). The only difference is presentational — the editor widget
  gives it its own badge (`ITODO` vs `TODO`).
- **`project`** — a grouping/organizing unit. Status defaults to `active`.
- **`milestone`** — a dated marker, no status semantics beyond an optional
  free-form tag.
- **`clock`** — a time-tracking span referencing a todo (see
  [Clock engine](#clock-engine)).

## Structural grammar

Two shapes, either of which any kind may use:

```
@@kind(status) [title]{key: value, key: value}      # inline
@@kind(status) [title] {                             # block
  key: value
  key: value
}
```

`project`/`milestone`/`clock` additionally accept a **bracket-less title** —
bare text up to the `{`, instead of `[title]`:

```
@@project(active) Notes App {
  area: tooling
}
```

`todo`/`itodo` also has a bare fallback with no brackets and no attrs block,
for quick capture: `@@todo(doing) write up the results`.

Escaping inside `[...]` titles: `\]` and `\\` are unescaped on read; a
generated title (e.g. clock-in's auto-inserted `[task title]`) re-escapes
both.

## Canonical keys and aliases

`canonicalTodoArgs`/`todoArgKeyForCanonical` (`shared/planning-values.mjs`)
normalize every alias below to its canonical spelling on read, and reuse
whichever alias a line already has on write (introducing the canonical
spelling only for brand-new keys):

| Canonical | Aliases | Value grammar |
|---|---|---|
| `id` | — | stable id (see [Stable ids](#stable-ids)) |
| `ddl` | `due`, `deadline` | date |
| `sche` | `scheduled`, `start` | date |
| `end` | `finish` | date |
| `prio` | `priority` | `A`–`F` |
| `repeat` | `rep`, `every` | repeater |
| `warn` | `lead` | lead-time |
| `after` | `dep` | dep-ref list |
| `blocks` | — | dep-ref list (reverse of `after`) |
| `project` | `proj` | text (a project key) |
| `area` | — | text |
| `phase` | — | text |
| `goal` | — | text |
| `effort` | — | duration |
| `progress` | `pct` | `0`–`100` |
| `owner` | — | text |
| `date` | `when` | date (milestone) |
| `tags` | — | text |
| `context` | `ctx` | text |
| `done` | — | date |
| `log` | — | `&`-joined date list |

`@@clock` additionally uses `from`/`to` (date, with time-of-day) and an
optional `note`. These aren't part of `TODO_CANON_KEYS` (they're
clock-specific) but share the same date grammar and lint the same way.

## Value grammar

**Dates** (`parseDateValue`/`formatDateValue`/`normalizeDateValue`): ISO
(`2026-07-07`, optionally `HH:MM`), slash/dot/CJK variants, bare `MM-DD`
(current year), relative (`today`/`tomorrow`/`yesterday`/`now`,
`+3d`/`-1w`/`+2m`/`+1y`), or anything `Date.parse` accepts. Canonical output
is `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`. ISO timestamp imports with `Z` or a
numeric offset are interpreted as local planning wall time, not as instants:
`2026-07-07T23:30:00Z` normalizes to `2026-07-07 23:30` and stays in the
July 7 agenda bucket.

**Repeater** (`parseRepeater`/`applyRepeater`): `[+|++|.+]N(d|w|m|y)`; bare
`Nd` behaves like `+Nd`. org semantics: `+` shifts once from the old date
(may still land in the past); `++` shifts repeatedly until the result is
after "now"; `.+` shifts from the completion moment instead of the old date.
Display-only future-occurrence projection (the agenda's `repeat` entries)
always uses plain `+` stepping regardless of the todo's own mode — only
*completion* uses the todo's actual mode.

**Lead time** (`parseLeadTime`): `Nd`/`Nw`/`Nm`, defaults to 14 days —
how many days before a deadline a `warning` entry appears.

**Dep-ref** (`parseDepRefs`) — used by `after`, `blocks`, and a clock's
`task`: `ref ( "&" ref )*`, where `ref := "#" stable-id | [ "[[" note-title
"]]" "::" ] text`. An `#id` ref resolves directly against the id index (see
[Stable ids](#stable-ids)) with no fuzzy matching. Otherwise, same-file refs
are just text; cross-file refs prefix the note title. Text matches resolve
same-file (or same-titled-note) todos by exact, then prefix, then substring
tier; multiple hits at a tier lint as `ambiguous-ref`/`ambiguous-clock-ref`
and zero hits lint as `broken-ref`/`broken-clock-ref` — neither ever blocks a
todo from being usable, they only ever surface as lints.

**Duration** (`parseDuration`/`formatDuration`) — `effort` and clock spans:
`2h`, `90m`, `1d` (an 8-hour workday), or `H:MM`. Returns/accepts total
minutes.

## Diagnostics (parse-time)

`scanPlanningNodes` attaches a `diagnostics` array to every node:

| kind | meaning |
|---|---|
| `malformed` | block-shape node with no title before `{` |
| `invalid-date` | a date-valued key didn't parse |
| `invalid-repeater` | `repeat`/`rep`/`every` didn't parse |
| `invalid-lead-time` | `warn`/`lead` didn't parse |
| `invalid-duration` | `effort` didn't parse |
| `invalid-dep-ref` | `after`/`blocks` parsed to zero refs |
| `unknown-key` | a key not in the canonical/alias set |

None of these drop the node or its other attrs — they're purely advisory.

## Dependency resolution

`resolveTodoDeps` (`server/lib/runtime.mjs`) decorates every todo with
`deps` (resolved target ids), `effectiveStatus`, and `blockedBy`:

- **`after`** — forward: this todo depends on the referenced todo(s).
- **`blocks`** — reverse: the *referenced* todo(s) gain this todo as a
  dependency. `T {blocks: X}` is equivalent to `X {after: T}`.
- A todo whose unresolved (non-`done`/`cancelled`) deps are non-empty gets
  `effectiveStatus: "blocked"` — distinct from the manually-set `blocked`
  status.
- Cycles (via either `after` or `blocks`) are detected and reported as a
  `cycle` lint in the Gantt model.

## Stable ids

A todo's default id is derived (`` `${file}:${offset}` ``) and drifts on
every edit above it — fine for a single request, useless as a durable
anchor. `id:` (base36, 6 chars) is a **stable, opt-in** id that survives
edits, minted **on demand** (org-id model), never on every save:

- `createTodo` always mints one for a brand-new todo.
- `ensureTodoId` mints one for an existing todo the first time something
  needs a durable anchor into it: the web/Emacs dependency picker (before
  writing an `after`/`blocks` ref) and `clockIn` (before writing a clock's
  `task` anchor). Idempotent — a todo that already has an id is returned
  unchanged.
- Passive completion (typing `after:`/`blocks:`/`task:` and picking a
  candidate) does **not** mint an id: a candidate that already has one
  completes to `#id`, otherwise it falls back to `depRefForTodo`'s text ref
  — browsing candidates should never have a write side effect.
- A todo's view-model `id` is `#xxxxxx` when it has a stable id, else the
  positional fallback — every consumer already treats `id` as an opaque
  string, so this is transparent everywhere (`cursorId`, selection sets,
  Gantt drag targets, `byId` dependency maps).
- Two nodes sharing the same `id:` (hand-copied, typically) lint as
  `duplicate-id`; the engine keeps the first occurrence's id and the second
  falls back to its positional id so nothing silently merges.
- Concurrent id minting uses an in-process reservation set in addition to
  the scanned id index, so two simultaneous dependency/clock actions cannot
  receive the same freshly-minted id even before either write lands on disk.

## Urgency

`todoUrgency`: `priority-weight * 1000 + deadline-proximity-score +
doing-bonus - blocked-penalty`. Deadline proximity ramps up inside the
`warn` window and further once overdue; a *computed* blocked state is
pushed to the very bottom regardless of priority.

## Clock engine

```
@@clock [task-ref]{from: <date>, to: <date>, task: "#id"}
```

The bracket title is a dep-ref (same grammar as `after`/`blocks`) naming the
todo being timed; `to` is optional — a clock with `from` but no `to` is
**running**. `task` is a stable-id anchor (`resolveClockRefs` prefers it
over the title text when present) — `clockIn` always mints one for the
target todo first (see [Stable ids](#stable-ids)) and writes it, so the
clock keeps attributing correctly even after the todo's title is edited;
only clocks written before a todo had an id fall back to matching the
(now possibly stale) bracket text. Only one clock may run vault-wide at a
time: `clockIn` closes any currently-running clock first, then inserts a
new `@@clock` line directly after the target todo's line/block. `clockOut`
closes either an explicit clock (file+locator) or whatever is running.

`buildClockModel(clocks, todos, projects)` aggregates:

- `tasks[]` — per-todo total minutes plus `effortMinutes` (parsed from the
  todo's `effort`) for an effort-vs-actual comparison.
- `byDay` — minutes per `YYYY-MM-DD` (keyed off each clock's `from` date).
- `byProject` — minutes per project key (see [Project rollup](#project-rollup)).
- `running` — the one open clock, if any, with `minutesSoFar` computed
  against the current time.

Broken/ambiguous clock refs (`resolveClockRefs`) never drop the clock from
aggregation — an unresolved clock still counts toward its own file/day,
just not toward a specific todo or project.

Clock data-quality problems also surface as lints without changing
aggregation:

- `multiple-running-clocks` — more than one open `@@clock`; the first is the
  displayed running clock, but every span still contributes to totals.
- `reversed-clock-span` — `to` is earlier than `from`; aggregation counts it
  as zero minutes.
- `overlapping-clocks` — two spans overlap, so totals may over-count.

## Agenda view-model

`buildAgenda({ from, days, includePlanning, includeGantt })` returns:

- `days[]` — one bucket per day (`date`, `entries[]`). Each entry carries
  `kind` (`deadline`/`warning`/`overdue`/`scheduled`/`sched-carry`/`log`/
  `repeat`), `time` (an `"HH:MM"` string when the source date carried a
  time-of-day, else `null`), and `urgency`.
  - **Time grid**: within a bucket, timed entries sort ascending by `time`
    ahead of all untimed entries (which sort by `urgency` instead).
  - **Repeat projection**: a todo with `repeat` and an open (non-closed)
    status gets its future `ddl`/`sche` occurrences projected forward
    (plain `+n·unit` stepping, not the completion-time repeater mode) into
    every bucket inside the requested range, as `kind: "repeat",
    virtual: true` entries — display-only, not patchable.
- `todos[]` — the full urgency-sorted list.
- `lints[]` — dependency, clock-ref, clock data-quality, and (when
  `includeGantt`) Gantt lints.
- `logByDay` — completion counts per day (drives the activity heatmap).
- `stats` — open/doing/done/cancelled/blocked/overdue counts.
- When `includePlanning`: `projects[]`, `milestones[]`, `clocks[]`,
  `clocktable` (the `buildClockModel` output), `projectModel` (see below).
- When `includeGantt`: `gantt` — `{ tasks, backlog, milestones, lanes,
  lints }` (see [Gantt model](#gantt-model)).

## Caching

Agenda keeps two local, disposable cache layers under
`stateRoot/cache/agenda-cache.json` (`var/` by default, git-ignored):

- **Parsed file cache** — keyed by absolute file path plus `mtimeMs`/`size`.
  It stores note metadata and parsed planning groups (`todos`, `projects`,
  `milestones`, `clocks`) so a restart can avoid re-reading unchanged files.
- **Agenda payload cache** — keyed by a snapshot fingerprint, today's date,
  and the normalized `buildAgenda` request. It stores the final payload only
  when the result is stable; payloads with a running clock are not cached
  because `minutesSoFar` changes with wall time.

Both layers are invalidated by `markNotesDirty(file)`/watcher changes and are
best-effort only: cache read/write failures fall back to the in-memory scanner
path. Set `AARONNOTE_AGENDA_CACHE=0` to disable the persistent cache.

## Creating todos

`createTodo({ text, file?, status?, ...attrs })` appends a new `@@todo` line.
When `file` is omitted it writes to `inbox.md` under the note root, creating
that note with metadata if necessary. Relative `file` values are resolved
against the note root. Supported attrs are the normal todo canonical keys and
aliases (`ddl`/`due`, `sche`/`scheduled`, `prio`/`priority`, `project`/`proj`,
`repeat`, `after`, `blocks`, `effort`, etc.). The returned payload includes
the created source line and parsed todo, then the host broadcasts
`agenda-changed`.

## Write serialization

All agenda mutations that rewrite note files (`createTodo`, `patchTodo`,
`updateTodoStatus`, `ensureTodoId`, `clockIn`, `clockOut`) share the same
per-file write queue as editor saves. The entire read/locate/compute/write
cycle is serialized by canonical file path, so an agenda patch and a browser
save cannot interleave and overwrite each other. If the editor later saves
with an old `baseMtimeMs`, `saveNote` returns `conflict: true`; the client
should reload/review instead of forcing an overwrite.

Agenda writes mark the file dirty and enqueue its path for Roam DB sync, but
they do not start an automatic git commit or background DB rebuild. The queue
is drained by the next explicit/manual sync (`syncRoamDb`) or a very-low-rate
sampled editor save, preserving the "collect changes until sync" workflow.

## Completion

`todoRefCompletions({ prefix, file, excludeId?, limit? })` powers `after:`/
`blocks:`/`task:` value completion in both clients — same-file todos rank
first, then open statuses before closed ones. Each candidate's `ref` is
`#id` when the todo already has a stable id, else the same shortest-unique
text ref `depRefForTodo` generates for the explicit dependency picker.
Browsing candidates never mints an id (see [Stable ids](#stable-ids)).

- **Web** (`aaronnote/main.ts`): `depRefCompletionContext`/
  `matchingTodoRefCompletions` slot into the same completion-popup waterfall
  as tag/roam/path completion (`updateSnippetPopup`), triggered by the
  cursor sitting inside an `after=`/`blocks=`/`task=` attr value.
- **Emacs**: `my/aaronnote-roam-capf` gets a matching `cond` branch that
  calls the `todo-refs` action through the same `/api` bridge other roam
  actions use.
- **API**: `aaronnote:api:completions:todo-refs` (web-host.mjs), bridged as
  `api.completions.todoRefs(...)`.

## Project rollup

`buildProjectModel(projects, todos, clocks)` groups todos onto each
`@@project` by the **same key** `inferTodoProject`/the Gantt model already
use — explicit `project:`/`proj:`, file-level `project:` defaults injected
into those args, or the slugified title of the nearest preceding same-file
`@@project`. A note title is not a project; unprojected todos remain
unprojected. Per project: open/doing/done/cancelled/blocked counts, `total`,
`progress` (an explicit `progress:` key wins; otherwise `done / (total -
cancelled)` rounded to a percent), `effortMinutes` and `clockedMinutes`
summed from its todos. Todos whose inferred project key doesn't match any
real `@@project` stay visible in agenda/list views but do not get synthetic
project rollup cards.

## Gantt model

`buildGanttModel(todos, projects, milestones)`:

- `tasks[]` — todos with `sche`/`start` plus `end`/`ddl`; `backlog[]`
  — unscheduled or agenda-only todos. Deadline-only and scheduled-only todos
  are allowed and do not lint. A backlog item only lints as
  `missing-gantt-date` when it has explicit Gantt end intent (`end`/`finish`)
  without `sche`/`start` and is not closed.
- `milestones[]` — requires `date`; missing it lints as
  `missing-milestone-date`.
- `lanes[]` — one swimlane per `@@project`: an explicit `sche`/`end`(or
  `ddl`) on the project itself wins for the bar's span; otherwise it spans
  `min(children start) .. max(children end)`. Projects with neither (no
  dates anywhere) are omitted.
- `lints[]` — the above plus `cycle` (dependency cycles, from either
  `after` or `blocks`).

## Examples

```
@@project(active) [Thesis] {
  project: thesis
  area: research
  goal: "Submit by Q4"
}

@@todo(doing) [write related-work section] {
  id: 9k2xq1
  project: thesis
  sche: 2026-07-06
  end: 2026-07-10
  effort: 6h
  prio: A
}

@@milestone [advisor check-in] { project: thesis, date: 2026-07-15 }

@@clock [write related-work section] {from: "2026-07-07 09:00", to: "2026-07-07 11:30", task: "#9k2xq1"}

@@todo [second pass] {after: "#9k2xq1", repeat: +1w, ddl: 2026-07-20}

@@todo(doing) [blocking task] {blocks: "second pass"}
```
