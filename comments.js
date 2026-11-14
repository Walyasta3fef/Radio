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

// ذكر لقاء داخل النص: «لقاء 5» أو «لقاء 5 12:30» أو «الكورس الأساسي 2 1:07:59»
// الوقت اختياري، ويُقارن بمدة النسخة العادية
const MENTION_RE = /(الكورس\s+ال[أا]ساسي\s+(?:لقا[ءئ]?\s+)?|(?:ال)?لقا[ءئ]?\s+)(\d{1,3})(?!\d)(?:\s+(?:عند\s+|الدقيقة\s+|دقيقة\s+)?(\d{1,2}:\d{2}(?::\d{2})?)(?![\d:]))?/g;

const mentionId = (prefix, num) =>
  (prefix.startsWith('الكورس') ? 'c' : 'L') + String(parseInt(num, 10)).padStart(2, '0');

// النص الذي يُكتب عند اختيار لقاء من القائمة، ويطابق نمط الذكر أعلاه
function mentionText(id, sec) {
  const n = parseInt(id.slice(1), 10);
  const label = id[0] === 'c' ? t('mentionLabelCourse', { n }) : t('mentionLabelLecture', { n });
  return sec != null ? label + ' ' + fmtClock(sec) : label;
}

// وقت تكتبه في خانة الوقت: يقبل النقطتين، أو ; . , - والمسافة بدلًا منهما،
// أو أرقامًا متصلة (آخر رقمين ثوانٍ، وقبلهما دقائق، وقبلهما ساعات): 1715 = 17:15
function parseLooseTime(str) {
  let s = toLatinDigits(String(str)).trim().replace(/[;.,،؛\-\s]+/g, ':');
  if (/^\d{3,6}$/.test(s)) s = s.length > 4
    ? s.slice(0, -4) + ':' + s.slice(-4, -2) + ':' + s.slice(-2)
    : s.slice(0, -2) + ':' + s.slice(-2);
  if (!/^\d{1,2}:\d{1,2}(:\d{1,2})?$/.test(s)) return null;
  return parseTime(s);
}

