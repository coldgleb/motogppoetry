// Чистая логика сравнения напарников по квалификации и зачёта квалификаций.
// Без DOM и сети — чтобы гонять под node. Данные приходят из
// fetchSeasonQualifying (motogp.js): массив этапов с results, где у каждого
// пилота Q1/Q2 уже в секундах (или null, если сессию не проехал).

// Кода этапа тут считать не надо: Dorna отдаёт его сама — short_name («THA»,
// «CAT», «RSM»), и он же стоит на официальных таблицах.

const SESSIONS = ['Q2', 'Q1']; // от поздней к ранней

// Секунды → «1:28.782». Округляем до миллисекунд до деления, иначе 119.9995
// превратилось бы в «1:60.000».
export function formatLapTime(sec) {
  if (sec == null || !Number.isFinite(sec)) return '—';
  const ms = Math.round(sec * 1000);
  if (ms < 60000) return (ms / 1000).toFixed(3);
  const m = Math.floor(ms / 60000);
  return `${m}:${((ms - m * 60000) / 1000).toFixed(3).padStart(6, '0')}`;
}

// Последняя сессия, где оба поставили время. Именно её и сравниваем: гэп между
// Q2 одного и Q1 другого — это сравнение разных условий трассы и резины, а не
// пилотов. Возвращаем 'Q2'|'Q1' или null, если общей сессии нет.
export function commonSession(a, b) {
  for (const s of SESSIONS) {
    if (a?.[s] != null && b?.[s] != null) return s;
  }
  return null;
}

// Гэп первого относительно второго, в процентах. Отрицательный — первый
// быстрее (его время меньше). База — время второго пилота.
export const gapPercent = (ta, tb) =>
  ta == null || tb == null || tb === 0 ? null : ((ta - tb) / tb) * 100;

// Разрыв больше этого — уже не про пилотов: трафик, ошибка, падение, красный
// флаг в чужом круге. Такой этап сам выпадает из счёта и среднего гэпа.
// Порог настраивается на странице; здесь — значение по умолчанию.
export const AUTO_OFF_PCT = 1.5;

// Ключ строки для ручного включения/отключения: пара + этап.
export const rowKey = (pairKey, round) => `${pairKey}|${round}`;

// Очки за место — гоночная система MotoGP, топ-15. Неизменна на всём диапазоне
// сезонов вкладки. Спринт-квалификаций в MotoGP нет: стартовая решётка спринта
// и гонки одна и та же, поэтому колонка на этап тоже одна.
export const RACE_POINTS = [25, 20, 16, 13, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];

export const pointsFor = (pos) => RACE_POINTS[pos - 1] || 0;

// Лучший круг пилота за квалификацию и сессия, в которой он его показал.
// Нужен там, где напарники не сошлись в одной сессии и полноценный гэп не
// посчитать: тогда в колонке сегмента стоит не прочерк, а пара «Q2/Q1» —
// видно, что времена вообще из разных сессий и потому несравнимы.
const best = (res) => {
  let t = null;
  let session = null;
  for (const s of SESSIONS) {
    if (res?.[s] != null && (t == null || res[s] < t)) { t = res[s]; session = s; }
  }
  return { t, session };
};

// Зачёт квалификаций сезона: место в квале оплачивается как место в гонке.
// Возвращает { stages, drivers }: stages — колонки в порядке календаря,
// drivers — строки зачёта, отсортированные по очкам; у каждой строки cells
// (ключ этапа → { pos, pts }).
//
// Ничьи разбиваем «по-чемпионатному»: выше тот, у кого больше поулов, при
// равенстве — вторых мест и так далее.
export function buildStandings(rounds) {
  const stages = [];
  const riders = new Map();

  for (const r of rounds) {
    const stage = { key: `${r.round}Q`, code: r.code, label: r.code, round: r.round };
    stages.push(stage);
    r.results.forEach((res, i) => {
      const pos = res.pos ?? i + 1;
      const pts = pointsFor(pos);
      const d = riders.get(res.riderId) || {
        id: res.riderId, code: res.code, name: res.name, number: res.number,
        teamId: res.teamId, team: res.team, points: 0, best: [], cells: new Map(),
      };
      d.teamId = res.teamId; // команда — по последнему этапу пилота
      d.team = res.team;
      d.points += pts;
      d.best[pos] = (d.best[pos] || 0) + 1;
      d.cells.set(stage.key, { pos, pts });
      riders.set(res.riderId, d);
    });
  }

  // Больше поулов — выше; дальше вторых мест, третьих…
  const byBest = (a, b) => {
    const n = Math.max(a.best.length, b.best.length);
    for (let p = 1; p < n; p++) {
      if ((b.best[p] || 0) !== (a.best[p] || 0)) return (b.best[p] || 0) - (a.best[p] || 0);
    }
    return 0;
  };
  const rows = [...riders.values()].sort((a, b) => b.points - a.points || byBest(a, b));

  return { stages, drivers: rows };
}

