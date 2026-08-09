// Вкладка «Квалификация · напарники»: за выбранный сезон, класс и команду —
// таблица гэпа между напарниками по каждому этапу. Данные из API MotoGP
// (motogp.js), расчёт — в qualifying.js; здесь только DOM и события.

import { fetchSeasonQualifying, fetchCategories, fetchSeasons, teamsFromRounds } from './motogp.js';
import { buildComparison, formatLapTime, AUTO_OFF_PCT } from './qualifying.js';
import { teamColor, onColor } from './teams.js';

// Единицы гэпа. permille = проценты × 10 (тысячные доли отношения): мелкие
// разрывы читаются крупнее. sec — абсолютная разница времён в секундах.
const GAP_UNITS = {
  pct: { label: 'проценты' },
  permille: { label: 'промилле' },
  sec: { label: 'секунды' },
};

// Порог автоотсева живёт в localStorage: настройка личная и меняется редко,
// каждый заход выставлять её заново — раздражает. Ключ вне префикса кэша
// данных, чтобы Ctrl+F5 сбрасывал данные, но не настройку.
const LS_CUT = 'mp-quali:cut';
const loadCut = () => {
  try {
    const v = parseFloat(localStorage.getItem(LS_CUT));
    return Number.isFinite(v) && v >= 0 ? v : AUTO_OFF_PCT;
  } catch {
    return AUTO_OFF_PCT;
  }
};
const saveCut = (v) => {
  try {
    localStorage.setItem(LS_CUT, String(v));
  } catch {
    // Приватный режим — порог просто не переживёт перезагрузку.
  }
};

// Названия команд едут в атрибуты, а приходят из чужого API — экранируем.
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot' }[c]};`);

const $ = (id) => document.getElementById(id);
const els = {
  season: $('q-season'),
  cls: $('q-class'),
  team: $('q-team'),
  load: $('q-load'),
  cut: $('q-cut'),
  gapUnit: $('q-gap-unit'),
  status: $('q-status'),
  table: $('q-table'),
};

const state = {
  rounds: null, // из fetchSeasonQualifying
  teams: [], // список команд сезона ({ id, name }) — собран из этапов
  team: null, // id выбранной команды
  pairKey: null, // ключ активной пары-вкладки; null → пара, начинавшая сезон
  gapUnit: 'pct',
  rowOff: new Map(), // rowKey → включён ли этап вручную (сильнее автоотсева)
  cut: loadCut(), // порог автоотсева, %
  loading: false,
};

function setStatus(msg, isError = false) {
  els.status.textContent = msg || '';
  els.status.hidden = !msg;
  els.status.classList.toggle('error', isError);
}

// --- форматирование гэпа ---------------------------------------------------

// Величина гэпа без знака — направление показывает подсветка лучшего времени.
function fmtGap(row) {
  if (row.gap == null) return '—';
  if (state.gapUnit === 'sec') return `${Math.abs(row.ta - row.tb).toFixed(3)}`;
  if (state.gapUnit === 'permille') return `${(Math.abs(row.gap) * 10).toFixed(2)}‰`;
  return `${Math.abs(row.gap).toFixed(3)}%`;
}

// Сегмент этапа. Общая сессия — одна буква на двоих. Общей не нашлось —
// пишем обе через дробь в порядке колонок («Q2/Q1»): так видно, что времена
// из разных сессий, и почему гэпа нет.
function segment(row) {
  if (row.session) return row.session;
  if (!row.sa && !row.sb) return '—';
  return `${row.sa || '—'}/${row.sb || '—'}`;
}

// -1 — быстрее якорь, 1 — напарник, 0 — нет данных/поровну.
const faster = (row) =>
  row.ta == null || row.tb == null || row.ta === row.tb ? 0 : row.ta < row.tb ? -1 : 1;

// Средний гэп пары для карточки, без знака и в выбранных единицах.
function fmtPairGap(pair) {
  if (state.gapUnit === 'sec') return pair.avgSec == null ? '—' : Math.abs(pair.avgSec).toFixed(3);
  if (pair.avgPct == null) return '—';
  if (state.gapUnit === 'permille') return `${(Math.abs(pair.avgPct) * 10).toFixed(2)}‰`;
  return `${Math.abs(pair.avgPct).toFixed(3)}%`;
}

// --- отрисовка -------------------------------------------------------------

