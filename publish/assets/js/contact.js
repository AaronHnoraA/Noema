(function () {
  "use strict";

  // Keep the address out of static HTML and common email-harvesting regexes.
  // It is decoded only in response to an explicit user click.
  const key = 37;
  const encoded = [68, 68, 87, 74, 75, 11, 77, 64, 101, 86, 81, 80, 65, 64, 75, 81, 11, 80, 75, 86, 82, 11, 64, 65, 80, 11, 68, 80];

  function contactAddress() {
    return encoded.map((value) => String.fromCharCode(value ^ key)).join("");
  }

  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("[data-contact-link]") : null;
    if (!link) return;
    event.preventDefault();
    window.location.href = `mailto:${contactAddress()}`;
  });
})();
