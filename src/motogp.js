// Квалификации из официального API Dorna (api.motogp.pulselive.com) через
// локальный прокси /api — см. server.js, напрямую из браузера туда не пускает
// проверка Origin.
//
// Готового «сезона одним запросом» здесь нет, поэтому собираем сами:
// сезоны → этапы → сессии этапа → классификация Q1 и Q2. Лимит частоты
// щедрый (1000 запросов в минуту), но этапов два десятка и на каждый по три
// запроса, так что тянем пачками и складываем в localStorage.

import { canonicalTeam } from './teams.js';

const BASE = '/api';
const CHUNK = 6; // этапов параллельно; на каждом до трёх запросов
const RETRIES = 3;

// Сезоны в выпадающем списке. API знает календарь с 1949 года, но нынешний
// формат квалификации (Q1 + Q2) действует с 2013-го — раньше сравнивать
// напарников было бы не по чему.
export const SEASONS = Array.from({ length: new Date().getFullYear() - 2012 }, (_, i) => new Date().getFullYear() - i);

const seasonsCache = new Map(); // год → uuid сезона
const catsCache = new Map(); // год → список классов
const qualiCache = new Map(); // `${год}:${класс}` → этапы с квалификациями

// Постоянный кэш: прошедшие сессии Dorna уже не меняет, поэтому прошлые сезоны
// храним бессрочно, а текущий — недолго, он ещё пополняется этапами.
// Полный сброс — по Ctrl+F5 (см. purgeOnHardReload).
// Номер в префиксе — версия формата: разбор ответов меняется, а в кэше лежат
// уже разобранные этапы. Меняешь форму данных — двигай номер, иначе у тех, кто
// уже открывал страницу, останется старая раскладка.
const LS_PREFIX = 'mp-api2:';
const CUR_YEAR = new Date().getFullYear();
const CUR_TTL = 6 * 3600 * 1000;

const lsGet = (key, year) => {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return null;
    const { t, data } = JSON.parse(raw);
    if (year >= CUR_YEAR && Date.now() - t > CUR_TTL) return null;
    return data;
  } catch {
    return null;
  }
};

const lsSet = (key, data) => {
  try {
    localStorage.setItem(LS_PREFIX + key, JSON.stringify({ t: Date.now(), data }));
  } catch {
    // Приватный режим или переполнение — переживём без постоянного кэша.
  }
};