function render() {
  if (!state.rounds) {
    els.table.innerHTML = '<p class="empty-state">Нажми «Загрузить», чтобы построить таблицу.</p>';
    return;
  }
  const team = state.teams.find((t) => t.id === state.team);

  const { pairs } = buildComparison(state.rounds, state.team, state.rowOff, state.cut);
  if (!pairs.length) {
    els.table.innerHTML = state.loading
      ? '<p class="empty-state">Загружаю квалификации…</p>'
      : `<p class="empty-state">У команды «${team?.name || ''}» в этом сезоне ` +
        'некого сравнить: не набралось второго пилота с квалификацией.</p>';
    return;
  }

  // Активная пара держится по ключу: список при дозагрузке может пополниться, а
  // выбор должен оставаться на месте. По умолчанию — первая (начинавшая сезон).
  const sel = pairs.find((p) => p.key === state.pairKey) || pairs[0];
  state.pairKey = sel.key;
  const c = teamColor(team?.name);

  // Вкладки пар — только когда пар больше одной (замены, вайлд-карды).
  const tabs = pairs.length > 1
    ? `<div class="q-tabs">${pairs
        .map((p) => {
          const on = p.key === sel.key;
          return `<button class="q-tab${on ? ' active' : ''}" data-pair="${p.key}">${p.left.code} — ${p.right.code}</button>`;
        })
        .join('')}</div>`
    : '';

  let body = '';
  for (const r of sel.rows) {
    const f = r.on ? faster(r) : 0; // у выключенного этапа никто не «быстрее»
    const bestA = f < 0 ? ' q-best' : '';
    const bestB = f > 0 ? ' q-best' : '';
    const auto = !r.auto && !state.rowOff.has(r.key) ? ` (гэп больше ${state.cut}%)` : '';
    const title = !r.cmp
      ? 'Нет общей сессии — сравнивать нечего'
      : r.on
        ? 'Клик — убрать этап из счёта'
        : `Этап не в счёте${auto} — клик вернёт`;
    // Зачёркнутое означает «этап выкинут из счёта». Но там, где общей сессии
    // не было, выкидывать нечего: времена поставлены в разных сессиях и
    // сравнивать их нельзя в принципе. В MotoGP это не редкость — один
    // напарник сразу в Q2, второй остался в Q1, — поэтому такие строки просто
    // приглушаем, без зачёркивания, иначе они читаются как ручное отключение.
    const cls = r.on ? '' : r.cmp ? ' off' : ' off q-nocmp';
    body +=
      `<tr class="q-row${cls}" data-key="${r.key}" title="${title}">` +
      `<th class="q-track">${r.label}</th>` +
      `<td class="q-time${bestA}">${formatLapTime(r.ta)}</td>` +
      `<td class="q-time${bestB}">${formatLapTime(r.tb)}</td>` +
      `<td class="q-seg">${segment(r)}</td>` +
      `<td class="q-gap">${fmtGap(r)}</td></tr>`;
  }

  const table =
    '<table class="quali"><thead><tr>' +
    '<th class="corner">Этап</th>' +
    `<th>${sel.left.code}</th><th>${sel.right.code}</th>` +
    '<th>Сегмент</th><th>Гэп</th>' +
    `</tr></thead><tbody>${body}</tbody></table>`;

  const head =
    '<div class="quali-head">' +
    `<span class="q-team-name" style="background:${c};color:${onColor(c)}">${(team?.name || '').toUpperCase()}</span>` +
    '</div>';

  els.table.innerHTML =
    head + tabs + renderH2H(sel, c) + `<div class="table-wrap">${table}</div>`;
}

// Head-to-head активной пары — над таблицей: очный счёт с полоской перевеса,
// средний гэп и число общих квалификаций.
function renderH2H(p, c) {
  const total = p.winsLeft + p.winsRight;
  const wa = total ? Math.round((p.winsLeft / total) * 100) : 50;
  const lead = p.avgPct == null || p.avgPct === 0 ? '' : p.avgPct < 0 ? p.left.code : p.right.code;
  const aWin = p.winsLeft > p.winsRight ? ' win' : '';
  const bWin = p.winsRight > p.winsLeft ? ' win' : '';
  return (
    `<div class="q-h2h" style="--team:${c}">` +
    '<div class="q-h2h-score">' +
    `<span class="q-h2h-side${aWin}">${p.left.code}<b>${p.winsLeft}</b></span>` +
    '<span class="q-h2h-vs">очные</span>' +
    `<span class="q-h2h-side${bWin}"><b>${p.winsRight}</b>${p.right.code}</span>` +
    '</div>' +
    `<div class="q-h2h-bar"><i style="width:${wa}%"></i></div>` +
    `<div class="q-h2h-meta">ср. гэп ${fmtPairGap(p)}${lead ? ` · <span class="q-pair-lead">быстрее ${lead}</span>` : ''} · общих квалификаций: ${p.shared}</div>` +
    '</div>'
  );
}

// --- команды и загрузка ----------------------------------------------------

// Списка команд в API нет — собираем его из уже загруженных этапов. Поэтому
// селект наполняется по ходу загрузки, а не до неё.
function syncTeams() {
  const teams = teamsFromRounds(state.rounds || []);
  const same = teams.map((t) => t.id).join() === state.teams.map((t) => t.id).join();
  state.teams = teams;
  if (!teams.length) {
    els.team.disabled = true;
    els.team.innerHTML = '';
    return;
  }
  // Селект не переписываем без нужды: он открыт у пользователя прямо сейчас.
  if (!same) {
    els.team.innerHTML = teams.map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('');
  }
  els.team.disabled = false;
  // Сохраняем выбор пользователя, если команда есть и в новых данных.
  if (!teams.some((t) => t.id === state.team)) state.team = teams[0].id;
  els.team.value = state.team;
}

