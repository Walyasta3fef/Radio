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
  // lectures: لكل لقاء { h: الشرائح المسموعة مشفّرة، c: عددها، p: موضع التوقف، t: وقت آخر تحديث للموضع، d: اكتمل،
  //   fp: موضع التوقف في النسخة السريعة من الكورس، ft: وقت آخر تحديث له،
  //   z: الشرائح المسموعة لأول مرة و«حذف السكتات» يعمل، ولم تُسمع بعدها بالسرعة العادية (مشفّرة)،
  //   k: عدد مرات إكمال اللقاء، rb و rc: الشرائح المسموعة في المرة الحالية بعد الإكمال الأول وعددها }
  // lvl: أعلى عدد مرات أُكمل فيه الكورس كله (من 1 إلى 5) ولا ينقص بإضافة لقاء جديد،
  // core: أكمل الأساسيات (COURSE_HEAD)، cg: آخر مرتبة عُرضت تهنئتها
  // sec: وقت الاستماع القديم قبل التقرير اليومي (لكل جهاز)، days: أيام الاستماع، last: آخر لقاء
  // daily: وقت الاستماع الفعلي لكل جهاز ولكل يوم، مع التكرار:
  //   { جهاز: { يوم: { c: الكورس، n: الراديو العادي، f: الراديو السريع، l: { لقاء: ثوانٍ } } } }
  // other: تقدّم لقاءات لا يعرفها هذا الجهاز بعد (لقاء جديد لم تصله قائمته)، يُحفظ كما هو حتى لا يضيع عند الرفع
  // tz: مشاهدة مواد «تزكية»: { معرّف: { p: الموضع بالثواني، d: المدة، w: 1 إذا اكتملت، t: آخر تحديث } }
  const empty = () => ({ v: 2, lectures: {}, sec: {}, days: [], legacyDays: 0, last: null, lastAt: 0, daily: {}, seen: {}, other: {}, tz: {} });

  function migrate(s) {
    if (!s) return empty();
    if (s.v === 2) { if (!s.daily) s.daily = {}; if (!s.seen) s.seen = {}; if (!s.other) s.other = {}; if (!s.tz) s.tz = {}; return s; }
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
  if (!state.other) state.other = {};
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
  const zCache = {};
  const rbCache = {};
  function rbits(id) {
    if (!rbCache[id]) rbCache[id] = decode(id, state.lectures[id] && state.lectures[id].rb);
    return rbCache[id];
  }
  function zbits(id) {
    if (!zCache[id]) zCache[id] = decode(id, state.lectures[id] && state.lectures[id].z);
    return zCache[id];
  }
  const anyBit = (arr) => arr.some(b => b);
  const encodeZ = (arr) => anyBit(arr) ? encode(arr) : '';

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

  // تسجيل جزء مسموع فعلًا من لقاء. how: بلا قيمة استماع عادي، 'skipping' كلام مسموع و«حذف السكتات» يعمل،
  // 'skip' سكتة قُفز فوقها فتُحتسب مسموعة. لكل شريحة: الجديدة بحذف السكتات تُعلَّم،
  // والمسموعة بالعادي تُمحى علامتها، والمسموعة من قبل لا تتغيّر بالاستماع بحذف السكتات
  function record(id, from, to, how) {
    if (!LECTURE_BY_ID[id] || !(to > from)) return;
    const e = entry(id);
    const arr = bits(id);
    const total = slotsOf(id);
    const a = Math.max(0, Math.floor(from / SLOT_SECONDS));
    const b = Math.min(total - 1, Math.floor(to / SLOT_SECONDS));
    let changed = false;
    const z = (how || e.z) ? zbits(id) : null;
    // بعد الإكمال الأول: الاستماع يُحسب في المرة التالية، فإذا بلغ 95% زاد عدد مرات الإكمال.
    // والجزء الذي لم يُسمع قط يكمّل السماع الأول ولا يُعدّ في التالي (فآخر اللقاء لا يبدأ سماعًا ثانيًا)
    const rb = e.d ? rbits(id) : null;
    let rbChanged = false;
    for (let i = a; i <= b; i++) {
      const byte = i >> 3, mask = 1 << (i & 7);
      if (rb && (arr[byte] & mask) && !(rb[byte] & mask)) { rb[byte] |= mask; e.rc = (e.rc || 0) + 1; rbChanged = true; }
      if (!(arr[byte] & mask)) {
        arr[byte] |= mask; e.c++; changed = true;
        if (how) z[byte] |= mask;
      } else if (!how && z && (z[byte] & mask)) { z[byte] &= ~mask; changed = true; }
    }
    if (z) e.z = encodeZ(z);
    if (changed) {
      e.h = encode(arr);
      if (!e.d && e.c / total >= DONE_RATIO) { e.d = 1; e.da = dayKey(); e.k = 1; }
    }
    if (rbChanged) {
      if (e.rc / total >= DONE_RATIO) { e.k = Math.min(99, (e.k || 1) + 1); rb.fill(0); e.rc = 0; e.rb = ''; }
      else e.rb = encode(rb);
    }
    if (changed || rbChanged) updateLevels();
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

  // =====================
  // تزكية: موضع المشاهدة وإكمالها (90% فأكثر تُعدّ مشاهدة)
  // =====================
  const TZ_DONE = 0.9;
  const tzInfo = (id) => (state.tz && state.tz[id]) || null;
  function tzSave(id, pos, dur) {
    if (!id || !(pos >= 0)) return;
    const e = state.tz[id] || (state.tz[id] = {});
    e.p = Math.round(pos);
    if (dur > 0) e.d = Math.round(dur);
    if (e.d && pos / e.d >= TZ_DONE) e.w = 1;
    e.t = Date.now();
    touch();
    notifySoon();
  }
  const tzWatched = (id) => !!(state.tz && state.tz[id] && state.tz[id].w);

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

  // موضع النسخة السريعة من الكورس: مستقل عن العادية، ولا يغيّر التقدّم ولا «أكمل من حيث توقفت»
  function setFastPosition(id, sec) {
    if (!LECTURE_BY_ID[id]) return;
    const e = entry(id);
    e.fp = Math.max(0, Math.floor(sec));
    e.ft = Date.now();
    touch();
  }
  function fastPosition(id) {
    const e = state.lectures[id];
    if (!e || !e.fp || !LECTURE_BY_ID[id]) return 0;
    return e.fp > LECTURE_BY_ID[id].fast - 15 ? 0 : e.fp;
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
    return segmentsOf(bits(id), slotsOf(id));
  }

  // =====================
  // الجولات: بعد إكمال اللقاء أول مرة تبدأ جولته التالية فورًا، وتُعدّ شرائحها من جديد (rb و rc)
  // =====================
  // نسبة ما سُمع من الجولة الحالية للقاء مكتمل (0 لغير المكتمل)
  function roundPct(id) {
    const e = state.lectures[id];
    if (!e || !e.d || !e.rc || !LECTURE_BY_ID[id]) return 0;
    return Math.min(100, Math.floor(e.rc / slotsOf(id) * 100));
  }
  // الأجزاء المسموعة في الجولة الحالية
  function roundSegments(id) {
    const e = state.lectures[id];
    if (!e || !e.d || !e.rc || !LECTURE_BY_ID[id]) return [];
    return segmentsOf(rbits(id), slotsOf(id));
  }
  // الشرائح المعتمدة للقاء: خريطة الجولة الحالية إن اكتمل، وإلا خريطة السماع الأول
  const activeBits = (id) => (state.lectures[id] && state.lectures[id].d ? rbits(id) : bits(id));
  const activeCount = (id) => { const e = state.lectures[id]; return e ? (e.d ? (e.rc || 0) : (e.c || 0)) : 0; };

  function segmentsOf(arr, total) {
    const out = [];
    let start = -1;
    for (let i = 0; i <= total; i++) {
      const on = i < total && (arr[i >> 3] & (1 << (i & 7)));
      if (on && start < 0) start = i;
      if (!on && start >= 0) { out.push([start / total * 100, i / total * 100]); start = -1; }
    }
    return out;
  }

  // أول موضع لم يُسمع بعد الموضع sec، إذا كان sec نفسه داخل جزء مسموع
  // الفجوات القصيرة (أقل من نصف دقيقة) تُعدّ مسموعة، والقفزة القصيرة لا تستحق زرًا
  const GAP_SLOTS = Math.ceil(30 / SLOT_SECONDS);
  function nextUnheard(id, sec) {
    const e = state.lectures[id];
    if (!e || !activeCount(id) || !LECTURE_BY_ID[id]) return null;
    const arr = activeBits(id);
    const total = slotsOf(id);
    const on = (i) => !!(arr[i >> 3] & (1 << (i & 7)));
    const start = Math.floor(sec / SLOT_SECONDS);
    if (start >= total || !on(start)) return null;
    let i = start;
    while (i < total) {
      if (on(i)) { i++; continue; }
      let j = i;
      while (j < total && !on(j)) j++;
      if (j - i >= GAP_SLOTS || j >= total) break;
      i = j;
    }
    if (i >= total - GAP_SLOTS) return null;                 // مسموع حتى النهاية تقريبًا
    const target = i * SLOT_SECONDS;
    return target - sec >= 60 ? target : null;
  }

  const isDone = (id) => !!(state.lectures[id] && state.lectures[id].d);
  // عدد مرات إكمال اللقاء
  const rounds = (id) => (isDone(id) ? Math.max(1, state.lectures[id].k || 1) : 0);

  // مرتبة المستمع: -1 لا شيء، 0 أكمل الأساسيات، 1 إلى 5 عدد مرات إكمال الكورس كله.
  // المرتبة المكتسبة لا تنقص؛ واللقاء الجديد يدخل في حساب المرتبة التالية فقط
  const MAX_LEVEL = 5;
  function updateLevels() {
    const all = Math.min(MAX_LEVEL, Math.min(...COURSE_ORDER.map(rounds)));
    if (all > (state.lvl || 0)) { state.lvl = all; touch(); }
    if (!state.core && COURSE_HEAD.every(isDone)) { state.core = 1; touch(); }
  }
  const level = () => (state.lvl >= 1 ? state.lvl : state.core ? 0 : -1);

  // موضع إكمال الجولة الحالية للقاء مكتمل: موضع التوقف إن كان في جزء لم يُسمع في هذه الجولة،
  // وإلا أول جزء لم يُسمع فيها (الفجوات القصيرة تُعدّ مسموعة)، ومن البداية إن كانت الجولة جديدة
  function roundResume(id) {
    if (!isDone(id)) return position(id);
    const e = state.lectures[id];
    if (!e.rc) return 0;
    const arr = rbits(id);
    const total = slotsOf(id);
    const on = (i) => !!(arr[i >> 3] & (1 << (i & 7)));
    const p = position(id);
    const ps = Math.floor(p / SLOT_SECONDS);
    if (p > 0 && ps < total && !on(ps)) return p;
    let i = 0;
    while (i < total) {
      if (on(i)) { i++; continue; }
      let j = i;
      while (j < total && !on(j)) j++;
      if (j - i >= GAP_SLOTS || j >= total) break;
      i = j;
    }
    return i >= total ? 0 : i * SLOT_SECONDS;
  }

  // جولة الكورس الحالية بعد إكماله أول مرة: n رقمها (2 فأكثر)، done اللقاءات التي أكملتها،
  // percent نسبة ما سُمع منها بحسب المدة. null ما دام في الجولة الأولى
  function lap() {
    const ids = COURSE_ORDER.filter(id => LECTURE_BY_ID[id]);
    if (!ids.length) return null;
    const n = Math.min(...ids.map(rounds)) + 1;
    if (n < 2) return null;
    let heard = 0, total = 0, done = 0;
    ids.forEach(id => {
      const dur = LECTURE_BY_ID[id].normal;
      total += dur;
      if (rounds(id) >= n) { heard += dur; done++; }
      else heard += Math.min(dur, (state.lectures[id].rc || 0) * SLOT_SECONDS);
    });
    return { n, done, count: ids.length, percent: total ? heard / total * 100 : 0 };
  }
  const congratsSeen = () => (typeof state.cg === 'number' ? state.cg : -1);
  function setCongratsSeen(l) { if (l > congratsSeen()) { state.cg = l; touch(); save(); notifyNow(); } }
  // نسبة اللقاء المكتمل التي سُمعت بحذف السكتات فقط، إن بلغت ربعه فأكثر (وإلا 0)
  const SKIPPED_MARK = 0.25;
  function doneSkipped(id) {
    if (!isDone(id) || !state.lectures[id].z) return 0;
    const share = popcount(zbits(id)) / slotsOf(id);
    return share >= SKIPPED_MARK ? share : 0;
  }
  // اللقاءات التي اكتملت قبل إتاحة الإكمال بحذف السكتات سُمعت كلها بالعادي
  const SKIP_DONE_FROM = '20261118';
  function cleanZ() {
    Object.entries(state.lectures).forEach(([id, e]) => {
      if (e && e.z && e.d && e.da && e.da < SKIP_DONE_FROM) { e.z = ''; delete zCache[id]; dirty = true; }
    });
  }
  cleanZ();
  if (dirty) save();

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
  // لقاء توقف المستمع في وسطه ولم يصل إلى آخره (آخر دقيقة)، ولو حُسب مكتملًا عند 95%
  function midListen(id) {
    const l = LECTURE_BY_ID[id];
    if (!l) return false;
    const p = position(id);
    return p > 0 && p < l.normal - 60;
  }

  // وبعد إكمال الكورس: آخر لقاء فتحه ولم يكمله في الجولة الحالية، وإلا أول لقاء بالترتيب لم يكمله فيها
  function continueId() {
    if (state.last && LECTURE_BY_ID[state.last] && (!isDone(state.last) || midListen(state.last))) return state.last;
    const first = COURSE_ORDER.find(id => !isDone(id));
    if (first) return first;
    const L = lap();
    if (!L) return null;
    if (state.last && LECTURE_BY_ID[state.last] && rounds(state.last) < L.n) return state.last;
    return COURSE_ORDER.find(id => rounds(id) < L.n) || null;
  }

  // هل بدأ الكورس فعلًا (فتح لقاء منه)
  const hasAny = () => !!state.last;

  // دمج تقدّم محفوظ على جهاز آخر دون فقدان أي جزء من الجهتين
  function merge(remote) {
    remote = remote && migrateRemote(remote);
    if (!remote) return;
    const incoming = Object.assign({}, remote.other || {}, remote.lectures || {});
    Object.entries(incoming).forEach(([id, r]) => {
      if (!r || typeof r !== 'object') return;
      if (!LECTURE_BY_ID[id]) {
        // لقاء غير معروف هنا: يُحتفظ بالنسخة الأكثر استماعًا كما هي
        if (/^[cL][0-9]{2}$/.test(id) && (!state.other[id] || (r.c || 0) >= (state.other[id].c || 0))) state.other[id] = r;
        return;
      }
      const e = entry(id);
      const mine = bits(id);
      const theirs = decode(id, r.h);
      // علامة القفز تبقى للشريحة فقط إن لم تُسمع بالعادي في أي من الجهتين
      if (e.z || r.z) {
        const zm = zbits(id), zt = decode(id, r.z);
        for (let i = 0; i < zm.length; i++) zm[i] = (zm[i] | ~mine[i]) & (zt[i] | ~theirs[i]) & (mine[i] | theirs[i]) & 255;
        e.z = encodeZ(zm);
      }
      // المرة الحالية بعد الإكمال: من الجهة الأكثر إكمالًا، وعند التساوي تُجمع الجهتان
      const rk = r.d ? Math.max(1, r.k || 1) : 0, ek = e.d ? Math.max(1, e.k || 1) : 0;
      if (rk > ek) { e.k = rk; e.rb = r.rb || ''; e.rc = r.rc || 0; delete rbCache[id]; }
      else if (rk === ek && rk > 0 && r.rb) {
        const rm = rbits(id), rt = decode(id, r.rb);
        for (let i = 0; i < rm.length; i++) rm[i] |= rt[i];
        e.rc = popcount(rm); e.rb = encode(rm);
      }
      for (let i = 0; i < mine.length; i++) mine[i] |= theirs[i];
      e.h = encode(mine);
      e.c = popcount(mine);
      e.d = e.d || r.d || (e.c / slotsOf(id) >= DONE_RATIO) ? 1 : 0;
      if (r.da && (!e.da || r.da < e.da)) e.da = r.da;
      if (e.d && !e.da) e.da = dayKey();
      if (e.d && !e.k) e.k = 1;
      if ((r.t || 0) > (e.t || 0)) { e.p = r.p || 0; e.t = r.t; }
      if ((r.ft || 0) > (e.ft || 0)) { e.fp = r.fp || 0; e.ft = r.ft; }
    });
    Object.entries(remote.sec || {}).forEach(([dev, s]) => {
      if (typeof s === 'number') state.sec[dev] = Math.max(state.sec[dev] || 0, s);
    });
    Object.entries(remote.seen || {}).forEach(([lid, ts]) => {
      if (typeof ts === 'number' && ts > seenAt(lid)) state.seen[lid] = ts;
    });
    // تزكية: المكتملة تبقى مكتملة، والموضع من الجهة الأحدث
    Object.entries(remote.tz || {}).forEach(([id, r]) => {
      if (!r || typeof r !== 'object') return;
      const e = state.tz[id] || (state.tz[id] = {});
      if (r.w) e.w = 1;
      if (r.d > 0 && !(e.d > 0)) e.d = r.d;
      if ((r.t || 0) > (e.t || 0)) { e.p = r.p || 0; e.t = r.t; if (r.d > 0) e.d = r.d; }
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
    ['lvl', 'core', 'cg'].forEach(k => { if (typeof remote[k] === 'number' && remote[k] > (state[k] == null ? -1 : state[k])) state[k] = remote[k]; });
    if ((remote.lastAt || 0) > (state.lastAt || 0)) { state.last = remote.last; state.lastAt = remote.lastAt; }
    cleanZ();
    updateLevels();
    touch();
    save();
    notifyNow();
  }

  function migrateRemote(r) {
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { return null; } }
    return r && r.v === 2 ? r : null;
  }

  function exportState() { return JSON.stringify(state); }
  // ملخص التقدّم لمتابعة من يستمع بلا حساب: الأيام والمكتمل والمرتبة فقط، بلا خرائط الشرائح الثقيلة
  function exportSummary() {
    const lectures = {};
    Object.entries(state.lectures || {}).forEach(([id, e]) => {
      if (!e) return;
      const x = {};
      ['d', 'da', 'k', 'c'].forEach(k => { if (e[k] != null) x[k] = e[k]; });
      if (Object.keys(x).length) lectures[id] = x;
    });
    return JSON.stringify({ daily: state.daily || {}, sec: state.sec || {}, lectures, lvl: state.lvl || 0, core: state.core || 0 });
  }

  // مسح التقدّم من هذا المتصفح فقط (عند الخروج)، ويبقى محفوظًا في الحساب
  function reset() {
    state = empty();
    bitsCache = {};
    Object.keys(zCache).forEach(k => delete zCache[k]);
    Object.keys(rbCache).forEach(k => delete rbCache[k]);
    storage.set(PROGRESS_KEY, '');
    dirty = false;
    rev++;
    notifyNow();
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // لقاءات كانت مجهولة ثم وصلت قائمتها: يُضم تقدّمها المحفوظ، وما حُذف من القائمة يُنقل إلى other
  (function adoptKnown() {
    const known = Object.keys(state.other).filter(id => LECTURE_BY_ID[id]);
    if (known.length) {
      const lectures = {};
      known.forEach(id => { lectures[id] = state.other[id]; delete state.other[id]; });
      merge({ v: 2, lectures });
    }
    Object.keys(state.lectures).filter(id => !LECTURE_BY_ID[id]).forEach(id => {
      if (/^[cL][0-9]{2}$/.test(id)) state.other[id] = state.lectures[id];
      delete state.lectures[id];
      delete bitsCache[id];
      touch();
    });
  })();

  updateLevels();
  if (dirty) save();

  setInterval(save, 5000);
  window.addEventListener('pagehide', save);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') save(); });

  return {
    tzInfo, tzSave, tzWatched,
    record, addTime, doneSkipped, rounds, level, roundPct, roundSegments, roundResume, lap, midListen, congratsSeen, setCongratsSeen, stats, nextUnheard, seenAt, markSeen, legacySeconds, setPosition, position, setFastPosition, fastPosition, percent, segments, isDone, summary, continueId, hasAny,
    merge, exportState, exportSummary, reset, subscribe, save,
    get rev() { return rev; },
  };
})();
