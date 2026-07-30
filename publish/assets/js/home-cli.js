/* home-cli.js — Terminal CLI for Aaron He's site */

(function () {
  "use strict";

  /* ── DOM ──────────────────────────────────────────────────────────────── */
  const scroll   = document.getElementById("terminal-scroll");
  const history  = document.getElementById("terminal-history");
  const input    = document.getElementById("terminal-input");

  if (!scroll || !history || !input) return;

  /* ── Input history (↑/↓) ─────────────────────────────────────────────── */
  const inputHistory = [];
  let histIdx = -1;
  let savedDraft = "";

  /* ── Virtual filesystem state ────────────────────────────────────────── */
  let cwd = "~";

  /* ── Auto-scroll ─────────────────────────────────────────────────────── */
  function scrollBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  function terminalIsVisible() {
    const slide = input.closest(".cli-slide");
    return !slide || slide.classList.contains("present");
  }

  /* ── Build prompt PS1 HTML (dynamic cwd) ────────────────────────────── */
  function ps1() {
    return `<span class="p-user">hc</span><span class="p-at">@</span><span class="p-host">Aaron</span> <span class="p-path">${escHtml(cwd)}</span> <span class="p-sym">%</span>`;
  }

  /* Sync the live input-area prompt path span */
  function updateInputPrompt() {
    const el = document.querySelector(".prompt-area .p-path");
    if (el) el.textContent = cwd;
  }

  /* ── Append a command block (echo + output) ──────────────────────────── */
  function appendBlock(cmdText, outputHtml) {
    const block = document.createElement("div");
    block.className = "cmd-block";

    const echo = document.createElement("div");
    echo.className = "cmd-prompt-echo";
    echo.innerHTML = `<span class="prompt-ps1">${ps1()}</span>&nbsp;<span class="t-cmd">${escHtml(cmdText)}</span>`;

    const out = document.createElement("div");
    out.className = "cmd-output";
    out.innerHTML = outputHtml;

    block.appendChild(echo);
    if (outputHtml) block.appendChild(out);
    history.appendChild(block);
    scrollBottom();
  }

  /* ── Helpers ─────────────────────────────────────────────────────────── */
  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function line(cls, text) {
    return `<span class="t-line ${cls}">${escHtml(text)}</span>`;
  }

  function blank() { return `<span class="t-blank"></span>`; }

  /* ── Notes data helper ───────────────────────────────────────────────── */
  function getKnowledge() {
    return window.KNOWLEDGE_DATA || null;
  }

  /* ── Person info (single source of truth) ───────────────────────────── */
  const PERSON = {
    name:           "Chang He (Aaron)",
    role:           "Mathematics undergraduate",
    program:        "Talented Students Program",
    school:         "UNSW Sydney",
    supervisorText: "Youming Qiao",
    supervisorUrl:  "https://sites.google.com/site/jimmyqiao86/",
    research:       "Quantum · TCS · Algebra",
    location:       "Sydney, AU",
    github:         "AaronHnoraA",
    githubUrl:      "https://github.com/AaronHnoraA",
    cv:             "CV/Aaron_He_CV.pdf",
  };

  /* ── Virtual filesystem helpers ──────────────────────────────────────── */

  function findGroup(name, k) {
    if (!k) return null;
    const lower = name.toLowerCase();
    return k.groups.find((g) =>
      g.label === name || g.label.toLowerCase() === lower ||
      (g.key && (g.key === name || g.key.toLowerCase() === lower))
    ) || null;
  }

  /* Resolve a target path relative to cwd; returns null if not found */
  function resolvePath(target, k) {
    if (!target || target === "~") return "~";
    if (target.startsWith("~/")) return target.replace(/\/$/, "");
    if (target === "..") {
      if (cwd === "~") return "~";
      if (cwd === "~/notes") return "~";
      if (cwd.startsWith("~/notes/")) return "~/notes";
      return "~";
    }
    const lower = target.toLowerCase();
    if (lower === "notes" || lower === "notes/") return "~/notes";
    if (lower === "cv") return "~/CV";
    /* Smart: look for a group under notes/ from anywhere */
    const g = findGroup(target, k);
    if (g) return "~/notes/" + g.label;
    return null;
  }

  /* ── Interactive search filter (used by search-live inputs) ─────────── */
  window._searchFilter = function (uid, query) {
    const notes     = window["_sn_" + uid];
    const resultsEl = document.getElementById(uid + "-r");
    const countEl   = document.getElementById(uid + "-n");
    if (!notes || !resultsEl) return;

    const q = (query || "").trim().toLowerCase();
    let filtered;
    if (!q) {
      filtered = notes.slice(0, 20);
    } else {
      filtered = notes.filter((n) => {
        const title = (n.title || "").toLowerCase();
        const tags  = (n.tags  || []).join(" ").toLowerCase();
        const group = (n.group || "").toLowerCase();
        return title.includes(q) || tags.includes(q) || group.includes(q);
      });
    }

    if (countEl) countEl.textContent = q ? ` (${filtered.length})` : ` (${notes.length})`;

    if (!filtered.length) {
      resultsEl.innerHTML = `<div class="out-note-item t-dim">  no results</div>`;
      return;
    }

    const MAX = 30;
    const shown = filtered.slice(0, MAX);
    const parts = shown.map((n) => {
      const lnk  = n.link
        ? `<a class="out-note-link" href="${escHtml(n.link)}">${escHtml(n.title)}</a>`
        : escHtml(n.title);
      const date  = n.date  ? ` <span class="out-note-date">${escHtml(n.date)}</span>` : "";
      const group = n.group ? ` <span class="out-note-date">${escHtml(n.group)}</span>` : "";
      const tags  = (n.tags || []).slice(0, 3).map((t) =>
        `<span class="t-cmd tag-btn" onclick="window._termRun('search ${escHtml(t)}')">${escHtml(t)}</span>`
      ).join(" ");
      return `<div class="out-note-item">  ${lnk}${date}${group}${tags ? "  " + tags : ""}</div>`;
    });
    if (filtered.length > MAX) {
      parts.push(`<div class="out-note-item t-dim">  … and ${filtered.length - MAX} more</div>`);
    }
    resultsEl.innerHTML = parts.join("");
  };

  /* ── Global run hook (used by tag-btn onclick) ───────────────────────── */
  window._termRun = function (cmd) {
    if (cmd.trim()) {
      inputHistory.unshift(cmd);
      if (inputHistory.length > 200) inputHistory.pop();
    }
    histIdx = -1;
    savedDraft = "";
    const output = dispatch(cmd);
    if (output !== null) {
      appendBlock(cmd, output || "");
    } else if (cmd.trim() !== "clear" && cmd.trim() !== "cls") {
      appendBlock(cmd, "");
    }
  };

  /* ── COMMANDS ─────────────────────────────────────────────────────────── */

  const COMMANDS = {

    help(_args) {
      return [
        line("out-section-title", "Available commands:"),
        blank(),
        `<table class="out-table">` +
        rows([
          ["about",        "Personal information and research profile"],
          ["notes",        "Browse published notes by section"],
          ["ls [path]",    "List directory (cwd-aware)"],
          ["cd <dir>",     "Change directory  (~ notes/ <group>)"],
          ["tree",         "Directory tree of notes"],
          ["search <q>",   "Search notes by title or tag"],
          ["tags",         "List all tags (click to search)"],
          ["recent [n]",   "Most recently updated notes"],
          ["random",       "Open a random note"],
          ["graph",        "Open the knowledge graph"],
          ["archive",      "Go to the full notes archive"],
          ["publications", "Publications and preprints"],
          ["neofetch",     "Show personal info panel"],
          ["cv",           "Open CV (PDF)"],
          ["github",       "Open GitHub profile"],
          ["clear",        "Clear the terminal"],
          ["help",         "Show this message"],
        ]) +
        `</table>`,
      ].join("\n");
    },

    about(_args) {
      const p = PERSON;
      return [
        blank(),
        `<table class="out-table">` +
        rows([
          ["Name",       escHtml(p.name)],
          ["Role",       escHtml(p.role)],
          ["School",     escHtml(p.school)],
          ["Program",    escHtml(p.program)],
          ["Supervisor", `<a class='out-note-link' href='${escHtml(p.supervisorUrl)}' target='_blank'>${escHtml(p.supervisorText)}</a>`],
          ["Research",   escHtml(p.research)],
          ["Email",      `<a class='out-note-link' href='#' data-contact-link>Send email</a>`],
          ["GitHub",     `<a class='out-note-link' href='${escHtml(p.githubUrl)}' target='_blank'>${escHtml(p.github)}</a>`],
          ["CV",         `<a class='out-note-link' href='${escHtml(p.cv)}' target='_blank'>${escHtml(p.cv)}</a>`],
        ]) +
        `</table>`,
        blank(),
        line("out-val", "I keep these notes in public so each topic has to survive"),
        line("out-val", "careful writing, revision, and cross-reference."),
      ].join("\n");
    },

    whoami(_args) { return COMMANDS.about([]); },

    research(_args) {
      return [
        blank(),
        line("out-section-title", "Research interests"),
        blank(),
        line("out-key", "Quantum computing"),
        line("out-val", "  Quantum states, observables, density operators, the linear"),
        line("out-val", "  algebra behind them; quantum information theory."),
        blank(),
        line("out-key", "Theoretical computer science"),
        line("out-val", "  Complexity, algorithms, combinatorics, and communication"),
        line("out-val", "  complexity."),
        blank(),
        line("out-key", "Algebraic structure"),
        line("out-val", "  Galois theory, group theory, linear algebra over general fields."),
      ].join("\n");
    },

    cd(args) {
      const k = getKnowledge();
      const target = args[0];
      if (!target || target === "~") {
        cwd = "~";
        updateInputPrompt();
        return null;
      }
      const resolved = resolvePath(target, k);
      if (!resolved) {
        return line("out-error", `cd: ${escHtml(target)}: No such directory`);
      }
      cwd = resolved;
      updateInputPrompt();
      return null;
    },

    ls(args) {
      const k = getKnowledge();
      const target = args[0];

      let path = cwd;
      if (target) {
        const r = resolvePath(target, k);
        if (!r) return line("out-error", `ls: ${escHtml(target)}: No such directory`);
        path = r;
      }

      if (path === "~") {
        const groupList = k
          ? k.groups.map((g) =>
              `<div class="out-note-item">  <span class="out-note-group">${escHtml(g.label)}/</span> <span class="out-note-date">(${g.items.length} notes)</span></div>`
            ).join("")
          : "";
        return [
          blank(),
          line("out-section-title", "~/"),
          `<div class="out-note-item">  <span class="out-note-group">notes/</span></div>`,
          groupList,
          blank(),
          line("out-dim", "  CV/          about.txt      research.txt"),
        ].join("\n");
      }

      if (path === "~/notes") {
        if (!k) return line("out-warn", "Note data not loaded yet.");
        const sections = k.groups.map((g) =>
          `<div class="out-note-item">  <span class="out-note-group">${escHtml(g.label)}/</span> <span class="out-note-date">(${g.items.length} notes)</span></div>`
        ).join("");
        return [blank(), line("out-section-title", "~/notes/"), sections].join("\n");
      }

      if (path.startsWith("~/notes/")) {
        const groupName = path.slice("~/notes/".length);
        const g = findGroup(groupName, k);
        if (!g) return line("out-error", `ls: ${escHtml(path)}: No such directory`);
        const items = g.items.map((n) => {
          const lnk = n.link
            ? `<a class="out-note-link" href="${escHtml(n.link)}" target="_blank">${escHtml(n.title)}</a>`
            : escHtml(n.title);
          const date = n.date ? ` <span class="out-note-date">${escHtml(n.date)}</span>` : "";
          return `<div class="out-note-item">  ${lnk}${date}</div>`;
        }).join("");
        return [blank(), line("out-section-title", escHtml(path) + "/"), items].join("\n");
      }

      return line("out-error", `ls: ${escHtml(path)}: No such directory`);
    },

    dir(args) { return COMMANDS.ls(args); },

    tree(_args) {
      const k = getKnowledge();
      const parts = [blank(), line("out-section-title", "~/")];
      parts.push(`<div class="out-note-item"><span class="out-note-group">├── notes/</span></div>`);
      if (k) {
        k.groups.forEach((g, i) => {
          const last = i === k.groups.length - 1;
          const branch = last ? "└──" : "├──";
          parts.push(
            `<div class="out-note-item">` +
            `<span class="nf-border">│   </span>` +
            `<span class="out-note-group">${escHtml(branch)} ${escHtml(g.label)}/</span>` +
            ` <span class="out-note-date">(${g.items.length})</span>` +
            `</div>`
          );
        });
      }
      parts.push(`<div class="out-note-item"><span class="out-note-group">├── CV/</span></div>`);
      parts.push(`<div class="out-note-item t-dim">├── about.txt</div>`);
      parts.push(`<div class="out-note-item t-dim">└── research.txt</div>`);
      return parts.join("\n");
    },

    notes(args) {
      const k = getKnowledge();
      if (!k) return line("out-warn", "Note data not loaded yet — try again in a moment.");

      const query = args.join(" ").toLowerCase().trim();
      let groups = k.groups;

      if (query) {
        groups = groups
          .map((g) => ({
            ...g,
            items: g.items.filter(
              (n) =>
                n.title.toLowerCase().includes(query) ||
                n.tags.some((t) => t.includes(query)),
            ),
          }))
          .filter((g) => g.items.length > 0);
      }

      if (groups.length === 0) {
        return line("out-warn", `No notes matching "${query}".`);
      }

      const total = groups.reduce((s, g) => s + g.items.length, 0);
      const parts = [
        blank(),
        line("out-section-title", `Public notes (${total} shown${query ? ` · filtered: "${query}"` : ""})`),
      ];

      groups.forEach((g) => {
        parts.push(`<div class="out-note-group">  ${escHtml(g.label)}/</div>`);
        g.items.slice(0, 20).forEach((n) => {
          const date = n.date ? `<span class="out-note-date"> ${escHtml(n.date)}</span>` : "";
          const lnk = n.link
            ? `<a class="out-note-link" href="${escHtml(n.link)}" target="_blank">${escHtml(n.title)}</a>`
            : escHtml(n.title);
          parts.push(`<div class="out-note-item">    ${lnk}${date}</div>`);
        });
        if (g.items.length > 20) {
          parts.push(`<div class="out-note-item t-dim">    … and ${g.items.length - 20} more</div>`);
        }
      });

      if (query) {
        parts.push(blank());
        parts.push(line("out-hint", `  Tip: "notes" without arguments shows all sections.`));
      }

      return parts.join("\n");
    },

    search(args) {
      const k = getKnowledge();
      if (!k) return line("out-warn", "Note data not loaded yet.");
      const initialQuery = args.join(" ").trim();
      const uid = "srch" + Date.now();
      window["_sn_" + uid] = k.publicNotes || k.notes || [];
      setTimeout(() => {
        const inp = document.getElementById(uid + "-q");
        if (inp) {
          inp.focus();
          window._searchFilter(uid, initialQuery);
        }
      }, 0);
      return (
        `<div class="search-live" id="${uid}">` +
        `<div class="search-live-bar">` +
        `<span class="t-dim">/ </span>` +
        `<input id="${uid}-q" class="search-live-input" type="text" ` +
        `value="${escHtml(initialQuery)}" placeholder="filter notes…" ` +
        `autocomplete="off" autocorrect="off" spellcheck="false" ` +
        `oninput="window._searchFilter('${uid}',this.value)" ` +
        `onkeydown="if(event.key==='Escape'){document.getElementById('terminal-input').focus()}" />` +
        `<span class="search-live-count" id="${uid}-n"></span>` +
        `</div>` +
        `<div class="search-live-results" id="${uid}-r"></div>` +
        `</div>`
      );
    },

    tags(_args) {
      const k = getKnowledge();
      if (!k) return line("out-warn", "Note data not loaded yet.");
      const tags = (k.publicTags || k.tags || []).slice(0, 60);
      if (!tags.length) return line("out-warn", "No tags found.");
      const tagHtml = tags.map((t) => {
        const name = escHtml(t.name || t);
        const count = t.count || "";
        return `<span class="t-cmd tag-btn" onclick="window._termRun('search ${name}')">${name}</span><span class="out-note-date">(${count})</span>`;
      }).join("  ");
      return [
        blank(),
        line("out-section-title", `Tags (${tags.length})`),
        `  ` + tagHtml,
      ].join("\n");
    },

    recent(args) {
      const k = getKnowledge();
      if (!k) return line("out-warn", "Note data not loaded yet.");

      const count = Math.min(parseInt(args[0]) || 10, 50);
      const notes = (k.publicNotes || [])
        .filter((n) => n.date)
        .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
        .slice(0, count);

      if (!notes.length) return line("out-warn", "No notes with dates found.");

      const parts = [
        blank(),
        line("out-section-title", `Recent notes (${notes.length})`),
      ];

      notes.forEach((n) => {
        const lnk = n.link
          ? `<a class="out-note-link" href="${escHtml(n.link)}" target="_blank">${escHtml(n.title)}</a>`
          : escHtml(n.title);
        const date = n.date ? ` <span class="out-note-date">${escHtml(n.date)}</span>` : "";
        parts.push(`<div class="out-note-item">  ${lnk}${date}</div>`);
      });

      return parts.join("\n");
    },

    random(_args) {
      const k = getKnowledge();
      const notes = k ? (k.publicNotes || []) : [];
      if (!notes.length) return line("out-warn", "No notes available.");
      const n = notes[Math.floor(Math.random() * notes.length)];
      if (n.link) window.open(n.link, "_blank");
      return line("out-ok", "Opening: " + n.title);
    },

    publications(_args) {
      return [
        blank(),
        line("out-section-title", "Publications & preprints"),
        blank(),
        line("out-dim",  "  No publications yet."),
        blank(),
        line("out-val",  "  Working on research with Youming Qiao (UNSW Sydney)."),
        line("out-val",  "  Results forthcoming."),
      ].join("\n");
    },

    graph(_args) {
      if (typeof window.MacWindow === "undefined") {
        return line("out-err", "mac-window.js not loaded.");
      }
      window.MacWindow.open({
        title: "Knowledge Graph",
        width: Math.min(window.innerWidth * 0.88, 1100),
        height: Math.min(window.innerHeight * 0.85, 760),
        hasFocus: true,
        build(body, focus) {
          body.style.overflow = "hidden";
          body.style.display  = "flex";
          body.style.flexDirection = "column";

          const graphEl = document.createElement("div");
          graphEl.id = "graph-container-float";
          graphEl.style.cssText = "flex:1;min-height:0;";

          if (focus) {
            focus.id        = "graph-focus-float";
            focus.className = "macwin-focus graph-focus empty";
          }

          body.appendChild(graphEl);

          setTimeout(() => {
            if (typeof initKnowledgeGraph === "function") {
              initKnowledgeGraph({
                container:           graphEl,
                focusPanel:          focus,
                knowledge:           window.KNOWLEDGE_DATA,
                toolbar:             true,
                dispatchTagEvents:   false,
                dispatchFocusEvents: false,
              });
            } else {
              graphEl.innerHTML = '<div style="padding:20px;color:#9aa5ce">graph.js not loaded.</div>';
            }
          }, 30);
        },
      });
      return null;
    },

    archive(_args) {
      if (typeof window.MacWindow === "undefined") {
        return line("out-err", "mac-window.js not loaded.");
      }
      window.MacWindow.open({
        title: "Notes Archive",
        width: Math.min(window.innerWidth * 0.88, 1100),
        height: Math.min(window.innerHeight * 0.85, 760),
        build(body) {
          body.style.padding = "0";
          const iframe = document.createElement("iframe");
          iframe.src = "notes.html";
          iframe.style.cssText = "display:block;width:100%;height:100%;border:none;";
          body.appendChild(iframe);
        },
      });
      return null;
    },

    cv(_args) {
      window.open("CV/Aaron_He_CV.pdf", "_blank");
      return line("out-ok", "Opening CV/Aaron_He_CV.pdf in new tab.");
    },

    github(_args) {
      window.open("https://github.com/AaronHnoraA", "_blank");
      return line("out-ok", "Opening GitHub profile in new tab.");
    },

    neofetch(_args) { return buildFastfetch(); },
    fastfetch(_args) { return buildFastfetch(); },

    clear(_args) {
      history.innerHTML = "";
      return null;
    },

    cls(args) { return COMMANDS.clear(args); },

    /* Easter eggs */
    sudo(_args) {
      return line("out-error", "hc is not in the sudoers file. This incident will be reported.");
    },

    exit(_args) {
      return [
        line("out-warn", "logout"),
        line("out-dim", "Saving session..."),
        line("out-dim", "...copying shared history..."),
        line("out-dim", "...saving history...truncating history files..."),
        line("out-dim", "...completed."),
      ].join("\n");
    },

    uname(_args) {
      return line("t-line", "Darwin Aaron-MBP.local 25.5.0 Darwin Kernel Version 25.5.0 arm64");
    },

    pwd(_args) {
      const map = { "~": "/Users/hc", "~/notes": "/Users/hc/notes", "~/CV": "/Users/hc/CV" };
      return line("t-line", map[cwd] || cwd.replace("~", "/Users/hc"));
    },

    cat(args) {
      const target = args[0] || "";
      const map = {
        "about.txt":    () => COMMANDS.about([]),
        "research.txt": () => COMMANDS.research([]),
        "hostname":     () => line("t-line", "Aaron-MBP.local"),
        "/etc/hostname":() => line("t-line", "Aaron-MBP.local"),
      };
      if (map[target]) return map[target]();
      return line("out-error", `cat: ${escHtml(target)}: No such file or directory`);
    },

    open(args) {
      const target = args[0] || "";
      if (target === "notes" || target === "notes.html") return COMMANDS.archive([]);
      if (target === "graph")                            return COMMANDS.graph([]);
      if (target === "cv" || target === "CV")           return COMMANDS.cv([]);
      if (target === "github")                          return COMMANDS.github([]);
      return line("out-error", `open: ${escHtml(target)}: not found`);
    },
  };

  /* ── Personal fastfetch (boot + neofetch command) ─────────────────────── */

  function buildFastfetch() {
    const k = getKnowledge();
    const stats = k ? k.stats : null;

    const siteAge = Math.floor(
      (Date.now() - new Date("2025-06-01").getTime()) / (1000 * 60 * 60 * 24),
    );

    function daysAgo(dateStr) {
      if (!dateStr) return "—";
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      const days = Math.floor((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24));
      if (days === 0) return "today";
      if (days === 1) return "1 day ago";
      return days + " days ago";
    }

    const noteCount = stats
      ? stats.totalNotes
      : k ? (k.publicNotes || []).length : "—";
    const tagCount  = stats ? stats.totalTags  : "—";
    const linkCount = stats ? stats.totalReferenceEdges : "—";
    const updated   = stats ? daysAgo(stats.latestDate) : "—";

    function ll(inner) { return `<span class="ff-logo-line">${inner}</span>`; }
    function sp(s)     { return `<span class="ff-sphere">${escHtml(s)}</span>`; }
    function kt(s)     { return `<span class="ff-ket">${escHtml(s)}</span>`; }
    function pl(s)     { return `<span class="ff-plus">${escHtml(s)}</span>`; }
    function cp(s)     { return `<span class="ff-caption">${escHtml(s)}</span>`; }
    function dm(s)     { return `<span class="nf-border">${escHtml(s)}</span>`; }

    const logoHtml = [
      ll(sp("         .----.")),
      ll(sp("        /  |   \\")),
      ll(sp("       |   |    |") + "  " + kt("|0⟩")),
      ll(sp("       | ") + pl("-+-") + sp("   |") + "  " + dm("─────")),
      ll(sp("       |   |    |") + "  " + kt("|1⟩")),
      ll(sp("        \\  |   /")),
      ll(sp("         '----'")),
      ll(cp("  |ψ⟩ = α|0⟩+β|1⟩")),
    ].join("");

    const KW = 10;
    function kv(key, val, valCls) {
      valCls = valCls || "nf-val";
      return (
        `<div class="ff-row">` +
        `<span class="nf-key">${escHtml(key.padEnd(KW))}</span>` +
        `<span class="nf-arrow"> →  </span>` +
        `<span class="${valCls}">${val}</span>` +
        `</div>`
      );
    }

    function sep() { return `<div class="ff-sep"></div>`; }

    const p = PERSON;
    const infoHtml = [
      kv("Name",       escHtml(p.name)),
      kv("Role",       escHtml(p.role)),
      kv("School",     escHtml(p.school)),
      kv("Program",    escHtml(p.program)),
      kv("Supervisor", `<a class='out-note-link' href='${escHtml(p.supervisorUrl)}' target='_blank'>${escHtml(p.supervisorText)}</a>`),
      kv("Research",   escHtml(p.research)),
      kv("Location",   escHtml(p.location)),
      sep(),
      kv("Notes",   escHtml(String(noteCount)), "nf-val-hi"),
      kv("Tags",    escHtml(String(tagCount)),  "nf-val-hi"),
      kv("Links",   escHtml(String(linkCount)), "nf-val-hi"),
      kv("Updated", escHtml(String(updated)),   "nf-val-hi"),
      kv("Uptime",  escHtml(siteAge + " days"), "nf-val-hi"),
      sep(),
      kv("Email",  `<a class='out-note-link' href='#' data-contact-link>Send email</a>`),
      kv("GitHub", `<a class='out-note-link' href='${escHtml(p.githubUrl)}' target='_blank'>${escHtml(p.github)}</a>`),
      kv("CV",     `<a class='out-note-link' href='${escHtml(p.cv)}' target='_blank'>${escHtml(p.cv)}</a>`),
    ].join("");

    const palette =
      `<div class="palette-row ff-palette">` +
      [0,1,2,3,4,5,6,7].map((i) => `<span class="swatch swatch-${i}">  </span>`).join("") +
      `</div>`;

    return (
      `<div class="fastfetch">` +
      `<div class="ff-logo">${logoHtml}</div>` +
      `<div class="ff-info">${infoHtml}${palette}</div>` +
      `</div>`
    );
  }

  /* ── Fortune / cow generator ─────────────────────────────────────────── */

  const FORTUNES = [
    {
      text: "Why you say you no bunny rabbit when you have little powder-puff tail?",
      attr: "-- The Tasmanian Devil",
    },
    {
      text: "There are 10 types of people in the world:\nthose who understand binary, and those who don't.",
      attr: "-- unknown",
    },
    {
      text: "The best way to predict the future is to invent it.",
      attr: "-- Alan Kay",
    },
    {
      text: "A proof is a proof. What kind of a proof? It's a proof.\nA proof is a proof, and when you have a good proof, it's because it's proven.",
      attr: "-- Jean Chrétien",
    },
    {
      text: "Mathematics is the language with which God has written the universe.",
      attr: "-- Galileo Galilei",
    },
    {
      text: "It is not enough to be in the right place at the right time.\nYou should also have an open mind at the right time.",
      attr: "-- Paul Erdős",
    },
  ];

  function buildFortune() {
    const f = FORTUNES[Math.floor(Math.random() * FORTUNES.length)];
    const cowLines = [
      `              (__)`,
      `               (oo)`,
      `         /------\\/`,
      `        / |    ||`,
      `       *  /\\---/\\`,
      `          ~~   ~~`,
    ];

    const cowHtml = cowLines
      .map((l) => `<span class="t-line nf-border">${escHtml(l)}</span>`)
      .join("");

    const attrLines = f.text.split("\n")
      .map((l) => `<span class="t-line fortune-quote">${escHtml(l)}</span>`)
      .join("");

    return (
      cowHtml +
      `<span class="t-line fortune-quote">..."Have you mooed today?"...</span>` +
      attrLines +
      `<span class="t-line fortune-attr">        ${escHtml(f.attr)}</span>`
    );
  }

  /* ── Recent notes preview (boot) ─────────────────────────────────────── */

  function buildRecentPreview() {
    const k = getKnowledge();
    if (!k || !(k.publicNotes || []).length) return "";

    const notes = (k.publicNotes || [])
      .filter((n) => n.date)
      .sort((a, b) => (b.date > a.date ? 1 : b.date < a.date ? -1 : 0))
      .slice(0, 3);

    if (!notes.length) return "";

    const items = notes.map((n) => {
      const lnk = n.link
        ? `<a class="out-note-link" href="${escHtml(n.link)}" target="_blank">${escHtml(n.title)}</a>`
        : escHtml(n.title);
      const date = n.date ? ` <span class="out-note-date">${escHtml(n.date)}</span>` : "";
      return `<div class="out-note-item">  ${lnk}${date}</div>`;
    }).join("");

    return [
      `<span class="t-line out-section-title">Recent:</span>`,
      items,
      `<span class="t-blank"></span>`,
    ].join("");
  }

  /* ── Table builder ───────────────────────────────────────────────────── */

  function rows(pairs) {
    return pairs.map(([k, v]) =>
      `<tr><td class="td-key">${escHtml(k)}</td>` +
      `<td class="td-arrow">  →  </td>` +
      `<td>${v}</td></tr>`
    ).join("");
  }

  /* ── Command dispatcher ──────────────────────────────────────────────── */

  function dispatch(raw) {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const parts = trimmed.split(/\s+/);
    const cmd   = parts[0].toLowerCase();
    const args  = parts.slice(1);

    if (COMMANDS[cmd]) {
      return COMMANDS[cmd](args);
    }

    return line("out-error", `${escHtml(cmd)}: command not found  (type help for available commands)`);
  }

  /* ── Tab completion ─────────────────────────────────────────────────── */

  const COMMAND_NAMES = Object.keys(COMMANDS).sort();

  function tabCandidates(text) {
    const trimmed = text.trimStart();
    const spaceIdx = trimmed.indexOf(" ");

    if (spaceIdx === -1) {
      /* Completing command name */
      return COMMAND_NAMES.filter((c) => c.startsWith(trimmed) && c !== trimmed);
    }

    const cmd  = trimmed.slice(0, spaceIdx).toLowerCase();
    const rest = trimmed.slice(spaceIdx + 1);

    if (cmd === "cd" || cmd === "ls") {
      const k = getKnowledge();
      const paths = ["notes", "notes/", "CV", "~"];
      if (k) k.groups.forEach((g) => paths.push(g.label, "notes/" + g.label));
      const lo = rest.toLowerCase();
      return paths.filter((p) => p.toLowerCase().startsWith(lo) && p.toLowerCase() !== lo);
    }

    if (cmd === "search" || cmd === "tag") {
      const k = getKnowledge();
      const tags = k ? (k.publicTags || k.tags || []).map((t) => t.name || t) : [];
      const lo = rest.toLowerCase();
      return tags.filter((t) => t.toLowerCase().startsWith(lo) && t.toLowerCase() !== lo);
    }

    return [];
  }

  function applyCompletion(text, completion) {
    const trimmed = text.trimStart();
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) return completion + " ";
    return trimmed.slice(0, spaceIdx + 1) + completion + " ";
  }

  /* ── Keyboard handler ─────────────────────────────────────────────────── */

  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const text = input.value;
      const candidates = tabCandidates(text);
      if (candidates.length === 0) return;

      if (candidates.length === 1) {
        input.value = applyCompletion(text, candidates[0]);
      } else {
        /* Common prefix fill + show options */
        const common = candidates.reduce((a, b) => {
          let i = 0;
          while (i < a.length && i < b.length && a[i].toLowerCase() === b[i].toLowerCase()) i++;
          return a.slice(0, i);
        });
        const listHtml = candidates.map((c) => `<span class="t-cmd">${escHtml(c)}</span>`).join("  ");
        appendBlock(text, listHtml);

        const trimmed = text.trimStart();
        const spaceIdx = trimmed.indexOf(" ");
        const currentWord = spaceIdx === -1 ? trimmed : trimmed.slice(spaceIdx + 1);
        if (common.length > currentWord.length) {
          input.value = applyCompletion(text, common);
        }
      }
      return;
    }

    if (e.key === "Enter") {
      const raw = input.value;
      input.value = "";
      histIdx = -1;
      savedDraft = "";

      if (raw.trim()) {
        inputHistory.unshift(raw);
        if (inputHistory.length > 200) inputHistory.pop();
      }

      const output = dispatch(raw);
      if (output !== null) {
        appendBlock(raw, output || "");
      } else if (raw.trim() === "clear" || raw.trim() === "cls") {
        /* already cleared */
      } else {
        appendBlock(raw, "");
      }
      return;
    }

    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (histIdx === -1) savedDraft = input.value;
      if (histIdx < inputHistory.length - 1) {
        histIdx++;
        input.value = inputHistory[histIdx];
      }
      moveCursorEnd();
      return;
    }

    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (histIdx > 0) {
        histIdx--;
        input.value = inputHistory[histIdx];
      } else if (histIdx === 0) {
        histIdx = -1;
        input.value = savedDraft;
      }
      moveCursorEnd();
      return;
    }

    if (e.key === "l" && e.ctrlKey) {
      e.preventDefault();
      history.innerHTML = "";
    }
  });

  function moveCursorEnd() {
    const len = input.value.length;
    input.setSelectionRange(len, len);
  }

  /* ── Login time ──────────────────────────────────────────────────────── */

  (function () {
    const el = document.querySelector("[data-login-time]");
    if (!el) return;
    const d   = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    const days = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
    const mons = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const ts = `${days[d.getDay()]} ${mons[d.getMonth()]} ${String(d.getDate()).padStart(2," ")} `
             + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    el.textContent = `login time: ${ts} on ttys004`;
  })();

  /* ── Click anywhere → focus input ────────────────────────────────────── */

  document.getElementById("terminal-scroll").addEventListener("click", () => {
    if (!window.getSelection().toString()) {
      input.focus();
    }
  });

  window.addEventListener("aaronnote:cli-visible", () => {
    input.focus({ preventScroll: true });
    scrollBottom();
  });

  /* ── Startup boot sequence ────────────────────────────────────────────── */

  const nfEl = document.getElementById("neofetch-static");
  if (nfEl) nfEl.innerHTML = buildFastfetch();

  const rcEl = document.getElementById("recent-static");
  if (rcEl) rcEl.innerHTML = buildRecentPreview();

  const ftEl = document.getElementById("fortune-static");
  if (ftEl) ftEl.innerHTML = buildFortune();

  setTimeout(() => {
    const hint = document.getElementById("terminal-hint");
    if (hint) hint.style.visibility = "visible";
    if (terminalIsVisible()) input.focus({ preventScroll: true });
    scrollBottom();
  }, 100);

})();
