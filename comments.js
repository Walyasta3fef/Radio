// =====================
// التعليقات
// المكان (lid): رمز لقاء مثل L05، أو general للتعليقات العامة على الموقع
// كل تعليق: t النص، s أول وقت مذكور فيه بالثواني، n رقم الاسم المعروض، ts وقت الإرسال
// والرد يحمل أيضًا: p رقم التعليق الأصلي، و r رقم صاحب التعليق المردود عليه
// المستويات اثنان فقط: تعليق، ورد عليه
// لا يمكن تعديل التعليق أو حذفه إلا من لوحة Firebase
// =====================
const COMMENT_MAX = 500;
const COMMENT_COOLDOWN_MS = 30000;
const COMMENT_LAST_KEY = 'afaf_last_comment';
const COMMENTS_LIMIT = 300;
const GENERAL_ID = 'general';

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

// تقسيم النص إلى أجزاء عادية وأوقات قابلة للضغط (maxSec = 0 يعني بلا أوقات)
function splitTimes(text, maxSec) {
  if (!maxSec) return [{ text }];
  const src = toLatinDigits(text);
  const out = [];
  let last = 0, m;
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(src))) {
    const start = m.index + m[1].length;
    const sec = parseTime(m[2]);
    if (sec == null || sec > maxSec) continue;
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

const maxSecOf = (lid) => (LECTURE_BY_ID[lid] ? LECTURE_BY_ID[lid].normal : 0);

const commentsApi = {
  ref: (lid) => database.ref('/comments/' + lid),

  // الاشتراك في تعليقات مكان، ويعيد دالة لإلغاء الاشتراك
  subscribe(lid, cb) {
    const q = this.ref(lid).orderByChild('ts').limitToLast(COMMENTS_LIMIT);
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

  // أحدث التعليقات من كل اللقاءات
  subscribeRecent(limit, cb) {
    const q = database.ref('/recent').orderByChild('ts').limitToLast(limit);
    const handler = q.on('value', snap => {
      const list = [];
      snap.forEach(child => { const v = child.val(); if (v && v.l && LECTURE_BY_ID[v.l] && typeof v.t === 'string') list.push({ id: child.key, ...v }); });
      cb(list.reverse());
    }, () => cb([]));
    return () => q.off('value', handler);
  },

  // عدد التعليقات لكل لقاء
  subscribeCounts(cb) {
    const ref = database.ref('/counts');
    const handler = ref.on('value', snap => cb(snap.val() || {}), () => cb({}));
    return () => ref.off('value', handler);
  },

  cooldownLeft() {
    const last = parseInt(storage.get(COMMENT_LAST_KEY) || '0', 10);
    return Math.max(0, COMMENT_COOLDOWN_MS - (Date.now() - last));
  },

  // هل يستطيع المستخدم الكتابة: باسم خاص، أو كمميز داخل بحساب Google
  canWrite: () => staff.isStaff || (account.loggedIn && !!account.nick),

  // parent: التعليق الأصلي عند الرد { id, n, a }
  async add(lid, text, parent) {
    text = String(text || '').trim();
    if (!this.canWrite()) return { error: 'commentNeedName' };
    if (!text) return { error: 'commentEmpty' };
    if (text.length > COMMENT_MAX) return { error: 'commentTooLong' };
    if (!staff.isStaff && this.cooldownLeft() > 0) return { error: 'commentWait' };
    if (!navigator.onLine) return { error: 'needOnline' };
    const TS = firebase.database.ServerValue.TIMESTAMP;
    const item = { t: text, ts: TS };
    if (staff.isStaff) item.a = staff.uid;
    else item.n = account.nick;
    const s = firstTime(text, maxSecOf(lid));
    if (s != null) item.s = s;
    if (parent) {
      item.p = parent.id;
      if (parent.n) item.r = parent.n;
      if (parent.a) item.ra = parent.a;
    }
    try {
      const ref = this.ref(lid).push();
      await ref.set(item);
      storage.set(COMMENT_LAST_KEY, String(Date.now()));
      if (LECTURE_BY_ID[lid]) {
        // نسخة مختصرة لقسم أحدث التعليقات بنفس وقت التعليق، وزيادة عدّاد اللقاء
        let ts = Date.now();
        try { const v = (await ref.child('ts').once('value')).val(); if (typeof v === 'number') ts = v; } catch (e) {}
        const recent = { l: lid, c: parent ? parent.id : ref.key, i: ref.key, t: text.slice(0, 200), ts };
        ['n', 'a', 'r', 'ra', 's'].forEach(k => { if (item[k] != null) recent[k] = item[k]; });
        database.ref('/recent').push(recent).catch(() => {});
        database.ref('/counts/' + lid).transaction(v => (v || 0) + 1).catch(() => {});
      }
      logEvent(parent ? 'reply_added' : 'comment_added');
      return { ok: true };
    } catch (e) { return { error: 'commentFailed' }; }
  },

  // حذف تعليق وردوده (للمشرف فقط)، مع نسخه في «أحدث التعليقات» وتصحيح العدّاد
  async remove(lid, comment, replies) {
    const ids = [comment.id, ...(replies || []).map(r => r.id)];
    try {
      await Promise.all(ids.map(id => this.ref(lid).child(id).remove()));
      if (LECTURE_BY_ID[lid]) {
        await Promise.all(ids.map(async id => {
          const snap = await database.ref('/recent').orderByChild('i').equalTo(id).once('value');
          const tasks = [];
          snap.forEach(ch => { tasks.push(database.ref('/recent/' + ch.key).remove()); });
          await Promise.all(tasks);
        }));
        database.ref('/counts/' + lid).transaction(v => Math.max(0, (v || 0) - ids.length)).catch(() => {});
      }
      return { ok: true };
    } catch (e) { return { error: 'commentFailed' }; }
  },
};

// صاحب التعليق: هل هو المستخدم الحالي
const isMine = (c) => (c.n && c.n === account.nick) || (c.a && c.a === staff.uid);
// هل التعليق جديد على المستخدم: بعد آخر قراءة ومن شخص آخر
const isNewComment = (c, lid) => (c.ts || 0) > progress.seenAt(lid) && !isMine(c);
const isReplyToMe = (c, lid) => ((!!account.nick && c.r === account.nick) || (!!staff.uid && c.ra === staff.uid)) && isNewComment(c, lid);
const maxTs = (list) => list.reduce((m, c) => Math.max(m, c.ts || 0), 0);

// تعليق مطلوب إبرازه عند فتح لقاء من «أحدث التعليقات»
let pendingFocus = null;
