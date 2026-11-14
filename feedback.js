// =====================
// الإبلاغ عن مشكلة
// يسجّل الموقع آخر 5 أخطاء على الجهاز نفسه، وتُرفق بالبلاغ إن وافق المستخدم
// البلاغات تُحفظ في Firebase ولا يقرؤها إلا المالك
// =====================
const APP_VERSION = '45';
const ERR_LOG_KEY = 'errLog';
const FEEDBACK_LAST_KEY = 'feedbackLast';
const FEEDBACK_GAP_MS = 60000;
const FEEDBACK_MAX = 1000;
const FEEDBACK_TYPES = ['audio', 'progress', 'comments', 'account', 'other'];

const errLog = (() => {
  const read = () => storage.getJSON(ERR_LOG_KEY) || [];
  function add(msg) {
    const m = String(msg || '').slice(0, 200);
    if (!m) return;
    const list = read();
    list.push({ t: Date.now(), m });
    storage.setJSON(ERR_LOG_KEY, list.slice(-5));
  }
  window.addEventListener('error', e => {
    const where = e.filename ? ' @' + String(e.filename).split('/').pop().split('?')[0] + ':' + e.lineno : '';
    add((e.message || 'error') + where);
  });
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    add('promise: ' + (r && (r.message || r.code || r)));
  });
  return { add, read };
})();

// سياق تقني بسيط تملؤه الواجهة: الصفحة وحالة المشغّل فقط، دون رمز الدخول أو اللقاء المسموع
let feedbackContext = {};

const feedbackApi = {
  waitLeft() {
    const last = parseInt(storage.get(FEEDBACK_LAST_KEY) || '0', 10);
    return Math.max(0, FEEDBACK_GAP_MS - (Date.now() - last));
  },
  async send({ type, text, tech }) {
    if (!FEEDBACK_TYPES.includes(type)) return { error: 'feedbackPickType' };
    if (!navigator.onLine) return { error: 'needOnline' };
    if (this.waitLeft() > 0) return { error: 'feedbackWait' };
    const item = { ty: type, ts: firebase.database.ServerValue.TIMESTAMP, v: APP_VERSION };
    const body = String(text || '').trim();
    if (body) item.t = body.slice(0, FEEDBACK_MAX);
    if (tech) {
      let standalone = false;
      try { standalone = matchMedia('(display-mode: standalone)').matches || !!navigator.standalone; } catch (e) {}
      item.i = JSON.stringify({
        ua: navigator.userAgent.slice(0, 200), pwa: standalone, w: window.innerWidth,
        ...feedbackContext, er: errLog.read(),
      }).slice(0, 3000);
    }
    try {
      // ختم آخر بلاغ: لكل حساب على حدة، وللزوار دون حساب ختم عام واحد
      const mine = account.loggedIn && (await account.ready());
      const db = mine ? account.db : database;
      const key = db.ref('/feedback').push().key;
      await withTimeout(db.ref().update({
        ['feedback/' + key]: item,
        ['frate/' + (mine ? account.uid : 'anon')]: firebase.database.ServerValue.TIMESTAMP,
      }));
      storage.set(FEEDBACK_LAST_KEY, String(Date.now()));
      return { ok: true };
    } catch (e) { errLog.add('feedback: ' + (e && (e.code || e.message))); return { error: 'feedbackFailed' }; }
  },
  // للمالك فقط
  watch(cb) {
    const ref = database.ref('/feedback').orderByChild('ts').limitToLast(100);
    const h = ref.on('value', snap => {
      const out = [];
      snap.forEach(ch => { out.push({ id: ch.key, ...ch.val() }); });
      cb(out.reverse());
    }, () => cb([]));
    return () => ref.off('value', h);
  },
  resolve(id) { return database.ref('/feedback/' + id).remove().catch(() => {}); },
};
