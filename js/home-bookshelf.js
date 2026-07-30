document.addEventListener("DOMContentLoaded", () => {
  if (!document.body.classList.contains("site-home") || document.body.classList.contains("site-archive")) {
    return;
  }

  const homeGrid = document.querySelector(".home-grid");
  if (!homeGrid) {
    return;
  }

  const heights = [278, 304, 288, 326, 296, 278, 306, 286, 274, 314];
  const widths = [164, 180, 170, 196, 176, 164, 188, 172, 162, 186];

  function slugify(value) {
    return String(value || "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function findPageById(root, id) {
    if (!id) {
      return null;
    }

    if (window.CSS && typeof window.CSS.escape === "function") {
      return root.querySelector(`#${window.CSS.escape(id)}`);
    }

    return document.getElementById(id);
  }

  function createShelfRow(index) {
    const row = document.createElement("section");
    row.className = "shelf-row";
    row.dataset.shelfRow = String(index + 1);
    row.innerHTML = `
      <div class="shelf-cavity">
        <div class="shelf-shadow"></div>
        <div class="shelf-books"></div>
        <div class="shelf-floor"></div>
      </div>
    `;
    return row;
  }

  function buildFallbackStructure() {
    const books = Array.from(homeGrid.querySelectorAll(":scope > .shelf-book"));
    if (books.length === 0) {
      return null;
    }

    const shelfMap = [0, 0, 0, 0, 1, 1, 1, 2, 2, 2];
    const bookshelfStage = document.createElement("div");
    bookshelfStage.className = "bookshelf-stage";

    const readingDesk = document.createElement("section");
    readingDesk.className = "bookshelf-reading-desk";
    readingDesk.innerHTML = `
      <div class="reading-desk-paper reading-desk-paper-placeholder">
        <p>Select a volume to open its notebook page.</p>
      </div>
    `;

    const shelfRows = [createShelfRow(0), createShelfRow(1), createShelfRow(2)];
    bookshelfStage.appendChild(readingDesk);
    shelfRows.forEach((row) => bookshelfStage.appendChild(row));

    books.forEach((book, index) => {
      const title = book.dataset.book || book.querySelector("h2")?.textContent?.trim() || `Book ${index + 1}`;
      const titleSlug = slugify(title) || `book-${index + 1}`;
      const rowIndex = shelfMap[index] ?? shelfMap[shelfMap.length - 1];
      const row = shelfRows[rowIndex];
      const shelfBooks = row.querySelector(".shelf-books");

      book.style.setProperty("--book-height", `${heights[index % heights.length]}px`);
      book.style.setProperty("--book-width", `${widths[index % widths.length]}px`);
      book.dataset.bookSlug = titleSlug;

      const pageWrapper = document.createElement("div");
      pageWrapper.className = "bookshelf-pages";
      pageWrapper.id = `${titleSlug}-pages`;

      while (book.firstChild) {
        pageWrapper.appendChild(book.firstChild);
      }

      const cover = document.createElement("button");
      cover.type = "button";
      cover.className = "bookshelf-cover";
      cover.setAttribute("aria-expanded", "false");
      cover.setAttribute("aria-controls", pageWrapper.id);
      cover.innerHTML = `
        <span class="bookshelf-cover-kicker">${index + 1 < 10 ? `0${index + 1}` : index + 1}</span>
        <span class="bookshelf-cover-title">${title}</span>
        <span class="bookshelf-cover-subtitle">open volume</span>
      `;

      book.appendChild(cover);
      shelfBooks.appendChild(book);
      readingDesk.appendChild(pageWrapper);
    });

    homeGrid.replaceChildren(bookshelfStage);
    return { books: Array.from(homeGrid.querySelectorAll(".shelf-book")), readingDesk, shelfRows };
  }

  function useExistingStructure() {
    const bookshelfStage = homeGrid.querySelector(".bookshelf-stage");
    if (!bookshelfStage) {
      return null;
    }

    const readingDesk = bookshelfStage.querySelector(".bookshelf-reading-desk");
    const shelfRows = Array.from(bookshelfStage.querySelectorAll(".shelf-row"));
    const books = Array.from(bookshelfStage.querySelectorAll(".shelf-book"));
    if (!readingDesk || books.length === 0) {
      return null;
    }

    books.forEach((book, index) => {
      const title = book.dataset.book || book.querySelector(".bookshelf-cover-title")?.textContent?.trim() || `Book ${index + 1}`;
      const titleSlug = slugify(title) || `book-${index + 1}`;
      const cover = book.querySelector(".bookshelf-cover");
      const pageId = cover?.getAttribute("aria-controls") || `${titleSlug}-pages`;

      book.style.setProperty("--book-height", `${heights[index % heights.length]}px`);
      book.style.setProperty("--book-width", `${widths[index % widths.length]}px`);
      book.dataset.bookSlug = titleSlug;

      if (cover) {
        cover.setAttribute("aria-expanded", "false");
      }

      book._bookshelfPages = findPageById(readingDesk, pageId);
    });

    return { books, readingDesk, shelfRows };
  }

  const structure = useExistingStructure() || buildFallbackStructure();
  if (!structure) {
    return;
  }

  const { books, readingDesk, shelfRows } = structure;

  function closeAllBooks() {
    books.forEach((book) => {
      book.classList.remove("is-open");
      const trigger = book.querySelector(".bookshelf-cover");
      const pages = book._bookshelfPages;
      if (trigger) {
        trigger.setAttribute("aria-expanded", "false");
      }
      if (pages) {
        pages.classList.remove("is-active");
      }
    });

    shelfRows.forEach((row) => row.classList.remove("has-open-book"));
    readingDesk.classList.remove("has-open-book");
  }

  function openBook(book, { pushHash = true, scroll = true } = {}) {
    if (!book) {
      return;
    }

    const isOpen = book.classList.contains("is-open");
    closeAllBooks();

    if (isOpen) {
      if (pushHash) {
        window.history.replaceState(null, "", window.location.pathname);
      }
      return;
    }

    const row = book.closest(".shelf-row");
    if (row) {
      row.classList.add("has-open-book");
    }
    readingDesk.classList.add("has-open-book");

    book.classList.add("is-open");
    const trigger = book.querySelector(".bookshelf-cover");
    const pages = book._bookshelfPages;
    if (trigger) {
      trigger.setAttribute("aria-expanded", "true");
    }
    if (pages) {
      pages.classList.add("is-active");
    }

    if (pushHash && book.id) {
      window.history.replaceState(null, "", `#${book.id}`);
    }

    if (scroll) {
      readingDesk.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  books.forEach((book) => {
    const cover = book.querySelector(".bookshelf-cover");
    if (cover) {
      cover.addEventListener("click", () => openBook(book));
    }
  });

  document.querySelectorAll('.site-nav a[href^="#"]').forEach((link) => {
    link.addEventListener("click", (event) => {
      const targetId = link.getAttribute("href")?.slice(1);
      const target = targetId ? document.getElementById(targetId) : null;
      if (!target || !target.classList.contains("shelf-book")) {
        return;
      }

      event.preventDefault();
      openBook(target, { pushHash: true, scroll: true });
    });
  });

  if (window.location.hash) {
    const target = document.getElementById(window.location.hash.slice(1));
    if (target && target.classList.contains("shelf-book")) {
      window.setTimeout(() => openBook(target, { pushHash: false, scroll: false }), 80);
    }
  }
});
