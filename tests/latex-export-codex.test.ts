import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { access, chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// @ts-ignore Node ESM module outside the TS app graph.
import { buildPolishCandidates, codexAvailable, loadAgentRules, normalizeAgentTitle, polishBodyWithAgent, proseFidelityWarnings, strictFidelityIssues } from "../server/lib/latex-export-codex.mjs";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function oneShotLayoutCompiler(root: string, name = "fake-latex.sh"): Promise<string> {
  const compiler = join(root, name);
  await writeFile(compiler, [
    "#!/bin/sh",
    "if [ ! -f .aaronnote-draft-checked ]; then",
    "  touch .aaronnote-draft-checked",
    "  printf '%s\\n' 'Overfull \\hbox (1.0pt too wide)' > out.log",
    "  exit 0",
    "fi",
    ": > out.log",
    "exit 0",
  ].join("\n"), "utf8");
  await chmod(compiler, 0o755);
  return compiler;
}

describe("latex-export-codex helpers", () => {
  test("normalizes generated titles to the title-area budget", () => {
    expect(normalizeAgentTitle('Title: "Linear Algebra Projectors"')).toBe("Linear Algebra Projectors");
    const title = normalizeAgentTitle("A Very Long and Needlessly Detailed Assignment Title About Idempotent Linear Transformations and Their Diagonal Matrices");
    expect([...title].length).toBeLessThanOrEqual(42);
    expect(title.endsWith(" ")).toBe(false);
  });
  test("codexAvailable trusts bare names and existing files, rejects missing paths", () => {
    expect(codexAvailable("codex")).toBe(true);
    expect(codexAvailable("")).toBe(false);
    expect(codexAvailable("/definitely/not/here/codex")).toBe(false);
  });

  test("proseFidelityWarnings ignores formatting but flags dropped and added prose", () => {
    const same = proseFidelityWarnings(
      "The quick brown fox jumps over the lazy dog near the river",
      "\\textbf{The} quick \\emph{brown} fox jumps over the lazy dog near the river",
    );
    expect(same).toEqual([]);

    const drift = proseFidelityWarnings(
      "alpha beta gamma delta epsilon zeta eta theta",
      "\\section{alpha} plus many entirely unrelated inserted english words here now",
    );
    expect(drift.some((w: string) => /missing/.test(w))).toBe(true);
    expect(drift.some((w: string) => /not in the source/.test(w))).toBe(true);
  });

  test("proseFidelityWarnings ignores math and code content", () => {
    const warnings = proseFidelityWarnings(
      "See the bound \\(x \\le y\\) and the snippet `foo()` below here",
      "See the bound \\(x \\le y\\) and the snippet \\texttt{foo()} below here",
    );
    expect(warnings).toEqual([]);
  });

  test("proseFidelityWarnings ignores Noema structural commands", () => {
    const warnings = proseFidelityWarnings(
      "# Question 1\nAnswer text. @@latexmk(newline)\n#+begin proof\nProof text.\n#+end proof",
      "\\section{Question 1}\nAnswer text. \\\\\n\\begin{proof}\nProof text.\n\\end{proof}",
    );
    expect(warnings).toEqual([]);
  });

  test("successful Agent export does not surface the cross-syntax word-bag heuristic", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-no-wordbag-warning-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "fake-agent.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      "test -f review.json || exit 9",
      "grep -q 'whole-document-structure' review.json || exit 10",
      "printf 'Answer text.\\n' > body.tex",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"checked\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"checked\"}]}' > review.json",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);
    const compiler = await oneShotLayoutCompiler(root);
    const result = await polishBodyWithAgent({
      // Deliberately unlike the draft: this would trigger the old cross-syntax
      // word-bag warning, while the authoritative draft/body gate still passes.
      sourceMarkdown: "Completely unrelated source words that are absent from the converted draft.",
      draftBody: "Answer text.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: compiler,
      agentBin: agent,
      backend: "codex",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      maxAttempts: 1,
      polishVerifiedDraft: true,
    });
    expect(result.usedAgent).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.review?.decisions).toHaveLength(2);
    expect(result.agentElapsedMs).toBeGreaterThanOrEqual(0);
    expect(result.warnings.some((warning: string) => warning.startsWith("fidelity:"))).toBe(false);
  });

  test("strict fidelity gate rejects reordered prose and changed protected payloads", () => {
    expect(strictFidelityIssues("Alpha beta gamma.", "Gamma alpha beta.")).toContain("visible prose tokens changed or were reordered");
    expect(strictFidelityIssues("Value \\(x+1\\).", "Value \\(x+2\\)."))
      .toContain("math payloads changed or were reordered");
    expect(strictFidelityIssues("Answer A.", "Answer B!")).toContain("visible prose tokens changed or were reordered");
    expect(strictFidelityIssues("Value 1.", "Value 2.")).toContain("visible prose tokens changed or were reordered");
    expect(strictFidelityIssues("Code \\texttt{x+y}.", "Code \\texttt{x-y}."))
      .toContain("code payloads changed or were reordered");
    expect(strictFidelityIssues("\\includegraphics[width=2cm,alt={A}]{x.png}", "\\includegraphics[width=3cm,alt={B}]{x.png}"))
      .toContain("resources payloads changed or were reordered");
    expect(strictFidelityIssues("\\includegraphics[width=2cm,alt={A}]{x.png}", "\\includegraphics[width=3cm,alt={A}]{x.png}"))
      .toEqual([]);
    expect(strictFidelityIssues("Alpha.", "Alpha.\\copyright"))
      .toContain("visible prose tokens changed or were reordered");
    expect(strictFidelityIssues("\\section{Alpha}", "\\subsection{Alpha}"))
      .toContain("document structure changed or was reordered");
    expect(strictFidelityIssues("\\section{Title}", "\\section*{Title}"))
      .toContain("document structure changed or was reordered");
    expect(strictFidelityIssues("A \\footnote{note}", "A note"))
      .toContain("document structure changed or was reordered");
    expect(strictFidelityIssues(
      "\\begin{longtable}{ll}\nA & B \\\\\n\\end{longtable}",
      "\\begin{longtable}{ll}\nA B \\\\\n\\end{longtable}",
    )).toContain("document structure changed or was reordered");
    expect(strictFidelityIssues("\\begin{itemize}\n\\item Alpha\n\\end{itemize}", "\\begin{enumerate}\n\\item Alpha\n\\end{enumerate}"))
      .not.toEqual([]);
    expect(strictFidelityIssues(
      "\\begin{enumerate}\n\\def\\labelenumi{(\\alph{enumi})}\n\\item Alpha\n\\end{enumerate}",
      "\\begin{enumerate}\n\\def\\labelenumi{(\\roman{enumi})}\n\\item Alpha\n\\end{enumerate}",
    )).not.toEqual([]);
    expect(strictFidelityIssues(
      "(a) Alpha\n(b) Beta",
      "\\begin{enumerate}\n\\def\\labelenumi{(\\alph{enumi})}\n\\item Alpha\n\\item Beta\n\\end{enumerate}",
    )).toContain("document structure changed or was reordered");
    expect(strictFidelityIssues(
      "\\begin{itemize}\n\\item Alpha\n\\end{itemize}",
      "• Alpha",
    )).toContain("document structure changed or was reordered");
    expect(strictFidelityIssues("\\textbf{Alpha beta}.", "\\emph{Alpha beta}.")).toEqual([]);
  });

  test("strict fidelity gate preserves paragraphs and every typed layout intent", () => {
    expect(strictFidelityIssues("Alpha.\n\nBeta.", "Alpha. Beta."))
      .toContain("paragraph boundaries changed or were reordered");
    const intents = [
      ["Alpha \\\\ Beta", "Alpha Beta"],
      ["Alpha~Beta", "Alpha Beta"],
      ["Alpha \\allowbreak{} Beta", "Alpha Beta"],
      ["\\noindent Alpha", "Alpha"],
      ["Alpha\n\\newpage\nBeta", "Alpha\nBeta"],
      ["Alpha\n\\clearpage\nBeta", "Alpha\nBeta"],
      ["Alpha\n\\nopagebreak[4]\nBeta", "Alpha\nBeta"],
      ["Alpha\n\\Needspace{4\\baselineskip}\nBeta", "Alpha\nBeta"],
      ["Alpha\n\\appendix\nBeta", "Alpha\nBeta"],
    ];
    for (const [draft, polished] of intents) {
      expect(strictFidelityIssues(draft, polished)).toContain("explicit layout intents changed or were reordered");
    }
    expect(strictFidelityIssues("\\section{Alpha}\n\nBody.", "\\section{Alpha}\nBody.")).toEqual([]);
  });

  test("does not reuse a title from an Agent attempt that changes a protected payload", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-rejected-title-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "fake-agent.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      "printf 'Answer A. \\\\cite{invented}\\n' > body.tex",
      "printf 'Untrusted Rejected Title\\n' > title.txt",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"checked\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"checked\"}]}' > review.json",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);
    const compiler = await oneShotLayoutCompiler(root);
    const result = await polishBodyWithAgent({
      sourceMarkdown: "Answer A.",
      draftBody: "Answer A.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: compiler,
      agentBin: agent,
      backend: "codex",
      needsTitle: true,
      makeWorkdir: async () => workdir,
      maxAttempts: 3,
      polishVerifiedDraft: true,
    });
    expect(result.usedAgent).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.body).toBe("Answer A.\n");
    expect(result.aiTitle).toBe("");
  });

  test("allows agent structural and math-layout polish when protected payloads remain intact", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-layout-polish-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "layout-agent.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      "printf '\\\\begin{enumerate}\\n\\\\item Alpha\\n\\\\item Beta\\n\\\\end{enumerate}\\n\\\\[\\\\begin{aligned}x&=1\\\\end{aligned}\\\\]\\n' > body.tex",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"applied\",\"reason\":\"semantic list\"},{\"id\":\"academic-layout\",\"action\":\"applied\",\"reason\":\"display alignment\"}]}' > review.json",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);
    const result = await polishBodyWithAgent({
      sourceMarkdown: "Alpha\n\nBeta\n\n\\(x=1\\)",
      draftBody: "Alpha\n\nBeta\n\n\\[x=1\\]\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: "/usr/bin/true",
      agentBin: agent,
      backend: "opencode",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      maxAttempts: 3,
      polishVerifiedDraft: true,
    });
    expect(result).toMatchObject({ usedAgent: true, compiled: true, attempts: 1 });
    expect(result.body).toContain("\\begin{aligned}");
  });

  test("skips the Agent entirely when the mechanical draft compiles cleanly", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-clean-draft-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "must-not-run.sh");
    await writeFile(agent, "#!/bin/sh\nexit 99\n", "utf8");
    await chmod(agent, 0o755);
    const result = await polishBodyWithAgent({
      sourceMarkdown: "Clean answer.",
      draftBody: "Clean answer.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: "/usr/bin/true",
      agentBin: agent,
      backend: "codex",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      maxAttempts: 3,
    });
    expect(result).toMatchObject({ usedAgent: false, compiled: true, attempts: 0, body: "Clean answer.\n" });
  });

  test("does not invoke the Agent for a non-fatal layout warning unless polish is enabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-layout-warning-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "must-not-run.sh");
    await writeFile(agent, "#!/bin/sh\nexit 99\n", "utf8");
    await chmod(agent, 0o755);
    const compiler = await oneShotLayoutCompiler(root);
    const result = await polishBodyWithAgent({
      sourceMarkdown: "A long but valid formula.",
      draftBody: "A long but valid formula.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: compiler,
      agentBin: agent,
      backend: "opencode",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      maxAttempts: 3,
    });
    expect(result).toMatchObject({ usedAgent: false, compiled: true, attempts: 0 });
  });

  test("limits verified-draft polish to one attempt even when repair allows more", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-one-polish-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "failing-agent.sh");
    await writeFile(agent, "#!/bin/sh\nexit 7\n", "utf8");
    await chmod(agent, 0o755);
    const result = await polishBodyWithAgent({
      sourceMarkdown: "Verified answer.",
      draftBody: "Verified answer.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: "/usr/bin/true",
      agentBin: agent,
      backend: "opencode",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      maxAttempts: 3,
      polishVerifiedDraft: true,
    });
    expect(result).toMatchObject({ usedAgent: false, compiled: true, attempts: 1 });
    expect(result.warnings.some((warning: string) => warning.includes("opencode adjust failed"))).toBe(true);
  });

  test("terminates the agent process group on timeout", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-agent-timeout-"));
    roots.push(root);
    const workdir = join(root, "work");
    const marker = join(root, "leaked-child.txt");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "slow-agent.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      `(sleep 0.25; printf leaked > '${marker}') &`,
      "wait",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);

    const result = await polishBodyWithAgent({
      sourceMarkdown: "Verified answer.",
      draftBody: "Verified answer.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: "/usr/bin/true",
      agentBin: agent,
      backend: "opencode",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      polishVerifiedDraft: true,
      agentTimeoutMs: 30,
      agentHardTimeoutMs: 30,
    });
    await new Promise((resolve) => setTimeout(resolve, 350));

    expect(result).toMatchObject({ usedAgent: false, attempts: 1 });
    expect(result.warnings.some((warning: string) => warning.includes("opencode reached the"))).toBe(true);
    await expect(access(marker)).rejects.toThrow();
  });

  test("keeps a live agent past the idle check and accepts its eventual polish", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-agent-idle-grace-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "quiet-agent.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      "sleep 0.08",
      "printf 'Answer A.\\n' > body.tex",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"full structure checked\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"layout already restrained\"}]}' > review.json",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);
    const progress: string[] = [];
    const result = await polishBodyWithAgent({
      sourceMarkdown: "Answer A.",
      draftBody: "Answer A.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: "/usr/bin/true",
      agentBin: agent,
      backend: "claude",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      polishVerifiedDraft: true,
      agentTimeoutMs: 20,
      agentHardTimeoutMs: 500,
      onProgress: (text: string) => progress.push(text),
    });
    expect(result).toMatchObject({ usedAgent: true, compiled: true });
    expect(progress.some((line) => line.includes("still alive"))).toBe(true);
  });

  test("applies isolated, network-capable launch policy to all three backends", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-agent-policy-"));
    roots.push(root);
    const style = join(root, "style-source.md");
    const skills = join(root, "skills");
    await writeFile(style, "STYLE_SENTINEL\n", "utf8");
    await mkdir(join(skills, "one"), { recursive: true });
    await mkdir(join(skills, "two"), { recursive: true });
    await writeFile(join(skills, "one", "SKILL.md"), "ONE_SENTINEL\n", "utf8");
    await writeFile(join(skills, "two", "SKILL.md"), "TWO_SENTINEL\n", "utf8");

    for (const backend of ["codex", "claude", "opencode"]) {
      const workdir = join(root, `work-${backend}`);
      const agent = join(root, `${backend}-agent.sh`);
      await mkdir(workdir, { recursive: true });
      const policyChecks = backend === "codex"
        ? [
            "case \" $* \" in *\" --ignore-user-config \"*) ;; *) exit 21 ;; esac",
            "case \" $* \" in *\" sandbox_workspace_write.network_access=true \"*) ;; *) exit 22 ;; esac",
            "case \" $* \" in *\" sandbox_workspace_write.writable_roots=[] \"*) ;; *) exit 23 ;; esac",
          ]
        : backend === "claude"
          ? [
              "case \" $* \" in *\" --safe-mode \"*) ;; *) exit 24 ;; esac",
              "case \" $* \" in *dangerously-skip-permissions*) exit 25 ;; *) ;; esac",
              "case \" $* \" in *\" --disallowedTools Bash,Task \"*) ;; *) exit 26 ;; esac",
            ]
          : [
              "case \" $* \" in *\" --pure \"*) ;; *) exit 27 ;; esac",
              "case \" $* \" in *dangerously-skip-permissions*) exit 28 ;; *) ;; esac",
              "grep -q '\"external_directory\": \"deny\"' opencode.json || exit 29",
              "grep -q '\"webfetch\": \"allow\"' opencode.json || exit 30",
            ];
      const reportEvent = backend === "codex"
        ? '{"type":"item.completed","item":{"type":"agent_message","text":"codex concrete audit report"}}'
        : backend === "claude"
          ? '{"type":"result","result":"claude concrete audit report"}'
          : '{"type":"text","text":"opencode concrete audit report"}';
      await writeFile(agent, [
        "#!/bin/sh",
        "grep -q STYLE_SENTINEL style.md || exit 11",
        "grep -q ONE_SENTINEL skills/one/SKILL.md || exit 12",
        "grep -q TWO_SENTINEL skills/two/SKILL.md || exit 13",
        ...policyChecks,
        "printf 'Answer A.\\n' > body.tex",
        "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"full structure checked\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"layout already restrained\"}]}' > review.json",
        `printf '%s\\n' '${reportEvent}'`,
      ].join("\n"), "utf8");
      await chmod(agent, 0o755);

      const result = await polishBodyWithAgent({
        sourceMarkdown: "Answer A.",
        draftBody: "Answer A.\n",
        templateText: "{{body}}",
        styleDoc: style,
        skillsDir: skills,
        assemble: (body: string) => body,
        latexBin: "/usr/bin/true",
        agentBin: agent,
        backend,
        needsTitle: false,
        makeWorkdir: async () => workdir,
        polishVerifiedDraft: true,
      });
      expect(result).toMatchObject({ usedAgent: true, compiled: true });
      expect(result.agentSummary).toContain("concrete audit report");
    }
  });

  test("invokes the Agent only after a real mechanical compile defect", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-broken-draft-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "repair-agent.sh");
    const compiler = join(root, "compile-by-body.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      "printf '\\\\emph{Alpha}.\\n' > body.tex",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"checked\"},{\"id\":\"academic-layout\",\"action\":\"applied\",\"reason\":\"replaced unsupported emphasis markup\"}]}' > review.json",
    ].join("\n"), "utf8");
    await writeFile(compiler, [
      "#!/bin/sh",
      "for last do :; done",
      "if grep -q '\\\\textbf' \"$last\"; then printf '%s\\n' '! Undefined control sequence.' > out.log; exit 1; fi",
      ": > out.log",
      "exit 0",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);
    await chmod(compiler, 0o755);
    const result = await polishBodyWithAgent({
      sourceMarkdown: "Alpha.",
      draftBody: "\\textbf{Alpha}.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: compiler,
      agentBin: agent,
      backend: "codex",
      needsTitle: false,
      makeWorkdir: async () => workdir,
      maxAttempts: 2,
    });
    expect(result).toMatchObject({ usedAgent: true, compiled: true, attempts: 1, body: "\\emph{Alpha}.\n" });
  });

  test("surfaces incomplete review evidence without blocking compiled agent output", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-fresh-review-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    await writeFile(join(workdir, "review.json"), '{"decisions":[{"id":"whole-document-structure","action":"kept","reason":"stale"},{"id":"academic-layout","action":"kept","reason":"stale"}]}', "utf8");
    await writeFile(join(workdir, "title.txt"), "Stale title\n", "utf8");
    const silentAgent = join(root, "silent-agent.sh");
    await writeFile(silentAgent, "#!/bin/sh\nexit 0\n", "utf8");
    await chmod(silentAgent, 0o755);
    const compiler = await oneShotLayoutCompiler(root);
    const stale = await polishBodyWithAgent({
      sourceMarkdown: "Answer A.",
      draftBody: "Answer A.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: compiler,
      agentBin: silentAgent,
      backend: "codex",
      needsTitle: true,
      makeWorkdir: async () => workdir,
      maxAttempts: 1,
      polishVerifiedDraft: true,
    });
    expect(stale.usedAgent).toBe(true);
    expect(stale.aiTitle).toBe("");
    expect(stale.warnings.some((warning: string) => warning.includes("review incomplete"))).toBe(true);

    const duplicateWorkdir = join(root, "duplicate-work");
    await mkdir(duplicateWorkdir, { recursive: true });
    const duplicateAgent = join(root, "duplicate-agent.sh");
    await writeFile(duplicateAgent, [
      "#!/bin/sh",
      "printf 'Answer A.\\n' > body.tex",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"one\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"two\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"duplicate\"}]}' > review.json",
    ].join("\n"), "utf8");
    await chmod(duplicateAgent, 0o755);
    const duplicateCompiler = await oneShotLayoutCompiler(root, "duplicate-latex.sh");
    const duplicate = await polishBodyWithAgent({
      sourceMarkdown: "Answer A.",
      draftBody: "Answer A.\n",
      templateText: "{{body}}",
      assemble: (body: string) => body,
      latexBin: duplicateCompiler,
      agentBin: duplicateAgent,
      backend: "codex",
      needsTitle: false,
      makeWorkdir: async () => duplicateWorkdir,
      maxAttempts: 1,
      polishVerifiedDraft: true,
    });
    expect(duplicate.usedAgent).toBe(true);
    expect(duplicate.warnings.some((warning: string) => warning.includes("duplicate candidate"))).toBe(true);
  });

  test("compiles an Agent title together with its candidate body before accepting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-title-compile-"));
    roots.push(root);
    const workdir = join(root, "work");
    await mkdir(workdir, { recursive: true });
    const agent = join(root, "fake-agent.sh");
    const compiler = join(root, "fake-latex.sh");
    await writeFile(agent, [
      "#!/bin/sh",
      "printf 'Answer A.\\n' > body.tex",
      "printf 'Candidate Title\\n' > title.txt",
      "printf '%s\\n' '{\"decisions\":[{\"id\":\"whole-document-structure\",\"action\":\"kept\",\"reason\":\"checked\"},{\"id\":\"academic-layout\",\"action\":\"kept\",\"reason\":\"checked\"}]}' > review.json",
    ].join("\n"), "utf8");
    await writeFile(compiler, [
      "#!/bin/sh",
      "for last do :; done",
      "if grep -q 'Candidate Title' \"$last\"; then : > out.log; exit 1; fi",
      "if [ ! -f .aaronnote-draft-checked ]; then",
      "  touch .aaronnote-draft-checked",
      "  printf '%s\\n' 'Overfull \\hbox (1.0pt too wide)' > out.log",
      "  exit 0",
      "fi",
      ": > out.log",
      "exit 0",
    ].join("\n"), "utf8");
    await chmod(agent, 0o755);
    await chmod(compiler, 0o755);
    const result = await polishBodyWithAgent({
      sourceMarkdown: "Answer A.",
      draftBody: "Answer A.\n",
      templateText: "{{body}}",
      assemble: (body: string, title = "") => `\\title{${title || "Original Title"}}\n${body}`,
      latexBin: compiler,
      agentBin: agent,
      backend: "codex",
      needsTitle: true,
      makeWorkdir: async () => workdir,
      maxAttempts: 1,
      polishVerifiedDraft: true,
    });
    expect(result.usedAgent).toBe(false);
    expect(result.aiTitle).toBe("");
  });

  test("builds mandatory and context-sensitive polish candidates", () => {
    const candidates = buildPolishCandidates([
      "(a) First", "(b) Second", "", "Proof follows.",
      "#+begin theorem Key", "Body.", "#+end theorem",
    ].join("\n"), [
      "\\[", "x=" + "a\\otimes b\\otimes c\\otimes d\\otimes e".repeat(4), "\\]",
      "\\cite[p. 2]{ref:A}",
      ...Array.from({ length: 270 }, () => "Body."),
    ].join("\n"));
    expect(candidates.map((candidate: { id: string }) => candidate.id)).toEqual(expect.arrayContaining([
      "whole-document-structure", "academic-layout", "alpha-enumeration", "role-environments",
      "semantic-environments", "display-math-layout", "citation-presentation", "long-document-flow", "long-material",
    ]));
  });

  test("loadAgentRules reads envMap/commentBlocks and returns null when empty", async () => {
    const root = await mkdtemp(join(tmpdir(), "aaronnote-agent-"));
    roots.push(root);
    await mkdir(join(root, "mechanical"), { recursive: true });
    expect(await loadAgentRules(root)).toBe(null); // no file yet

    await writeFile(join(root, "mechanical", "rules.json"),
      JSON.stringify({ envMap: { claim: "theorem" }, commentBlocks: ["aside"] }), "utf8");
    const rules = await loadAgentRules(root) as { envMap: Record<string, string>; commentBlocks: string[] };
    expect(rules.envMap.claim).toBe("theorem");
    expect(rules.commentBlocks).toContain("aside");

    await writeFile(join(root, "mechanical", "rules.json"),
      JSON.stringify({ envMap: {}, commentBlocks: [] }), "utf8");
    expect(await loadAgentRules(root)).toBe(null); // empty rules -> null
  });
});
