// =====================
// سكتات اللقاءات: مواضع الصمت في الملف الأصلي كما يستخرجها Audacity (Label Sounds ثم تصدير العلامات)
// عند تفعيل «حذف السكتات» يقفز المشغّل فوقها في الملف نفسه، فيبقى للّقاء ملف واحد وموضع واحد وخط زمني واحد
// يرفع المالك ملف كل لقاء من صفحة المميزين، ويُخزَّن مضغوطًا في قاعدة البيانات:
//   sil/{lid}   = النص المضغوط        silat/{lid} = وقت رفعه (يتابعه كل زائر، وهو صغير جدًا)
// ملف اللقاء نفسه لا يُنزَّل إلا عند الحاجة إليه، ثم يُحفظ على الجهاز
// =====================
const SILENCE_PAD = 0.2;       // يُترك هذا القدر من كل طرف حتى لا يُقصّ أول الكلام وآخره
const SILENCE_MIN = 0.5;       // قفزة أقصر من هذا لا تستحق
const SIL_AT_KEY = 'afaf_silat_v1';
const SIL_DATA_KEY = 'afaf_sil_v1:';

// قراءة ملف علامات Audacity: كل سطر «بداية<tab>نهاية<tab>اسم». يعيد قائمة [بداية، نهاية] بالثواني، أو null إذا لم يكن الملف بهذه الصيغة
function parseAudacityLabels(text) {
  const rows = [];
  let bad = 0;
  String(text || '').split(/\r?\n/).forEach(line => {
    if (!line.trim()) return;
    const p = line.trim().split(/\t|\s{2,}|\s/);
    const a = parseFloat(p[0]), b = parseFloat(p[1]);
    if (!isFinite(a) || !isFinite(b) || a < 0 || b <= a) { bad++; return; }
    rows.push([a, b]);
  });
  if (!rows.length || bad > rows.length / 10) return null;
  rows.sort((x, y) => x[0] - y[0]);
  // دمج المتداخل
  const out = [];
  rows.forEach(r => {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else out.push([r[0], r[1]]);
  });
  return out;
}

// الضغط: كل سكتة رقمان بجزء من مئة من الثانية (المسافة عن نهاية السابقة، ثم طولها) بنظام العدّ 36
function encodeSilences(rows) {
  let prev = 0;
  const parts = [];
  rows.forEach(([a, b]) => {
    const s = Math.round(a * 100), e = Math.round(b * 100);
    if (e <= s || s < prev) return;
    parts.push((s - prev).toString(36), (e - s).toString(36));
    prev = e;
  });
  return '1:' + parts.join(',');
}
function decodeSilences(str) {
  if (typeof str !== 'string' || str.slice(0, 2) !== '1:') return null;
  const parts = str.slice(2).split(',');
  const out = [];
  let pos = 0;
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const gap = parseInt(parts[i], 36), len = parseInt(parts[i + 1], 36);
    if (!(gap >= 0) || !(len > 0)) return null;
    const s = pos + gap;
    pos = s + len;
    out.push([s / 100, pos / 100]);
  }
  return out.length ? out : null;
}
// المقاطع التي تُقفز فعلًا بعد ترك الأطراف
function skipRangesOf(rows) {
  const out = [];
  (rows || []).forEach(([a, b]) => {
    const s = a + SILENCE_PAD, e = b - SILENCE_PAD;
    if (e - s >= SILENCE_MIN) out.push([s, e]);
  });
  return out;
}

