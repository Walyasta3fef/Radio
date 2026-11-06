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

// tracks: [{ id, title, duration }]
function createStation(name, tracks) {
  const total = tracks.reduce((s, tr) => s + tr.duration, 0);
  const salt = hashString(name);
  const cache = new Map();

  const rawOrder = (k) => shuffled(tracks, (salt ^ Math.imul(k + 1, 2654435761)) >>> 0);

  function order(k) {
    if (cache.has(k)) return cache.get(k);
    const list = rawOrder(k);
    // منع تكرار اللقاء نفسه مرتين متتاليتين بين نهاية دورة وبداية التي تليها
    const prevLast = rawOrder(k - 1)[list.length - 1];
    if (list.length > 2 && list[0].id === prevLast.id) {
      const m = Math.floor(list.length / 2);
      [list[0], list[m]] = [list[m], list[0]];
    }
    if (cache.size > 6) cache.clear();
    cache.set(k, list);
    return list;
  }

  // موضع البث الآن: اللقاء الحالي والتالي والثانية داخل اللقاء
  function getState(now = Date.now()) {
    const elapsed = Math.floor((now - RADIO_EPOCH) / 1000);
    const k = Math.floor(elapsed / total);
    let pos = elapsed - k * total;
    const list = order(k);
    for (let i = 0; i < list.length; i++) {
      if (pos < list[i].duration) {
        const next = i + 1 < list.length ? list[i + 1] : order(k + 1)[0];
        return { track: list[i], next, position: pos };
      }
      pos -= list[i].duration;
    }
    return { track: list[0], next: list[1], position: 0 };
  }

  return { name, total, getState };
}
