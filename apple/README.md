# Noema Agenda EventKit bridge

This is an optional macOS 14+ native helper, owned by Emacs through the Remote
client process boundary. It is not an application shell and never reads project
files or converts tasks to Org. Build with `make agenda-apple-build`; test with
`make agenda-apple-test` (or the same target at the Emacs root).

**Integration status:** explicit task promotion, a durable binding journal,
versioned source receipts, field-level reconciliation, conflict actions and
native/Web global attention views are connected to the host. Enabling the helper
does not promote existing tasks. The host and source lifecycle are tested with
a disposable Apple protocol substitute; live EventKit writes and device sync
remain unverified.

## Daily use

1. Enable the selected kind with `M-x my/noema-agenda-apple-enable`.
2. In native Agenda, press `P` on a task and choose `reminder` or `event`, then
   choose a writable list/calendar. In the hosted Web view, use **Promote**.
3. `v a` or `M-x my/noema-agenda-attention` opens global attention. The Web
   equivalent is the **Global attention** tab. Opening or refreshing this view
   reads saved bindings without scanning or activating inactive projects.

Reminder promotion uses the deadline when present, otherwise the scheduled
date. Calendar promotion requires an explicit scheduled start and later end
(`s` / `E` in native Agenda). Both must be timed or both all-day; an all-day end
is exclusive. A deadline alone does not create a Calendar event. A task can be
promoted separately to Reminders and Calendar. Repeating promotion to the same
kind and collection reuses its binding; multiple time blocks in one calendar
are not yet supported.

Global attention keys: `g` refreshes saved receipts; `R` refetches the selected
Apple item and retries its pending source write; `s` keeps the current source;
`a` uses the current Apple fields. Conflict resolution requires an active source
project. `RET` explicitly enters that project and opens the source. `d` removes
the bound Apple item while preserving the Noema source; `F` forgets the binding
and leaves both objects untouched. Web rows offer the same actions.

If the helper or Emacs gateway is unavailable, the view labels its data as
saved receipts. These values do not assert that Apple is currently up to date.

## Ownership and permissions

`M-x my/noema-agenda-apple-enable` starts the helper and explicitly requests
Reminders or Calendar full access. `my/noema-agenda-apple-disable` closes it.
It has a dedicated client workspace, independent of the current project.
Emacs exit closes the process; recovery uses workspace resources, not timers.
Gateway clients cannot invoke authorization or implicitly start the helper.

The executable embeds usage descriptions and is ad-hoc signed. Current checks
compile it, validate civil dates, query its own authorization status, exercise
stdio and close/recover the Emacs process. They do **not** request permission,
read personal Apple items, write test reminders or verify iCloud/device sync.

## JSON-lines protocol v1

Each request has `id` and `op`. Responses have the same `id` and either `result`
or `error: {code,message}`. Notifications have `event: ready|changed`; stdio EOF
ends the helper. One request executes at a time, with a bounded waiting queue.

| Operation | Scope |
| --- | --- |
| `status` | Authorization status only; no EventKit store initialization |
| `authorize` | Explicit `kind: reminder|event`; direct Emacs enable only |
| `collections` | Selected kind; returns list/calendar IDs, account names and writability |
| `get` | A binding reference; refetches the bound native object |
| `put` | Binding, normalized fields and `expectedRevision`; optimistic update |
| `remove` | Binding and observed `expectedRevision`; removes only the bound object |

A binding reference contains `kind`, `calendarId`, a UUID `token`, and saved
`itemId` / `externalId` when available. Events also carry a recovery `window`
with civil `start` / `end`, bounded to one year. The token is stored in the
item URL as `noema://agenda/binding/UUID`; URL dispatch to a source project is
not implemented yet.

Normal reads use the known ID. If it changed, recovery checks external IDs and
the token in the selected Reminders list or selected calendar date window.
Token collisions, movement to another collection and token changes are errors;
titles are never used for pairing. A scoped missing result does not prove global
deletion and must never delete source Markdown or DAG nodes.

`put` with an absent object additionally requires `allowCreate: true` and an
explicit null revision. The durable driver records its creation
attempt **before** sending it. On an uncertain receipt, it retries by token without
`allowCreate`: an existing identical object is acknowledged, while an absent
object remains unconfirmed instead of creating another copy. Changes use the
hash of normalized fields; EventKit does not provide an atomic cross-device
compare-and-swap; revision checks cannot guarantee an atomic cross-device edit.

## Fields and dates

Reminder fields are `title`, `completed`, `priority` (0–9), `due` (civil date or
null), and `recurring: false`. An unchanged completed flag is not reassigned,
because EventKit would reset the completion date. Calendar fields are `title`,
`start`, `end`, `allDay`, and `recurring: false`. Explicit intervals are required;
a task deadline alone does not create an event. Unmanaged notes/alarms are kept.
External recurrence changes are conflicts; the helper cannot take over repeat
advancement from Noema.

Civil dates are `{date: "YYYY-MM-DD", timeZone: "Australia/Sydney"}`, optionally
with `time: "HH:mm"`. `floating` preserves a floating reminder date. All-day
events omit time and use an exclusive end date. Invalid dates and nonexistent
DST times fail validation. Ambiguous repeated-hour handling and full cross-zone
source projection still need explicit fixtures and policy before completion.

## Event-driven reconciliation

The helper coalesces EventKit store notifications and wake notifications into
`changed`, without a polling timer. The host refetches its durable binding set
and persists lightweight external receipts in `agenda-attention.sqlite` under
its state root. It defers source access while a project is inactive. Notification
receipt does not activate a project. Prompt text, outputs and raw documents are
never part of the binding journal.

Each side has its own field baseline to tolerate lossy priority projection.
Disjoint edits merge; competing edits to one field retain both values for
resolution. A source receipt confirms the version it wrote, while fields still
awaiting an Apple write retain their previous baseline. A later edit cannot be
silently acknowledged as part of an earlier write. A missing source or uncertain
recurring completion remains inspectable instead of repeating the completion.
Known pre-write buffer protection failures retry from a fresh merge after a
save/entry event. Project entry replays deferred receipts against current source
identity and revision; a lost receipt never permits blind duplicate creation.

Apple documents that store notifications do not identify individual changes;
stored objects need refetching. See [Updating with notifications](https://developer.apple.com/documentation/eventkit/updating-with-notifications)
and [Accessing the event store](https://developer.apple.com/documentation/eventkit/accessing-the-event-store).
The user-provided [org-reminders discussion](https://emacs-china.org/t/org-reminders-macos-reminders-org-mode/28953)
informs the notification approach; no Org conversion or account-wide polling is reused.
