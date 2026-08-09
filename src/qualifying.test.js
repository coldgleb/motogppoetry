// node src/qualifying.test.js — автоотсев аномальных этапов, ручное
// переключение и зачёт квалификаций.
import assert from 'node:assert/strict';
import {
  buildComparison, buildStandings, pointsFor, rowKey, commonSession, formatLapTime, AUTO_OFF_PCT,
} from './qualifying.js';

const rider = (riderId, number, Q2) => ({
  riderId, code: riderId, name: riderId, number, teamId: 'x', team: 'X', Q1: null, Q2,
});

// Два этапа: обычный (гэп ~0.5%) и аномальный (гэп ~3% — авто-выкид).
const rounds = [
  { round: 1, code: 'THA', results: [rider('A', 1, 80), rider('B', 2, 80.4)] },
  { round: 2, code: 'ARG', results: [rider('A', 1, 100), rider('B', 2, 103)] },
];

const pair = (overrides, cut) => buildComparison(rounds, 'x', overrides, cut).pairs[0];

const base = pair();
assert.equal(base.rows[0].on, true, 'обычный этап в счёте');
assert.equal(base.rows[1].on, false, `гэп больше ${AUTO_OFF_PCT}% — этап вне счёта`);
assert.equal(base.shared, 1);
assert.equal(base.winsLeft, 1);
assert.ok(Math.abs(base.avgPct) < 1, 'средний гэп без аномалии');

// Ручное возвращение аномального этапа.
const back = pair(new Map([[rowKey(base.key, 2), true]]));
assert.equal(back.shared, 2);
assert.ok(Math.abs(back.avgPct) > 1, 'аномалия вернулась в средний гэп');

// Ручное отключение нормального этапа.
const off = pair(new Map([[rowKey(base.key, 1), false]]));
assert.equal(off.shared, 0);
assert.equal(off.winsLeft, 0);
assert.equal(off.avgPct, null);

// Порог со страницы: строгий выкидывает оба этапа, щедрый — оставляет оба.
assert.equal(pair(undefined, 0.1).shared, 0);
assert.equal(pair(undefined, 5).shared, 2);

// Общая сессия: сравниваем по поздней, где оба были; если пересечения нет —
// сравнивать нечего.
assert.equal(commonSession({ Q1: 90, Q2: 89 }, { Q1: 91, Q2: 90 }), 'Q2');
assert.equal(commonSession({ Q1: 90, Q2: 89 }, { Q1: 91, Q2: null }), 'Q1');
assert.equal(commonSession({ Q1: null, Q2: 89 }, { Q1: 91, Q2: null }), null);

// Этап, где напарники не сошлись в одной сессии: время видно, гэпа нет и в
// счёт он не идёт. Пара остаётся на месте за счёт второго, сравнимого этапа.
const split = buildComparison(
  [
    { round: 1, code: 'QAT', results: [
      { ...rider('A', 1, 90) },
      { ...rider('B', 2, null), Q1: 92 },
    ] },
    { round: 2, code: 'SPA', results: [rider('A', 1, 90), rider('B', 2, 90.3)] },
  ],
  'x',
).pairs[0];
assert.equal(split.rows[0].cmp, false, 'нет общей сессии — сравнения нет');
assert.equal(split.rows[0].ta, 90, 'но лучший круг всё равно показан');
assert.equal(split.rows[0].tb, 92);
assert.equal(split.rows[0].sa, 'Q2', 'сегмент у каждого времени свой');
assert.equal(split.rows[0].sb, 'Q1');
assert.equal(split.rows[1].sa, 'Q2', 'при общей сессии оба сегмента совпадают');
assert.equal(split.rows[1].sb, 'Q2');
assert.equal(split.shared, 1, 'в счёт пошёл только сравнимый этап');

// Напарник вовсе без времени: сегмент известен только у одного.
const alone = buildComparison(
  [
    { round: 1, code: 'POR', results: [
      { ...rider('A', 1, null), Q1: 91 },
      { ...rider('B', 2, null) },
    ] },
    { round: 2, code: 'SPA', results: [rider('A', 1, 90), rider('B', 2, 90.3)] },
  ],
  'x',
).pairs[0];
assert.equal(alone.rows[0].sa, 'Q1');
assert.equal(alone.rows[0].sb, null);
assert.equal(alone.rows[0].tb, null);

assert.equal(formatLapTime(88.782), '1:28.782');
assert.equal(formatLapTime(null), '—');

// --- зачёт квалификаций ----------------------------------------------------

assert.equal(pointsFor(1), 25);
assert.equal(pointsFor(2), 20);
assert.equal(pointsFor(15), 1);
assert.equal(pointsFor(16), 0);

const at = (riderId, pos) => ({ riderId, code: riderId, name: riderId, teamId: 'x', team: 'X', pos });
const season = [
  { round: 1, code: 'THA', results: [at('A', 2), at('B', 1)] },
  { round: 2, code: 'ARG', results: [at('A', 3), at('B', 16)] },
];

const st = buildStandings(season);
assert.deepEqual(st.stages.map((s) => s.label), ['THA', 'ARG']);
const [first, second] = st.drivers;
assert.equal(first.id, 'A'); // 20 (P2) + 16 (P3) = 36
assert.equal(first.points, 36);
assert.equal(second.id, 'B'); // 25 (P1) + 0 (P16) = 25
assert.equal(second.points, 25);
assert.equal(st.drivers.find((d) => d.id === 'B').cells.get('2Q').pts, 0, 'P16 — без очков');

// Ничья разводится по числу поулов: 25+1 против 20+6 — очков поровну,
// но поул только у A.
const tie = buildStandings([
  { round: 1, code: 'THA', results: [at('A', 1), at('B', 2)] },
  { round: 2, code: 'ARG', results: [at('B', 10), at('A', 15)] },
]);
assert.equal(tie.drivers[0].points, tie.drivers[1].points, 'очки поровну');
assert.equal(tie.drivers[0].id, 'A', 'поул перевешивает');

console.log('qualifying: ok');
