// Переключение вкладок — всё остальное живёт в модулях самих вкладок.
import { onReveal as onRevealQuali } from './quali-view.js';
import { onReveal as onRevealPoints } from './points-view.js';

const $ = (id) => document.getElementById(id);
const panels = { quali: $('tab-quali'), points: $('tab-points') };
const reveal = { quali: onRevealQuali, points: onRevealPoints };

const tabs = document.querySelectorAll('.tabs .tab');
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const t of tabs) {
      const on = t === tab;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', String(on));
    }
    for (const [name, panel] of Object.entries(panels)) {
      panel.hidden = name !== tab.dataset.tab;
    }
    reveal[tab.dataset.tab]?.();
  });
}
