// Загрузка данных. Сами квалификации собраны заранее в статические файлы
// data/{год}-{класс}.json — см. build.js, там же объяснено почему: страница
// живёт на GitHub Pages, а API Dorna из браузера недоступно (проверка Origin).
//
// Из-за этого модуль вышел коротким: ни обхода API, ни кэша в localStorage,
// ни очередей — один fetch за сезон, кэширование берёт на себя браузер.
import { canonicalTeam } from './teams.js';

// Пути считаем от самого модуля, а не от адреса страницы: на GitHub Pages
// проект лежит не в корне домена, и «/data/…» ушёл бы мимо.
const url = (name) => new URL(`../data/${name}`, import.meta.url);

const cache = new Map(); // имя файла → разобранное содержимое

async function load(name) {
  if (cache.has(name)) return cache.get(name);
  const res = await fetch(url(name));
  if (!res.ok) {
    throw new Error(res.status === 404
      ? `Нет данных за этот сезон (${name}) — пересобери их через npm run build`
      : `Не удалось загрузить ${name}: ${res.status}`);
  }
  const data = await res.json();
  cache.set(name, data);
  return data;
}

// Указатель: какие сезоны и классы собраны. Обещание кэшируем целиком, чтобы
// две вкладки, стартующие одновременно, не тянули его дважды.
let indexPromise = null;
export const fetchIndex = () => (indexPromise ||= load('index.json'));

export async function fetchSeasons() {
  return (await fetchIndex()).seasons.map((s) => s.year);
}

export async function fetchCategories(year) {
  const season = (await fetchIndex()).seasons.find((s) => s.year === Number(year));
  if (!season) throw new Error(`Сезона ${year} нет в собранных данных`);
  return season.classes;
}

export async function fetchSeasonQualifying(year, categoryId, onProgress) {
  onProgress?.('Загружаю квалификации сезона…');
  const rounds = await load(`${year}-${categoryId}.json`);
  onProgress?.('');
  // Команду приводим к каноническому имени здесь, а не при сборке: иначе
  // правка справочника в teams.js требовала бы пересобирать все данные.
  return rounds.map((r) => ({
    ...r,
    results: r.results.map((x) => ({ ...x, teamId: canonicalTeam(x.team), team: canonicalTeam(x.team) })),
  }));
}

// Команды сезона — из загруженных этапов: отдельного списка команд у Dorna нет.
export function teamsFromRounds(rounds) {
  const teams = new Map();
  for (const r of rounds) {
    for (const res of r.results) {
      if (res.teamId) teams.set(res.teamId, res.team);
    }
  }
  return [...teams].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}
