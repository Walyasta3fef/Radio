// =====================
// تقدّم المستمع
// يُحسب على النسخة العادية فقط (الكورس والراديو العادي)
// كل لقاء مقسّم إلى شرائح مدة كل منها 5 ثوانٍ، وتُعلَّم الشريحة عند سماعها فعلًا
// فالتقديم لا يُحتسب، وسماع الجزء نفسه مرتين لا يُحتسب مرتين
// يُحفظ على المتصفح، ويُزامَن مع الحساب عند تسجيل الاسم (account.js)
// =====================
const PROGRESS_KEY = 'afaf_progress_v1';
const DEVICE_KEY = 'afaf_device';
const SLOT_SECONDS = 5;
const DONE_RATIO = 0.95;

// معرّف عشوائي لهذا المتصفح، لجمع وقت الاستماع من الأجهزة المختلفة دون تكرار
const DEVICE_ID = (() => {
  let id = storage.get(DEVICE_KEY);
  if (!id) { id = Math.random().toString(36).slice(2, 10); storage.set(DEVICE_KEY, id); }
  return id;
})();

const dayKey = (d = new Date()) =>
  d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');

const progress = (() => {
  // الحالة:
  // lectures: لكل لقاء { h: الشرائح المسموعة مشفّرة، c: عددها، p: موضع التوقف، t: وقت آخر تحديث للموضع، d: اكتمل }
  // sec: وقت الاستماع القديم قبل التقرير اليومي (لكل جهاز)، days: أيام الاستماع، last: آخر لقاء
  // daily: وقت الاستماع الفعلي لكل جهاز ولكل يوم، مع التكرار:
  //   { جهاز: { يوم: { c: الكورس، n: الراديو العادي، f: الراديو السريع، l: { لقاء: ثوانٍ } } } }
  const empty = () => ({ v: 2, lectures: {}, sec: {}, days: [], legacyDays: 0, last: null, lastAt: 0, daily: {}, seen: {} });

  function migrate(s) {
    if (!s) return empty();
    if (s.v === 2) { if (!s.daily) s.daily = {}; if (!s.seen) s.seen = {}; return s; }
    if (s.v === 1) {
      const n = empty();
      n.lectures = s.lectures || {};
      n.sec[DEVICE_ID] = s.seconds || 0;
      n.legacyDays = s.days || 0;
      n.last = s.last || null;
      return n;
    }
    return empty();
  }

  let state = migrate(storage.getJSON(PROGRESS_KEY));
  let bitsCache = {};
  const listeners = new Set();
  let dirty = false;
  let rev = 0;          // يزيد مع كل تغيير، لمعرفة وجود ما يلزم رفعه
  let notifyTimer = null;

  const slotsOf = (id) => Math.ceil(LECTURE_BY_ID[id].normal / SLOT_SECONDS);

  function entry(id) {
    if (!state.lectures[id]) state.lectures[id] = { h: '', c: 0, p: 0, t: 0, d: 0 };
    return state.lectures[id];
  }

  function decode(id, h) {
    const arr = new Uint8Array(Math.ceil(slotsOf(id) / 8));
    if (h) {
      try {
        const bin = atob(h);
        for (let i = 0; i < Math.min(arr.length, bin.length); i++) arr[i] = bin.charCodeAt(i);
      } catch (e) {}
    }
    return arr;
  }

  function bits(id) {
    if (!bitsCache[id]) bitsCache[id] = decode(id, state.lectures[id] && state.lectures[id].h);
    return bitsCache[id];
  }

  function encode(arr) {
    let s = '';
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }

  function popcount(arr) {
    let n = 0;
    for (let i = 0; i < arr.length; i++) { let b = arr[i]; while (b) { n += b & 1; b >>= 1; } }
    return n;
  }

  function touch() { dirty = true; rev++; }

  function notifySoon() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; listeners.forEach(fn => fn()); }, 1000);
  }
  function notifyNow() {
    clearTimeout(notifyTimer); notifyTimer = null;
    listeners.forEach(fn => fn());
  }

  function save() {
    if (!dirty) return;
    storage.setJSON(PROGRESS_KEY, state);
    dirty = false;
  }

  // تسجيل جزء مسموع فعلًا من لقاء
  function record(id, from, to) {
    if (!LECTURE_BY_ID[id] || !(to > from)) return;
    const e = entry(id);
    const arr = bits(id);
    const total = slotsOf(id);
    const a = Math.max(0, Math.floor(from / SLOT_SECONDS));
    const b = Math.min(total - 1, Math.floor(to / SLOT_SECONDS));
    let changed = false;
    for (let i = a; i <= b; i++) {
      const byte = i >> 3, mask = 1 << (i & 7);
      if (!(arr[byte] & mask)) { arr[byte] |= mask; e.c++; changed = true; }
    }
    if (changed) {
      e.h = encode(arr);
      if (!e.d && e.c / total >= DONE_RATIO) { e.d = 1; e.da = dayKey(); }
    }
    const day = dayKey();
    if (!state.days.includes(day)) state.days.push(day);
    touch();
    notifySoon();
  }

  // وقت الاستماع الفعلي من أي مصدر (c كورس، n راديو عادي، f راديو سريع)، والتكرار يُحتسب
  function addTime(source, id, sec) {
    if (!(sec > 0) || !['c', 'n', 'f'].includes(source)) return;
    const day = dayKey();
    const mine = state.daily[DEVICE_ID] || (state.daily[DEVICE_ID] = {});
    const d = mine[day] || (mine[day] = { c: 0, n: 0, f: 0, l: {} });
    const r1 = (x) => Math.round(x * 10) / 10;
    d[source] = r1((d[source] || 0) + sec);
    if (id) d.l[id] = r1((d.l[id] || 0) + sec);
    touch();
  }

  // إحصاءات فترة: من يوم إلى يوم (مفاتيح YYYYMMDD، شاملة)
  function stats(fromKey, toKey) {
    const byDay = {};
    const bySrc = {};   // لكل يوم: { c, n, f }
    const lec = {};
    let c = 0, n = 0, f = 0;
    Object.values(state.daily).forEach(days => {
      Object.entries(days).forEach(([day, d]) => {
        if (day < fromKey || day > toKey || !d) return;
        const total = (d.c || 0) + (d.n || 0) + (d.f || 0);
        byDay[day] = (byDay[day] || 0) + total;
        const b = bySrc[day] || (bySrc[day] = { c: 0, n: 0, f: 0 });
        b.c += d.c || 0; b.n += d.n || 0; b.f += d.f || 0;
        c += d.c || 0; n += d.n || 0; f += d.f || 0;
        Object.entries(d.l || {}).forEach(([id, s]) => { lec[id] = (lec[id] || 0) + s; });
      });
    });
    let top = null;
    Object.entries(lec).forEach(([id, s]) => { if (LECTURE_BY_ID[id] && (!top || s > top.sec)) top = { id, sec: s }; });
    const completed = Object.entries(state.lectures)
      .filter(([id, e]) => e.d && e.da && e.da >= fromKey && e.da <= toKey && LECTURE_BY_ID[id]).length;
    const activeDays = Object.values(byDay).filter(s => s >= 60).length;
    return { total: c + n + f, c, n, f, byDay, bySrc, top, completed, activeDays };
  }

  // آخر تعليق قرأه المستخدم في كل مكان (بتوقيت الخادم)، لمعرفة الجديد
  const seenAt = (lid) => (state.seen && state.seen[lid]) || 0;
  function markSeen(lid, ts) {
    if (!lid || !(ts > seenAt(lid))) return;
    state.seen[lid] = ts;
    touch();
    notifyNow();
  }

  // وقت الاستماع القديم المسجّل قبل إضافة التقرير اليومي
  const legacySeconds = () => Object.values(state.sec || {}).reduce((s, x) => s + x, 0);

  // يُستدعى من الكورس فقط، فيحدد آخر لقاء فُتح منه
  function setPosition(id, sec) {
    if (!LECTURE_BY_ID[id]) return;
    const e = entry(id);
    e.p = Math.max(0, Math.floor(sec));
    e.t = Date.now();
    state.last = id;
    state.lastAt = e.t;
    touch();
  }

  // موضع الاستئناف، ويبدأ من الأول إذا كان قد وصل إلى النهاية تقريبًا
  function position(id) {
    const e = state.lectures[id];
    if (!e || !LECTURE_BY_ID[id]) return 0;
    return e.p > LECTURE_BY_ID[id].normal - 15 ? 0 : e.p;
  }

  function percent(id) {
    const e = state.lectures[id];
    if (!e || !LECTURE_BY_ID[id]) return 0;
    return Math.min(100, Math.floor(e.c / slotsOf(id) * 100));
  }

  // الأجزاء المسموعة كنسب مئوية متصلة: [[البداية، النهاية], ...]
  function segments(id) {
    const e = state.lectures[id];
    if (!e || !e.c || !LECTURE_BY_ID[id]) return [];
    const arr = bits(id);
    const total = slotsOf(id);
    const out = [];
    let start = -1;
    for (let i = 0; i <= total; i++) {
      const on = i < total && (arr[i >> 3] & (1 << (i & 7)));
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push([start / total * 100, i / total * 100]); start = -1; }
    }
    return out;
  }

  const isDone = (id) => !!(state.lectures[id] && state.lectures[id].d);

  function summary() {
    let heard = 0, total = 0, done = 0;
    COURSE_ORDER.forEach(id => {
      const dur = LECTURE_BY_ID[id].normal;
      total += dur;
      const e = state.lectures[id];
      if (e) heard += Math.min(dur, e.c * SLOT_SECONDS);
      if (isDone(id)) done++;
    });
    const seconds = Object.values(state.sec).reduce((s, x) => s + x, 0);
    return {
      percent: total ? heard / total * 100 : 0,
      done,
      count: COURSE_ORDER.length,
      seconds: Math.floor(seconds),
      days: state.days.length + (state.legacyDays || 0),
    };
  }

  // اللقاء الذي يكمل منه في الكورس: آخر لقاء فتحه من الكورس ولم يكتمل،
  // وإلا أول لقاء غير مكتمل بالترتيب. الاستماع من الراديو لا يغيّره
  function continueId() {
    if (state.last && LECTURE_BY_ID[state.last] && !isDone(state.last)) return state.last;
    return COURSE_ORDER.find(id => !isDone(id)) || null;
  }

  // هل بدأ الكورس فعلًا (فتح لقاء منه)
  const hasAny = () => !!state.last;

  // دمج تقدّم محفوظ على جهاز آخر دون فقدان أي جزء من الجهتين
  function merge(remote) {
    remote = remote && migrateRemote(remote);
    if (!remote) return;
    Object.entries(remote.lectures || {}).forEach(([id, r]) => {
      if (!LECTURE_BY_ID[id] || !r) return;
      const e = entry(id);
      const mine = bits(id);
      const theirs = decode(id, r.h);
      for (let i = 0; i < mine.length; i++) mine[i] |= theirs[i];
      e.h = encode(mine);
      e.c = popcount(mine);
      e.d = e.d || r.d || (e.c / slotsOf(id) >= DONE_RATIO) ? 1 : 0;
      if (r.da && (!e.da || r.da < e.da)) e.da = r.da;
      if (e.d && !e.da) e.da = dayKey();
      if ((r.t || 0) > (e.t || 0)) { e.p = r.p || 0; e.t = r.t; }
    });
    Object.entries(remote.sec || {}).forEach(([dev, s]) => {
      if (typeof s === 'number') state.sec[dev] = Math.max(state.sec[dev] || 0, s);
    });
    Object.entries(remote.seen || {}).forEach(([lid, ts]) => {
      if (typeof ts === 'number' && ts > seenAt(lid)) state.seen[lid] = ts;
    });
    // وقت الاستماع اليومي: لكل جهاز ويوم نأخذ النسخة الأكبر، فلا يتكرر شيء
    Object.entries(remote.daily || {}).forEach(([dev, days]) => {
      const mine = state.daily[dev] || (state.daily[dev] = {});
      Object.entries(days || {}).forEach(([day, d]) => {
        if (!d) return;
        const tot = (x) => x ? (x.c || 0) + (x.n || 0) + (x.f || 0) : -1;
        if (tot(d) > tot(mine[day])) mine[day] = { c: d.c || 0, n: d.n || 0, f: d.f || 0, l: { ...(d.l || {}) } };
      });
    });
    (remote.days || []).forEach(d => { if (!state.days.includes(d)) state.days.push(d); });
    state.legacyDays = Math.max(state.legacyDays || 0, remote.legacyDays || 0);
    if ((remote.lastAt || 0) > (state.lastAt || 0)) { state.last = remote.last; state.lastAt = remote.lastAt; }
    touch();
    save();
    notifyNow();
  }

  function migrateRemote(r) {
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return null; } }
    return r && r.v === 2 ? r : null;
  }

  function exportState() { return JSON.stringify(state); }

  // مسح التقدّم من هذا المتصفح فقط (عند الخروج)، ويبقى محفوظًا في الحساب
  function reset() {
    state = empty();
    bitsCache = {};
    storage.set(PROGRESS_KEY, '');
    dirty = false;
    rev++;
    notifyNow();
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  setInterval(save, 5000);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });

  return {
    record, addTime, stats, seenAt, markSeen, legacySeconds, setPosition, position, percent, segments, isDone, summary, continueId, hasAny,
    merge, exportState, reset, subscribe, save,
    get rev() { return rev; },
  };
})();
