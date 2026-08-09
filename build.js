// Сборка статических данных: node build.js [год …]
//
// Страница живёт на GitHub Pages, где нет ни сервера, ни функций, а в API
// Dorna из браузера не сходить — оно проверяет Origin и всему, кроме
// motogp.com, отвечает 403. Зато данные исторические: прошедшая квалификация
// больше не меняется. Поэтому весь обход API происходит здесь, под node
// (оттуда Origin не отправляется и запрос проходит), а в репозиторий ложатся
// готовые файлы: сезон с классом — около 110 КБ, в gzip меньше десяти.
//
// Без аргументов досыпает недостающие сезоны и всегда пересобирает текущий —
// он ещё пополняется этапами. С аргументами пересобирает только их.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const API = 'https://api.motogp.pulselive.com/motogp/v1/results';
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data');
const FIRST_YEAR = 2013; // с этого сезона квалификация идёт форматом Q1 + Q2
const CHUNK = 6; // этапов параллельно; на каждом до трёх запросов
const RETRIES = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dorna пускает 1000 запросов в минуту (заголовок x-ratelimit-limit). Полная
// сборка — это несколько тысяч, так что окно приходится держать самим: без
// этого середина прогона упирается в 429 и сезоны собираются дырявыми.
const RATE = 400; // с большим запасом: счётчик у Dorna переживает и перезапуск сборки
const stamps = [];
async function throttle() {
  for (;;) {
    const now = Date.now();
    while (stamps.length && now - stamps[0] > 60000) stamps.shift();
    if (stamps.length < RATE) return void stamps.push(now);
    await sleep(60000 - (now - stamps[0]) + 100);
  }
}

async function getJSON(url, attempt = 0) {
  await throttle();
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    // 429 приходит без Retry-After, поэтому ждём сами и подолгу: короткая
    // пауза только повторяет отказ.
    if (res.status === 429) {
      if (attempt >= RETRIES + 3) throw new Error('429 не отпускает');
      await sleep(65000); // окно у лимита минутное — пережидаем его целиком
      return getJSON(url, attempt + 1);
    }
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } catch (e) {
    if (attempt >= RETRIES) throw new Error(`${url} — ${e.message}`);
    await sleep(500 * 2 ** attempt);
    return getJSON(url, attempt + 1);
  }
}

// «01:28.782» → 88.782, «1'28.782» → то же самое. Dorna пишет время лучшего
// круга с ведущим нулём и двоеточием, а в других местах — с апострофом.
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

// «MotoGP™» → «motogp»: имя файла должно читаться.
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

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
    // Название команды кладём как есть: приведением к каноническому занимается
    // страница (teams.js), иначе правка справочника требовала бы пересборки.
    team: c.team?.name || '',
    bike: c.constructor?.name || '',
    time: toSeconds(c.best_lap?.time),
  }));
}

// Один этап: сессии класса → классификации Q1 и Q2 → строки нашего вида.
// Ошибки наружу не глушим: тихо пропущенный этап — это молча кривой сезон
// в репозитории, и заметить его потом почти нечем.
async function buildRound(event, categoryUuid, index) {
  const sessions = await getJSON(
    `${API}/sessions?eventUuid=${event.id}&categoryUuid=${categoryUuid}`,
  );

  // Обычно квалификация — это Q1 и Q2. Но бывает и одна сессия на всех:
  // в мокрой Японии-2013 вместо них стоит QP, и по строгому поиску Q2 этап
  // молча выпадал из сезона. Одиночную сессию считаем решающей, то есть Q2.
  const qs = sessions.filter((s) => String(s.type || '').startsWith('Q'));
  const find = (n) => qs.find((s) => s.type === 'Q' && Number(s.number) === n);
  const s1 = find(1);
  const s2 = find(2) || (qs.length === 1 ? qs[0] : null);
  if (!s2) return null; // квалификации нет вовсе — класс не ехал этот этап

  const load = async (s) =>
    (s ? mapClassification((await getJSON(`${API}/session/${s.id}/classification?test=false`)).classification) : []);
  const [q1, q2] = await Promise.all([load(s1), load(s2)]);

  const byId = new Map();
  const put = (r, key) => {
    const cur = byId.get(r.riderId) || { ...r, q1pos: null, Q1: null, Q2: null };
    cur.team = r.team || cur.team; // команда по последней сессии, где пилот был
    cur[key] = r.time;
    if (key === 'Q1') cur.q1pos = r.pos;
    byId.set(r.riderId, cur);
  };
  for (const r of q1) put(r, 'Q1');
  for (const r of q2) put(r, 'Q2');

  const order = gridOrder([...byId.values()].filter((r) => r.q1pos != null), q2);
  const results = [...byId.values()]
    .map((r) => ({
      riderId: r.riderId, pos: order.get(r.riderId) ?? 99, code: r.code, name: r.name,
      number: r.number, team: r.team, bike: r.bike, Q1: r.Q1, Q2: r.Q2,
    }))
    .sort((a, b) => a.pos - b.pos);

  return {
    round: index + 1,
    name: event.name,
    code: event.short_name || event.country?.iso || '???',
    country: event.country?.name || '',
    date: event.date_end || event.date_start || '',
    results,
  };
}

