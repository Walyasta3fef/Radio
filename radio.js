// =====================
// جدول البث الموحّد
// كل دورة كاملة تأخذ ترتيبًا عشوائيًا خاصًا بها:
// كل لقاء يُبث مرة واحدة قبل أي تكرار، ولا يُقطع لقاء في منتصفه
// =====================
const RADIO_EPOCH = 1672531200000;

// مولّد أرقام عشوائية ثابت يعطي النتيجة نفسها على كل الأجهزة والمتصفحات
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let x = Math.imul(a ^ (a >>> 15), 1 | a);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function shuffled(items, seed) {
  const a = [...items];
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// tracks: [{ id, title, duration, from }]
// from: وقت إضافة اللقاء إلى البث (اختياري). اللقاءات بلا from تكوّن البث الأصلي كما كان دائمًا.
// اللقاء الجديد يدخل البث عند أول نهاية دورة كاملة بعد تاريخ إضافته، فلا يقفز البث لمن يستمع الآن.
function createStation(name, tracks) {
  const salt = hashString(name);
  const sum = (list) => list.reduce((s, tr) => s + tr.duration, 0);
  const eras = [];
  const addEra = (start, list) => eras.push({ start, list, total: sum(list), idx: eras.length, cache: new Map() });
  addEra(RADIO_EPOCH, tracks.filter(tr => !tr.from));
  [...new Set(tracks.filter(tr => tr.from).map(tr => tr.from))].sort((a, b) => a - b).forEach(d => {
    const prev = eras[eras.length - 1];
    const cycles = Math.max(0, Math.ceil((d - prev.start) / 1000 / prev.total));
    addEra(prev.start + cycles * prev.total * 1000, tracks.filter(tr => !tr.from || tr.from <= d));
  });

  // الحقبة الأولى بالملح نفسه القديم حتى يبقى البث الحالي مطابقًا لما كان
  const rawOrder = (era, k) => shuffled(era.list,
    (salt ^ Math.imul(k + 1, 2654435761) ^ (era.idx ? hashString('era' + era.idx) : 0)) >>> 0);

  function order(era, k) {
    if (era.cache.has(k)) return era.cache.get(k);
    const list = rawOrder(era, k);
    // منع تكرار اللقاء نفسه مرتين متتاليتين بين نهاية دورة وبداية التي تليها
    const prevLast = rawOrder(era, k - 1)[list.length - 1];
    if (list.length > 2 && list[0].id === prevLast.id) {
      const m = Math.floor(list.length / 2);
      [list[0], list[m]] = [list[m], list[0]];
    }
    if (era.cache.size > 6) era.cache.clear();
    era.cache.set(k, list);
    return list;
  }

  const eraAt = (now) => {
    let e = eras[0];
    for (const x of eras) if (x.start <= now) e = x;
    return e;
  };

  // موضع البث الآن: اللقاء الحالي والتالي والثانية داخل اللقاء (بتوقيت الخادم)
  function getState(now = serverNow()) {
    const era = eraAt(now);
    const elapsed = Math.floor((now - era.start) / 1000);
    const k = Math.floor(elapsed / era.total);
    let pos = elapsed - k * era.total;
    const list = order(era, k);
    for (let i = 0; i < list.length; i++) {
      if (pos < list[i].duration) {
        const next = i + 1 < list.length ? list[i + 1] : order(era, k + 1)[0];
        return { track: list[i], next, position: pos };
      }
      pos -= list[i].duration;
    }
    return { track: list[0], next: list[1], position: 0 };
  }

  return { name, get total() { return eraAt(serverNow()).total; }, getState };
}
