// Runs before the first paint (classic script, no module) so the saved look, theme and text size never flash.
// Always sets data-look and data-theme on <html>: app.css has one dark block per look and no media query.
(function () {
  var LOOKS = ['instrument', 'fisa', 'darkspear']; // the first one is the default, used when she has not chosen
  var root = document.documentElement;
  var dark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : { matches: false };
  function saved() {
    try {
      return JSON.parse(localStorage.getItem('rokhan:setari')) || {};
    } catch (e) {
      return {};
    }
  }
  function apply(s) {
    s = s || saved();
    root.dataset.look = LOOKS.indexOf(s.aspect) >= 0 ? s.aspect : LOOKS[0];
    root.dataset.theme = s.tema === 'luminos' ? 'light' : s.tema === 'intunecat' ? 'dark' : dark.matches ? 'dark' : 'light';
    if (s.text === 'mare') root.dataset.size = 'mare';
    else delete root.dataset.size;
    // The browser bar takes the colour of the header, read from the look's own token.
    var bar = getComputedStyle(root).getPropertyValue('--chrome').trim();
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta && bar) meta.content = bar;
  }
  apply();
  // "Sistem" follows the phone when it switches between day and night.
  if (dark.addEventListener) dark.addEventListener('change', function () { apply(); });
  window.rokhanTheme = { apply: apply, looks: LOOKS };
})();
