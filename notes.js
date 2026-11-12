// =====================
// ملاحظات المستخدم الخاصة على كل لقاء
// كل ملاحظة مستقلة: وقتها داخل اللقاء (اختياري) ونصها
// تُحفظ على الجهاز، وتُرفع مع الحساب مشفّرة برمز الدخول (AES-GCM)
// فلا يستطيع أحد قراءتها من قاعدة البيانات دون معرفة الرمز
// =====================
const NOTES_KEY = 'afaf_notes_v2';
const NOTES_KEY_V1 = 'afaf_notes_v1';      // الصيغة القديمة: نص واحد لكل لقاء
const NOTE_MAX = 500;                      // أقصى طول للملاحظة الواحدة
const NOTE_LEGACY_MAX = 2000;              // الملاحظات القديمة المنقولة قد تكون أطول
const NOTES_BUDGET = 2000;                 // حد اللقاء الواحد: مجموع الحروف + تكلفة ثابتة لكل ملاحظة
const NOTE_COST = 20;
const NOTES_PER_LECTURE = 150;
const NOTE_TOMB_MS = 90 * 24 * 3600 * 1000;
const NOTES_SALT = 'afaf-notes-v1';

const notes = (() => {
  // الحالة: { لقاء: { معرّف: [الوقت بالثواني أو -1، وقت آخر تعديل، النص أو null إذا حُذفت] } }
  // الملاحظة المحذوفة تبقى سجلًا فارغًا بتاريخه، حتى يصل الحذف إلى الأجهزة الأخرى
  const validItem = (n) => Array.isArray(n) && n.length === 3
    && typeof n[0] === 'number' && typeof n[1] === 'number' && (n[2] === null || typeof n[2] === 'string');

  // نسخة نظيفة من بيانات محفوظة أو قادمة من جهاز آخر
  function clean(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') return out;
    Object.entries(raw).forEach(([lid, items]) => {
      if (!items || typeof items !== 'object' || Array.isArray(items)) return;
      const o = {};
      let count = 0;
      Object.entries(items).forEach(([nid, n]) => {
        if (count >= NOTES_PER_LECTURE || !/^[a-z0-9]{1,12}$/.test(nid) || !validItem(n)) return;
        o[nid] = [n[0] >= 0 ? Math.floor(n[0]) : -1, n[1], n[2] === null ? null : n[2].slice(0, NOTE_LEGACY_MAX)];
        count++;
      });
      if (count) out[lid] = o;
    });
    return out;
  }

  // تحويل الصيغة القديمة: نص اللقاء كله يصير ملاحظة واحدة بلا وقت، بمعرّف ثابت حتى لا تتكرر عند الدمج
  function fromV1(old) {
    const out = {};
    if (!old || typeof old !== 'object') return out;
    Object.entries(old).forEach(([lid, n]) => {
      if (!n || typeof n.t !== 'string' || typeof n.u !== 'number') return;
      out[lid] = { old0: [-1, n.u, n.t.trim() ? n.t : null] };
    });
    return out;
  }

  // سجلات الحذف القديمة لا حاجة إليها بعد أن وصلت إلى كل الأجهزة
  function prune(s) {
    const limit = Date.now() - NOTE_TOMB_MS;
    Object.keys(s).forEach(lid => {
      Object.keys(s[lid]).forEach(nid => { if (s[lid][nid][2] === null && s[lid][nid][1] < limit) delete s[lid][nid]; });
      if (!Object.keys(s[lid]).length) delete s[lid];
    });
    return s;
  }

  function load() {
    const v2 = storage.getJSON(NOTES_KEY);
    if (v2 && typeof v2 === 'object') return prune(clean(v2));
    const s = clean(fromV1(storage.getJSON(NOTES_KEY_V1)));
    if (Object.keys(s).length) storage.setJSON(NOTES_KEY, s);
    return s;
  }

  let state = load();
  let rev = 0;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  const persist = () => storage.setJSON(NOTES_KEY, state);
  const commit = () => { rev++; persist(); notify(); };

  const timeOf = (s) => (typeof s === 'number' && s >= 0 ? Math.floor(s) : -1);
  const newId = () => Math.random().toString(36).slice(2, 8) || 'n' + Date.now().toString(36).slice(-5);

  // الملاحظات الظاهرة: ذات الوقت أولًا مرتبة به، ثم العامة بترتيب كتابتها
  function list(lid) {
    return Object.entries(state[lid] || {})
      .filter(([, n]) => n[2] !== null)
      .map(([id, n]) => ({ id, s: n[0] >= 0 ? n[0] : null, u: n[1], x: n[2] }))
      .sort((a, b) => (a.s === null) - (b.s === null) || (a.s ?? 0) - (b.s ?? 0) || a.u - b.u);
  }
  const count = (lid) => Object.values(state[lid] || {}).filter(n => n[2] !== null).length;
  const has = (lid) => count(lid) > 0;

  // المساحة المستعملة من حد اللقاء، والمتاحة لنص ملاحظة (جديدة، أو تعديل ملاحظة موجودة)
  const used = (lid) => Object.values(state[lid] || {}).reduce((sum, n) => sum + NOTE_COST + (n[2] ? n[2].length : 0), 0);
  function room(lid, nid) {
    const cur = nid && state[lid] && state[lid][nid];
    const curLen = cur && cur[2] ? cur[2].length : 0;
    const free = NOTES_BUDGET - used(lid) + (cur ? NOTE_COST + curLen : 0) - NOTE_COST;
    return Math.max(curLen, Math.min(cur ? NOTE_LEGACY_MAX : NOTE_MAX, free));
  }

  // يعيد معرّف الملاحظة الجديدة، أو null إذا كان النص فارغًا أو امتلأ حد اللقاء
  function add(lid, sec, text) {
    const x = String(text || '').trim();
    if (!x || x.length > room(lid, null)) return null;
    if (!state[lid]) state[lid] = {};
    let id = newId();
    while (state[lid][id]) id = newId();
    state[lid][id] = [timeOf(sec), Date.now(), x];
    commit();
    return id;
  }

  function update(lid, nid, sec, text) {
    const cur = state[lid] && state[lid][nid];
    if (!cur || cur[2] === null) return false;
    const x = String(text || '').trim();
    if (!x) { remove(lid, nid); return true; }
    if (x.length > room(lid, nid)) return false;
    state[lid][nid] = [timeOf(sec), Date.now(), x];
    commit();
    return true;
  }

  function remove(lid, nid) {
    if (!state[lid] || !state[lid][nid]) return;
    state[lid][nid] = [-1, Date.now(), null];
    commit();
  }

  // الدمج: لكل ملاحظة تبقى النسخة الأحدث، فلا يضيع ما كُتب على جهاز آخر
  function merge(remote) {
    let changed = false;
    Object.entries(clean(remote)).forEach(([lid, items]) => {
      Object.entries(items).forEach(([nid, n]) => {
        const mine = state[lid] && state[lid][nid];
        if (mine && mine[1] >= n[1]) return;
        if (!state[lid]) state[lid] = {};
        state[lid][nid] = n;
        changed = true;
      });
    });
    if (changed) { persist(); notify(); }
  }

  // مسح الملاحظات من هذا الجهاز فقط (عند الخروج)، وتبقى محفوظة في الحساب
  function reset() { state = {}; storage.set(NOTES_KEY, ''); storage.set(NOTES_KEY_V1, ''); rev++; notify(); }

  // مفتاح التشفير مشتق من رمز الدخول بملح مختلف عن البصمة المخزّنة
  const keyCache = {};
  async function keyFor(name) {
    if (keyCache[name]) return keyCache[name];
    const enc = new TextEncoder();
    const base = await crypto.subtle.importKey('raw', enc.encode(name), 'PBKDF2', false, ['deriveKey']);
    keyCache[name] = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: enc.encode(NOTES_SALT), iterations: 100000, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    return keyCache[name];
  }
  const toB64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
  const fromB64 = (s) => Uint8Array.from(atob(s), c => c.charCodeAt(0));

  // يعيد نصًا مشفّرًا لكل الملاحظات، أو null إذا لم تُكتب أي ملاحظة على هذا الجهاز
  async function encrypt(name) {
    if (!Object.keys(state).length) return null;
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = new TextEncoder().encode(JSON.stringify({ v: 2, n: state }));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(name), data));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv); out.set(ct, iv.length);
    return toB64(out);
  }

  // يقبل الصيغة الجديدة والقديمة المحفوظة في الحساب
  async function decryptMerge(name, blob) {
    if (typeof blob !== 'string' || !blob) return;
    try {
      const all = fromB64(blob);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await keyFor(name), all.slice(12));
      const data = JSON.parse(new TextDecoder().decode(plain));
      merge(data && data.v === 2 ? data.n : fromV1(data));
    } catch (e) {}
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { list, count, has, room, add, update, remove, reset, encrypt, decryptMerge, subscribe, get rev() { return rev; } };
})();
