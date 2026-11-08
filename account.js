// =====================
// رمز الدخول
// الرمز هو كلمة المرور في Firebase Auth، والبريد مشتق منه سرًا، فلا يعرف أحد الرموز أو قائمة بها
// بيانات كل حساب في /users/{uid} لا يقرؤها ولا يكتبها غير صاحبها
// =====================
const ACCOUNT_KEY = 'afaf_account_v1';
const NAME_SHOWN_KEY = 'afaf_code_shown_day';   // الرمز مخفي افتراضيًا لأنه كلمة مرور
const NAME_MIN = 8;
const PUSH_EVERY_MS = 30000;
const NICK_MIN = 1000;   // الأرقام الجديدة من 4 خانات (الأرقام القديمة الأصغر تبقى كما هي)
const NICK_MAX = 9999;
const TITLE_MAX = 15;

// توحيد الكتابة: إزالة المسافات، وتحويل الأرقام العربية، وعدم التفريق بين الحروف الكبيرة والصغيرة
function normalizeName(raw) {
  return String(raw || '')
    .normalize('NFKC')
    .replace(/[٠-٩]/g, d => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, d => String(d.charCodeAt(0) - 0x06F0))
    .replace(/\s+/g, '')
    .toLowerCase();
}

// يعيد مفتاح رسالة الخطأ، أو null إذا كان الاسم صالحًا
function validateName(name) {
  if (/[^a-z0-9]/.test(name)) return 'nameLatinOnly';
  if (name.length < NAME_MIN) return 'nameTooShort';
  if (!/\p{L}/u.test(name) || !/\p{N}/u.test(name)) return 'nameNeedsMix';
  if (name.length > 40) return 'nameTooLong';
  return null;
}

