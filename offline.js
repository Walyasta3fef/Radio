// =====================
// الاستماع دون اتصال (للكورس فقط، والراديو يبقى بثًا مباشرًا)
// يُحمَّل اللقاء كاملًا ويُحفظ في مخزن خاص بالموقع داخل المتصفح (Cache Storage)،
// ثم يُشغَّل منه مباشرة دون إنترنت
// المتصفح قد يحذف المخزن إذا امتلأت ذاكرة الجهاز أو مُسحت بيانات الموقع،
// لذلك تُراجَع القائمة عند كل فتح وتُطابَق مع الموجود فعلًا
// =====================
const OFFLINE_KEY = 'afaf_offline_v1';
const OFFLINE_SIZES_KEY = 'afaf_media_sizes_v1';
const AUDIO_CACHE = 'audio-v1';              // ملف sw.js يُبقي كل مخزن يبدأ بـ audio- عند التحديث
const SIZES_FRESH_MS = 7 * 24 * 3600 * 1000;
const SIZES_RETRY_MS = 10 * 60 * 1000;

const offline = (() => {
  const supported = (() => {
    try {
      return 'caches' in window && typeof fetch === 'function'
        && typeof AbortController === 'function' && typeof URL.createObjectURL === 'function';
    } catch (e) { return false; }
  })();

  const savedIndex = storage.getJSON(OFFLINE_KEY);
  const index = savedIndex && typeof savedIndex === 'object' ? savedIndex : {};   // { 'normal:L05': الحجم بالبايت }
  const urls = new Map();        // روابط التشغيل الجاهزة للملفات المحمّلة
  const preparing = new Map();
  const jobs = new Map();        // التحميلات الجارية: { loaded, total, ctrl }
  const errors = new Map();      // آخر خطأ تحميل لكل لقاء (مفتاح نص في i18n)
  const broken = new Set();      // ملفات تعذّرت قراءتها في هذه الجلسة
  const listeners = new Set();
  let notifyTimer = null;

  const keyOf = (variant, id) => variant + ':' + id;
  // مفتاح الملف داخل المخزن: عنوان داخلي ثابت لا يُطلب من الشبكة أبدًا
  const cacheUrl = (variant, id) => new URL('offline-audio/' + variant + '/' + id + '.mp3', location.href.split('#')[0]).href;
  const openCache = () => caches.open(AUDIO_CACHE);

  const persist = () => storage.setJSON(OFFLINE_KEY, index);
  const notify = () => { clearTimeout(notifyTimer); notifyTimer = null; listeners.forEach(fn => fn()); };
  const notifySoon = () => { if (!notifyTimer) notifyTimer = setTimeout(notify, 300); };

  const has = (variant, id) => !!index[keyOf(variant, id)] && !broken.has(keyOf(variant, id));
  const url = (variant, id) => urls.get(keyOf(variant, id)) || null;

  function forget(k) {
    delete index[k];
    urls.delete(k);
    persist();
  }

  // تجهيز رابط التشغيل لملف محمّل. يعيد الرابط، أو null إذا لم يعد الملف موجودًا
  function prepare(variant, id) {
    const k = keyOf(variant, id);
    if (urls.has(k)) return Promise.resolve(urls.get(k));
    if (!supported || !has(variant, id)) return Promise.resolve(null);
    if (preparing.has(k)) return preparing.get(k);
    const p = (async () => {
      try {
        const res = await (await openCache()).match(cacheUrl(variant, id));
        const blob = res && await res.blob();
        if (!blob || !blob.size) { forget(k); notify(); return null; }
        const u = URL.createObjectURL(blob);
        urls.set(k, u);
        return u;
      } catch (e) {
        broken.add(k);
        notify();
        return null;
      } finally { preparing.delete(k); }
    })();
    preparing.set(k, p);
    return p;
  }

  // تعذّر تشغيل الملف المحفوظ: يُجهَّز من جديد في المحاولة التالية
  function invalidate(variant, id) { urls.delete(keyOf(variant, id)); }

  function errorKey(e, aborted) {
    if (aborted) return null;
    if (!navigator.onLine) return 'dlNeedNet';
    if (e && (e.name === 'QuotaExceededError' || e.message === 'space')) return 'dlNoSpace';
    return 'dlFailed';
  }

  // تحميل واحد: بالكتابة إلى المخزن أثناء التحميل (stream)، أو بتحميل الملف كله ثم حفظه (blob)
  async function fetchInto(variant, id, job, useStream) {
    const k = keyOf(variant, id);
    const target = cacheUrl(variant, id);
    const res = await fetch(mediaUrl(variant, id), { signal: job.ctrl.signal, mode: 'cors', credentials: 'omit' });
    if (res.status !== 200) throw new Error('http ' + res.status);
    if (/^text\//i.test(res.headers.get('content-type') || '')) throw new Error('type');
    const declared = parseInt(res.headers.get('content-length') || '0', 10) || 0;
    job.total = declared || sizes.s[k] || 0;
    job.loaded = 0;

    // التأكد من وجود مساحة كافية قبل البدء
    let est = null;
    try { est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; } catch (e) {}
    if (est && est.quota && job.total && est.quota - (est.usage || 0) < job.total * 1.05) throw new Error('space');

    const cache = await openCache();
    const headers = { 'Content-Type': 'audio/mpeg' };
    job.storing = true;
    if (useStream) {
      // فلا يُحمَّل الملف كله في ذاكرة الجهاز
      const reader = res.body.getReader();
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) { controller.close(); return; }
            job.loaded += value.byteLength;
            notifySoon();
            controller.enqueue(value);
          } catch (e) { controller.error(e); }
        },
        cancel(reason) { try { reader.cancel(reason); } catch (e) {} },
      });
      await cache.put(target, new Response(stream, { headers }));
    } else {
      const blob = await res.blob();
      job.loaded = blob.size;
      await cache.put(target, new Response(blob, { headers }));
    }
    if (job.ctrl.signal.aborted) throw new Error('aborted');
    if (!job.loaded || (declared && job.loaded !== declared)) throw new Error('short');
    return job.loaded;
  }

  async function download(variant, id) {
    const k = keyOf(variant, id);
    if (!supported || !LECTURE_BY_ID[id] || jobs.has(k) || has(variant, id)) return;
    errors.delete(k);
    if (!navigator.onLine) { errors.set(k, 'dlNeedNet'); notify(); return; }
    const job = { loaded: 0, total: 0, storing: false, ctrl: new AbortController() };
    jobs.set(k, job);
    broken.delete(k);
    notify();
    try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {}); } catch (e) {}

    const canStream = typeof ReadableStream === 'function' && typeof Response === 'function'
      && 'body' in Response.prototype;
    let size = 0, failure = null;
    try { size = await fetchInto(variant, id, job, canStream); }
    catch (e) {
      failure = e;
      // متصفح لا يقبل الكتابة أثناء التحميل: محاولة واحدة بالطريقة البسيطة
      const storeFailed = canStream && job.storing && !job.loaded && !job.ctrl.signal.aborted
        && navigator.onLine && e && e.name !== 'QuotaExceededError' && e.message !== 'space';
      if (storeFailed) {
        job.storing = false;
        try { size = await fetchInto(variant, id, job, false); failure = null; } catch (e2) { failure = e2; }
      }
    }

    jobs.delete(k);
    if (!failure && size) {
      index[k] = size;
      persist();
      notify();
      prepare(variant, id);
      return;
    }
    try { await (await openCache()).delete(cacheUrl(variant, id)); } catch (e) {}
    const key = errorKey(failure, job.ctrl.signal.aborted);
    if (key) {
      errors.set(k, key);
      try { errLog.add('offline dl: ' + (failure && (failure.name + ' ' + failure.message))); } catch (e) {}
    }
    notify();
  }

  function cancel(variant, id) {
    const job = jobs.get(keyOf(variant, id));
    if (job) { try { job.ctrl.abort(); } catch (e) {} }
  }

  async function remove(variant, id) {
    const k = keyOf(variant, id);
    cancel(variant, id);
    errors.delete(k);
    broken.delete(k);
    forget(k);
    notify();
    try { await (await openCache()).delete(cacheUrl(variant, id)); } catch (e) {}
  }

  async function removeAll() {
    Array.from(jobs.keys()).forEach(k => { const [v, id] = k.split(':'); cancel(v, id); });
    Object.keys(index).forEach(k => delete index[k]);
    urls.clear(); errors.clear(); broken.clear();
    persist();
    notify();
    try { await caches.delete(AUDIO_CACHE); } catch (e) {}
  }

  // حالة لقاء واحد كما تُعرض:
  // { st: 'done', size } أو { st: 'loading', loaded, total } أو { st: 'error', error, size } أو { st: 'none', size }
  function state(variant, id) {
    const k = keyOf(variant, id);
    const job = jobs.get(k);
    if (job) return { st: 'loading', loaded: job.loaded, total: job.total };
    if (has(variant, id)) return { st: 'done', size: index[k] };
    const size = sizes.s[k] || 0;
    if (errors.has(k)) return { st: 'error', error: errors.get(k), size };
    return { st: 'none', size };
  }

  function usage() {
    const keys = Object.keys(index);
    return { count: keys.length, bytes: keys.reduce((s, k) => s + (index[k] || 0), 0) };
  }

  // أحجام الملفات قبل التحميل: تُقرأ من فهرس الأرشيف مرة كل أسبوع، وغيابها لا يمنع التحميل
  const savedSizes = storage.getJSON(OFFLINE_SIZES_KEY);
  let sizes = savedSizes && savedSizes.s && typeof savedSizes.s === 'object' ? savedSizes : { at: 0, s: {} };
  let sizesTriedAt = 0;
  async function loadSizes() {
    if (!supported || !navigator.onLine) return;
    if (Object.keys(sizes.s).length && Date.now() - (sizes.at || 0) < SIZES_FRESH_MS) return;
    if (Date.now() - sizesTriedAt < SIZES_RETRY_MS) return;
    sizesTriedAt = Date.now();
    try {
      const items = {};
      LECTURES.forEach(l => ['normal', 'fast'].forEach(v => {
        const m = /\/download\/([^/]+)\/(.+)$/.exec(mediaUrl(v, l.id));
        if (m) (items[m[1]] = items[m[1]] || []).push({ k: keyOf(v, l.id), name: decodeURIComponent(m[2]) });
      }));
      const out = {};
      for (const [item, wants] of Object.entries(items)) {
        const r = await fetch('https://archive.org/metadata/' + item + '/files', { credentials: 'omit' });
        if (!r.ok) continue;
        const j = await r.json();
        const files = (j && (j.result || j.files)) || [];
        const byName = {};
        files.forEach(f => { if (f && f.name) byName[f.name] = parseInt(f.size, 10) || 0; });
        wants.forEach(w => { if (byName[w.name]) out[w.k] = byName[w.name]; });
      }
      if (Object.keys(out).length) {
        sizes = { at: Date.now(), s: out };
        storage.setJSON(OFFLINE_SIZES_KEY, sizes);
        notify();
      }
    } catch (e) {}
  }

  // مطابقة القائمة المحفوظة مع الموجود فعلًا في المخزن
  async function init() {
    if (!supported) return;
    try {
      const cache = await openCache();
      const keys = await cache.keys();
      const present = new Set(keys.map(r => r.url));
      let changed = false;
      Object.keys(index).forEach(k => {
        const [v, id] = k.split(':');
        if (jobs.has(k)) return;
        if (!LECTURE_BY_ID[id] || !present.has(cacheUrl(v, id))) { delete index[k]; urls.delete(k); changed = true; }
      });
      for (const r of keys) {
        const m = /offline-audio\/(normal|fast)\/(\w+)\.mp3$/.exec(r.url);
        if (!m || !LECTURE_BY_ID[m[2]] || index[keyOf(m[1], m[2])]) continue;
        try {
          const res = await cache.match(r);
          const blob = res && await res.blob();
          if (blob && blob.size) { index[keyOf(m[1], m[2])] = blob.size; changed = true; }
        } catch (e) {}
      }
      if (changed) { persist(); notify(); }
    } catch (e) {}
  }
  init();

  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  return { supported, has, url, prepare, invalidate, download, cancel, remove, removeAll, state, usage, loadSizes, subscribe };
})();