// Сброс при смене сезона или класса: старые данные к новому набору отношения
// не имеют, а ручные решения по строкам привязаны к парам того сезона.
function reset() {
  state.rounds = null;
  state.teams = [];
  state.team = null;
  state.pairKey = null;
  state.rowOff = new Map();
  els.team.disabled = true;
  els.team.innerHTML = '';
  setStatus('');
  render();
}

// Номер текущей загрузки. Сезон грузится сам, поэтому запусков может
// оказаться несколько сразу: перещёлкнул сезон стрелками — и предыдущая
// загрузка всё ещё идёт. Её ответ лёг бы поверх уже нового сезона, поэтому
// всё, что приходит с устаревшим номером, молча выбрасываем.
let gen = 0;

async function load() {
  if (!els.cls.value) return;
  const my = ++gen;
  const mine = () => my === gen;
  els.load.disabled = true;
  state.rounds = [];
  state.pairKey = null; // активная пара выберется сама (начинавшая сезон)
  state.loading = true;
  try {
    render(); // каркас с «Загружаю…»
    const rounds = await fetchSeasonQualifying(
      Number(els.season.value), els.cls.value, (m) => mine() && setStatus(m),
    );
    if (!mine()) return;
    state.rounds = rounds;
    if (!rounds.length) throw new Error('В этом сезоне ещё нет квалификаций');
    syncTeams();
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

// Вкладка наполняется при старте (см. низ модуля). Открытие лишь досыпает
// список, если стартовый запрос не удался.
export function onReveal() {
  if (!els.season.options.length) init();
}

async function loadClasses() {
  reset();
  els.cls.disabled = true;
  try {
    const cats = await fetchCategories(Number(els.season.value));
    els.cls.innerHTML = cats.map((c) => `<option value="${c.id}">${c.name}</option>`).join('');
    els.cls.disabled = !cats.length;
    setStatus('');
    // Выбранный сезон и класс грузим сразу. Список команд собирается из
    // этапов — без загрузки он пуст, и страница при открытии выглядела бы
    // сломанной. «Загрузить» остаётся кнопкой повтора после ошибки.
    load();
  } catch (e) {
    els.cls.innerHTML = '';
    setStatus(`${e.message}. Выбери сезон ещё раз.`, true);
  }
}

// Список сезонов приходит из указателя собранных данных, а не из календаря
// Dorna: показывать сезон, которого нет в data/, нечестно.
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

// --- события ---------------------------------------------------------------

els.gapUnit.innerHTML = Object.entries(GAP_UNITS)
  .map(([k, u]) => `<option value="${k}">${u.label}</option>`)
  .join('');

els.season.addEventListener('change', loadClasses);
els.cls.addEventListener('change', () => {
  reset();
  load();
});
els.load.addEventListener('click', load);

// Смена команды не требует перезагрузки — данные всего сезона уже на руках.
els.team.addEventListener('change', () => {
  state.team = els.team.value;
  state.pairKey = null; // у новой команды свои пары
  render();
});

// Порог автоотсева. Пустое или мусорное поле — вернуть значение по умолчанию:
// без порога таблица молча учла бы этапы с падением и красным флагом. Ручные
// решения по строкам не трогаем — они и так сильнее автоматики.
els.cut.value = state.cut;
els.cut.addEventListener('change', () => {
  const v = parseFloat(els.cut.value);
  state.cut = Number.isFinite(v) && v >= 0 ? v : AUTO_OFF_PCT;
  els.cut.value = state.cut;
  saveCut(state.cut);
  render();
});

els.gapUnit.addEventListener('change', () => {
  state.gapUnit = els.gapUnit.value;
  render();
});

// Вкладки пар над таблицей — переключают активного напарника.
// Клик по строке — ручное включение/отключение этапа. Если ручное решение
// совпало с автоматическим, override убираем: иначе он «залипнет» и после
// дозагрузки сезона строка перестанет слушаться автоотсева.
els.table.addEventListener('click', (e) => {
  const tab = e.target.closest('.q-tab');
  if (tab) {
    state.pairKey = tab.dataset.pair;
    return render();
  }
  const row = e.target.closest('.q-row');
  if (!row) return;
  const { pairs } = buildComparison(state.rounds, state.team, state.rowOff, state.cut);
  const r = pairs.flatMap((p) => p.rows).find((x) => x.key === row.dataset.key);
  if (!r?.cmp) return; // нечего сравнивать — нечего и переключать
  if (!r.on === r.auto) state.rowOff.delete(r.key);
  else state.rowOff.set(r.key, !r.on);
  render();
});

// Сезоны и классы — сразу при старте, чтобы списки были готовы до открытия вкладки.
init();