function fmtClock(s) {
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${String(m).padStart(2, '0')}:${sec}`;
}

// تقسيم النص إلى: نص عادي، وأوقات داخل اللقاء الحالي، وذكر لقاءات أخرى (lid)
function splitRich(text, maxSec) {
  const src = toLatinDigits(text);
  const out = [];
  let last = 0, m;
  MENTION_RE.lastIndex = 0;
  while ((m = MENTION_RE.exec(src))) {
    const lec = LECTURE_BY_ID[mentionId(m[1], m[2])];
    if (!lec) continue;
    let sec = m[3] ? parseTime(m[3]) : null;
    let end = m.index + m[0].length;
    // الوقت غير الصحيح يبقى نصًا عاديًا، ويبقى ذكر اللقاء
    if (m[3] && (sec == null || sec > lec.normal)) {
      sec = null;
      end = m.index + m[1].length + m[2].length;
      MENTION_RE.lastIndex = end;
    }
    if (m.index > last) out.push(...splitTimes(text.slice(last, m.index), maxSec));
    out.push({ lid: lec.id, time: sec, text: text.slice(m.index, end).trim() });
    last = end;
  }
  if (last < text.length) out.push(...splitTimes(text.slice(last), maxSec));
  return out.filter(p => p.text !== '');
}

// أول وقت داخل اللقاء نفسه (لترتيب التعليقات حسب الوقت)، دون أوقات اللقاءات المذكورة
function firstTime(text, maxSec) {
  const p = splitRich(text, maxSec).find(x => x.time != null && !x.lid);
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

  // parent: التعليق الأصلي عند الرد { id, n, a, pf }
  async add(lid, text, parent) {
    text = String(text || '').trim();
    if (!this.canWrite()) return { error: 'commentNeedName' };
    if (!text) return { error: 'commentEmpty' };
    if (text.length > COMMENT_MAX) return { error: 'commentTooLong' };
    if (!staff.isStaff && hasContact(text)) return { error: 'noContacts' };
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
      // المشترك يكتب باتصال حسابه حتى تتحقق القواعد من ملكية رقمه
      const db = staff.isStaff ? database : account.db;
      if (!staff.isStaff && !(await account.ready())) return { error: 'saveFailed' };
      const ref = db.ref('/comments/' + lid).push();
      if (staff.isStaff) await withTimeout(ref.set(item));
      else await withTimeout(db.ref().update({
        ['comments/' + lid + '/' + ref.key]: item,
        // ختم آخر تعليق: القواعد ترفض تعليقًا جديدًا قبل مرور 30 ثانية
        ['rate/' + account.uid]: firebase.database.ServerValue.TIMESTAMP,
      }));
      storage.set(COMMENT_LAST_KEY, String(Date.now()));
      if (LECTURE_BY_ID[lid]) {
        // نسخة مختصرة لقسم أحدث التعليقات بنفس وقت التعليق، وزيادة عدّاد اللقاء
        let ts = Date.now();
        try { const v = (await ref.child('ts').once('value')).val(); if (typeof v === 'number') ts = v; } catch (e) {}
        const recent = { l: lid, c: parent ? parent.id : ref.key, i: ref.key, t: text.slice(0, 200), ts };
        ['n', 'a', 'r', 'ra', 's'].forEach(k => { if (item[k] != null) recent[k] = item[k]; });
        db.ref('/recent').push(recent).catch(() => {});
        database.ref('/counts/' + lid).transaction(v => (v || 0) + 1).catch(() => {});
      }
      logEvent(parent ? 'reply_added' : 'comment_added');
      return { ok: true };
    } catch (e) { return { error: 'commentFailed' }; }
  },

  // نسخ التعليق في «أحدث التعليقات» (مفاتيحها)، للقاءات فقط
  async recentKeys(lid, ids) {
    if (!LECTURE_BY_ID[lid]) return [];
    const keys = [];
    await Promise.all(ids.map(async id => {
      const snap = await withTimeout(database.ref('/recent').orderByChild('i').equalTo(id).once('value'));
      snap.forEach(ch => { keys.push(ch.key); });
    }));
    return keys;
  },

  // اتصال الكتابة لتعليق يملكه المستخدم: المميز باتصال Google، والمشترك باتصال حسابه (لتتحقق القواعد من ملكية رقمه)
  async ownDb(c) {
    if (c.a) return database;
    return (await account.ready()) ? account.db : null;
  },

  // حذف المستخدم تعليقه خلال مهلة التعديل: يُحذف هو وكل الردود عليه ونسخها في «أحدث التعليقات» في عملية واحدة
  // (إما أن يُحذف الكل أو لا يُحذف شيء)، ثم يُصحَّح عدّاد اللقاء
  async removeOwn(lid, comment, replies) {
    if (!navigator.onLine) return { error: 'needOnline' };
    const ids = [comment.id, ...(replies || []).map(r => r.id)];
    try {
      const db = await this.ownDb(comment);
      if (!db) return { error: 'saveFailed' };
      const patch = {};
      ids.forEach(id => { patch['comments/' + lid + '/' + id] = null; });
      (await this.recentKeys(lid, ids)).forEach(k => { patch['recent/' + k] = null; });
      await withTimeout(db.ref().update(patch));
      if (LECTURE_BY_ID[lid]) database.ref('/counts/' + lid).transaction(v => Math.max(0, (v || 0) - ids.length)).catch(() => {});
      logEvent('comment_deleted_own');
      return { ok: true };
    } catch (e) {
      errLog.add('own delete: ' + (e && (e.code || e.message)));
      return { error: 'deleteFailed' };
    }
  },

  // تعديل المستخدم نص تعليقه خلال المهلة: يتغير النص (وعلامة الوقت المستخرجة منه) وتُضاف علامة «معدّل»
  async edit(lid, c, text) {
    text = String(text || '').trim();
    if (!text) return { error: 'commentEmpty' };
    if (text.length > COMMENT_MAX) return { error: 'commentTooLong' };
    if (!c.a && hasContact(text)) return { error: 'noContacts' };
    if (!navigator.onLine) return { error: 'needOnline' };
    if (text === c.t) return { ok: true };
    try {
      const db = await this.ownDb(c);
      if (!db) return { error: 'saveFailed' };
      const s = firstTime(text, maxSecOf(lid));
      const base = 'comments/' + lid + '/' + c.id + '/';
      const patch = { [base + 't']: text, [base + 'ed']: true, [base + 's']: s != null ? s : null };
      (await this.recentKeys(lid, [c.id])).forEach(k => {
        patch['recent/' + k + '/t'] = text.slice(0, 200);
        patch['recent/' + k + '/s'] = s != null ? s : null;
      });
      await withTimeout(db.ref().update(patch));
      logEvent('comment_edited');
      return { ok: true };
    } catch (e) {
      errLog.add('edit: ' + (e && (e.code || e.message)));
      return { error: 'editFailed' };
    }
  },

  // حذف تعليق وردوده (للمشرف فقط)، مع نسخه في «أحدث التعليقات» وتصحيح العدّاد
  async remove(lid, comment, replies) {
    const ids = [comment.id, ...(replies || []).map(r => r.id)];
    try {
      await Promise.all(ids.map(id => this.ref(lid).child(id).remove()));
      // المجتمع: حذف قلوب المنشور وبلاغاته معه
      if (lid === GENERAL_ID) ids.forEach(id => { reactions.clear(id); });
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
// مهلة تعديل التعليق وحذفه لصاحبه (القواعد تفرضها بوقت الخادم). يُخفى الخيار قبل نهايتها بدقيقة تفاديًا لطلب مرفوض
const OWN_EDIT_MS = 3 * 3600 * 1000;
const canModifyOwn = (c) => !!isMine(c) && typeof c.ts === 'number' && serverNow() - c.ts < OWN_EDIT_MS - 60000;
// هل التعليق جديد على المستخدم: بعد آخر قراءة ومن شخص آخر
const isNewComment = (c, lid) => (c.ts || 0) > progress.seenAt(lid) && !isMine(c);
const isReplyToMe = (c, lid) => ((!!account.nick && c.r === account.nick) || (!!staff.uid && c.ra === staff.uid)) && isNewComment(c, lid);
const maxTs = (list) => list.reduce((m, c) => Math.max(m, c.ts || 0), 0);

// تعليق مطلوب إبرازه عند فتح لقاء من «أحدث التعليقات»
let pendingFocus = null;

// =====================
// منع أرقام الهواتف والروابط وحسابات التواصل في الكتابة
// حماية للإخوة من التواصل الخاص والاستغلال
// =====================
const CONTACT_LINK_RE = /(https?:\/\/|www\.|t\.me|wa\.me|\b[a-z0-9-]+\.(com|net|org|me|io|co|app|link|ly|gg|tv|info|xyz|site|online)\b)/i;
const CONTACT_HANDLE_RE = /@[a-z0-9_.]{3,}/i;
const CONTACT_PHONE_RE = /(?:\+?\d[\s\-.()]*){8,}/;
function hasContact(text) {
  const s = toLatinDigits(String(text || ''));
  return CONTACT_LINK_RE.test(s) || CONTACT_HANDLE_RE.test(s) || CONTACT_PHONE_RE.test(s);
}

// =====================
// تفاعلات المجتمع: القلوب والبلاغات
// كل مستخدم له مفتاح سري لكل منشور مشتق من رمز دخوله، فيظهر العدد فقط دون معرفة صاحبه
// =====================
const reactions = (() => {
  const watch = (path, cb) => {
    const ref = database.ref(path);
    const h = ref.on('value', snap => cb(snap.val() || {}), () => cb({}));
    return () => ref.off('value', h);
  };
  const mine = () => account.uid;
  return {
    mine,
    count: (node) => Object.keys(node || {}).length,
    watchHearts: (cb) => watch('/hearts', cb),
    watchReports: (cb) => watch('/reports', cb),
    async setHeart(cid, on) {
      if (!(await account.ready())) return false;
      const ref = account.db.ref('/hearts/' + cid + '/' + mine());
      try { await withTimeout(on ? ref.set(true) : ref.remove()); return true; }
      catch (e) { errLog.add('heart: ' + (e && (e.code || e.message))); return false; }
    },
    // البلاغ لا يحذف ولا يخفي شيئًا: يظهر للمشرفين فقط والقرار لهم
    // قيمته true لمنشور المجتمع، ومعرّف اللقاء لتعليق داخل لقاء (ليُعرف مكانه في قائمة البلاغات)
    async report(cid, lid) {
      if (!(await account.ready())) return false;
      const value = !lid || lid === GENERAL_ID ? true : lid;
      try { await withTimeout(account.db.ref('/reports/' + cid + '/' + mine()).set(value)); return true; }
      catch (e) { errLog.add('report: ' + (e && (e.code || e.message))); return false; }
    },
    // للمشرف: إلغاء البلاغات وإظهار المنشور
    clearReports(cid) { return database.ref('/reports/' + cid).remove().catch(() => {}); },
    clear(cid) {
      database.ref('/hearts/' + cid).remove().catch(() => {});
      database.ref('/reports/' + cid).remove().catch(() => {});
    },
  };
})();
