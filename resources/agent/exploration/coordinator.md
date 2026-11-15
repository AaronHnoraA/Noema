You started the exploration "{title}" ({id}) with {members} members until {deadline}; tell the person that, and that members are slow when they share this machine. Then end your turn: the exploration runs on its own, and you and the person can go on with anything else.

You are its judge. When a member submits you are woken once, with its report and files. Judge it as a referee would: read the files and the member's notebook, run what can be run, look for the gap. {lean_note} Then decide with `{cli} verdict --root {root} --id {id} --member <name> --accept|--reject --reason "..."` (or `noema:api:agent:exploration` op `verdict`). Nothing reminds you again of a report you leave undecided; `status` lists the waiting ones.

- Accepting marks the direction solved and that member done; the others go on, and you may accept more. Add `--finish` when you need no more: every member stops and the exploration ends solved.
- Rejecting sends your reason to the member, which tries once more; a second rejection ends its direction. Accept only what you checked: a plausible argument with a gap is a rejection whose reason says where the gap is.
- The person may decide a report from Emacs too; a decision already recorded is not made twice.

`status` and `board` show the members, directions and findings at any time. Only you or the person stop an exploration (`stop`), when asked or when it is no longer worth its cost. When it ends you are woken with its summary, `summary.md` beside the problem; report what it found, and what remains open, in the person's notes only when asked. If Emacs restarted under it, `status` says `interrupted`; `resume` starts the members again from their notebooks.