async function buildSeason(year, seasonUuid) {
  // Этапы без тестов: у тестов нет квалификаций, а в списке они идут
  // вперемешку с гонками (в 2025-м — 11 тестов на 22 этапа).
  const events = (await getJSON(`${API}/events?seasonUuid=${seasonUuid}&isFinished=true`))
    .filter((e) => !e.test)
    .sort((a, b) => (a.date_start || '').localeCompare(b.date_start || ''));
  if (!events.length) return [];

  // Классы спрашиваем у каждого этапа, а не один раз у первого. Во-первых,
  // состав классов по ходу сезона меняется: в 2020-м на открывающем этапе в
  // Катаре MotoGP не выступал (этап отменили), и по первому этапу королевский
  // класс не нашёлся бы вовсе. Во-вторых, идентификатор класса в старых
  // сезонах у разных этапов свой, поэтому сессии надо просить именно с тем id,
  // который отдал этот этап; общее у классов только название.
  for (let i = 0; i < events.length; i += CHUNK) {
    await Promise.all(events.slice(i, i + CHUNK).map(async (e) => {
      e.cats = await getJSON(`${API}/categories?eventUuid=${e.id}`);
    }));
  }
  const names = [];
  for (const e of events) {
    for (const c of e.cats) if (!names.includes(c.name)) names.push(c.name);
  }

  const written = [];
  for (const name of names) {
    const cat = { name: name.replace(/™/g, ''), slug: slug(name) };
    const mine = events.filter((e) => e.cats.some((c) => c.name === name));
    const rounds = [];
    for (let i = 0; i < mine.length; i += CHUNK) {
      const got = await Promise.all(mine.slice(i, i + CHUNK).map((e, j) => {
        const id = e.cats.find((c) => c.name === name).id;
        return buildRound(e, id, i + j);
      }));
      for (const r of got) if (r?.results.length) rounds.push(r);
    }
    if (!rounds.length) continue; // класс в этом сезоне не ехал
    // Нумеруем этапы подряд уже после отбора: у MotoE свой, более короткий
    // календарь, и дырки в номерах сбивали бы ключи колонок.
    rounds.forEach((r, i) => { r.round = i + 1; });
    await fs.writeFile(path.join(OUT, `${year}-${cat.slug}.json`), JSON.stringify(rounds));
    written.push({ id: cat.slug, name: cat.name });
    console.log(`  ${cat.name.padEnd(7)} ${String(rounds.length).padStart(2)} этапов`);
  }
  return written;
}

const only = process.argv.slice(2).map(Number).filter(Boolean);
const thisYear = new Date().getFullYear();

await fs.mkdir(OUT, { recursive: true });
const seasons = (await getJSON(`${API}/seasons`))
  .filter((s) => s.year >= FIRST_YEAR)
  .sort((a, b) => b.year - a.year);

// Что уже собрано, знаем по указателю: он и есть содержание каталога data.
const indexFile = path.join(OUT, 'index.json');
const prev = await fs.readFile(indexFile, 'utf8').then(JSON.parse).catch(() => ({ seasons: [] }));
const known = new Map(prev.seasons.map((s) => [s.year, s.classes]));

const out = [];

// Указатель переписываем после каждого сезона, а не в конце. Полная сборка
// идёт минуты и вполне может оборваться на лимите запросов — тогда повторный
// запуск досыпает только недостающее, а не начинает всё заново.
const saveIndex = () => fs.writeFile(
  indexFile,
  JSON.stringify({ builtAt: new Date().toISOString(), seasons: [...out].sort((a, b) => b.year - a.year) }, null, 1),
);

for (const s of seasons) {
  // Прошедший сезон неизменен — второй раз не тянем. Текущий пересобираем
  // всегда: в нём появляются новые этапы.
  const stale = s.year >= thisYear || !known.has(s.year);
  const wanted = only.length ? only.includes(s.year) : stale;
  if (!wanted) {
    out.push({ year: s.year, classes: known.get(s.year) });
    continue;
  }
  console.log(s.year);
  const classes = await buildSeason(s.year, s.id);
  if (classes.length) out.push({ year: s.year, classes });
  else if (known.has(s.year)) out.push({ year: s.year, classes: known.get(s.year) });
  await saveIndex();
}

await saveIndex();
console.log(`готово: ${out.length} сезонов в ${OUT}`);