// Жёсткая перезагрузка (Ctrl+F5) чистит кэш. Отличаем её от обычного F5 так:
// при F5 документ приходит из кэша браузера (encodedBodySize === 0), при
// Ctrl+F5 — полным ответом из сети.
(function purgeOnHardReload() {
  try {
    const nav = performance.getEntriesByType('navigation')[0];
    if (!nav || nav.type !== 'reload' || nav.encodedBodySize === 0) return;
    for (const k of Object.keys(localStorage)) {
      if (k.startsWith(LS_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    // Нет performance/localStorage — просто пропускаем.
  }
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(path, attempt = 0) {
  try {
    const res = await fetch(BASE + path, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`API ответил ${res.status}`);
    return await res.json();
  } catch (e) {
    // Про сервер напоминаем прямо в тексте ошибки: файл, открытый через
    // file://, ходить в /api не может, а пустая страница об этом не скажет.
    if (attempt >= RETRIES) {
      throw new Error(`API MotoGP недоступен (${e.message}) — страница должна быть открыта через npm start`);
    }
    await sleep(400 * 2 ** attempt);
    return getJSON(path, attempt + 1);
  }
}

// «01:28.782» → 88.782, «1'28.782» → то же самое. Dorna пишет время лучшего
// круга с ведущим нулём и двоеточием, а в других местах — с апострофом;
// разбираем оба вида, чтобы формат не решал, покажем мы время или нет.
export function toSeconds(t) {
  if (typeof t !== 'string') return null;
  const m = /^(?:(\d+)\s*[:'])?(\d+(?:\.\d+)?)$/.exec(t.trim());
  if (!m) return null;
  const sec = (parseInt(m[1], 10) || 0) * 60 + parseFloat(m[2]);
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}

// «Marc Marquez» → «M.MARQUEZ». Трёхбуквенных кодов, как в Формуле, у MotoGP
// нет, а по одной фамилии братьев Маркесов не различить.
export function riderCode(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/);
  if (parts.length < 2) return (parts[0] || '???').toUpperCase();
  return `${parts[0][0].toUpperCase()}.${parts.slice(1).join(' ').toUpperCase()}`;
}

async function seasonUuid(year) {
  if (seasonsCache.has(year)) return seasonsCache.get(year);
  const list = await getJSON('/seasons');
  for (const s of list) seasonsCache.set(s.year, s.id);
  const id = seasonsCache.get(Number(year));
  if (!id) throw new Error(`Сезона ${year} нет в календаре`);
  return id;
}

// Этапы сезона без тестов: у тестов нет квалификаций, а в списке они идут
// вперемешку с гонками (в 2025-м — 11 тестов на 22 этапа).
async function seasonEvents(year) {
  const uuid = await seasonUuid(year);
  const events = await getJSON(`/events?seasonUuid=${uuid}&isFinished=true`);
  return events
    .filter((e) => !e.test)
    .sort((a, b) => (a.date_start || '').localeCompare(b.date_start || ''));
}

// Классы этапа (MotoGP, Moto2, Moto3, MotoE). Идентификаторы у них общие для
// всего календаря, поэтому спрашиваем один раз по первому этапу сезона.
export async function fetchCategories(year) {
  if (catsCache.has(year)) return catsCache.get(year);
  const events = await seasonEvents(year);
  if (!events.length) throw new Error(`В сезоне ${year} ещё нет прошедших этапов`);
  const cats = (await getJSON(`/categories?eventUuid=${events[0].id}`)).map((c) => ({
    id: c.id,
    name: c.name.replace(/™/g, ''),
  }));
  catsCache.set(year, cats);
  return cats;
}

// Итоговая расстановка по квалификации. Q2 даёт места с первого, дальше идут
// те, кто остался в Q1, в порядке Q1. Сколько человек Q1 отправляет наверх,
// нигде не написано и по классам различается (в MotoGP двое, в Moto3 четверо),
// поэтому считаем по факту: сначала все, кто доехал до Q2, потом остальные.
function gridOrder(q1, q2) {
  const inQ2 = new Set(q2.map((r) => r.riderId));
  const rest = q1.filter((r) => !inQ2.has(r.riderId)).sort((a, b) => a.q1pos - b.q1pos);
  const order = new Map();
  q2.forEach((r, i) => order.set(r.riderId, i + 1));
  rest.forEach((r, i) => order.set(r.riderId, q2.length + i + 1));
  return order;
}

function mapClassification(rows) {
  return (rows || []).map((c, i) => ({
    riderId: c.rider?.riders_id || c.rider?.id || String(i),
    pos: c.position ?? i + 1,
    code: riderCode(c.rider?.full_name),
    name: c.rider?.full_name || '',
    number: c.rider?.number ?? 999,
    // Команду опознаём по каноническому названию, а не по её uuid: у Dorna
    // запись команды заведена на каждый мотоцикл отдельно, поэтому у двух
    // напарников из Ducati Lenovo Team идентификаторы (и uuid, и legacy_id)
    // разные, а название вдобавок несёт спонсора этого мотоцикла. Приведение
    // к канону живёт в teams.js — там же объяснено, зачем.
    teamId: canonicalTeam(c.team?.name),
    team: canonicalTeam(c.team?.name),
    bike: c.constructor?.name || '',
    time: toSeconds(c.best_lap?.time),
  }));
}

// Один этап: сессии класса → классификации Q1 и Q2 → строки нашего вида.
async function fetchRound(event, categoryUuid, index) {
  const sessions = await getJSON(
    `/sessions?eventUuid=${event.id}&categoryUuid=${categoryUuid}`,
  ).catch(() => []);
  // Обычно квалификация — это Q1 и Q2. Но бывает и одна сессия на всех:
  // в мокрой Японии-2013 вместо них стоит QP, и по строгому поиску Q2 этап
  // молча выпадал из сезона. Одиночную сессию считаем решающей, то есть Q2.
  const qs = sessions.filter((s) => String(s.type || '').startsWith('Q'));
  const find = (n) => qs.find((s) => s.type === 'Q' && Number(s.number) === n);
  const s1 = find(1);
  const s2 = find(2) || (qs.length === 1 ? qs[0] : null);
  if (!s2) return null; // квалификации нет вовсе — класс не ехал этот этап

  const load = async (s) =>
    s ? mapClassification((await getJSON(`/session/${s.id}/classification?test=false`)).classification) : [];
  const [q1, q2] = await Promise.all([load(s1), load(s2)]);

  const byId = new Map();
  const put = (r, key) => {
    const cur = byId.get(r.riderId) || { ...r, q1pos: null, Q1: null, Q2: null };
    // Команда и номер — по последней сессии, где пилот вообще был.
    cur.teamId = r.teamId || cur.teamId;
    cur.team = r.team || cur.team;
    cur[key] = r.time;
    if (key === 'Q1') cur.q1pos = r.pos;
    byId.set(r.riderId, cur);
  };
  for (const r of q1) put(r, 'Q1');
  for (const r of q2) put(r, 'Q2');

  const order = gridOrder([...byId.values()].filter((r) => r.q1pos != null), q2);
  const results = [...byId.values()].map((r) => ({
    riderId: r.riderId,
    pos: order.get(r.riderId) ?? 99,
    code: r.code,
    name: r.name,
    number: r.number,
    teamId: r.teamId,
    team: r.team,
    bike: r.bike,
    Q1: r.Q1,
    Q2: r.Q2,
  }));
  results.sort((a, b) => a.pos - b.pos);

  return {
    round: index + 1,
    name: event.name,
    code: event.short_name || (event.country?.iso || '???'),
    country: event.country?.name || '',
    date: event.date_end || event.date_start || '',
    results,
  };
}

// Квалификации всего сезона в выбранном классе. onRound вызывается по мере
// готовности этапов (пачками, но в порядке календаря) — таблица наполняется
// на глазах, как и в исходном проекте.
export async function fetchSeasonQualifying(year, categoryUuid, onProgress, onRound) {
  const key = `${year}:${categoryUuid}`;
  if (qualiCache.has(key)) return qualiCache.get(key);
  const stored = lsGet(`quali:${key}`, year);
  if (stored) {
    qualiCache.set(key, stored);
    return stored;
  }

  const events = await seasonEvents(year);
  const rounds = [];

  for (let i = 0; i < events.length; i += CHUNK) {
    const chunk = events.slice(i, i + CHUNK);
    const got = await Promise.all(
      chunk.map((e, j) => fetchRound(e, categoryUuid, i + j).catch(() => null)),
    );
    // Отдаём в порядке календаря, чтобы колонки не прыгали.
    for (const r of got) {
      if (!r?.results.length) continue;
      rounds.push(r);
      onRound?.(r);
    }
    onProgress?.(
      `Загружаю квалификации… ${Math.round((Math.min(i + CHUNK, events.length) * 100) / events.length)}%`,
    );
  }

  // Пустой результат не кэшируем — иначе повторное «Загрузить» вернуло бы ту же
  // пустоту и не дало бы шанса перезапросить.
  if (rounds.length) {
    qualiCache.set(key, rounds);
    lsSet(`quali:${key}`, rounds);
  }
  return rounds;
}

// Команды сезона — из уже загруженных этапов: отдельного эндпоинта со
// списком команд у Dorna нет.
export function teamsFromRounds(rounds) {
  const teams = new Map();
  for (const r of rounds) {
    for (const res of r.results) {
      if (res.teamId) teams.set(res.teamId, res.team);
    }
  }
  return [...teams].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