const silences = (() => {
  const savedAt = storage.getJSON(SIL_AT_KEY);
  let at = savedAt && typeof savedAt === 'object' ? savedAt : {};       // لقاء → وقت رفع ملفه
  const ranges = {};          // لقاء → المقاطع الجاهزة للقفز (للنسخة الحالية من ملفه)
  const loadedAt = {};        // لقاء → وقت الرفع الذي تطابقه المقاطع المحمّلة
  const loading = {};
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());

  try {
    database.ref('/silat').on('value', snap => {
      const v = snap.val() || {};
      const next = {};
      Object.keys(v).forEach(id => { if (LECTURE_BY_ID[id] && typeof v[id] === 'number') next[id] = v[id]; });
      at = next;
      storage.setJSON(SIL_AT_KEY, at);
      notify();
    }, () => {});              // رفض القراءة (قواعد لم تُنشر بعد) لا يؤثر في شيء
  } catch (e) {}

  // هل لهذا اللقاء ملف سكتات
  const available = (id) => !!at[id];
  // هل مقاطعه محمّلة وجاهزة للقفز
  const ready = (id) => !!at[id] && loadedAt[id] === at[id] && !!ranges[id];

  function adopt(id, stamp, str) {
    const rows = decodeSilences(str);
    if (!rows) return false;
    ranges[id] = skipRangesOf(rows);
    loadedAt[id] = stamp;
    return true;
  }

  // تحميل مقاطع لقاء: من النسخة المحفوظة على الجهاز إن طابقت آخر رفع، وإلا من قاعدة البيانات
  function load(id) {
    if (!at[id] || ready(id)) return Promise.resolve(ready(id));
    if (loading[id]) return loading[id];
    const stamp = at[id];
    const cached = storage.getJSON(SIL_DATA_KEY + id);
    if (cached && cached.t === stamp && adopt(id, stamp, cached.d)) { notify(); return Promise.resolve(true); }
    loading[id] = (async () => {
      try {
        const snap = await withTimeout(database.ref('/sil/' + id).once('value'), 15000);
        const str = snap.val();
        if (!adopt(id, stamp, str)) return false;
        storage.setJSON(SIL_DATA_KEY + id, { t: stamp, d: str });
        notify();
        return true;
      } catch (e) { return false; }
      finally { delete loading[id]; }
    })();
    return loading[id];
  }

  const get = (id) => (ready(id) ? ranges[id] : []);

  // إذا كان الموضع t داخل سكتة: نهايتها (الموضع الذي يُقفز إليه)، وإلا null
  function endAt(id, t) {
    const r = get(id);
    let lo = 0, hi = r.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < r[mid][0]) hi = mid - 1;
      else if (t >= r[mid][1] - 0.05) lo = mid + 1;
      else return r[mid][1];
    }
    return null;
  }

  // تحريك الموضع t بمقدار delta ثانية من الكلام المسموع فقط (السكتات لا تُحتسب)، للأمام أو للخلف
  function shift(id, t, delta) {
    const r = get(id);
    if (!r.length || !delta) return t + delta;
    let pos = t;
    let left = Math.abs(delta);
    if (delta > 0) {
      let i = 0;
      while (i < r.length && r[i][1] <= pos) i++;
      if (i < r.length && pos >= r[i][0]) { pos = r[i][1]; i++; }      // داخل سكتة: يبدأ العدّ من نهايتها
      for (; i < r.length; i++) {
        const speech = r[i][0] - pos;
        if (speech >= left) return pos + left;
        left -= speech;
        pos = r[i][1];
      }
      return pos + left;
    }
    let i = r.length - 1;
    while (i >= 0 && r[i][0] >= pos) i--;
    if (i >= 0 && pos < r[i][1]) { pos = r[i][0]; i--; }               // داخل سكتة: يبدأ العدّ من بدايتها
    for (; i >= 0; i--) {
      const speech = pos - r[i][1];
      if (speech >= left) return pos - left;
      left -= speech;
      pos = r[i][0];
    }
    return Math.max(0, pos - left);
  }

  // مجموع ما يُقفز بالثواني
  const total = (id) => get(id).reduce((s, x) => s + (x[1] - x[0]), 0);
  const list = () => Object.keys(at);
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  const stamp = (id) => at[id] || null;
  return { available, ready, load, endAt, shift, total, list, stamp, subscribe };
})();
