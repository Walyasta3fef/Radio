// =====================
// الاسم الخاص بالمستخدم
// الاسم هو مفتاح التقدّم المحفوظ، فلا إيميل ولا كلمة مرور
// لا يُخزَّن الاسم نفسه على الخادم، بل بصمة مشفّرة منه (SHA-256)
// فلا يمكن لأحد معرفة الأسماء أو عرض قائمة بها
// =====================
const ACCOUNT_KEY = 'afaf_account_v1';
const NAME_HIDDEN_KEY = 'afaf_name_hidden_day';
const NAME_SALT = 'afaf-radio-v1|';
const NAME_MIN = 8;
const PUSH_EVERY_MS = 30000;
const NICK_MAX = 10000;

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
  if (name.length < NAME_MIN) return 'nameTooShort';
  if (!/\p{L}/u.test(name) || !/\p{N}/u.test(name)) return 'nameNeedsMix';
  if (name.length > 40) return 'nameTooLong';
  return null;
}

const SUGGEST_WORDS = ['noor', 'najm', 'qamar', 'fajr', 'sabr', 'amal', 'salam', 'yaqeen', 'sanad', 'hilm', 'rawda', 'nakheel'];
function suggestName() {
  const w = SUGGEST_WORDS[Math.floor(Math.random() * SUGGEST_WORDS.length)];
  const n = String(Math.floor(1000 + Math.random() * 9000));
  return w + n;
}

async function hashName(name) {
  const data = new TextEncoder().encode(NAME_SALT + name);
  const buf = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

const account = (() => {
  let acc = storage.getJSON(ACCOUNT_KEY);   // { name, hash }
  let syncStatus = acc ? 'idle' : 'none';   // none | idle | syncing | synced | error
  let lastSync = 0;
  let pushedRev = -1;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  const setStatus = (s) => { syncStatus = s; notify(); };

  const ref = (hash) => database.ref('/progress/' + hash);
  const nickRef = (n) => database.ref('/nicks/' + n);
  // k: رقم الاسم المعروض في التعليقات (أخ 4821)، ثابت للحساب على كل الأجهزة
  const payload = () => {
    const p = { d: progress.exportState(), u: firebase.database.ServerValue.TIMESTAMP };
    if (acc && acc.nick) p.k = acc.nick;
    return p;
  };

  // حجز رقم عشوائي غير مستخدم للاسم المعروض
  async function claimNick(hash) {
    for (let i = 0; i < 25; i++) {
      const n = 1 + Math.floor(Math.random() * NICK_MAX);
      try {
        const res = await nickRef(n).transaction(cur => (cur === null ? hash : undefined));
        if (res.committed) return n;
      } catch (e) { return null; }
    }
    return null;
  }

  // التأكد من وجود رقم للحساب: من المحفوظ على الخادم، وإلا حجز رقم جديد
  async function ensureNick(remote) {
    if (!acc || acc.nick) return;
    let n = remote && Number.isInteger(remote.k) ? remote.k : null;
    if (!n) n = await claimNick(acc.hash);
    if (!n || !acc) return;
    acc.nick = n;
    storage.setJSON(ACCOUNT_KEY, acc);
    pushedRev = -1;
    notify();
  }

  async function push() {
    if (!acc || !navigator.onLine) return;
    const rev = progress.rev;
    if (rev === pushedRev) return;
    try {
      setStatus('syncing');
      await ref(acc.hash).set(payload());
      pushedRev = rev;
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
      const snap = await ref(acc.hash).once('value');
      const v = snap.val();
      if (v && v.d) progress.merge(v.d);
      await ensureNick(v);
      pushedRev = -1;
      await push();
    } catch (e) { setStatus('error'); }
  }

  function remember(name, hash) {
    acc = { name, hash };
    storage.setJSON(ACCOUNT_KEY, acc);
  }

  // إنشاء اسم جديد بشرط ألا يكون مستخدمًا
  async function create(raw) {
    const name = normalizeName(raw);
    const err = validateName(name);
    if (err) return { error: err };
    if (!navigator.onLine) return { error: 'needOnline' };
    try {
      const hash = await hashName(name);
      const res = await ref(hash).transaction(cur => (cur === null ? payload() : undefined));
      if (!res.committed) return { error: 'nameTaken' };
      remember(name, hash);
      pushedRev = progress.rev;
      lastSync = Date.now();
      setStatus('synced');
      await ensureNick(null);
      await push();
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
      const hash = await hashName(name);
      const snap = await ref(hash).once('value');
      if (!snap.exists()) return { error: 'nameNotFound' };
      remember(name, hash);
      const v = snap.val();
      if (v && v.d) progress.merge(v.d);
      await ensureNick(v);
      pushedRev = -1;
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
    storage.set(NAME_HIDDEN_KEY, '');
    progress.reset();
    setStatus('none');
  }

  // إخفاء الاسم يستمر طوال اليوم فقط، ثم يظهر من جديد حتى لا يُنسى
  const isHidden = () => storage.get(NAME_HIDDEN_KEY) === dayKey();
  function setHidden(h) { storage.set(NAME_HIDDEN_KEY, h ? dayKey() : ''); notify(); }

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
    get hash() { return acc && acc.hash; },
    get loggedIn() { return !!acc; },
    get status() { return syncStatus; },
    get lastSync() { return lastSync; },
    create, login, logout, sync, isHidden, setHidden, subscribe,
  };
})();
