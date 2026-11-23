// =====================
// تزكية: مختارات من مواد يوتيوب وساوند كلاود يقترحها المشتركون، وتظهر بعد موافقة المالك
//   /tz/{معرّف}        المواد المعتمدة (يقرؤها الجميع، ويكتبها المالك)
//   /tzq/{معرّف}       الاقتراحات قبل المراجعة (يكتبها المشترك، ويقرؤها المالك)
//   /tzh/{معرّف}/{uid} الإعجابات
// المادة: s المصدر (yt أو sc)، u الرابط، v معرّف يوتيوب، t العنوان، th صورة ساوند كلاود،
//         n رقم صاحب الاختيار أو a معرّف المشرف، ts وقت النشر، at وقت الاقتراح
// =====================
const TZ_TITLE_MAX = 140;

const tazkiya = (() => {
  // ---------- الروابط ----------
  const YT_ID = /^[A-Za-z0-9_-]{11}$/;
  function parse(raw) {
    let url;
    try { url = new URL(String(raw || '').trim()); } catch (e) { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    let v = null;
    if (host === 'youtu.be') v = url.pathname.slice(1).split('/')[0];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (url.pathname === '/watch') v = url.searchParams.get('v');
      else {
        const m = /^\/(?:shorts|live|embed|v)\/([^/?#]+)/.exec(url.pathname);
        if (m) v = m[1];
      }
    }
    if (v) return YT_ID.test(v) ? { s: 'yt', v, u: 'https://www.youtube.com/watch?v=' + v } : null;
    if (host === 'soundcloud.com' || host === 'on.soundcloud.com') {
      const parts = url.pathname.split('/').filter(Boolean);
      // مقطع واحد فقط (حساب/مقطع)، لا قوائم ولا صفحات حسابات
      if (host === 'soundcloud.com' && (parts.length !== 2 || parts[1] === 'sets' || parts[0] === 'discover')) return null;
      if (host === 'on.soundcloud.com' && parts.length !== 1) return null;
      return { s: 'sc', u: 'https://' + host + '/' + parts.join('/') };
    }
    return null;
  }

  // العنوان والصورة من الموقع نفسه (oEmbed). إن تعذّر يكتب المستخدم العنوان بنفسه
  async function meta(p) {
    const tries = p.s === 'yt'
      ? ['https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent(p.u),
         'https://noembed.com/embed?url=' + encodeURIComponent(p.u)]
      : ['https://soundcloud.com/oembed?format=json&url=' + encodeURIComponent(p.u)];
    for (const src of tries) {
      try {
        const res = await withTimeout(fetch(src), 8000);
        if (!res.ok) continue;
        const j = await res.json();
        if (!j || j.error || !j.title) continue;
        const out = { t: String(j.title).slice(0, TZ_TITLE_MAX) };
        if (p.s === 'sc' && typeof j.thumbnail_url === 'string' && j.thumbnail_url.startsWith('https://')) out.th = j.thumbnail_url.slice(0, 400);
        return out;
      } catch (e) {}
    }
    return null;
  }

  // ---------- القراءة ----------
  let items = null;        // null: لم تصل بعد
  let hearts = {};
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  let started = false;
  function start() {
    if (started) return;
    started = true;
    database.ref('/tz').on('value', snap => {
      const v = snap.val() || {};
      items = Object.entries(v).filter(([, it]) => it && it.u && it.t).map(([id, it]) => Object.assign({ id }, it));
      notify();
    }, () => { items = items || []; notify(); });
    database.ref('/tzh').on('value', snap => { hearts = snap.val() || {}; notify(); }, () => {});
  }

  // ---------- الكتابة ----------
  const fieldsOf = (it) => {
    const o = { s: it.s, u: it.u, t: String(it.t || '').trim().slice(0, TZ_TITLE_MAX) };
    if (it.s === 'yt') o.v = it.v;
    if (it.s === 'sc' && it.th) o.th = it.th;
    return o;
  };

  // اقتراح من مشترك له رقم، ومعه وقت الكتابة لمنع التكرار السريع
  async function suggest(it) {
    if (!(await account.ready())) return { error: 'needAccount' };
    const n = account.nick;
    if (!Number.isInteger(n)) return { error: 'tzNeedNumber' };
    const db = account.db;
    const key = db.ref('/tzq').push().key;
    const TS = firebase.database.ServerValue.TIMESTAMP;
    try {
      await withTimeout(db.ref().update({
        ['tzq/' + key]: Object.assign(fieldsOf(it), { n, ts: TS }),
        ['rate/' + account.uid]: TS,
      }));
      return { ok: true };
    } catch (e) {
      errLog.add('tz suggest: ' + (e && (e.code || e.message)));
      return { error: 'tzTooFast' };
    }
  }

  async function setHeart(id, on) {
    if (!(await account.ready())) return false;
    const ref = account.db.ref('/tzh/' + id + '/' + account.uid);
    try { await withTimeout(on ? ref.set(true) : ref.remove()); return true; }
    catch (e) { errLog.add('tz heart: ' + (e && (e.code || e.message))); return false; }
  }

  // ---------- المالك ----------
  function watchQueue(cb) {
    const ref = database.ref('/tzq');
    const h = ref.on('value', snap => {
      const v = snap.val() || {};
      cb(Object.entries(v).map(([id, it]) => Object.assign({ id }, it)).sort((a, b) => (a.ts || 0) - (b.ts || 0)));
    }, () => cb([]));
    return () => ref.off('value', h);
  }
  // الموافقة: تُنشر المادة (بالرابط والعنوان بعد أي تعديل) وتُحذف من الاقتراحات في عملية واحدة
  async function approve(q, edited) {
    const it = Object.assign(fieldsOf(edited), { n: q.n, ts: firebase.database.ServerValue.TIMESTAMP, at: q.ts || 0 });
    try { await withTimeout(database.ref().update({ ['tz/' + q.id]: it, ['tzq/' + q.id]: null })); return true; }
    catch (e) { errLog.add('tz approve: ' + (e && (e.code || e.message))); return false; }
  }
  const reject = (id) => database.ref('/tzq/' + id).remove().then(() => true, () => false);
  async function remove(id) {
    try { await withTimeout(database.ref().update({ ['tz/' + id]: null, ['tzh/' + id]: null })); return true; }
    catch (e) { return false; }
  }
  // إضافة مباشرة من المالك باسمه الخاص
  async function add(it) {
    const key = database.ref('/tz').push().key;
    const TS = firebase.database.ServerValue.TIMESTAMP;
    try { await withTimeout(database.ref('/tz/' + key).set(Object.assign(fieldsOf(it), { a: staff.uid, ts: TS, at: TS }))); return true; }
    catch (e) { errLog.add('tz add: ' + (e && (e.code || e.message))); return false; }
  }

  return {
    parse, meta, suggest, setHeart, watchQueue, approve, reject, remove, add,
    get items() { start(); return items; },
    heartCount: (id) => Object.keys(hearts[id] || {}).length,
    myHeart: (id) => !!(account.uid && hearts[id] && hearts[id][account.uid]),
    subscribe(fn) { start(); listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
