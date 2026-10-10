# Upstream implementation ownership

gptel and Magent remain internalized. On 2026-09-15 the user authorized moving
the pristine ACP toolchain to package-vc. On 2026-09-26 the user asked to update
it together with the pristine gptel snapshot: acp.el 0.15.2, shell-maker 0.97.3,
agent-shell 0.79.2 and gptel 0.9.9.6 are pinned below.  Every upstream
definition Noema and the host configuration call was checked to still exist.
Noema's hidden-output optimization now lives in `lisp/noema-agent-render.el`;
the package source has no local modifications.

| Tree | Upstream | Revision | Noema role |
|---|---|---|---|
| `upstream/gptel/` | `karthink/gptel` | `ec25a41fb8bebf5ea08341a9d8c70c0ee907ee23` | arbitrary-buffer composition, context, presets, transient controls, rewrite review, lightweight inference |
| package-vc `agent-shell` | `xenodium/agent-shell` | `55d7148505da2433a30b1228092e17b0775ffa25` | structured Emacs agent session UI and event stream |
| package-vc `acp` | `xenodium/acp.el` | `242cef63d76cc1073485847f67a21f6d8406d158` | ACP transport and protocol implementation |
| package-vc `shell-maker` | `xenodium/shell-maker` | `f448a74a8eded23aa42f8d60a41c5d8d3a183d07` | comint substrate required by agent-shell |
| `upstream/magent/` | `Jamie-Cui/magent` plus local integration work | upstream base `412a12cbe9151d11eb66ce3dbdd893324fb36825`, followed by the audited local integration present at migration | queue, ledger, permissions, agent runtime and gptel/agent-shell integration |
| `upstream/codex-cli/` | previously internalized Codex CLI Emacs integration | source present at migration time | terminal/CLI compatibility and reference implementation |
| `upstream/claude-code-ide/` | previously internalized Claude Code IDE integration | source present at migration time | terminal/MCP compatibility and reference implementation |

Each upstream directory retains its own license, history-facing documentation,
tests and source layout. Noema-specific code lives in `lisp/`; upstream symbols
remain intact so mature behavior is reused instead of imperfectly rewritten.

## Recall and similarity

nanoMuse's memory store was read at `1e08351843052ddcace724e8cac1e4aefbc1101c`
and each candidate judged by whether it improves Noema, not by whether it
could be carried over.

| nanoMuse | Decision |
|---|---|
| `standouts` (cut a result list relative to its own scores) | Translated into `shared/nanomuse-recall.mjs` (GPL-3.0-or-later, see `NOTICE`); used by partial Wiki search. |
| Rare-word weighting of shared terms | Idea adopted, written for Noema's data: SQL document counts in partial search, weighted vocabulary share in Run memory recall. |
| Near-duplicate check on statements | Idea adopted as a notice for Wiki titles and Findings; never a refusal. |
| `_same_stem` (prefix match for inflections) | Rejected after trial: on the real vault it equated `tensor` with `tensorforscientist`, and by rule `Group` with `Groupoid`. |
| `tokenize` | Rejected: Noema's tokenizer counts kana and compatibility ideographs as CJK and never pairs characters across a gap. |
| `similarity`, `search`, `fuse` | Not carried over: nothing in Noema would call them. |
| Embedding recall | Rejected: it sends note text to an external endpoint. |
| Model-driven memory tidy-up | Rejected: Findings change only through a person's evidence review. |
| Conversation sync (sequence cursors, tombstones), column-add migrations | Rejected: Git owns sync, and `wiki.db` is a projection that rebuilds. |

## Run context under a budget

context-mode (`8de5f73af9365d459bdfc564c045948cc3fc488b`, Elastic License 2.0)
and Headroom (`976aa714ef3e19174dc0cb586cee7b20d064e4ef`, Apache-2.0) were read
on 2026-10-11 for how they keep an agent's context small. Both sit where Noema
does not: context-mode replaces an agent's tools through MCP and hooks, and
Headroom rewrites requests in a proxy in front of the model. Noema's part is
the frozen 64 KiB context of a Run, so each piece was judged there.

The Elastic License adds restrictions the AGPL does not allow on combined
work, so nothing from context-mode is translated; only ideas are taken.

