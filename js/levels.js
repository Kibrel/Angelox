(function () {
  'use strict';

  const charts = window.ANGELOX_CHARTS || [];
  const list = document.getElementById('levelList');
  const STORAGE_KEY = 'angelox.progress.v1';

  function readProgress() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || { cleared: {}, best: {} };
    } catch (_) {
      return { cleared: {}, best: {} };
    }
  }

  function isUnlocked(index, progress) {
    if (index === 0) return true;
    const previous = charts[index - 1];
    return !!(previous && progress.cleared && progress.cleared[previous.id]);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, ch => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[ch]));
  }

  function render() {
    const progress = readProgress();
    list.innerHTML = charts.map((chart, index) => {
      const number = String(chart.level || index + 1).padStart(2, '0');
      const title = escapeHtml(chart.title || `关卡 ${number}`);
      if (isUnlocked(index, progress)) {
        return `<a class="level-option" href="game.html?chart=${encodeURIComponent(chart.id)}">
          <span class="level-number">${number}</span>
          <span>${title}</span>
        </a>`;
      }
      return `<div class="level-option locked" aria-disabled="true">
        <span class="level-number">${number}</span>
        <span>${title}</span>
        <span class="lock-mark" aria-hidden="true">⌑</span>
      </div>`;
    }).join('');
  }

  render();
})();
