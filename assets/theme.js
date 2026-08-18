// NexxtLevel Store — перемикач теми (світла / темна)
(function () {
  var STORAGE_KEY = 'nl_theme';

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function getSavedTheme() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return null;
    }
  }

  function saveTheme(theme) {
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {
      /* ignore (private mode / storage disabled) */
    }
  }

  function init() {
    // Safety net: keep in sync with the inline bootstrap that already ran
    // before first paint (this covers pages where the bootstrap snippet
    // might be missing for any reason).
    var saved = getSavedTheme();
    if (saved === 'dark') applyTheme('dark');

    var btn = document.getElementById('themeToggleBtn');
    if (!btn) return;

    btn.addEventListener('click', function () {
      var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      var next = isDark ? 'light' : 'dark';
      applyTheme(next);
      saveTheme(next);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
