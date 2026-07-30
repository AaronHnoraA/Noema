(function () {
  "use strict";

  const root = document.querySelector(".reveal");
  const slides = Array.from(document.querySelectorAll(".slides > section"));

  function siteData() {
    try {
      return typeof SITE_DATA === "object" && SITE_DATA ? SITE_DATA : { meta: {}, notes: [] };
    } catch (_error) {
      return { meta: {}, notes: [] };
    }
  }

  function publicNotes(data) {
    return (Array.isArray(data.notes) ? data.notes : [])
      .filter((note) => note && !note.private && !note.hidden)
      .sort((left, right) => {
        const leftDate = Date.parse(left.date || "") || 0;
        const rightDate = Date.parse(right.date || "") || 0;
        return rightDate - leftDate || String(left.title || "").localeCompare(String(right.title || ""));
      });
  }

  function shortDate(value) {
    const date = new Date(value);
    if (!value || Number.isNaN(date.getTime())) return "Living note";
    return new Intl.DateTimeFormat("en", { month: "short", day: "2-digit", year: "numeric" }).format(date);
  }

  function trimmedSummary(note) {
    const text = String(note.summary || note.searchText || "A note from the public research notebook.")
      .replace(/\s+/g, " ")
      .trim();
    return text.length > 155 ? `${text.slice(0, 152).trimEnd()}…` : text;
  }

  function makeNoteCard(note) {
    const link = document.createElement("a");
    link.className = "note-card";
    link.href = String(note.link || "notes.html");

    const date = document.createElement("span");
    date.className = "note-date";
    date.textContent = shortDate(note.date);

    const title = document.createElement("h3");
    title.textContent = String(note.title || "Untitled note");

    const summary = document.createElement("p");
    summary.textContent = trimmedSummary(note);

    const action = document.createElement("span");
    action.className = "note-open";
    action.textContent = "Open note ↗";

    link.append(date, title, summary, action);
    return link;
  }

  function hydrateNotebook() {
    const data = siteData();
    const notes = publicNotes(data);
    const tags = new Set(notes.flatMap((note) => Array.isArray(note.tags) ? note.tags : []).filter(Boolean));
    const noteCount = document.querySelector("[data-note-count]");
    const tagCount = document.querySelector("[data-tag-count]");
    const updatedDate = document.querySelector("[data-updated-date]");
    const recent = document.querySelector("[data-recent-notes]");
    const generated = document.querySelector("[data-generated-label]");

    if (noteCount) noteCount.textContent = new Intl.NumberFormat("en").format(notes.length);
    if (tagCount) tagCount.textContent = new Intl.NumberFormat("en").format(tags.size);
    if (updatedDate) updatedDate.textContent = notes.length ? shortDate(notes[0].date) : "—";

    if (recent && notes.length) {
      recent.replaceChildren(...notes.slice(0, 3).map(makeNoteCard));
    }

    const generatedAt = data.meta && data.meta.generatedAt;
    if (generated && generatedAt) {
      const parsed = new Date(generatedAt);
      if (!Number.isNaN(parsed.getTime())) {
        generated.textContent = `Notebook updated ${new Intl.DateTimeFormat("en", {
          month: "short",
          day: "numeric",
          year: "numeric",
        }).format(parsed)}`;
      }
    }
  }

  function setDeckPosition(index) {
    const position = document.querySelector("[data-deck-position]");
    if (position) {
      position.textContent = `${String(index + 1).padStart(2, "0")} / ${String(slides.length).padStart(2, "0")}`;
    }
    const currentId = slides[index] && slides[index].id;
    const cliIsActive = currentId === "cli";
    document.body.classList.toggle("cli-active", cliIsActive);
    document.querySelectorAll("[data-slide-link]").forEach((link) => {
      link.classList.toggle("is-active", link.dataset.slideLink === currentId);
    });
    if (cliIsActive) {
      window.dispatchEvent(new CustomEvent("aaronnote:cli-visible"));
    }
  }

  hydrateNotebook();

  if (!root || typeof window.Reveal !== "function") {
    document.body.classList.add("reveal-unavailable");
    return;
  }

  const deck = new window.Reveal(root, {
    width: 1440,
    height: 900,
    margin: 0,
    minScale: 0.18,
    maxScale: 1.5,
    controls: true,
    controlsLayout: "edges",
    controlsTutorial: false,
    progress: true,
    slideNumber: false,
    hash: true,
    history: true,
    keyboard: true,
    touch: true,
    overview: true,
    center: false,
    transition: "fade",
    transitionSpeed: "default",
    backgroundTransition: "fade",
    autoAnimate: false,
  });

  deck.on("ready", (event) => {
    document.body.classList.add("deck-ready");
    setDeckPosition(Number.isFinite(event.indexh) ? event.indexh : 0);
  });

  deck.on("slidechanged", (event) => {
    setDeckPosition(Number.isFinite(event.indexh) ? event.indexh : 0);
  });

  document.querySelectorAll("[data-next-slide]").forEach((button) => {
    button.addEventListener("click", () => deck.next());
  });

  deck.initialize().catch((error) => {
    document.body.classList.add("reveal-unavailable");
    console.error("Unable to initialize homepage presentation", error);
  });
})();