| Upstream | Decision |
|---|---|
| Headroom `relevance_split.segment` (records at blank lines, windows, indented continuations) | Translated into `server/lib/headroom-segment.mjs` (Apache-2.0, see `NOTICE`); a cut parent output or Handoff is split with it. |
| Headroom `plan_relevance_split`, context-mode `extractSnippet` (keep what matches the request, not the first N bytes) | Idea adopted in `server/lib/research-context-excerpt.mjs`: beginning, end and the matching passages. On Noema's own long documents at 8 KiB the excerpt held 6 of 8, 3 of 4 and 4 of 4 request terms where the plain cut held 2, 2 and 2. |
| Headroom's Otsu cut and BM25/embedding scorer | Not carried over: the byte budget ranks the passages, and the score is the rare-term weight Run memory already uses. An absolute share of the request decides instead, because a relative cut always keeps something, including when the document does not answer the request. |
| context-mode's window fill in document order | Rejected: the first matches spend the budget, so a common word early in the text wins over the passage meant. |
| Function words in the query (found while calibrating, in neither upstream) | Added to `memoryTerms`: `and`, `when` and `which` alone matched passages of `docs/research-workflow.md` to a question it does not answer. Finding recall shares the list. |
| Headroom CCR, context-mode's snapshot as a table of contents (leave a marker, fetch the original on demand) | Not adopted: an agent has no tool that reads one work output or artifact by reference, and pointing it at the whole `.noema` file costs more context than the cut saved. The person sees every cut and omission in the receipt. |
| Headroom SmartCrusher, CodeCompressor, log and diff compressors, lossless compaction, dense-line elision | Not carried over: automatic context is agent prose, source cells and Findings. Declared `@@ctx` files are a contract and are never rewritten. |
| Headroom cross-turn dedup, read lifecycle, thinking compaction, cold-prefix rewrites, CacheAligner | Not carried over: they rewrite a conversation's history, which the ACP agent owns. Noema sends one turn; identical context items are already attached once. |
| Headroom Kompress model, image compression | Rejected: a model deciding what a frozen RunSpec contains is not reproducible. |
| Headroom output shaping (terseness note, lower reasoning effort after a tool result) | Rejected: agents own their models, and context-mode records a benchmark loss from brevity prompts. |
| Headroom `learn` (mine failed sessions into `CLAUDE.md`) | Rejected: a durable fact needs a person's evidence review. |
| Headroom cross-agent memory | Rejected: reviewed Findings fill that role. |
| context-mode sandbox execution and tool routing hooks (`ctx_execute`, PreToolUse redirection) | Rejected: ACP agents own their tools. A person can install context-mode in an agent; Noema neither requires nor configures it. |
| context-mode session events and the PreCompact snapshot | Already present: durable Run events, Handoff artifacts and rollover at a Run boundary. |
| context-mode FTS5 store with stemming, trigram and rank fusion | Already present for what Noema searches: `wiki.db` and the history index. |
| context-mode secret redaction of stored tool input | Already present: `RedactSecrets`. |

## Web editor upstreams

LiveTeX (`src/cm6/extensions/visual/widgets/visualtex-inline.ts`) adapts
VisualTeX's MathLive editor; each adapted file records its revision, and
`NOTICE` lists them.  On 2026-09-27 LiveTeX was aligned with VisualTeX
`1deb334220a6acb4dd04cec0d51000d6855d954a` and MathLive 0.110.0:

- MathLive 0.110.0 carries the `\text{}` markup/MathML escaping fix
  (CVE-2026-54705) and the `replaceAll` stale-atom fix (#2964) that VisualTeX
  still patches into 0.109.2 at build time.  Noema does not patch MathLive.
- Assigning `field.macros` replaces MathLive's built-in dictionary; LiveTeX
  merges it back (`visualTexMathLiveDefaultMacros`), as VisualTeX does in its
  markup path, so `\argmin`, `\iff`, `\nicefrac` and `\coloneqq` stay valid.
- `mathlive-source-safety.ts` is VisualTeX's recursion guard: oversized or
  over-nested formulas fall back to source editing instead of reaching MathLive.

VisualTeX's remaining MathLive build patches (matrix hit testing, bold upright
Greek serialization, empty-model option writes) and its Office/OCR/keypad
features were reviewed and not adopted.

`dompurify` is pinned to 3.4.4.  `scripts/render-html.mjs` sanitizes
export/publish HTML under happy-dom, and from 3.4.8 DOMPurify no longer
sanitizes correctly there (allowed tags are dropped while `<script>` survives;
upstream declares happy-dom unsupported).  Unpin only after that path runs on
a supported DOM.
