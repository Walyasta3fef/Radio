// =====================
// الأسماء المميزة (المشرفون)
// يدخل المميز بحساب Google من صفحة سرية، ويُعرف من قائمة staff في قاعدة البيانات:
//   staff/{uid}: { name: الاسم الظاهر، mod: يستطيع حذف التعليقات، owner: المالك }
// قواعد Firebase تمنع أي أحد من انتحال صفة المميز أو تعديل القائمة إلا المالك
// =====================
const staff = (() => {
  let auth = null;
  try { auth = firebase.auth(); } catch (e) {}
  let user = null;
  let list = {};
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());

  // إن رُفضت القراءة أو انقطعت، تُعاد المحاولة بعد قليل
  const listen = () => database.ref('/staff').on('value',
    snap => { list = snap.val() || {}; notify(); },
    () => setTimeout(listen, 15000));
  listen();

  if (auth) {
    auth.onAuthStateChanged(u => { user = u; notify(); });
    auth.getRedirectResult().catch(() => {});
  }

  const me = () => (user && list[user.uid]) || null;

  // الدخول بنافذة منبثقة، وإن منعها المتصفح فبالتحويل
  async function signIn() {
    if (!auth) return { error: 'staffNoAuth' };
    const provider = new firebase.auth.GoogleAuthProvider();
    try {
      await auth.signInWithPopup(provider);
      return { ok: true };
    } catch (e) {
      const code = e && e.code || '';
      if (code.includes('popup') || code.includes('operation-not-supported')) {
        try { await auth.signInWithRedirect(provider); return { ok: true }; } catch (e2) {}
      }
      return { error: 'staffSignInFailed' };
    }
  }

  async function signOut() { try { await auth.signOut(); } catch (e) {} }

  async function add(uid, name, mod) {
    uid = String(uid || '').trim();
    name = String(name || '').trim();
    if (!uid || !name) return { error: 'staffMissing' };
    try {
      await database.ref('/staff/' + uid).set({ name: name.slice(0, 30), mod: !!mod });
      return { ok: true };
    } catch (e) { return { error: 'staffSaveFailed' }; }
  }

  // للمالك فقط: عدّ الحسابات من أرقامها، بالمفاتيح فقط دون البيانات
  async function countSubscribers() {
    try {
      const token = await auth.currentUser.getIdToken();
      const keysOf = async (path) => {
        const res = await fetch(firebaseConfig.databaseURL + path + '.json?shallow=true&auth=' + encodeURIComponent(token));
        if (!res.ok) throw new Error('count');
        return Object.keys((await res.json()) || {});
      };
      const n = (await keysOf('/owners')).length;
      await database.ref('/stats/subscribers').set(n);
      return { ok: true, n };
    } catch (e) { return { error: 'staffCountFailed' }; }
  }

  // للمالك فقط: قراءة بيانات كل الحسابات مرة واحدة لبناء تقرير الاستماع
  // (الملاحظات مشفّرة ولا تُقرأ هنا). تُستدعى بزر فقط، لأنها تنزّل بيانات كل المشتركين
  async function loadUsers() {
    try {
      const snap = await withTimeout(database.ref('/users').once('value'), 30000);
      const out = [];
      snap.forEach(ch => {
        const v = ch.val();
        if (!v || typeof v.d !== 'string') return;
        try { out.push({ k: v.k || null, u: v.u || 0, d: JSON.parse(v.d) }); } catch (e) {}
      });
      return { ok: true, users: out };
    } catch (e) { return { error: 'staffReportFailed' }; }
  }

  async function remove(uid) {
    try { await database.ref('/staff/' + uid).remove(); return { ok: true }; }
    catch (e) { return { error: 'staffSaveFailed' }; }
  }

  return {
    get user() { return user; },
    get uid() { return user && user.uid; },
    get isStaff() { return !!me(); },
    get isMod() { const m = me(); return !!(m && (m.mod || m.owner)); },
    get isOwner() { const m = me(); return !!(m && m.owner); },
    get name() { const m = me(); return m && m.name; },
    get list() { return list; },
    nameOf: (uid) => (list[uid] && list[uid].name) || null,
    names: () => Object.values(list).map(s => s && s.name).filter(Boolean),
    signIn, signOut, add, remove, countSubscribers, loadUsers,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

// =====================
// تقرير الاستماع لكل الحسابات (حساب بحت بلا اتصال، ليسهل اختباره)
// users: [{ k: رقم المشترك، d: بيانات تقدّمه }]، والفترة بمفاتيح الأيام YYYYMMDD (شاملة)
// allTime: يُضاف وقت الاستماع القديم المسجّل قبل التقرير اليومي (بلا تصنيف)
// =====================
function buildListenReport(users, fromKey, toKey, allTime) {
  const r = { accounts: users.length, listeners: 0, c: 0, n: 0, f: 0, legacy: 0, lectures: [], top: [] };
  const lec = {};      // لقاء → { sec, people, done }
  const slot = (id) => lec[id] || (lec[id] = { id, sec: 0, people: 0, done: 0 });
  users.forEach(u => {
    const d = u.d || {};
    let c = 0, n = 0, f = 0;
    const mine = {};
    Object.values(d.daily || {}).forEach(days => {
      Object.entries(days || {}).forEach(([day, v]) => {
        if (!v || day < fromKey || day > toKey) return;
        c += v.c || 0; n += v.n || 0; f += v.f || 0;
        Object.entries(v.l || {}).forEach(([id, s]) => { mine[id] = (mine[id] || 0) + (s || 0); });
      });
    });
    let legacy = 0;
    if (allTime) legacy = Object.values(d.sec || {}).reduce((s, x) => s + (x || 0), 0);
    Object.entries(mine).forEach(([id, s]) => {
      if (!LECTURE_BY_ID[id]) return;
      const e = slot(id); e.sec += s; if (s >= 60) e.people++;
    });
    Object.entries(d.lectures || {}).forEach(([id, e]) => {
      if (!e || !e.d || !LECTURE_BY_ID[id]) return;
      // اللقاءات المكتملة قبل تسجيل تاريخ الاكتمال تظهر في «كل الوقت» فقط
      if (allTime || (e.da && e.da >= fromKey && e.da <= toKey)) slot(id).done++;
    });
    const total = c + n + f + legacy;
    r.c += c; r.n += n; r.f += f; r.legacy += legacy;
    if (total >= 60) { r.listeners++; r.top.push({ k: u.k, sec: total }); }
  });
  r.total = r.c + r.n + r.f + r.legacy;
  r.lectures = Object.values(lec).filter(e => e.sec > 0 || e.done > 0).sort((a, b) => b.sec - a.sec || b.done - a.done);
  r.top.sort((a, b) => b.sec - a.sec);
  return r;
}