// Полный состав команды за сезон: все, кто хоть раз квалифицировался за неё.
// Первым идёт штатный лидер — он становится «якорем» сравнения.
//
// Лидер определяется так: сначала штатные пилоты (проехали хотя бы половину
// сезона) идут выше разовых подмен и вайлд-кардов; среди штатных вперёд тот,
// кто чаще выигрывал внутрикомандную квалификацию. Одна пропущенная гонка
// первенства уже не отбирает.
export function teamRoster(rounds, teamId) {
  const seen = new Map(); // riderId → { riderId, code, number, count, wins }
  for (const r of rounds) {
    let bestId = null;
    let bestT = Infinity;
    for (const res of r.results) {
      if (res.teamId !== teamId) continue;
      const cur = seen.get(res.riderId)
        || { riderId: res.riderId, code: res.code, name: res.name, number: res.number, count: 0, wins: 0 };
      cur.count += 1;
      seen.set(res.riderId, cur);
      const { t } = best(res);
      if (t != null && t < bestT) { bestT = t; bestId = res.riderId; }
    }
    if (bestId) seen.get(bestId).wins += 1; // выиграл внутрикомандную квалу этапа
  }
  const total = rounds.length;
  const regular = (d) => (d.count * 2 >= total ? 1 : 0); // проехал хотя бы полсезона
  return [...seen.values()].sort(
    (a, b) => regular(b) - regular(a) || b.wins - a.wins || b.count - a.count || a.number - b.number,
  );
}

// Сравнение всей команды за сезон вокруг «якоря» — штатного лидера. В каждом
// этапе он сравнивается с тем, кто в этом этапе был вторым пилотом команды,
// кем бы тот ни был. Это снимает проблему замен: травмы в MotoGP частые, и
// вместо одного кода с прочерками в колонке напарника стоит тот, кто правда
// ехал.
//
// Возвращает { pairs: [...] } — по одной паре на каждую комбинацию, что делила
// хотя бы одну квалификацию. left — старший по roster, right — второй; rows —
// этапы этой пары, winsLeft/winsRight — очный счёт, avgPct/avgSec — средний
// гэп, shared — число зачётных сравнений. Пары идут по календарю: та, что
// начинала сезон, — первой (активная вкладка).
//
// overrides — ручные решения по строкам (rowKey → true/false), сильнее
// автоматики: аномальный этап можно вернуть в счёт, обычный — выкинуть.
// cutPct — порог автоотсева в процентах.
export function buildComparison(rounds, teamId, overrides = new Map(), cutPct = AUTO_OFF_PCT) {
  const roster = teamRoster(rounds, teamId);
  const rank = new Map(roster.map((d, i) => [d.riderId, i])); // меньше — старше (лидер)
  const byId = new Map(roster.map((d) => [d.riderId, d]));
  const pairs = new Map(); // "leftId|rightId" → накопитель пары

  const pairFor = (aId, bId) => {
    const [l, r] = (rank.get(aId) ?? 99) <= (rank.get(bId) ?? 99) ? [aId, bId] : [bId, aId];
    const key = `${l}|${r}`;
    if (!pairs.has(key)) {
      pairs.set(key, {
        key, left: byId.get(l), right: byId.get(r),
        rows: [], winsLeft: 0, winsRight: 0, sumPct: 0, sumSec: 0, shared: 0,
      });
    }
    return pairs.get(key);
  };

  // Общая сессия — честный гэп; без неё показываем лучший круг того, у кого он
  // есть, но в расчёт (гэп, счёт) такой этап не берём. sa/sb — сессия каждого
  // времени: при общей сессии они совпадают, иначе расходятся, и интерфейс
  // пишет их парой.
  const compare = (results, left, right) => {
    const la = results.find((x) => x.riderId === left.riderId) || null;
    const rb = results.find((x) => x.riderId === right.riderId) || null;
    const s = la && rb ? commonSession(la, rb) : null;
    if (s) return { ta: la[s], tb: rb[s], gap: gapPercent(la[s], rb[s]), session: s, sa: s, sb: s };
    const [a, b] = [best(la), best(rb)];
    return { ta: a.t, tb: b.t, gap: null, session: null, sa: a.session, sb: b.session };
  };

  for (const r of rounds) {
    const mates = r.results.filter((x) => x.teamId === teamId);
    for (let i = 0; i < mates.length; i++) {
      for (let j = i + 1; j < mates.length; j++) {
        const p = pairFor(mates[i].riderId, mates[j].riderId);
        const c = compare(r.results, p.left, p.right);
        const key = rowKey(p.key, r.round);
        const cmp = c.gap != null && Number.isFinite(c.gap);
        const auto = cmp && Math.abs(c.gap) <= cutPct;
        const on = cmp && (overrides.get(key) ?? auto);
        p.rows.push({ round: r.round, code: r.code, label: r.code, ...c, key, cmp, auto, on });
        if (on) {
          p.shared += 1;
          p.sumPct += c.gap;
          p.sumSec += c.ta - c.tb;
          if (c.ta < c.tb) p.winsLeft += 1;
          else if (c.tb < c.ta) p.winsRight += 1;
        }
      }
    }
  }

  // Map хранит пары в порядке первого появления (rounds идут по календарю), так
  // что вкладки уже хронологические. Оставляем те, где было что сравнить, —
  // именно по сравнимым этапам, а не по зачётным: пара с единственным этапом,
  // выключенным авто- или вручную, иначе исчезала бы вместе со своей вкладкой.
  const list = [...pairs.values()]
    .filter((p) => p.rows.some((r) => r.cmp))
    .map((p) => ({
      key: p.key,
      left: p.left,
      right: p.right,
      rows: p.rows,
      shared: p.shared,
      winsLeft: p.winsLeft,
      winsRight: p.winsRight,
      avgPct: p.shared ? p.sumPct / p.shared : null,
      avgSec: p.shared ? p.sumSec / p.shared : null,
    }));

  return { pairs: list };
}