// قوة رمز الدخول: إرشادية فقط ولا تمنع الحفظ
// ضعيف: قصير، أو كلمة يليها رقم قصير، أو أرقام متتالية أو مكررة، أو سنة في آخره
function codeStrength(raw) {
  const s = normalizeName(raw);
  if (!s) return null;
  const weak = s.length < 10 || /^\p{L}+\d{1,4}$/u.test(s) || /^\d+\p{L}+$/u.test(s) || /(.)\1{3,}/.test(s)
    || /(0123|1234|2345|3456|4567|5678|6789|9876|8765|4321)/.test(s) || /(19|20)\d\d$/.test(s);
  if (weak) return 'weak';
  const mixed = /\p{L}.*\d.*\p{L}|\d.*\p{L}.*\d/u.test(s);
  return s.length >= 12 && mixed ? 'strong' : 'medium';
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// =====================
// الدخول الحقيقي عبر Firebase Auth
// رمز الدخول هو كلمة المرور، والبريد مشتق منه بطريقة سرية لا يعرفها غير صاحبه
// تطبيق Firebase منفصل للحسابات، حتى لا يتعارض مع دخول المشرفين بحساب Google
// =====================
const acctApp = firebase.initializeApp(firebaseConfig, 'acct');
const acctAuth = acctApp.auth();
const acctDb = acctApp.database();
// اتصال الحساب يُفتح عند الحاجة فقط ثم يُغلق بعد فترة سكون، حتى لا يستهلك كل مستخدم اتصالين دائمين
// (الخطة المجانية في Firebase تسمح بعدد محدود من الاتصالات المتزامنة)
acctDb.goOffline();
let acctIdleTimer = null;
function acctDbNow() {
  acctDb.goOnline();
  clearTimeout(acctIdleTimer);
  acctIdleTimer = setTimeout(() => acctDb.goOffline(), 20000);
  return acctDb;
}
const AUTH_EMAIL_DOMAIN = '@u.walyasta3fef.app';
const authEmail = async (name) => (await sha256Hex('afaf-auth|' + name)).slice(0, 40) + AUTH_EMAIL_DOMAIN;

// أخطاء «لا يوجد حساب بهذا الرمز» تختلف حسب إعدادات المشروع
function isNoUser(e) {
  const c = (e && e.code) || '', m = (e && e.message) || '';
  return c === 'auth/user-not-found' || c === 'auth/invalid-credential' || c === 'auth/invalid-login-credentials'
    || m.includes('INVALID_LOGIN_CREDENTIALS') || m.includes('EMAIL_NOT_FOUND');
}
const authError = (e) => ((e && e.code) === 'auth/too-many-requests' ? 'tooManyTries'
  : (e && e.code) === 'auth/network-request-failed' ? 'needOnline' : 'syncFailed');

// =====================
// أسماء التعليقات: /titles/{رقم} = الاسم المختار بدل «أخ»
// تُعرض كل التعليقات بالاسم الحالي لصاحب الرقم، فتغييره يغيّر القديم والجديد معًا
// لا يكتب اسم رقمٍ إلا صاحبه (القواعد تتحقق من /owners)
// =====================
const titles = (() => {
  let map = {};
  let version = 0;
  const listeners = new Set();
  try { map = JSON.parse(localStorage.getItem('titlesCache') || '{}') || {}; } catch (e) {}
  database.ref('/titles').on('value', snap => {
    map = snap.val() || {};
    version++;
    try { localStorage.setItem('titlesCache', JSON.stringify(map)); } catch (e) {}
    listeners.forEach(fn => fn());
  }, () => {});
  return {
    get: (n) => (n != null && typeof map[n] === 'string' ? map[n] : null),
    get version() { return version; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

const account = (() => {
  let acc = storage.getJSON(ACCOUNT_KEY);   // { name, uid, nick }
  let syncStatus = acc ? 'idle' : 'none';   // none | idle | syncing | synced | error
  let lastSync = 0;
  let pushedRev = -1;
  let pushedNotesRev = -1;
  let remoteNotes = null;   // آخر ملاحظات مشفّرة في الحساب، حتى لا يمسحها جهاز لم يكتب ملاحظات
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  const setStatus = (s) => { syncStatus = s; notify(); };

  // بيانات الحساب في /users/{uid}: لا يقرؤها ولا يكتبها إلا صاحبها
  const userRef = (uid) => acctDbNow().ref('/users/' + uid);
  // k: رقم الاسم المعروض في التعليقات (أخ 4821)، ثابت للحساب على كل الأجهزة
  const payload = () => {
    const p = { d: progress.exportState(), u: firebase.database.ServerValue.TIMESTAMP };
    if (acc && acc.nick) p.k = acc.nick;
    return p;
  };

  // الاتصال بالحساب: دخول أو إنشاء
  async function connect(name, mode) {
    const email = await authEmail(name);
    const cur = acctAuth.currentUser;
    if (cur && cur.email === email) return { uid: cur.uid };
    if (cur) await acctAuth.signOut();
    if (mode === 'create') {
      const c = await acctAuth.createUserWithEmailAndPassword(email, name);
      return { uid: c.user.uid };
    }
    try {
      const c = await acctAuth.signInWithEmailAndPassword(email, name);
      return { uid: c.user.uid };
    } catch (e) {
      if (isNoUser(e)) return { notFound: true };
      throw e;
    }
  }

  // اللقب الذي يسبق الرقم في التعليقات (افتراضيًا «أخ»): حروف ومسافات فقط، دون أرقام حتى لا يلتبس بالرقم الحقيقي
  function checkTitle(raw) {
    const v = String(raw || '').replace(/\s+/g, ' ').trim();
    if (!v) return { error: 'titleEmpty' };
    if (v.length > TITLE_MAX) return { error: 'titleTooLong' };
    if (!/^[\u0621-\u064Aa-zA-Z ]+$/.test(v)) return { error: 'titleChars' };
    return { ok: true, value: v };
  }
  // حفظ الاسم في جدول الأسماء، ولا يُعد ناجحًا إلا بعد تأكيد Firebase
  async function setTitle(raw) {
    if (!acc || !acc.nick) return { error: 'commentNeedName' };
    const r = checkTitle(raw);
    if (r.error) return r;
    if (!navigator.onLine) return { error: 'needOnline' };
    try {
      if (!(await ready())) return { error: 'saveFailed' };
      const ref = acctDbNow().ref('/titles/' + acc.nick);
      await withTimeout(r.value === t('nickPrefix') ? ref.remove() : ref.set(r.value));
      notify();
      return { ok: true };
    } catch (e) {
      errLog.add('title save: ' + (e && (e.code || e.message)));
      return { error: 'saveFailed' };
    }
  }

  // ملكية الأرقام في /owners/{رقم} = uid، لا يقرؤها غير صاحبها، والقواعد تتحقق منها عند كل تعليق
  const ownerRef = (n) => acctDbNow().ref('/owners/' + n);
  async function ownsNick(n) {
    try { return (await withTimeout(ownerRef(n).once('value'))).val() === acc.uid; } catch (e) { return false; }
  }
  async function takeNick(n) {
    try { await withTimeout(ownerRef(n).set(acc.uid)); return true; } catch (e) { return ownsNick(n); }
  }
  // حجز رقم عشوائي غير مستخدم
  async function claimNick() {
    for (let i = 0; i < 25; i++) {
      const n = NICK_MIN + Math.floor(Math.random() * (NICK_MAX - NICK_MIN + 1));
      if (await takeNick(n)) return n;
    }
    return null;
  }

  // التأكد من وجود رقم للحساب: رقمه المحفوظ أو رقمه القديم، وإلا حجز رقم جديد
  // التأكد من رقم الحساب: رقمه المحفوظ، وإلا حجز رقم جديد
  // nv: تأكدنا مرة أن الرقم مسجّل باسم هذا الحساب في /owners
  async function ensureNick(remote) {
    if (!acc || !acc.uid || (acc.nick && acc.nv)) return;
    let n = acc.nick || (remote && Number.isInteger(remote.k) ? remote.k : null);
    if (n && !(await takeNick(n))) n = null;
    if (!n) n = await claimNick();
    if (!n || !acc) return;
    acc.nick = n;
    acc.nv = true;
    storage.setJSON(ACCOUNT_KEY, acc);
    pushedRev = -1;
    notify();
  }

  // التأكد أن اتصال الحساب جاهز (مسجّل الدخول) قبل أي حفظ، وإلا يُسجَّل الدخول أولًا
  async function ready() {
    if (!acc) return false;
    const cur = acctAuth.currentUser;
    if (cur && cur.uid === acc.uid) return true;
    try {
      const r = await withTimeout(connect(acc.name, 'login'));
      if (!r || !r.uid) return false;
      acc.uid = r.uid;
      storage.setJSON(ACCOUNT_KEY, acc);
      return true;
    } catch (e) { errLog.add('auth: ' + (e && (e.code || e.message))); return false; }
  }

  async function push() {
    if (!acc || !navigator.onLine) return;
    if (!(await ready())) { setStatus('error'); return; }
    const rev = progress.rev, nrev = notes.rev;
    if (rev === pushedRev && nrev === pushedNotesRev) return;
    try {
      setStatus('syncing');
      const p = payload();
      const e = (await notes.encrypt(acc.name)) || remoteNotes;
      if (e) { p.e = e; remoteNotes = e; }
      await withTimeout(userRef(acc.uid).set(p));
      pushedRev = rev;
      pushedNotesRev = nrev;
      lastSync = Date.now();
      setStatus('synced');
    } catch (e) { setStatus('error'); }
  }

  // جلب التقدّم المحفوظ ودمجه مع هذا الجهاز ثم رفع النتيجة
  async function sync() {
    if (!acc) return;
    if (!navigator.onLine) { setStatus('error'); return; }
    try {
      setStatus('syncing');
      const r = await connect(acc.name, 'login');
      if (r.notFound) { setStatus('error'); return; }
      acc.uid = r.uid;
      storage.setJSON(ACCOUNT_KEY, acc);
      const v = (await userRef(acc.uid).once('value')).val();
      if (v && v.d) progress.merge(v.d);
      if (v && v.e) { remoteNotes = v.e; await notes.decryptMerge(acc.name, v.e); }
      await ensureNick(v);
      pushedRev = -1; pushedNotesRev = -1;
      await push();
    } catch (e) { setStatus('error'); }
  }

  function remember(name, uid) {
    acc = { name, uid };
    storage.setJSON(ACCOUNT_KEY, acc);
  }

  // إنشاء اسم جديد بشرط ألا يكون مستخدمًا
  async function create(raw) {
    const name = normalizeName(raw);
    const err = validateName(name);
    if (err) return { error: err };
    if (!navigator.onLine) return { error: 'needOnline' };
    try {
      let r;
      try { r = await connect(name, 'create'); }
      catch (e) { return { error: e && e.code === 'auth/email-already-in-use' ? 'nameTaken' : authError(e) }; }
      remember(name, r.uid);
      pushedRev = -1; pushedNotesRev = -1;
      await push();
      lastSync = Date.now();
      await ensureNick(null);
      await push();
      database.ref('/stats/subscribers').set(firebase.database.ServerValue.increment(1)).catch(() => {});
      logEvent('account_created');
      return { ok: true };
    } catch (e) { return { error: 'syncFailed' }; }
  }

  // الدخول باسم موجود من جهاز آخر
  async function login(raw) {
    const name = normalizeName(raw);
    if (!name) return { error: 'nameTooShort' };
    if (!navigator.onLine) return { error: 'needOnline' };
    try {
      let r;
      try { r = await connect(name, 'login'); } catch (e) { return { error: authError(e) }; }
      if (r.notFound) return { error: 'nameNotFound' };
      remember(name, r.uid);
      const v = (await userRef(acc.uid).once('value')).val();
      if (v && v.d) progress.merge(v.d);
      if (v && v.e) { remoteNotes = v.e; await notes.decryptMerge(name, v.e); }
      await ensureNick(v);
      pushedRev = -1; pushedNotesRev = -1;
      await push();
      logEvent('account_login');
      return { ok: true };
    } catch (e) { return { error: 'syncFailed' }; }
  }

  // الخروج من هذا الجهاز: يُرفع التقدّم أولًا ثم يُمسح من المتصفح
  async function logout() {
    progress.save();
    pushedRev = -1;
    await push();
    acc = null;
    storage.set(ACCOUNT_KEY, '');
    storage.set(NAME_SHOWN_KEY, '');
    progress.reset();
    notes.reset();
    remoteNotes = null;
    try { await acctAuth.signOut(); } catch (e) {}
    setStatus('none');
  }

  // إخفاء الاسم يستمر طوال اليوم فقط، ثم يظهر من جديد حتى لا يُنسى
  const isHidden = () => storage.get(NAME_SHOWN_KEY) !== dayKey();
  function setHidden(h) { storage.set(NAME_SHOWN_KEY, h ? '' : dayKey()); notify(); }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  // رفع تلقائي في الخلفية
  setInterval(push, PUSH_EVERY_MS);
  window.addEventListener('pagehide', () => { progress.save(); push(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { progress.save(); push(); }
    else sync();
  });
  window.addEventListener('online', () => sync());
  if (acc) sync();

  return {
    get name() { return acc && acc.name; },
    get nick() { return acc && acc.nick; },
    get title() { return (acc && titles.get(acc.nick)) || t('nickPrefix'); },
    get uid() { return (acc && acc.uid) || null; },
    // قاعدة البيانات المتصلة بحساب المستخدم (للكتابة باسمه)
    get db() { return acctDbNow(); },
    get loggedIn() { return !!acc; },
    get status() { return syncStatus; },
    get lastSync() { return lastSync; },
    create, login, logout, sync, isHidden, setHidden, subscribe, setTitle, ready,
  };
})();
