// =====================
// ملاحظات المستخدم الخاصة على كل لقاء
// تُحفظ على الجهاز، وتُرفع مع الحساب مشفّرة بالاسم الخاص (AES-GCM)
// فلا يستطيع أحد قراءتها من قاعدة البيانات دون معرفة الاسم
// =====================
const NOTES_KEY = 'afaf_notes_v1';
const NOTE_MAX = 2000;
const NOTES_SALT = 'afaf-notes-v1';

const notes = (() => {
  let state = storage.getJSON(NOTES_KEY) || {};   // { lid: { t: النص, u: وقت آخر تعديل } }
  let rev = 0;
  const listeners = new Set();
  const notify = () => listeners.forEach(fn => fn());
  const persist = () => storage.setJSON(NOTES_KEY, state);

  const get = (lid) => (state[lid] && state[lid].t) || '';
  const has = (lid) => !!get(lid).trim();

  // الحذف يبقى سجلًا فارغًا بتاريخه، حتى يصل الحذف إلى الأجهزة الأخرى
  function set(lid, text) {
    state[lid] = { t: String(text || '').slice(0, NOTE_MAX), u: Date.now() };
    rev++; persist(); notify();
  }

  // الدمج: لكل لقاء تبقى النسخة الأحدث
  function merge(remote) {
    let changed = false;
    Object.entries(remote || {}).forEach(([lid, n]) => {
      if (!n || typeof n.t !== 'string' || typeof n.u !== 'number') return;
      if (!state[lid] || n.u > state[lid].u) { state[lid] = { t: n.t.slice(0, NOTE_MAX), u: n.u }; changed = true; }
    });
    if (changed) { persist(); notify(); }
  }

  // مسح الملاحظات من هذا الجهاز فقط (عند الخروج)، وتبقى محفوظة في الحساب
  function reset() { state = {}; storage.set(NOTES_KEY, ''); rev++; notify(); }

  // مفتاح التشفير مشتق من الاسم الخاص بملح مختلف عن البصمة المخزّنة
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
    const data = new TextEncoder().encode(JSON.stringify(state));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(name), data));
    const out = new Uint8Array(iv.length + ct.length);
    out.set(iv); out.set(ct, iv.length);
    return toB64(out);
  }

  async function decryptMerge(name, blob) {
    if (typeof blob !== 'string' || !blob) return;
    try {
      const all = fromB64(blob);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: all.slice(0, 12) }, await keyFor(name), all.slice(12));
      merge(JSON.parse(new TextDecoder().decode(plain)));
    } catch (e) {}
  }

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { get, has, set, reset, encrypt, decryptMerge, subscribe, get rev() { return rev; } };
})();
