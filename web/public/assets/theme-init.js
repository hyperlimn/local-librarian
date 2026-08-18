(function initializeLocalLibrarianTheme() {
  var storageKey = "local-librarian.theme";
  var stored = null;
  try { stored = window.localStorage.getItem(storageKey); } catch (_error) { /* Storage may be unavailable. */ }
  var theme = stored === "light" || stored === "dark"
    ? stored
    : window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  var meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#101b18" : "#173d32");
}());
