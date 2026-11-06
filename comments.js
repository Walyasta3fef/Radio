// =====================
// التعليقات على اللقاءات
// كل تعليق: t النص، s أول وقت مذكور فيه بالثواني (إن وجد)، n رقم الاسم المعروض، ts وقت الإرسال
// لا يمكن تعديل التعليق أو حذفه إلا من لوحة Firebase
// =====================
const COMMENT_MAX = 500;
const COMMENT_COOLDOWN_MS = 30000;
const COMMENT_LAST_KEY = 'afaf_last_comment';
const COMMENTS_LIMIT = 300;

// الأوقات داخل النص: 7:59 أو 07:59 أو 1:07:59
const TIME_RE = /(^|[^\d:])(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:])/g;

// تحويل الأرقام العربية إلى إنجليزية حتى تُفهم الأوقات المكتوبة بها
const toLatinDigits = (s) => String(s)
  .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0));

function parseTime(str) {
  const parts = toLatinDigits(str).split(':').map(Number);
  if (parts.some(isNaN)) return null;
  if (parts.length === 2) { const [m, s] = parts; return s < 60 ? m * 60 + s : null; }
  const [h, m, s] = parts;
  return m < 60 && s < 60 ? h * 3600 + m * 60 + s : null;
}

// تقسيم النص إلى أجزاء عادية وأوقات قابلة للضغط
function splitTimes(text, maxSec) {
  const src = toLatinDigits(text);
  const out = [];
  let last = 0, m;
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(src))) {
    const start = m.index + m[1].length;
    const sec = parseTime(m[2]);
    if (sec == null || (maxSec && sec > maxSec)) continue;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ time: sec, text: m[2] });
    last = start + m[2].length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out;
}

function firstTime(text, maxSec) {
  const p = splitTimes(text, maxSec).find(x => x.time != null);
  return p ? p.time : null;
}

const commentsApi = {
  ref: (lectureId) => database.ref('/comments/' + lectureId),

  // الاشتراك في تعليقات لقاء، ويعيد دالة لإلغاء الاشتراك
  subscribe(lectureId, cb) {
    const q = this.ref(lectureId).orderByChild('ts').limitToLast(COMMENTS_LIMIT);
    const handler = q.on('value', snap => {
      const list = [];
      snap.forEach(child => {
        const v = child.val();
        if (v && typeof v.t === 'string') list.push({ id: child.key, ...v });
      });
      cb(list);
    }, () => cb([]));
    return () => q.off('value', handler);
  },

  cooldownLeft() {
    const last = parseInt(storage.get(COMMENT_LAST_KEY) || '0', 10);
    return Math.max(0, COMMENT_COOLDOWN_MS - (Date.now() - last));
  },

  async add(lectureId, text) {
    text = String(text || '').trim();
    if (!account.loggedIn || !account.nick) return { error: 'commentNeedName' };
    if (!text) return { error: 'commentEmpty' };
    if (text.length > COMMENT_MAX) return { error: 'commentTooLong' };
    if (this.cooldownLeft() > 0) return { error: 'commentWait' };
    if (!navigator.onLine) return { error: 'needOnline' };
    const item = { t: text, n: account.nick, ts: firebase.database.ServerValue.TIMESTAMP };
    const s = firstTime(text, LECTURE_BY_ID[lectureId] && LECTURE_BY_ID[lectureId].normal);
    if (s != null) item.s = s;
    try {
      await this.ref(lectureId).push(item);
      storage.set(COMMENT_LAST_KEY, String(Date.now()));
      logEvent('comment_added');
      return { ok: true };
    } catch (e) { return { error: 'commentFailed' }; }
  },
};
