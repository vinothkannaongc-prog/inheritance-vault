// The preliminary audit page (/audit). A link to a finding (#f41, from the index, a cross-reference
// or a shared URL) opens that finding, and printing opens every finding so a printed copy carries
// their full text. Without this script the page still works: a finding opens when it is selected.
(function () {
  "use strict";

  function findingFor(hash) {
    if (!hash || hash.charAt(0) !== "#" || hash.length < 2) return null;
    var id;
    try { id = decodeURIComponent(hash.slice(1)); } catch (error) { return null; }
    var element = document.getElementById(id);
    return element && element.matches && element.matches("details.finding") ? element : null;
  }

  function openFromHash() {
    var finding = findingFor(window.location.hash);
    if (finding && !finding.open) finding.open = true;
  }

  // A click on a link to the finding already in the address bar fires no hashchange, so open here.
  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest("a[href^='#']") : null;
    if (!link) return;
    var finding = findingFor(link.getAttribute("href"));
    if (finding) finding.open = true;
  });
  window.addEventListener("hashchange", openFromHash);
  openFromHash();

  var openedForPrint = [];
  window.addEventListener("beforeprint", function () {
    openedForPrint = Array.prototype.filter.call(document.querySelectorAll("details.finding"), function (finding) {
      return !finding.open;
    });
    openedForPrint.forEach(function (finding) { finding.open = true; });
  });
  window.addEventListener("afterprint", function () {
    openedForPrint.forEach(function (finding) { finding.open = false; });
    openedForPrint = [];
  });
})();
