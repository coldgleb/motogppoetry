// Вкладка «Зачёт квалификаций»: сезон целиком, очки за места в квалификациях
// по гоночной системе MotoGP. Данные из API MotoGP (motogp.js, тот же кэш, что
// и у вкладки напарников), расчёт — в qualifying.js; здесь только DOM и события.

import { fetchSeasonQualifying, fetchCategories, fetchSeasons } from './motogp.js';
import { buildStandings } from './qualifying.js';
import { teamColor } from './teams.js';

const $ = (id) => document.getElementById(id);
const els = {
  season: $('p-season'),
  cls: $('p-class'),
  load: $('p-load'),
  status: $('p-status'),
  table: $('p-table'),
};

const state = { rounds: null, loading: false };

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  els.status.hidden = !msg;
  els.status.classList.toggle('error', isError);
}

function render() {
  if (!state.rounds) {
    els.table.innerHTML = '<p class="empty-state">Нажми «Загрузить», чтобы посчитать зачёт.</p>';
    return;
  }
  const { stages, drivers } = buildStandings(state.rounds);
  if (!drivers.length) {
    els.table.innerHTML = state.loading
      ? '<p class="empty-state">Загружаю квалификации…</p>'
      : '<p class="empty-state">В этом сезоне ещё нет квалификаций.</p>';
    return;
  }

  const head =
    '<thead><tr><th class="corner">Пилот</th>' +
    stages.map((s) => `<th>${s.label}</th>`).join('') +
    '<th class="p-total">Очки</th></tr></thead>';

  let body = '';
  drivers.forEach((d, i) => {
    const cells = stages
      .map((s) => {
        const c = d.cells.get(s.key);
        if (!c) return '<td class="p-cell">·</td>';
        return `<td class="p-cell${c.pts ? '' : ' p-zero'}" title="${s.label}: P${c.pos}">${c.pts || 0}</td>`;
      })
      .join('');
    body +=
      `<tr><th class="q-track p-driver" style="--team:${teamColor(d.team)}">` +
      `<span class="p-pos">${i + 1}</span>${d.code}</th>` +
      `${cells}<td class="p-total">${d.points}</td></tr>`;
  });

  els.table.innerHTML =
    `<div class="table-wrap"><table class="quali points">${head}<tbody>${body}</tbody></table></div>`;
}

// Номер текущей загрузки — как во вкладке напарников: сезон грузится сам,
// и этапы отменённой загрузки не должны досыпаться в новый календарь.
let gen = 0;

async function load() {
  if (!els.cls.value) return;
  const my = ++gen;
  const mine = () => my === gen;
  els.load.disabled = true;
  state.rounds = [];
  state.loading = true;
  try {
    setStatus('Загружаю квалификации сезона…');
    render();
    const rounds = await fetchSeasonQualifying(
      Number(els.season.value), els.cls.value, (m) => mine() && setStatus(m),
    );
    if (!mine()) return;
    state.rounds = rounds;
    if (!rounds.length) throw new Error('В этом сезоне ещё нет квалификаций');
    setStatus('');
  } catch (e) {
    if (mine()) setStatus(`${e.message}. Нажми «Загрузить», чтобы попробовать снова.`, true);
  } finally {
    if (mine()) {
      state.loading = false;
      els.load.disabled = false;
      render();
    }
  }
}

// Смена сезона обнуляет таблицу и обновляет список классов: старый зачёт
// к новому году отношения не имеет.
async function loadClasses() {
  state.rounds = null;
  render();
  els.cls.disabled = true;
  try {
    const cats = await fetchCategories(Number(els.season.value));
    els.cls.innerHTML = cats.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    els.cls.disabled = !cats.length;
    setStatus('');
    load(); // выбранный сезон и класс показываем сразу, без нажатия кнопки
  } catch (e) {
    els.cls.innerHTML = '';
    setStatus(`${e.message}. Выбери сезон ещё раз.`, true);
  }
}

// Список сезонов приходит из указателя собранных данных (data/index.json).
async function init() {
  try {
    setStatus('Загружаю список сезонов…');
    const seasons = await fetchSeasons();
    els.season.innerHTML = seasons.map((y) => `<option>${y}</option>`).join('');
    setStatus('');
    await loadClasses();
  } catch (e) {
    setStatus(`${e.message}. Обнови страницу.`, true);
  }
}

// Наполняется при открытии вкладки: на старте хватает одной, а данные общие —
// второй заход уйдёт в кэш.
export function onReveal() {
  if (!els.season.options.length) init();
}

els.load.addEventListener('click', load);
els.season.addEventListener('change', loadClasses);
els.cls.addEventListener('change', () => {
  state.rounds = null;
  setStatus('');
  render();
  load();
});

render();
