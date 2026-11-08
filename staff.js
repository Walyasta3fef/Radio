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
    signIn, signOut, add, remove, countSubscribers,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();
