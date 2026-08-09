// Команды: приведение названия к каноническому и цвет.
//
// Зачем приведение. В API Dorna название команды — это название конкретного
// боевого мотоцикла вместе с его титульным спонсором, а не команды. Из-за
// этого одна команда разъезжается на несколько:
//   LCR-2025:        «CASTROL Honda LCR» (Зарко) и «IDEMITSU Honda LCR» (Чантра)
//   Trackhouse-2026: «Trackhouse MotoGP Team» и «SuperFile Trackhouse MotoGP Team»
//   VR46-2024:       «Pertamina Enduro VR46 MotoGP Team» и «…Racing Team»
// Напарники в таких «командах» оказывались поодиночке, и сравнивать было
// некого. Опознаём по устойчивому слову в названии — спонсоры меняются, «lcr»
// и «trackhouse» остаются.
//
// Откуда цвета. Основа — официальные цвета из живого тайминга MotoGP
// (api.motogp.pulselive.com/motogp/v1/timing-gateway/livetiming-lite, поле
// color у каждого пилота). Как есть они не годятся: пять из них темнее нашего
// фона (Monster Yamaha #0A2D82 даёт контраст 1.6:1), а несколько пар — близнецы
// (обе KTM #FF7E27 и #FF6600, обе Yamaha одинаковые, Ducati и Honda оба
// красные). Поэтому каждый цвет подвинут ровно настолько, чтобы вытянуть
// контраст к фону >= 3:1 и развести пары до ΔE00 >= 12 в обычном зрении, —
// остальное оставлено как у Dorna (Gresini, VR46, Trackhouse не тронуты вовсе).
//
// Два отступления от официальных цветов сделаны осознанно:
//   Honda HRC отдан белый (ливрея Castrol), потому что официальный красный —
//   близнец Ducati; LCR из-за этого получил зелёный Castrol вместо белого.
//   Тестовые заявки (Honda HRC Test, Yamaha Factory) идут нейтральным серым:
//   своей ливреи у них нет, а место в палитре они занимали.
//
// При дальтонизме часть пар всё же сливается (Pramac и Aprilia при протанопии,
// Monster Yamaha и Trackhouse при дейтеранопии) — четырнадцать различимых
// цветов на тёмном фоне туда просто не помещаются. Это терпимо: во вкладке
// напарников цвет команды на экране всегда один, а в зачёте он стоит рядом
// с кодом пилота и работает подсказкой, а не единственным признаком.
//
// Порядок важен: сначала частное, потом общее. «hrc test» обязан стоять выше
// «honda hrc» (тестовая команда — отдельная, её вайлд-карды не напарники
// заводским пилотам), «lcr» — выше «honda hrc», «pramac» — выше ямаховских
// ключей («Prima Pramac Yamaha MotoGP»).
// Ключи намеренно длиннее одного слова там, где короткий зацепил бы чужую
// команду в младших классах: «ktm factory racing» не трогает «Red Bull KTM
// Ajo» из Moto3, а «monster energy yamaha» — «WithU Yamaha RNF».
// ponytail: и склейка, и палитра правятся здесь одной строкой.
const NEUTRAL = '#9AA4B8';

const TEAMS = [
  ['hrc test', 'Honda HRC Test Team', NEUTRAL],
  ['lcr', 'LCR Honda', '#3FBF6E'],
  ['honda hrc', 'Honda HRC', '#F2F4F7'],
  ['repsol honda', 'Honda HRC', '#F2F4F7'],
  ['ducati lenovo', 'Ducati Lenovo Team', '#C81E14'],
  ['pramac', 'Pramac Racing', '#2A4EE0'],
  ['gresini', 'Gresini Racing', '#8CA6F5'],
  ['vr46', 'VR46 Racing Team', '#E1FF00'],
  ['tech3', 'Tech3', '#FD5600'],
  ['ktm factory racing', 'Red Bull KTM Factory Racing', '#FF8F36'],
  ['trackhouse', 'Trackhouse Racing', '#008AD3'],
  ['rnf', 'RNF Racing', '#00C2A8'],
  ['aprilia', 'Aprilia Racing', '#8442C4'],
  ['yamaha factory', 'Yamaha Factory Racing', NEUTRAL],
  ['monster energy yamaha', 'Monster Energy Yamaha', '#5079F2'],
];

const match = (name) => {
  const s = String(name || '').toLowerCase();
  return TEAMS.find(([key]) => s.includes(key));
};

// Каноническое имя команды — оно же ключ, по которому собираются напарники.
// Незнакомую команду (а это почти весь Moto2 и Moto3) оставляем как есть:
// лучше не склеить, чем склеить неверно.
export const canonicalTeam = (name) => match(name)?.[1] || String(name || '');

export const teamColor = (name) => match(name)?.[2] || NEUTRAL;

// Чёрный или белый текст поверх цвета команды — по воспринимаемой яркости.
// Порог не 0.5 и не привычные 0.36: тёмный текст у нас не чистый чёрный, а
// #10131a, и точка, где он становится читаемее белого, лежит на 0.194. С более
// высоким порогом плашки Monster Yamaha, Trackhouse и Tech3 получали белый
// текст с контрастом 3.2–4.1:1 вместо тёмного с 4.7–5.8:1.
export function onColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.194 ? '#10131a' : '#ffffff';
}
