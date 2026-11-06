// =====================
// تقدّم المستمع
// يُحسب على النسخة العادية فقط (الكورس والراديو العادي)
// كل لقاء مقسّم إلى شرائح مدة كل منها 5 ثوانٍ، وتُعلَّم الشريحة عند سماعها فعلًا
// فالتقديم لا يُحتسب، وسماع الجزء نفسه مرتين لا يُحتسب مرتين
// يُحفظ على هذا المتصفح فقط حتى إضافة كود الاسترجاع
// =====================
const PROGRESS_KEY = 'afaf_progress_v1';
const SLOT_SECONDS = 5;
const DONE_RATIO = 0.9;

const progress = (() => {
  let state = storage.getJSON(PROGRESS_KEY);
  if (!state || state.v !== 1) state = { v: 1, lectures: {}, seconds: 0, days: 0, lastDay: null, last: null };

  const bitsCache = {};
  const listeners = new Set();
  let dirty = false;
  let notifyTimer = null;

  const slotsOf = (id) => Math.ceil(LECTURE_BY_ID[id].normal / SLOT_SECONDS);

  // h: الشرائح المسموعة مشفّرة، c: عددها، p: موضع التوقف، d: اكتمل
  function entry(id) {
    if (!state.lectures[id]) state.lectures[id] = { h: '', c: 0, p: 0, d: 0 };
    return state.lectures[id];
  }

  function bits(id) {
    if (bitsCache[id]) return bitsCache[id];
    const arr = new Uint8Array(Math.ceil(slotsOf(id) / 8));
    const h = state.lectures[id] && state.lectures[id].h;
    if (h) {
      try {
        const bin = atob(h);
        for (let i = 0; i < Math.min(arr.length, bin.length); i++) arr[i] = bin.charCodeAt(i);
      } catch (e) {}
    }
    bitsCache[id] = arr;
    return arr;
  }

  function encode(arr) {
    let s = '';
    for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
    return btoa(s);
  }

  function today() {
    const d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }

  function notifySoon() {
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => { notifyTimer = null; listeners.forEach(fn => fn()); }, 1000);
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
      if (!e.d && e.c / total >= DONE_RATIO) e.d = 1;
    }
    state.seconds += to - from;
    state.last = id;
    const day = today();
    if (state.lastDay !== day) { state.lastDay = day; state.days++; }
    dirty = true;
    notifySoon();
  }

  function setPosition(id, sec) {
    if (!LECTURE_BY_ID[id]) return;
    entry(id).p = Math.max(0, Math.floor(sec));
    state.last = id;
    dirty = true;
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
    return {
      percent: total ? heard / total * 100 : 0,
      done,
      count: COURSE_ORDER.length,
      seconds: Math.floor(state.seconds),
      days: state.days,
    };
  }

  // اللقاء الذي يكمل منه: آخر لقاء لم يكتمل، وإلا أول لقاء غير مكتمل بالترتيب
  function continueId() {
    if (state.last && LECTURE_BY_ID[state.last] && !isDone(state.last)) return state.last;
    return COURSE_ORDER.find(id => !isDone(id)) || null;
  }

  const hasAny = () => Object.keys(state.lectures).length > 0;

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  setInterval(save, 5000);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });

  return { record, setPosition, position, percent, isDone, summary, continueId, hasAny, subscribe, save };
})();
