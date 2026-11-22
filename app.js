const { useState, useEffect, useRef, useCallback, useMemo, useContext } = React;
const html = htm.bind(React.createElement);

const MODES = ['normal', 'fast'];
const MODE_LABEL = { normal: 'normalRadio', fast: 'fastRadio', lecture: 'course' };
const MODE_SHORT = { normal: 'speedNormal', fast: 'speedFast' };
const MODE_INFO = { normal: 'normalInfo', fast: 'fastInfo' };
const SKIP_SECONDS = 15;
const BEHIND_SECONDS = 20;
const RADIO_MODE_KEY = 'radio_mode';

const STATIONS = Object.fromEntries(MODES.map(mode => [mode, createStation(mode,
  LECTURES.map(l => ({ id: l.id, title: l.title, duration: l[mode], from: l.from || (l.radioFrom ? Date.parse(l.radioFrom + 'T00:00:00Z') : 0) })))]));

const fmtTime = (s) => {
  if (isNaN(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
// الرقم يظهر كاملًا حتى 9999، ثم بالآلاف بلا «.0» زائدة: 12.5 ألف
const shortNum = (x) => String(Math.floor(x * 10) / 10).replace(/\.0$/, '');
const fmtCount = (n) => n >= 1000000 ? shortNum(n / 1000000) + ' ' + t('million')
  : n >= 10000 ? shortNum(n / 1000) + ' ' + t('thousand') : String(Math.floor(n));
// النسبة الكلية بكسر عشري عندما تكون صغيرة حتى يظهر أي تقدّم
const fmtPct = (n) => (n > 0 && n < 10 ? (Math.floor(n * 10) / 10) : Math.floor(n)) + '%';
const fmtHours = (sec) => {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? t('hoursMinutes', { h, m }) : t('minutesOnly', { m });
};

// النسبة داخل نص عربي: تُعزل حتى تظهر "35%" لا "%35"
function Pct({ value }) {
  return html`<bdi dir="ltr" className="pct-num">${typeof value === 'number' ? fmtPct(value) : value}</bdi>`;
}

// =====================
// التنقل بين الصفحات دون إعادة تحميل، فلا يتوقف الصوت
// =====================
function parseRoute() {
  const h = location.hash;
  let m = /^#\/radio\/(normal|fast)$/.exec(h);
  if (m) return { page: 'radio', mode: m[1] };
  if (h === '#/course' || h === '#/course/fast') return { page: 'course' };
  if (h === '#/account') return { page: 'account' };
  if (h === '#/report') return { page: 'report' };
  if (h === '#/general' || h === '#/community') return { page: 'general' };
  if (h.startsWith('#/community?c=')) return { page: 'general', focus: h.slice('#/community?c='.length) };
  if (h === '#/staff') return { page: 'staff' };
  if (h === '#/feedback') return { page: 'feedback' };
  m = /^#\/lecture\/(\w+)$/.exec(h);
  if (m && LECTURE_BY_ID[m[1]]) return { page: 'lecture', id: m[1], variant: 'normal' };
  // النسخة السريعة من لقاءات الكورس أُلغيت: روابطها القديمة تفتح الصفحة العادية
  m = /^#\/fast\/(\w+)$/.exec(h);
  if (m && LECTURE_BY_ID[m[1]]) { history.replaceState(history.state, '', '#/lecture/' + m[1]); if (typeof NAV !== 'undefined') NAV.hashes[NAV.cur] = location.hash; return { page: 'lecture', id: m[1], variant: 'normal' }; }
  return { page: 'home' };
}
// =====================
// موضع التمرير: الصفحة الجديدة تبدأ من أولها، والصفحة التي يُرجع إليها تعود إلى الموضع نفسه.
// كل خطوة في سجل المتصفح تحمل رقمها (nav)، فيُعرف الرجوع من الانتقال إلى صفحة جديدة
// =====================
const RESTORE_MS = 1000;   // صفحة الكورس تكمل تحميل محتواها، فتُعاد المحاولة خلال الثانية الأولى
const FLASH_MS = 1200;
const normHash = (h) => (!h || h === '#' ? '#/' : h);
// ep: رقم جلسة التنقل؛ الخطوات التي لم تُسجَّل في هذه الجلسة (قبل إعادة تحميل الصفحة مثلًا) لا يُعتمد على ترتيبها
const NAV = { ep: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), cur: 0, hashes: [], scroll: [],
  pushing: false, expect: null, lastLecture: null, prevPage: null };
try { history.scrollRestoration = 'manual'; } catch (e) {}
const stampEntry = () => {
  NAV.hashes[NAV.cur] = normHash(location.hash);
  try { history.replaceState(Object.assign({}, history.state, { nav: NAV.cur, ep: NAV.ep }), ''); } catch (e) {}
};
stampEntry();
window.addEventListener('scroll', () => { NAV.scroll[NAV.cur] = window.scrollY; }, { passive: true });

let restoreStop = null;
function restoreScroll(apply) {
  if (restoreStop) restoreStop();
  const start = Date.now();
  let timer = null;
  // لمس الشاشة أو التمرير من المستخدم يوقف المحاولات حتى لا تعارضه
  const stop = () => {
    clearInterval(timer);
    ['touchstart', 'wheel', 'keydown', 'mousedown'].forEach(ev => window.removeEventListener(ev, stop));
    if (restoreStop === stop) restoreStop = null;
  };
  ['touchstart', 'wheel', 'keydown', 'mousedown'].forEach(ev => window.addEventListener(ev, stop, { passive: true }));
  restoreStop = stop;
  const tick = () => { apply(); if (Date.now() - start >= RESTORE_MS) stop(); };
  setTimeout(tick, 0);
  timer = setInterval(tick, 100);
}

// يضع اللقاء في وسط الشاشة ويلوّنه تلوينًا خفيفًا مرة واحدة
function centerLesson(id) {
  let flashed = false;
  restoreScroll(() => {
    const el = document.getElementById('lesson-' + id);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    if (!flashed) {
      flashed = true;
      el.classList.add('lesson-flash');
      setTimeout(() => el.classList.remove('lesson-flash'), FLASH_MS);
    }
  });
}

function onNavigate(route) {
  const st = history.state;
  const pushed = NAV.pushing;
  NAV.pushing = false;
  const back = !pushed && st && st.ep === NAV.ep && typeof st.nav === 'number';
  if (back) {
    NAV.cur = st.nav;
  } else if (pushed) {
    NAV.cur += 1;
    NAV.hashes.length = NAV.cur;
    NAV.scroll.length = NAV.cur;
    stampEntry();
  } else {
    // رجوع إلى خطوة من خارج هذه الجلسة: يُبدأ سجل جديد حتى لا يُرجع زر الموقع إلى خطوة خاطئة
    NAV.ep += '+';
    NAV.cur = 0; NAV.hashes = []; NAV.scroll = [];
    stampEntry();
  }
  NAV.hashes[NAV.cur] = normHash(location.hash);
  // احتياط: إن لم يصل زر «رجوع» إلى الصفحة المطلوبة فُتحت مباشرة
  if (NAV.expect) {
    const want = NAV.expect;
    NAV.expect = null;
    if (normHash(location.hash) !== want) { go(want); return; }
  }
  const fromLecture = NAV.prevPage === 'lecture';
  NAV.prevPage = route.page;
  if (route.page === 'lecture') NAV.lastLecture = route.id;
  // الرجوع إلى الكورس من لقاء: اللقاء نفسه في وسط الشاشة، حتى لو تنقّل المستمع بين اللقاءات
  if (route.page === 'course' && fromLecture && NAV.lastLecture) { centerLesson(NAV.lastLecture); return; }
  if (back) {
    const y = NAV.scroll[NAV.cur] || 0;
    restoreScroll(() => { if (Math.abs(window.scrollY - y) > 1) window.scrollTo(0, y); });
    return;
  }
  if (restoreStop) restoreStop();
  window.scrollTo(0, 0);
}

function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    NAV.prevPage = route.page;
    if (route.page === 'lecture') NAV.lastLecture = route.id;
    const onHash = () => { const r = parseRoute(); setRoute(r); onNavigate(r); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
const go = (hash) => {
  if (normHash(location.hash) === normHash(hash)) return;
  NAV.pushing = true;
  location.hash = hash;
};
// زر «رجوع» في الموقع: إن كانت الصفحة المطلوبة خطوة سابقة في السجل رجع إليها،
// فيعمل زر الرجوع في الجهاز بعدها كما هو متوقع؛ وإلا فتحها
const goBack = (to) => {
  const target = normHash(to);
  for (let i = NAV.cur - 1; i >= 0; i--) {
    if (NAV.hashes[i] === target) { NAV.expect = target; history.go(i - NAV.cur); return; }
  }
  go(to);
};

function useClock() {
  const [now, setNow] = useState(serverNow());
  useEffect(() => {
    const id = setInterval(() => setNow(serverNow()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

function useProgressVersion() {
  const [v, setV] = useState(0);
  useEffect(() => progress.subscribe(() => setV(x => x + 1)), []);
  return v;
}

function useAccountVersion() {
  const [v, setV] = useState(0);
  useEffect(() => account.subscribe(() => setV(x => x + 1)), []);
  return v;
}

function useOfflineVersion() {
  const [v, setV] = useState(0);
  useEffect(() => offline.subscribe(() => setV(x => x + 1)), []);
  return v;
}

function useOnline() {
  const [on, setOn] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => setOn(navigator.onLine);
    window.addEventListener('online', up);
    window.addEventListener('offline', up);
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', up); };
  }, []);
  return on;
}

// =====================
// الكورس عالسريع: النسخة السريعة من كل لقاء، وتُفتح بعد إكمال اللقاء على السرعة العادية
// =====================
// حذف السكتات: في اللقاءات التي رُفع لها ملف سكتات، ويُفتح في اللقاءات الأساسية بعد إكمالها بالسرعة العادية
const silenceLocked = (id) => SILENCE_AFTER_DONE.includes(id) && !progress.isDone(id);
// بعد القفز فوق سكتة قد يرسل المتصفح إشارة انتظار قصيرة لا يُراد إظهارها،
// فإن طال الانتظار عن ثانية ظهرت «جاري التحميل»
const JUMP_QUIET_MS = 1500;
const JUMP_WAIT_SHOW_MS = 1000;
// الاتصال الضعيف أثناء الاستماع إلى لقاء من الإنترنت: وقفتان أطول من ثانيتين خلال دقيقة، أو وقفة أطول من 6 ثوانٍ
const SLOW_STALL_MS = 2000;
const SLOW_LONG_MS = 6000;
const SLOW_WINDOW_MS = 60000;
const SLOW_GRACE_MS = 10000;   // التحميل بعد ضغط التشغيل أو التقديم اليدوي طبيعي، فلا يُحتسب

const lectureHash = (id, variant) => (variant === 'fast' ? '#/fast/' : '#/lecture/') + id;
// اللقاء الذي له ملف سكتات لا نسخة «عالسريع» له، فلا يدخل في تنقّل الكورس عالسريع
const hasFast = (x) => progress.isDone(x) && !silences.available(x);
const fastNext = (id) => COURSE_ORDER.slice(courseIndex(id) + 1).find(hasFast) || null;
const fastPrev = (id) => COURSE_ORDER.slice(0, Math.max(0, courseIndex(id))).reverse().find(hasFast) || null;
const lectureNext = (id, variant) => (variant === 'fast' ? fastNext(id) : courseNext(id));
const lecturePrev = (id, variant) => (variant === 'fast' ? fastPrev(id) : coursePrev(id));

// =====================
// المشغّل: مشغّل واحد للموقع كله يبقى يعمل أثناء التنقل
// mode: normal أو fast (بث مباشر) أو lecture (لقاء من الكورس)
// variant: نسخة لقاء الكورس المشغّلة: normal (تُحتسب في التقدّم) أو fast (للمراجعة)
// shifted: أوقف المستمع البث فصار متأخرًا عنه، فيكمل من حيث توقف
// حتى ينتهي اللقاء ثم يعود إلى البث المباشر
// =====================
function usePlayer(volume) {
  const audioRef = useRef(null);
  const modeRef = useRef(null);
  const lectureRef = useRef(null);
  const variantRef = useRef('normal');
  // «حذف السكتات»: القفز فوق مواضع الصمت في الملف الأصلي للّقاء. لا يُحفظ الاختيار: يعود عاديًا عند فتح الموقع أو تغيير اللقاء
  const [skipSil, setSkipSilState] = useState(false);
  const skipSilRef = useRef(false);
  const lastJumpRef = useRef(0);
  // اكتشاف الاتصال الضعيف: اللقاء الذي ظهر فيه، واللقاءات التي ظهر فيها من قبل في هذه الجلسة
  const [slowNet, setSlowNet] = useState(null);
  const slowShownRef = useRef(new Set());
  const stallRef = useRef({ at: 0, list: [], user: 0, timer: null });
  const setSkipSil = useCallback((v) => { skipSilRef.current = !!v; setSkipSilState(!!v); }, []);
  const wantPlayRef = useRef(false);     // هل يريد المستخدم الاستماع الآن
  const loadedKeyRef = useRef(null);     // المحمّل حاليًا، مثل normal:L05 أو lecture:c01 أو flecture:c01 (النسخة السريعة)
  const statusRef = useRef('idle');
  const endedRef = useRef(false);
  const pendingSeekRef = useRef(false);
  const resumeRef = useRef(null);
  const shiftedRef = useRef(false);
  const lastProgressRef = useRef(0);
  const lastAttemptRef = useRef(0);
  const lastSampleRef = useRef(null);    // آخر موضع مسجّل لحساب الجزء المسموع فعلًا
  const lastGoodRef = useRef(null);      // آخر موضع كان الصوت يعمل فيه فعلًا { key, t }، للرجوع إليه بعد الانقطاع
  const stallsRef = useRef(0);           // عدد محاولات إعادة التحميل المتتالية بسبب التعليق

  const [mode, setMode] = useState(null);
  const [lectureId, setLectureId] = useState(null);
  const [variant, setVariant] = useState('normal');
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('idle');
  const [live, setLive] = useState(null);
  const [shifted, setShiftedState] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);

  const updateStatus = useCallback((s) => { statusRef.current = s; setStatus(s); }, []);
  const setShifted = (v) => { shiftedRef.current = v; setShiftedState(v); };
  const isRadio = () => modeRef.current === 'normal' || modeRef.current === 'fast';
  const radioState = () => isRadio() ? STATIONS[modeRef.current].getState() : null;
  const radioKey = (s) => modeRef.current + ':' + s.track.id;
  const lecKey = (id, v) => (v === 'fast' ? 'flecture:' : 'lecture:') + id;
  const posOf = (id, v) => (v === 'fast' ? progress.fastPosition(id) : progress.position(id));
  const savePos = (id, v, sec) => (v === 'fast' ? progress.setFastPosition(id, sec) : progress.setPosition(id, sec));
  // هل يعمل اللقاء الحالي من ملف محمّل على الجهاز (فلا يتأثر بانقطاع الإنترنت)
  const isLocal = () => {
    const a = audioRef.current;
    return !!a && modeRef.current === 'lecture' && !!lectureRef.current
      && loadedKeyRef.current === lecKey(lectureRef.current, variantRef.current)
      && (a.getAttribute('src') || '').startsWith('blob:');
  };

  // اللقاء الذي يُحتسب الاستماع إليه الآن (النسخة العادية فقط)
  const trackedId = () => {
    const k = loadedKeyRef.current;
    if (!k || k.startsWith('fast:') || k.startsWith('flecture:')) return null;
    return k.split(':')[1];
  };

  const playAudio = useCallback(() => {
    const audio = audioRef.current;
    const p = audio.play();
    // عندما يكون الصوت يعمل أصلًا لا يصل حدث «بدأ التشغيل» مرة أخرى، فنحدّث الحالة هنا
    const markPlaying = () => {
      if (wantPlayRef.current && statusRef.current === 'loading' && !audio.paused && audio.readyState >= 3) updateStatus('playing');
    };
    if (p && p.then) p.then(markPlaying, () => {});
    if (p && p.catch) {
      p.catch(err => {
        if (!wantPlayRef.current) return;
        const name = err && err.name;
        if (name === 'AbortError') return; // تغيّر المصدر أثناء التحميل
        updateStatus(name === 'NotAllowedError' ? 'blocked' : 'error');
      });
    }
  }, [updateStatus]);

  const switchTo = (m, id = null, v = 'normal') => {
    if (modeRef.current === m && lectureRef.current === id && variantRef.current === v) return;
    lastAttemptRef.current = Date.now();
    if (audioRef.current) audioRef.current.pause();
    loadedKeyRef.current = null;
    lastSampleRef.current = null;
    modeRef.current = m;
    lectureRef.current = id;
    variantRef.current = v;
    setSkipSil(false);
    setSlowNet(null);
    setShifted(false);
    setMode(m);
    setLectureId(id);
    setVariant(v);
    setCurrentTime(id ? posOf(id, v) : 0);
  };

  // آخر موضع موثوق للملف المحمّل حاليًا
  const goodPosition = (fallback) => {
    const g = lastGoodRef.current;
    return g && g.key === loadedKeyRef.current ? g.t : fallback;
  };

  // إعادة تحميل الملف الحالي من الموضع نفسه (بعد خطأ أو انقطاع)
  const reloadInPlace = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.getAttribute('src')) return;
    lastAttemptRef.current = Date.now();
    lastProgressRef.current = Date.now();
    if (!navigator.onLine) { updateStatus('offline'); return; }
    updateStatus('loading');
    // لا نأخذ موضع المشغّل بعد محاولة سابقة لأنه يعود إلى الصفر، بل آخر موضع كان يعمل فيه
    if (resumeRef.current == null) resumeRef.current = goodPosition(audio.currentTime);
    lastSampleRef.current = null;
    audio.src = audio.getAttribute('src');
    audio.load();
    playAudio();
  }, [updateStatus, playAudio]);

  // البث المباشر: ضبط المشغّل على موضع البث الحي ثم التشغيل
  const syncAndPlay = useCallback((forceReload = false) => {
    const audio = audioRef.current;
    const s = radioState();
    if (!audio || !s) return;
    setShifted(false);
    setLive(s);
    setMediaMeta(s.track.id);
    endedRef.current = false;
    lastAttemptRef.current = Date.now();
    lastProgressRef.current = Date.now();
    if (!navigator.onLine) { updateStatus('offline'); return; }
    updateStatus('loading');

    const key = radioKey(s);
    if (forceReload || loadedKeyRef.current !== key) {
      loadedKeyRef.current = key;
      pendingSeekRef.current = true;
      resumeRef.current = null;
      lastSampleRef.current = null;
      audio.src = mediaUrl(modeRef.current, s.track.id);
      audio.load();
    } else if (audio.readyState >= 1) {
      lastSampleRef.current = null;
      audio.currentTime = s.position;
    } else {
      pendingSeekRef.current = true;
    }
    playAudio();
  }, [updateStatus, playAudio]);

  // استئناف البث المتأخر من حيث توقف
  const resumeShifted = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    lastAttemptRef.current = Date.now();
    lastProgressRef.current = Date.now();
    if (!navigator.onLine) { updateStatus('offline'); return; }
    updateStatus('loading');
    playAudio();
  }, [updateStatus, playAudio]);

  // الكورس: تشغيل لقاء من موضع التوقف
  const loadLecture = useCallback((forceReload = false) => {
    const audio = audioRef.current;
    const id = lectureRef.current;
    const v = variantRef.current;
    if (!audio || !id) return;
    setMediaMeta(id, true);
    lastAttemptRef.current = Date.now();
    lastProgressRef.current = Date.now();

    // اللقاء المحمّل على الجهاز يُشغَّل منه مباشرة، مع الإنترنت أو دونه
    const local = offline.url(v, id);
    if (!local && offline.has(v, id)) {
      // محمّل لكن رابط تشغيله لم يُجهَّز بعد: يُجهَّز ثم تُعاد المحاولة
      // (بعدها إما يصير الرابط جاهزًا أو يُشطب الملف من القائمة، فلا تتكرر المحاولة بلا نهاية)
      updateStatus('loading');
      offline.prepare(v, id).then(() => {
        if (wantPlayRef.current && modeRef.current === 'lecture' && lectureRef.current === id && variantRef.current === v) {
          loadLecture(forceReload);
        }
      });
      return;
    }
    if (!local && !navigator.onLine) { updateStatus('offline'); return; }
    updateStatus('loading');

    const key = lecKey(id, v);
    if (forceReload || loadedKeyRef.current !== key) {
      // عند إعادة المحاولة: موضع لم يُطبّق بعد، أو آخر موضع كان يعمل فيه، أو الموضع المحفوظ
      resumeRef.current = forceReload && loadedKeyRef.current === key
        ? (resumeRef.current != null ? resumeRef.current : goodPosition(posOf(id, v)))
        : posOf(id, v);
      loadedKeyRef.current = key;
      lastSampleRef.current = null;
      audio.src = local || mediaUrl(v, id);
      audio.load();
      // تجهيز اللقاء التالي إن كان محمّلًا، حتى يبدأ فورًا عند الانتقال إليه
      const nx = lectureNext(id, v);
      if (nx) offline.prepare(v, nx);
    }
    playAudio();
  }, [updateStatus, playAudio]);

  const startPlaying = () => { wantPlayRef.current = true; setIsPlaying(true); };

  const playLecture = useCallback((id, v = 'normal') => {
    switchTo('lecture', id, v);
    startPlaying();
    loadLecture();
    logEvent('lecture_started');
  }, [loadLecture]);

  const stop = useCallback(() => {
    wantPlayRef.current = false;
    setIsPlaying(false);
    updateStatus('idle');
    if (audioRef.current) audioRef.current.pause();
    // إيقاف البث يجعله متأخرًا: يكمل من الموضع نفسه عند التشغيل
    if (isRadio() && loadedKeyRef.current) setShifted(true);
    progress.save();
  }, [updateStatus]);

  const resume = useCallback(() => {
    startPlaying();
    if (!isRadio()) return loadLecture();
    if (shiftedRef.current && loadedKeyRef.current) return resumeShifted();
    syncAndPlay();
  }, [syncAndPlay, loadLecture, resumeShifted]);

  const toggleRadio = useCallback((m) => {
    if (wantPlayRef.current && modeRef.current === m) {
      if (statusRef.current === 'blocked') return shiftedRef.current ? resumeShifted() : syncAndPlay();
      return stop();
    }
    if (modeRef.current === m && shiftedRef.current && loadedKeyRef.current) {
      startPlaying();
      return resumeShifted();
    }
    switchTo(m);
    startPlaying();
    syncAndPlay();
    logEvent('playback_started_' + m);
  }, [stop, syncAndPlay, resumeShifted]);

  // العودة إلى البث المباشر فورًا
  const goLive = useCallback(() => {
    if (!isRadio()) return;
    startPlaying();
    syncAndPlay();
  }, [syncAndPlay]);

  const toggleLecture = useCallback((id, v = 'normal') => {
    if (wantPlayRef.current && modeRef.current === 'lecture' && lectureRef.current === id && variantRef.current === v) {
      if (statusRef.current === 'blocked') return loadLecture();
      return stop();
    }
    playLecture(id, v);
  }, [playLecture, stop, loadLecture]);

  // التقديم والتأخير داخل لقاء من الكورس فقط
  const seekLecture = useCallback((id, sec, v = 'normal') => {
    const dur = LECTURE_BY_ID[id][v];
    sec = Math.max(0, Math.min(dur - 1, sec));
    const audio = audioRef.current;
    const mine = modeRef.current === 'lecture' && lectureRef.current === id && variantRef.current === v;
    if (mine && loadedKeyRef.current === lecKey(id, v) && audio && audio.readyState >= 1) {
      lastSampleRef.current = null;
      audio.currentTime = sec;
    } else if (mine) {
      resumeRef.current = sec;
    }
    savePos(id, v, sec);
    setCurrentTime(sec);
  }, []);

  const skip = useCallback((delta) => {
    const id = lectureRef.current;
    if (modeRef.current !== 'lecture' || !id) return;
    const v = variantRef.current;
    const audio = audioRef.current;
    const base = audio && audio.readyState >= 1 ? audio.currentTime : posOf(id, v);
    // مع «حذف السكتات» تُحتسب الثواني من الكلام فقط، فلا يقع القفز داخل سكتة
    const target = skipSilRef.current && v === 'normal' && silences.ready(id) ? silences.shift(id, base, delta) : base + delta;
    seekLecture(id, target, v);
  }, [seekLecture]);

  const retry = useCallback(() => {
    if (!isRadio()) return loadLecture(true);
    if (shiftedRef.current) return reloadInPlace();
    syncAndPlay(true);
  }, [syncAndPlay, loadLecture, reloadInPlace]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  // أحداث المشغّل
  useEffect(() => {
    const audio = audioRef.current;

    const onTime = () => {
      lastProgressRef.current = Date.now();
      const ct = audio.currentTime;
      // حذف السكتات: إذا دخل التشغيل سكتة معلّمة يُقفز إلى نهايتها (في النسخة العادية من لقاء الكورس فقط)
      if (skipSilRef.current && !audio.paused && !audio.seeking && resumeRef.current == null
          && modeRef.current === 'lecture' && variantRef.current === 'normal') {
        const lid = lectureRef.current;
        if (lid && loadedKeyRef.current === lecKey(lid, 'normal') && silences.ready(lid)) {
          const end = silences.endAt(lid, ct);
          if (end != null && end < LECTURE_BY_ID[lid].normal - 1) {
            // السكتة التي دخلها التشغيل طبيعيًا (لا بتقديم يدوي) تُحتسب مسموعة، مع علامة أنها قُفز فوقها
            const prev = lastSampleRef.current;
            if (prev != null && ct - prev > 0 && ct - prev <= 3) {
              progress.record(lid, prev, ct, 'skipping');
              progress.record(lid, ct, end, 'skip');
            }
            lastSampleRef.current = null;
            lastJumpRef.current = Date.now();
            audio.currentTime = end;
            return;
          }
        }
      }
      // حماية إضافية: الوقت يتقدّم فالصوت يعمل، فلا داعي لعلامة التحميل
      if (wantPlayRef.current && statusRef.current === 'loading' && !audio.paused) updateStatus('playing');
      setCurrentTime(prev => (Math.floor(prev) === Math.floor(ct) ? prev : ct));
      const id = trackedId();
      if (!audio.paused && !audio.seeking) {
        const prev = lastSampleRef.current;
        if (prev != null) {
          const d = ct - prev;
          if (d > 0 && d <= 3) {
            // وقت الاستماع الفعلي من كل المصادر، والأجزاء المسموعة من العادي فقط
            const k = loadedKeyRef.current || '';
            const src = modeRef.current === 'lecture' ? 'c' : modeRef.current === 'fast' ? 'f' : 'n';
            progress.addTime(src, k.split(':')[1], d);
            listenStats.add(d);
            if (id) progress.record(id, prev, ct, skipSilRef.current ? 'skipping' : undefined);
          }
        }
        lastSampleRef.current = ct;
        // الصوت يعمل فعلًا من الموضع الصحيح: نحفظه مرجعًا لأي إعادة تحميل
        if (resumeRef.current == null && !pendingSeekRef.current && audio.readyState >= 3) {
          lastGoodRef.current = { key: loadedKeyRef.current, t: ct };
        }
      }
      // لا يُحفظ موضع اللقاء قبل الرجوع إلى مكانه بعد التحميل، حتى لا يُحفظ الصفر
      if (modeRef.current === 'lecture' && resumeRef.current == null) {
        const lid = lectureRef.current;
        if (id) progress.setPosition(id, ct);
        else if (lid && variantRef.current === 'fast' && loadedKeyRef.current === lecKey(lid, 'fast')) progress.setFastPosition(lid, ct);
      }
    };
    const onSeeking = () => {
      lastSampleRef.current = null;
      // تقديم يدوي (لا قفزة فوق سكتة): انتظار التحميل بعده طبيعي
      if (Date.now() - lastJumpRef.current > 100) stallRef.current.user = Date.now();
    };
    // ضغط التشغيل من المستمع (لا إعادة المحاولة التلقائية بعد تعليق)
    const onPlay = () => { if (!stallsRef.current) stallRef.current.user = Date.now(); };
    const onPlaying = () => {
      stallEnd();
      stallsRef.current = 0;
      if (!wantPlayRef.current) return;
      updateStatus('playing');
      const id = loadedKeyRef.current && loadedKeyRef.current.split(':')[1];
      if (id) setMediaMeta(id, modeRef.current === 'lecture');
    };
    const showLoading = () => {
      if (wantPlayRef.current && statusRef.current !== 'next' && statusRef.current !== 'offline') updateStatus('loading');
    };
    // هل يصلح ما يحدث الآن أن يُعدّ دليلًا على ضعف الاتصال؟
    const slowCandidate = () => {
      const lid = lectureRef.current;
      return modeRef.current === 'lecture' && lid && wantPlayRef.current && !audio.paused && !isLocal()
        && navigator.onLine && !document.hidden && offline.supported && !slowShownRef.current.has(lid)
        && Date.now() - stallRef.current.user > SLOW_GRACE_MS
        && ['none', 'error'].includes(offline.state('normal', lid).st);
    };
    const flagSlow = () => {
      const lid = lectureRef.current;
      if (!slowCandidate()) return;
      slowShownRef.current.add(lid);
      setSlowNet(lid);
    };
    const stallEnd = () => {
      const st = stallRef.current;
      clearTimeout(st.timer); st.timer = null;
      if (!st.at) return;
      const d = Date.now() - st.at;
      st.at = 0;
      if (d < SLOW_STALL_MS) return;
      const now = Date.now();
      st.list = st.list.filter(x => now - x < SLOW_WINDOW_MS).concat(now);
      if (st.list.length >= 2) flagSlow();
    };
    const onWaiting = () => {
      const st = stallRef.current;
      if (!st.at && slowCandidate()) {
        st.at = Date.now();
        clearTimeout(st.timer);
        st.timer = setTimeout(() => { if (st.at && audio.readyState < 3) flagSlow(); }, SLOW_LONG_MS);
      }
      if (Date.now() - lastJumpRef.current < JUMP_QUIET_MS) {
        // بعد قفزة: لا تظهر «جاري التحميل» إلا إن طال الانتظار
        setTimeout(() => { if (audio.readyState < 3 && !audio.paused) showLoading(); }, JUMP_WAIT_SHOW_MS);
        return;
      }
      showLoading();
    };
    const onMeta = () => {
      if (resumeRef.current != null) {
        audio.currentTime = resumeRef.current;
        resumeRef.current = null;
        return;
      }
      if (!pendingSeekRef.current) return;
      pendingSeekRef.current = false;
      const s = radioState();
      if (s && radioKey(s) === loadedKeyRef.current) audio.currentTime = s.position;
    };
    const onEnded = () => {
      if (!wantPlayRef.current) return;
      if (modeRef.current === 'lecture') {
        // انتهى اللقاء: ننتقل تلقائيًا إلى اللقاء التالي في الكورس
        // (في الكورس عالسريع: التالي من اللقاءات المفتوحة فقط)
        const id = lectureRef.current;
        const v = variantRef.current;
        savePos(id, v, 0);
        progress.save();
        const next = lectureNext(id, v);
        if (next) {
          playLecture(next, v);
          if (location.hash === lectureHash(id, v)) go(lectureHash(next, v));
        } else {
          stop();
        }
        return;
      }
      // انتهى اللقاء المتأخر: العودة إلى البث المباشر
      if (shiftedRef.current) { syncAndPlay(); return; }
      const s = radioState();
      if (s && radioKey(s) !== loadedKeyRef.current) {
        syncAndPlay();
      } else {
        // انتهى الملف قبل موعده في البث؛ ننتظر بدء اللقاء التالي
        endedRef.current = true;
        updateStatus('next');
      }
    };
    // إيقاف من النظام (مكالمة، تطبيق آخر، شاشة القفل) يُحترم ولا يُستأنف تلقائيًا
    const onPause = () => {
      clearTimeout(stallRef.current.timer); stallRef.current.at = 0;
      if (!wantPlayRef.current || audio.ended) return;
      if (Date.now() - lastAttemptRef.current < 1500) return;
      if (statusRef.current === 'offline') return;
      wantPlayRef.current = false;
      setIsPlaying(false);
      updateStatus('idle');
      if (isRadio() && loadedKeyRef.current) setShifted(true);
      progress.save();
    };
    const onError = () => {
      const local = isLocal();
      // يُسجَّل اللقاء والنسخة مع الخطأ، مثل lecture:L05 (flecture = النسخة السريعة من الكورس)
      if (audio.error) errLog.add('audio ' + (audio.error.code || '') + ' ' + (loadedKeyRef.current || modeRef.current) + (local ? ' local' : '') + (navigator.onLine ? '' : ' offline'));
      // تعذّر تشغيل الملف المحمّل: يُجهَّز رابطه من جديد في المحاولة التالية
      if (local) offline.invalidate(variantRef.current, lectureRef.current);
      if (wantPlayRef.current && audio.getAttribute('src')) updateStatus(navigator.onLine || local ? 'error' : 'offline');
    };
    const onOffline = () => { if (wantPlayRef.current && !isLocal()) updateStatus('offline'); };
    const onOnline = () => {
      if (!wantPlayRef.current) return;
      if (isLocal()) return;
      if (!isRadio()) return loadLecture(true);
      if (shiftedRef.current) return reloadInPlace();
      syncAndPlay(true);
    };

    const events = {
      timeupdate: onTime, seeking: onSeeking, playing: onPlaying, waiting: onWaiting, play: onPlay,
      loadedmetadata: onMeta, ended: onEnded, pause: onPause, error: onError,
    };
    Object.entries(events).forEach(([e, fn]) => audio.addEventListener(e, fn));
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      Object.entries(events).forEach(([e, fn]) => audio.removeEventListener(e, fn));
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [syncAndPlay, loadLecture, playLecture, stop, updateStatus, reloadInPlace]);

  // المراقب: يعالج التوقف والتعليق، ويعيد البث المباشر إلى موضعه الحي
  useEffect(() => {
    const tick = () => {
      if (!wantPlayRef.current) return;
      const audio = audioRef.current;
      if (!audio) return;
      const sinceAttempt = Date.now() - lastAttemptRef.current;
      const st = statusRef.current;
      if (st === 'blocked' || st === 'offline') return;

      // المهلة قبل إعادة التحميل تزيد مع كل محاولة متتالية (15 ثم 25 ثم 40 ثانية)، حتى تكتمل المحاولة
      const stallWait = [15000, 25000, 40000][Math.min(stallsRef.current, 2)];
      const stalled = Date.now() - lastProgressRef.current > stallWait && sinceAttempt > stallWait;

      // الكورس والبث المتأخر: لا مزامنة مع البث، بل معالجة التعليق فقط
      if (modeRef.current === 'lecture' || shiftedRef.current) {
        const reload = () => { stallsRef.current++; modeRef.current === 'lecture' ? loadLecture(true) : reloadInPlace(); };
        if (st === 'error') { if (sinceAttempt > 8000) reload(); return; }
        if (audio.paused) { if (sinceAttempt > 6000) { lastAttemptRef.current = Date.now(); playAudio(); } return; }
        if (stalled) reload();
        return;
      }

      const s = radioState();
      if (!s) return;
      if (radioKey(s) !== loadedKeyRef.current) return syncAndPlay();
      if (endedRef.current) return;
      if (st === 'error') { if (sinceAttempt > 8000) syncAndPlay(true); return; }
      if (audio.paused) { if (sinceAttempt > 6000) syncAndPlay(); return; }
      if (stalled) { stallsRef.current++; return syncAndPlay(true); }
      if (audio.readyState >= 3 && Math.abs(audio.currentTime - s.position) > 15) {
        lastSampleRef.current = null;
        audio.currentTime = s.position;
      }
    };
    const id = setInterval(tick, 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [syncAndPlay, loadLecture, playAudio, reloadInPlace]);

  // شاشة القفل والإشعارات
  const nowId = mode === 'lecture' ? lectureId : (live && live.track.id);
  useEffect(() => { if (nowId) setMediaMeta(nowId); }, [nowId]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const set = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) {}
    };
    set('play', () => { if (modeRef.current) resume(); });
    set('pause', () => stop());
    set('stop', () => stop());
    if (mode === 'lecture') {
      set('seekbackward', () => skip(-SKIP_SECONDS));
      set('seekforward', () => skip(SKIP_SECONDS));
      set('seekto', (d) => { if (d && lectureRef.current) seekLecture(lectureRef.current, d.seekTime, variantRef.current); });
      set('previoustrack', () => { const p = lecturePrev(lectureRef.current, variantRef.current); if (p) playLecture(p, variantRef.current); });
      set('nexttrack', () => { const n = lectureNext(lectureRef.current, variantRef.current); if (n) playLecture(n, variantRef.current); });
    } else {
      ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach(a => set(a, null));
    }
  }, [mode, resume, stop, skip, seekLecture, playLecture]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'; } catch (e) {}
  }, [isPlaying]);

  return {
    audioRef, mode, lectureId, variant, isPlaying, status, live, shifted, currentTime, skipSil, setSkipSil,
    slowNet, hideSlowNet: () => setSlowNet(null),
    toggleRadio, goLive, toggleLecture, playLecture, seekLecture, skip, stop, retry,
  };
}

// بيانات شاشة القفل: اسم مختصر محايد مراعاةً للخصوصية
function setMediaMeta(id, course) {
  if (!('mediaSession' in navigator)) return;
  try {
    const label = t(course ? 'mediaCourse' : 'mediaArtist');
    navigator.mediaSession.metadata = new MediaMetadata({
      title: id ? shortTitle(id) : label, artist: label, album: '',
      artwork: [
        { src: 'icon-192-v2.png', sizes: '192x192', type: 'image/png' },
        { src: 'icon-512-v2.png', sizes: '512x512', type: 'image/png' },
      ],
    });
  } catch (e) {}
}
setMediaMeta(null);

// حالة الراديو كما تُعرض: البث الحي، أو اللقاء المتأخر إذا أوقفه المستمع
function radioView(player, mode, now) {
  const own = player.mode === mode;
  const liveState = STATIONS[mode].getState(now);
  const shifted = own && player.shifted && player.live;
  const active = own && player.isPlaying;
  const s = (active || shifted) && player.live ? player.live : liveState;
  const time = active || shifted ? player.currentTime : s.position;
  const behind = !!shifted && (s.track.id !== liveState.track.id
    || Math.abs(time - liveState.position) > BEHIND_SECONDS);
  return { s, time, active, behind, status: active ? player.status : 'idle' };
}

// =====================
// تسجيل الحضور
// كل زائر يسجّل نفسه فقط، ويُحذف تلقائيًا من الخادم عند انقطاع اتصاله
// at: المكان الذي يوجد فيه الزائر (home أو normal أو fast أو course)
// =====================
// =====================
// توفير الاتصالات: للخطة المجانية حد أقصى من الاتصالات المتزامنة بقاعدة البيانات، وكل تبويب مفتوح يشغل اتصالًا
// التبويب الذي يبقى في الخلفية دون صوت خمس دقائق يُفصل، ويعود فور الرجوع إليه أو بدء الصوت فيه
// من يستمع والشاشة مقفلة يبقى متصلًا، فهو مستمع فعلي ويُسجَّل وقته
// =====================
const IDLE_DISCONNECT_MS = 5 * 60 * 1000;
(() => {
  let timer = null;
  let off = false;
  const playing = () => { const a = document.querySelector('audio'); return !!a && !a.paused; };
  const wake = () => { clearTimeout(timer); timer = null; if (off) { off = false; database.goOnline(); } };
  const arm = () => { clearTimeout(timer); timer = setTimeout(sleep, IDLE_DISCONNECT_MS); };
  const sleep = () => {
    timer = null;
    if (document.visibilityState !== 'hidden' || off) return;
    if (playing()) return arm();          // ما زال يستمع: يُعاد الفحص لاحقًا
    off = true;
    database.goOffline();
  };
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'hidden' ? arm() : wake()));
  // بدء الصوت من أزرار شاشة القفل والتبويب مفصول
  document.addEventListener('play', () => { if (off) { off = false; database.goOnline(); } if (document.visibilityState === 'hidden') arm(); }, true);
})();

// أماكن الاستماع: من يقف في غيرها (الرئيسية، الحساب، المجتمع) لا يُعدّ مستمعًا
const LISTEN_PLACES = ['normal', 'fast', 'course'];

// السجل المتروك: سجل في /status لم يحذفه الخادم عند انقطاع صاحبه (تبويب جمّده الجهاز، أو انقطاع في لحظة التسجيل).
// كل زائر متصل يجدّد «آخر ظهور» في /seen كل 10 دقائق، ولا يتابع /seen أحد فلا يُوزَّع التجديد على الزوار.
// وكل زائر عند اتصاله يقرأ /seen مرة واحدة ويحذف السجلات التي لم تتجدد منذ أكثر من 25 دقيقة
const SEEN_EVERY_MS = 10 * 60 * 1000;
const SEEN_STALE_MS = 25 * 60 * 1000;

async function sweepStalePresence(myKey) {
  try {
    const [st, sn] = await Promise.all([database.ref('/status').once('value'), database.ref('/seen').once('value')]);
    const status = st.val() || {}, seen = sn.val() || {};
    const limit = serverNow() - SEEN_STALE_MS;
    const updates = {};
    Object.entries(status).forEach(([k, v]) => {
      if (k === myKey) return;
      const last = Math.max(Number(seen[k]) || 0, Number(v && v.since) || 0);
      if (last < limit) updates['/status/' + k] = null;
    });
    Object.entries(seen).forEach(([k, ts]) => {
      if (k !== myKey && !(Number(ts) >= limit) && !status[k]) updates['/seen/' + k] = null;
    });
    if (Object.keys(updates).length) await database.ref().update(updates);
  } catch (e) { /* التنظيف ليس ضروريًا لعمل الموقع */ }
}

function usePresence(at) {
  const [users, setUsers] = useState([]);
  const atRef = useRef(at);
  const myRefHolder = useRef(null);

  useEffect(() => {
    let code = null;
    let connected = false;
    let disposed = false;
    let swept = false;
    let written = null;   // آخر سجل كُتب فعلًا لهذا الاتصال
    const key = 'd' + DEVICE_ID;
    const seenRef = database.ref('/seen/' + key);
    const touchSeen = () => seenRef.set(firebase.database.ServerValue.TIMESTAMP).catch(() => {});

    const register = () => {
      if (disposed || !connected || !code || myRefHolder.current) return;
      const ref = database.ref('/status/' + key);
      myRefHolder.current = ref;
      // /seen منفصل حتى لا يتعطل التسجيل في /status إن رُفض (قبل نشر القواعد مثلًا)
      seenRef.onDisconnect().remove().catch(() => {});
      ref.onDisconnect().remove()
        .then(() => {
          ref.set({ countryCode: code, at: atRef.current, since: firebase.database.ServerValue.TIMESTAMP })
            .then(() => { if (myRefHolder.current === ref) written = ref; }).catch(() => {});
          touchSeen();
          if (!swept) { swept = true; setTimeout(() => sweepStalePresence(key), 3000); }
        })
        .catch(console.error);
    };

    getCountryCode().then(c => { code = c; register(); });

    const connRef = database.ref('.info/connected');
    const onConn = connRef.on('value', snap => {
      connected = snap.val() === true;
      // عند انقطاع الاتصال يحذف الخادم السجل القديم، وعند العودة يُسجَّل من جديد
      if (!connected) { myRefHolder.current = null; written = null; return; }
      register();
    });

    const beat = setInterval(() => { if (connected && myRefHolder.current) touchSeen(); }, SEEN_EVERY_MS);

    const statusRef = database.ref('/status');
    const onStatus = statusRef.on('value', snap => {
      const list = [];
      snap.forEach(child => { const v = child.val(); if (v) list.push(v); });
      setUsers(list);
      // إن حُذف سجلي وأنا متصل (حذفه زائر آخر ظنًّا أنه متروك بعد أن جمّد الجهاز التبويب) يُكتب من جديد
      if (connected && written && myRefHolder.current === written && !snap.hasChild(key)) {
        myRefHolder.current = null; written = null;
        register();
      }
    });

    return () => {
      disposed = true;
      clearInterval(beat);
      connRef.off('value', onConn);
      statusRef.off('value', onStatus);
      if (myRefHolder.current) { myRefHolder.current.remove().catch(() => {}); seenRef.remove().catch(() => {}); }
    };
  }, []);

  useEffect(() => {
    atRef.current = at;
    if (myRefHolder.current) myRefHolder.current.update({ at }).catch(() => {});
  }, [at]);

  return users;
}

// =====================
// أيقونات خطية بسيطة
// =====================
const ICON_PATHS = {
  play: html`<path d="M7 4v16l13-8z" fill="currentColor" stroke="none"></path>`,
  pause: html`<g fill="currentColor" stroke="none"><rect x="6" y="4" width="4" height="16" rx="1"></rect><rect x="14" y="4" width="4" height="16" rx="1"></rect></g>`,
  eye: html`<g><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"></path><circle cx="12" cy="12" r="3"></circle></g>`,
  eyeOff: html`<g><path d="M17.94 17.94A10.07 10.07 0 0 1 12 19c-7 0-11-7-11-7a18.45 18.45 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 7 11 7a18.5 18.5 0 0 1-2.16 3.19"></path><path d="M1 1l22 22"></path></g>`,
  key: html`<g><circle cx="7.5" cy="15.5" r="4.5"></circle><path d="M10.7 12.3L20 3"></path><path d="M16 7l3 3"></path><path d="M14 9l2 2"></path></g>`,
  leaf: html`<g><path d="M6 18C6 10 11 5.5 19 5c.2 8-4.6 13-12 13z"></path><path d="M6 18c2.6-3.6 5.4-6.2 9-8.4"></path></g>`,
  user: html`<g><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4 4-6 8-6s8 2 8 6"></path></g>`,
  check: html`<path d="M5 12l5 5L20 7"></path>`,
  back: html`<path d="M9 6l6 6-6 6"></path>`,
  home: html`<g><path d="M4 10.5L12 4l8 6.5V20a1 1 0 0 1-1 1h-4.5v-6h-5v6H5a1 1 0 0 1-1-1z"></path></g>`,
  book: html`<g><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"></path><path d="M4 19V5"></path><path d="M9 7h6"></path></g>`,
  radio: html`<g><circle cx="12" cy="12" r="2"></circle><path d="M8.5 8.5a5 5 0 0 0 0 7"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M5.6 5.6a9 9 0 0 0 0 12.8"></path><path d="M18.4 5.6a9 9 0 0 1 0 12.8"></path></g>`,
  chart: html`<g><path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M22 20H2"></path></g>`,
  download: html`<g><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path></g>`,
  list: html`<g><path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><circle cx="4.5" cy="6" r="1"></circle><circle cx="4.5" cy="12" r="1"></circle><circle cx="4.5" cy="18" r="1"></circle></g>`,
  chat: html`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path>`,
  heart: html`<path d="M12 20s-7-4.3-9-8.6C1.8 8.4 3.8 5 7 5c1.9 0 3.2 1 4 2.2h2C13.8 6 15.1 5 17 5c3.2 0 5.2 3.4 4 6.4C19 15.7 12 20 12 20z"></path>`,
  heartFill: html`<path d="M12 20s-7-4.3-9-8.6C1.8 8.4 3.8 5 7 5c1.9 0 3.2 1 4 2.2h2C13.8 6 15.1 5 17 5c3.2 0 5.2 3.4 4 6.4C19 15.7 12 20 12 20z" fill="currentColor"></path>`,
  dots: html`<g fill="currentColor" stroke="none"><circle cx="5" cy="12" r="1.8"></circle><circle cx="12" cy="12" r="1.8"></circle><circle cx="19" cy="12" r="1.8"></circle></g>`,
  toRight: html`<g><path d="M6 5l10 7-10 7z" fill="currentColor"></path><path d="M19 5v14"></path></g>`,
  toLeft: html`<g><path d="M18 5L8 12l10 7z" fill="currentColor"></path><path d="M5 5v14"></path></g>`,
  lock: html`<g><rect x="5" y="11" width="14" height="9" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></g>`,
  plus: html`<g><path d="M12 5v14"></path><path d="M5 12h14"></path></g>`,
  trash: html`<g><path d="M4 7h16"></path><path d="M9 7V4h6v3"></path><path d="M6 7l1 13h10l1-13"></path></g>`,
  // اللقاء محفوظ على الجهاز: هاتف (السهم للتحميل، وعلامة الصح للقاء المكتمل)
  saved: html`<g><rect x="6.5" y="2.5" width="11" height="19" rx="2.6"></rect><path d="M10.5 18.2h3"></path><path d="M9.6 6.4h4.8" strokeOpacity=".55"></path></g>`,
  // رابط يفتح صفحة أخرى، مرسوم باتجاه القراءة العربية
  external: html`<g><path d="M10 3H3v7"></path><path d="M3 3l9 9"></path><path d="M5 14v5a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-5"></path></g>`,
  note: html`<g><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"></path></g>`,
};
function Icon({ name, size = 18 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

// =====================
// عناصر مشتركة
// =====================
function Stars() {
  const stars = useMemo(() => Array.from({ length: 40 }, (_, i) => ({
    id: i,
    size: Math.random() * 2.5 + 0.5,
    top: Math.random() * 100,
    left: Math.random() * 100,
    dur: (Math.random() * 4 + 2).toFixed(1),
    delay: (Math.random() * 5).toFixed(1),
    op: (Math.random() * 0.18 + 0.04).toFixed(2),
  })), []);
  return html`<div className="stars">
    ${stars.map(s => html`<div key=${s.id} className="star" style=${{
      width: s.size, height: s.size, top: `${s.top}%`, left: `${s.left}%`,
      '--dur': `${s.dur}s`, '--delay': `${s.delay}s`, '--op': s.op,
    }} />`)}
  </div>`;
}

function LiveDot() {
  return html`<span className="live-dot pulse-dot"></span>`;
}

// علم الدولة من رمزها (SA → 🇸🇦)، والكرة الأرضية لمن لا تُعرف دولته
const UNKNOWN_FLAG = '\u{1F30D}';
const flagOf = (code) => (/^[A-Za-z]{2}$/.test(code || '') && code.toUpperCase() !== 'XX'
  ? String.fromCodePoint(...[...code.toUpperCase()].map(ch => 0x1F1A5 + ch.charCodeAt(0)))
  : UNKNOWN_FLAG);

// عدد كل من يفتح الموقع الآن، والزائر نفسه منهم؛ لا يقل عن 1 لأن صاحب الصفحة متصل.
// الضغط عليه يظهر أعلام الدول وعدد كل دولة، من الأكثر إلى الأقل
function OnlineBadge({ users }) {
  const count = Math.max(1, users.length);
  const by = {};
  users.forEach(u => { const f = flagOf(u.countryCode); by[f] = (by[f] || 0) + 1; });
  if (!users.length) by[UNKNOWN_FLAG] = 1;
  const rows = Object.entries(by).sort((a, b) => b[1] - a[1] || (a[0] === UNKNOWN_FLAG) - (b[0] === UNKNOWN_FLAG));
  return html`<${Popover} label=${t('onlineNow', { n: count })} btnClass="chip online-chip" wrapClass="online-wrap" popWidth=${96}
    button=${html`<${LiveDot} />${count}`}>
    <span className="online-flags">${rows.map(([f, n]) => html`<span className="flag-row" key=${f}><span className="flag">${f}</span><b>${n}</b></span>`)}</span>
  <//>`;
}

function BackButton({ to }) {
  return html`<button className="back" onClick=${() => goBack(to)}>
    <${Icon} name="back" />${t('back')}
  </button>`;
}

// الاسم الخاص: يظهر صغيرًا في أعلى كل الصفحات
function NameChip() {
  useAccountVersion();
  useProgressVersion();
  const own = html`<${LevelBadge} level=${progress.level()} />`;
  if (!account.loggedIn) {
    return html`<${React.Fragment}>${own}<button className="chip name-chip-cta" onClick=${() => go('#/account')}>
      <${Icon} name="user" size=${14} />${t('saveProgressShort')}
    </button><//>`;
  }
  const hidden = account.isHidden();
  const name = account.name;
  return html`<${React.Fragment}>${own}<div className="chip name-chip">
    <button className="name-chip-main" onClick=${() => go('#/account')} aria-label=${t('accountTitle')}>
      <span className=${'sync-dot sync-' + account.status}></span>
      <bdi dir="ltr" className="name-value">${hidden ? '•'.repeat(Math.min(8, name.length)) : name}</bdi>
    </button>
    <button className="eye" onClick=${() => account.setHidden(!hidden)}
      aria-label=${hidden ? t('showName') : t('hideName')} title=${hidden ? t('showName') : t('hideName')}>
      <${Icon} name=${hidden ? 'eye' : 'eyeOff'} size=${15} />
    </button>
  </div><//>`;
}

// =====================
// تذكير برمز الدخول كل 4 أيام: لا بريد ولا رقم هاتف، فالرمز هو المفتاح الوحيد للحساب.
// الرمز مخفي حتى يُضغط عليه (خصوصية من حوله)، والنافذة لا تُغلق إلا بكتابته صحيحًا لتثبيته في الذاكرة
// =====================
const CODE_REMIND_KEY = 'codeRemindAt';
const CODE_REMIND_MS = 4 * 86400000;
function CodeReminder({ route }) {
  useAccountVersion();
  useProgressVersion();
  const [, setTick] = useState(0);
  const [shown, setShown] = useState(false);
  const [typed, setTyped] = useState('');
  const [wrong, setWrong] = useState(false);
  const [shot, setShot] = useState(false);
  const code = account.loggedIn ? account.name : null;
  // يُعاد الفحص كل دقيقة، فتظهر النافذة لمن يبقي الموقع مفتوحًا أيامًا
  useEffect(() => { const id = setInterval(() => setTick(x => x + 1), 60000); return () => clearInterval(id); }, []);
  if (!code) return null;
  const last = Number(storage.get(CODE_REMIND_KEY)) || 0;
  if (Date.now() - last < CODE_REMIND_MS) return null;
  // لا تزاحم نوافذ أخرى: رسالة البداية في الرئيسية، والتهنئة، وصفحتا الحساب والإدارة
  if (route.page === 'account' || route.page === 'staff') return null;
  if (route.page === 'home' && storage.get(INTRO_NEVER_KEY) !== '1' && storage.get(INTRO_DAY_KEY) !== dayKey()) return null;
  if (progress.level() > progress.congratsSeen()) return null;
  const ok = normalizeName(typed) === normalizeName(code);
  const done = () => {
    if (!ok) { setWrong(true); setTimeout(() => setWrong(false), 600); return; }
    storage.set(CODE_REMIND_KEY, String(Date.now()));
    setTyped(''); setShown(false);
    setTick(x => x + 1);
  };
  return html`<div className="modal-back" role="presentation">
    <div className="modal code-remind" role="dialog" aria-modal="true" aria-labelledby="cr-title">
      <p className="intro-title" id="cr-title">${t('codeRemindTitle')}</p>
      <p>${t('codeRemindKey')}</p>
      <button className=${'code-box' + (shown ? ' open' : '')} onClick=${() => setShown(v => !v)} aria-label=${t('codeRemindShow')}>
        ${shown ? html`<bdi dir="ltr">${code}</bdi>` : html`<span>••••••••</span><small>${t('codeRemindShow')}</small>`}
      </button>
      <p>${t('codeRemindWhy')}</p>
      <p>${t('codeRemindType')}</p>
      <input className=${'name-input' + (wrong ? ' shake' : '')} dir="ltr" value=${typed} autoComplete="off" autoCapitalize="none" spellCheck="false"
        placeholder=${t('codeRemindPlaceholder')} aria-label=${t('codeRemindPlaceholder')}
        onInput=${e => setTyped(e.target.value)} onKeyDown=${e => { if (e.key === 'Enter') done(); }} />
      ${wrong && html`<p className="form-error">${t('codeRemindWrong')}</p>`}
      <div className="modal-actions">
        <button className="small-btn" disabled=${!typed.trim()} onClick=${done}>${t('codeRemindDone')}</button>
        <button className="link-btn" onClick=${() => setShot(true)}>${t('codeShotOpen')}</button>
      </div>
      <p className="hint">${t('codeRemindWarn')}</p>
      ${shot && html`<${CodeShot} code=${code} onClose=${() => setShot(false)} />`}
    </div>
  </div>`;
}

// تهنئة تظهر مرة واحدة عند كل مرتبة جديدة (على كل الأجهزة، لأن آخر ما عُرض يُحفظ مع التقدّم)
function CongratsModal() {
  useProgressVersion();
  const l = progress.level();
  if (l < 0 || l <= progress.congratsSeen()) return null;
  const text = l === 0 ? t('congratsCoreText')
    : t(l >= 5 ? 'congratsMaxText' : 'congratsLevelText', { times: timesText(l), n: l });
  return html`<div className="modal-back" role="presentation">
    <div className="modal congrats" role="dialog" aria-modal="true" aria-labelledby="cg-title">
      <div className=${'cg-badge ' + (l === 0 ? 'lvl-core' : l >= 5 ? 'lvl-gold lvl-max' : 'lvl-gold')}>
        ${l === 0 ? html`<${Icon} name="leaf" size=${26} />` : html`<bdi>${l}</bdi>`}
      </div>
      <p className="intro-title" id="cg-title">${t(l === 0 ? 'congratsCoreTitle' : 'congratsLevelTitle')}</p>
      <p>${text}</p>
      ${!account.loggedIn && html`<p className="hint">${t('congratsNeedAccount')}</p>`}
      <div className="modal-actions">
        <button className="small-btn" onClick=${() => progress.setCongratsSeen(l)}>${t('introOk')}</button>
      </div>
    </div>
  </div>`;
}

// العدادات الظاهرة: عدد المشتركين وساعات الاستماع من الجميع
// (الزيارات والمستمعون القدامى ما زالوا يُحسبون في القاعدة لكن لا يظهرون)
// آخر قراءة تُحفظ على الجهاز وتظهر فورًا، حتى دون اتصال، ثم تتحدّث عند وصول الجديد
const STATS_CACHE_KEY = 'statsCache';
const COMMUNITY_SORT_KEY = 'communitySort';
const INTRO_NEVER_KEY = 'introNever';
const INTRO_DAY_KEY = 'introClosedDay';
const NUDGE_KEY = 'nameNudgeClosedAt';
const NUDGE_AFTER_SEC = 20 * 60;
const NUDGE_AGAIN_MS = 7 * 24 * 3600 * 1000;
function TotalStats() {
  const [stats, setStats] = useState(() => {
    try {
      const c = JSON.parse(storage.get(STATS_CACHE_KEY) || 'null');
      if (c && typeof c.subscribers === 'number') return c;
    } catch (e) {}
    return { subscribers: 0, listen_seconds: 0 };
  });
  useEffect(() => {
    const ref = database.ref('/stats');
    const l = ref.on('value', snap => {
      const d = snap.val();
      if (!d) return;
      const next = { subscribers: d.subscribers || 0, listen_seconds: d.listen_seconds || 0 };
      setStats(next);
      storage.set(STATS_CACHE_KEY, JSON.stringify(next));
    });
    return () => ref.off('value', l);
  }, []);
  return html`<div className="chip stats">
    <div><b>${fmtCount(stats.subscribers)}</b><small>${t('subscribersStat')}</small></div>
    <span className="divider"></span>
    ${stats.listen_seconds < 3600
      ? html`<div><b>${fmtCount(stats.listen_seconds / 60)}</b><small>${t('listenMinutesStat')}</small></div>`
      : html`<div><b>${fmtCount(stats.listen_seconds / 3600)}</b><small>${t('listenHoursStat')}</small></div>`}
  </div>`;
}

// ساعات الاستماع العامة: يُجمع الوقت ويُرسل كل دقيقة، وبحد أقصى 120 ثانية في المرة (حسب قواعد Firebase)
const listenStats = (() => {
  let pending = 0;
  const flush = () => {
    const sec = Math.min(120, Math.floor(pending));
    if (sec < 1 || !navigator.onLine) return;
    pending -= sec;
    database.ref('/stats/listen_seconds').set(firebase.database.ServerValue.increment(sec))
      .catch(() => { pending += sec; });
  };
  setInterval(flush, 60000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  return { add(sec) { if (sec > 0) pending += sec; } };
})();

function FacebookLink() {
  return html`<a className="icon-btn" href="https://www.facebook.com/groups/1594701261071238"
      target="_blank" rel="noopener noreferrer" aria-label=${t('facebook')} title=${t('facebook')}>
    <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path fillRule="evenodd" d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z" clipRule="evenodd"/>
    </svg>
  </a>`;
}

// نافذة صغيرة تظهر عند الضغط على زر، بدل أن يشغل محتواها مساحة في الصفحة
// يُحسب مكانها لتبقى دائمًا داخل الشاشة، وتُغلق بالضغط خارجها أو بالتمرير
// keepOpen: الضغط داخلها لا يغلقها (لمحتوى فيه أزرار تتغير حالتها)
function Popover({ label, btnClass, wrapClass, button, children, keepOpen, btnProps, popWidth }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  const popRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = (e) => {
      // زر داخل النافذة قد يختفي بعد الضغط عليه (تتغيّر محتوياتها)، فلا تُغلق بسببه
      if (keepOpen && e && e.type === 'click' && popRef.current && (popRef.current.contains(e.target) || !e.target.isConnected)) return;
      setPos(null);
    };
    const id = setTimeout(() => {
      document.addEventListener('click', close);
      window.addEventListener('scroll', close, { passive: true });
    }, 0);
    return () => { clearTimeout(id); document.removeEventListener('click', close); window.removeEventListener('scroll', close); };
  }, [pos]);
  const openTip = (e) => {
    e.stopPropagation();
    if (pos) return setPos(null);
    const r = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const w = Math.min(popWidth || 260, vw - 32);
    const left = Math.max(16, Math.min(vw - 16 - w, r.left + r.width / 2 - w / 2));
    setPos({ top: r.bottom + 8, left, width: w });
  };
  return html`<span className=${'info' + (wrapClass ? ' ' + wrapClass : '')}>
    <button ref=${btnRef} className=${btnClass} aria-label=${label} aria-expanded=${!!pos} onClick=${openTip} ...${btnProps || {}}>${button}</button>
    ${pos && html`<span ref=${popRef} className="info-pop" role=${keepOpen ? 'dialog' : 'tooltip'} aria-label=${label} style=${pos}>${children}</span>`}
  </span>`;
}

function InfoTip({ label, text, children }) {
  return html`<${Popover} label=${label} btnClass="info-btn" button="i">${text}${children}<//>`;
}

function MiniBar({ value }) {
  return html`<div className="bar"><div className="fill" style=${{ width: Math.min(100, value) + '%' }}></div></div>`;
}

// شريط الأجزاء المسموعة في قائمة الكورس
function HeardBar({ id }) {
  const segs = progress.segments(id);
  return html`<div className="bar heard-bar">
    ${segs.map(([a, b], i) => html`<span key=${i} className="heard-seg"
      style=${{ insetInlineStart: a + '%', width: Math.max(0.6, b - a) + '%' }}></span>`)}
  </div>`;
}

// شريط التشغيل في صفحة اللقاء: شريط واحد يجمع
// موضع الاستماع، والأجزاء المسموعة سابقًا، وأماكن التعليقات
// plain: للنسخة السريعة، بلا أجزاء مسموعة ولا علامات. noteMarks: أماكن ملاحظات المستخدم
function SeekBar({ id, value, duration, marks, noteMarks, plain, onInput, onCommit }) {
  const segs = plain ? [] : progress.segments(id);
  const pos = Math.min(100, (value / duration) * 100 || 0);
  return html`<div className="seekbar">
    <div className="sb-marks" aria-hidden="true">
      ${(marks || []).map((s, i) => html`<span key=${i} className="sb-mark"
        style=${{ insetInlineStart: Math.min(100, s / duration * 100) + '%' }}></span>`)}
      ${(noteMarks || []).map((s, i) => html`<span key=${'n' + i} className="sb-mark sb-mark-note"
        style=${{ insetInlineStart: Math.min(100, s / duration * 100) + '%' }}></span>`)}
    </div>
    <div className="sb-track" aria-hidden="true">
      ${segs.map(([a, b], i) => html`<span key=${i} className="sb-heard"
        style=${{ insetInlineStart: a + '%', width: Math.max(0.6, b - a) + '%' }}></span>`)}
      <span className="sb-played" style=${{ width: pos + '%' }}></span>
    </div>
    <span className="sb-thumb" style=${{ insetInlineStart: pos + '%' }} aria-hidden="true"></span>
    <input type="range" min="0" max=${duration} step="1" value=${Math.floor(value)} aria-label=${t('seek')}
      onInput=${e => onInput(parseFloat(e.target.value))}
      onChange=${e => onInput(parseFloat(e.target.value))}
      onMouseUp=${onCommit} onTouchEnd=${onCommit} onKeyUp=${onCommit} onBlur=${onCommit} />
  </div>`;
}

// =====================
// التعليقات
// =====================
// قائمة فارغة مميزة تعني «لم يصل شيء بعد»، فيظهر هيكل التحميل بدل «لا توجد تعليقات»
const LOADING_LIST = Object.freeze([]);
function Skeleton({ rows = 3 }) {
  return html`<ul className="skel-list" aria-busy="true" aria-label=${t('statusLoading')}>
    ${Array.from({ length: rows }, (_, i) => html`<li key=${i} className="skel-item">
      <span className="skel skel-name"></span><span className="skel skel-line"></span><span className="skel skel-line short"></span>
    </li>`)}
  </ul>`;
}
function useComments(lid) {
  const [list, setList] = useState(() => (lid ? LOADING_LIST : []));
  useEffect(() => {
    setList(lid ? LOADING_LIST : []);
    if (!lid) return;
    return commentsApi.subscribe(lid, setList);
  }, [lid]);
  return list;
}

// أحدث التعليقات من كل اللقاءات، لمعرفة الجديد منها
function useRecentFeed(limit) {
  const [list, setList] = useState(LOADING_LIST);
  useEffect(() => commentsApi.subscribeRecent(limit, setList), [limit]);
  return list;
}

function useCommentCounts() {
  const [counts, setCounts] = useState({});
  useEffect(() => commentsApi.subscribeCounts(setCounts), []);
  return counts;
}

// وقت التعليق كما في التطبيقات الكبيرة: «الآن»، «منذ 5 دقائق»، «منذ 3 ساعات» في اليوم نفسه،
// ثم «أمس 9:15 م»، ثم «12 نوفمبر، 9:15 م»، ومن سنة سابقة «12 نوفمبر 2025»
const relTime = (() => {
  const mk = (opts) => { try { return new Intl.DateTimeFormat('ar-u-nu-latn', opts); } catch (e) { return null; } };
  let rtf = null;
  try { rtf = new Intl.RelativeTimeFormat('ar-u-nu-latn', { numeric: 'auto' }); } catch (e) {}
  const fTime = mk({ hour: 'numeric', minute: '2-digit' });
  const fDay = mk({ day: 'numeric', month: 'long' });
  const fYear = mk({ day: 'numeric', month: 'long', year: 'numeric' });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return (ts) => {
    if (!ts || !fTime) return '';
    const now = new Date(serverNow());
    const diff = Math.max(0, now.getTime() - ts);
    const d = new Date(ts);
    if (diff < 60000) return t('justNow');
    const today = startOfDay(now);
    if (ts >= today && rtf) {
      return diff < 3600000 ? rtf.format(-Math.floor(diff / 60000), 'minute') : rtf.format(-Math.floor(diff / 3600000), 'hour');
    }
    if (ts >= today - 86400000) return t('yesterdayAt', { t: fTime.format(d) });
    if (d.getFullYear() === now.getFullYear()) return t('dateAt', { d: fDay.format(d), t: fTime.format(d) });
    return fYear.format(d);
  };
})();

function useSilencesVersion() {
  const [v, setV] = useState(0);
  useEffect(() => silences.subscribe(() => setV(x => x + 1)), []);
  return v;
}

function useStaffVersion() {
  const [v, setV] = useState(0);
  useEffect(() => staff.subscribe(() => setV(x => x + 1)), []);
  return v;
}

// =====================
// شارة المرتبة بجانب الاسم: ورقة خضراء لمن أكمل الأساسيات، ودائرة ذهبية برقم مرات إكمال الكورس كله،
// وتمتلئ ذهبًا عند الخامسة. الضغط عليها يبيّن معناها
// =====================
const timesText = (n) => t(n === 1 ? 'timesOne' : n === 2 ? 'timesTwo' : 'timesMany', { n });
const badgeLabel = (l) => (l === 0 ? t('badgeCore') : t('badgeLevel', { times: timesText(l) }));
function useBadgesVersion() {
  const [, setV] = useState(0);
  useEffect(() => badges.subscribe(() => setV(v => v + 1)), []);
}
function LevelBadge({ level }) {
  if (level == null || level < 0) return null;
  const cls = 'lvl-badge ' + (level === 0 ? 'lvl-core' : level >= 5 ? 'lvl-gold lvl-max' : 'lvl-gold');
  const face = level === 0 ? html`<${Icon} name="leaf" size=${11} />` : html`<bdi>${level}</bdi>`;
  return html`<${Popover} label=${badgeLabel(level)} wrapClass="lvl-wrap" btnClass=${cls} button=${face}>${badgeLabel(level)}<//>`;
}

// اسم صاحب التعليق: الاسم المميز بعلامة، أو «أخ ...»
// الاسم الظاهر: اسم المشرف، أو اللقب (افتراضيًا «أخ») ثم الرقم
// الاسم من جدول الأسماء حسب الرقم، ثم الاسم القديم المكتوب في التعليق إن وُجد
const authorName = (n, a, pf) => (a && staff.nameOf(a)) || t('nickName', { p: titles.get(n) || pf || t('nickPrefix'), n });
function CommentAuthor({ c, toMe }) {
  const special = c.a && staff.nameOf(c.a);
  return html`<b className=${special ? 'staff-name' : ''}>
    ${special ? html`<span className="staff-check" aria-hidden="true"><${Icon} name="check" size=${11} /></span>` : ''}${authorName(c.n, c.a, c.pf)}
    ${!special && typeof c.b === 'number' && html`<${LevelBadge} level=${c.b} />`}
    ${toMe ? html`<span className="to-me">${t('repliedToYou')}</span>` : ''}
  </b>`;
}

// فتح لقاء مذكور في تعليق: مع وقت يبدأ منه، وبدونه تُفتح صفحته فقط
let mentionPlayer = null;
function openMention(lid, sec) {
  if (sec != null && mentionPlayer) {
    progress.setPosition(lid, sec);
    mentionPlayer.playLecture(lid);
  }
  go('#/lecture/' + lid);
}

// النص الطويل (أكثر من 5 أسطر) يُطوى ويظهر تحته «عرض المزيد»
function CommentText({ text, maxSec, onTime, replyTo, clamp = true }) {
  const parts = splitRich(text, maxSec);
  const ref = useRef(null);
  const [long, setLong] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!clamp || expanded || !el) return;
    const check = () => setLong(el.scrollHeight > el.clientHeight + 2);
    check();
    const id = setTimeout(check, 300);   // بعد تحميل الخط
    return () => clearTimeout(id);
  }, [text, clamp, expanded]);
  return html`<${React.Fragment}>
    ${replyTo && html`<div className="c-reply-to">${t('replyTo')} <bdi>${replyTo}</bdi></div>`}
    <p ref=${ref} className=${'c-text' + (clamp && !expanded ? ' clamped' : '')}>
      ${parts.map((p, i) => p.lid
        ? html`<button key=${i} className="time-chip mention-chip" onClick=${(e) => { e.stopPropagation(); openMention(p.lid, p.time); }}
            aria-label=${t('openMention', { t: p.text })}><${Icon} name="play" size=${10} /><span>${p.text}</span></button>`
        : p.time != null && onTime
        ? html`<button key=${i} className="time-chip" dir="ltr" onClick=${(e) => { e.stopPropagation(); onTime(p.time); }}
            aria-label=${t('jumpTo', { t: p.text })}>${p.text}</button>`
        : html`<span key=${i}>${p.text}</span>`)}
    </p>
    ${clamp && long && !expanded && html`<button className="more-btn" onClick=${(e) => { e.stopPropagation(); setExpanded(true); }}>${t('showMore')}</button>`}
  <//>`;
}

// اختيار لقاء ووقت اختياري، ثم إدراجه في التعليق كنص مقروء
// الحالة محفوظة في النموذج، حتى يُضاف الاختيار تلقائيًا عند الإرسال دون ضغط «إضافة»
// يعيد نص الذكر، أو null إذا كان الوقت غير صحيح
function mentionFromPick(pick) {
  let sec = null;
  if (pick.time.trim()) {
    sec = parseLooseTime(pick.time);
    if (sec == null || sec > LECTURE_BY_ID[pick.id].normal) return null;
  }
  return mentionText(pick.id, sec);
}

function MentionPicker({ pick, setPick, onInsert, onClose }) {
  const { id, time, bad } = pick;
  const setId = (v) => setPick(p => ({ ...p, id: v }));
  const setTime = (v) => setPick(p => ({ ...p, time: v }));
  const setBad = (v) => setPick(p => ({ ...p, bad: v }));
  const insert = () => {
    const s = mentionFromPick(pick);
    if (s == null) return setBad(true);
    onInsert(s);
  };
  return html`<div className="mention-pick">
    <label><small>${t('mentionPick')}</small>
      <select value=${id} onChange=${e => setId(e.target.value)}>
        ${LECTURES.map(l => html`<option key=${l.id} value=${l.id}>${l.title}</option>`)}
      </select>
    </label>
    <label><small>${t('mentionTime')}</small>
      <input value=${time} dir="ltr" inputMode="text" autoComplete="off" placeholder=${t('mentionTimeHint')}
        onInput=${e => { setTime(e.target.value); setBad(false); }} />
    </label>
    ${bad && html`<p className="form-error">${t('mentionBadTime')}</p>`}
    <div className="c-actions">
      <button type="button" className="small-btn" onClick=${insert}>${t('mentionInsert')}</button>
      <button type="button" className="link-btn muted" onClick=${onClose}>${t('cancel')}</button>
    </div>
  </div>`;
}

// نموذج كتابة تعليق أو رد
function CommentForm({ lid, parent, getTime, onDone, onCancel, compact, placeholder, submitLabel, autoFocus }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  // pick: اختيار «أضف لقاء» ما دامت القائمة مفتوحة
  const newPick = () => ({ id: LECTURE_BY_ID[lid] ? lid : LECTURES[0].id, time: '', bad: false });
  const [pick, setPick] = useState(null);
  const withTime = !!getTime && maxSecOf(lid) > 0;

  const joinText = (v, s) => ((v && !/\s$/.test(v) ? v + ' ' : v) + s + ' ').slice(0, COMMENT_MAX);
  const append = (s) => setText(v => joinText(v, s));
  const addTime = () => append(fmtTime(getTime()));

  const submit = async (e) => {
    e.preventDefault();
    // القائمة مفتوحة ولم يُضغط «إضافة»: يُضاف الاختيار إلى النص قبل الإرسال
    let body = text;
    if (pick) {
      const s = mentionFromPick(pick);
      if (s == null) return setPick(p => ({ ...p, bad: true }));
      body = joinText(text, s);
    }
    setBusy(true); setError(null); setSent(false);
    const res = await commentsApi.add(lid, body, parent);
    setBusy(false);
    if (res.error) {
      setText(body); setPick(null);
      setError(t(res.error, { s: Math.ceil(commentsApi.cooldownLeft() / 1000) }));
    } else { setText(''); setPick(null); setSent(true); if (onDone) onDone(); }
  };

  return html`<form className=${'c-form' + (compact ? ' reply-form' : '')} onSubmit=${submit}>
    ${!compact && html`<div className="c-as">${t('commentAs')} <b>${staff.isStaff ? staff.name : authorName(account.nick, null, null)}</b></div>`}
    <textarea value=${text} maxLength=${COMMENT_MAX} rows=${compact ? 2 : 3}
      placeholder=${placeholder || (compact ? t('replyPlaceholder', { name: authorName(parent.n, parent.a, parent.pf) }) : (withTime ? t('commentPlaceholder') : t('commentPlaceholderGeneral')))}
      autoFocus=${!!autoFocus}
      aria-label=${t('commentPlaceholderGeneral')}
      onInput=${e => { setText(e.target.value); setSent(false); }}></textarea>
    <div className="c-tools">
      <span className="hint">${text.length}/${COMMENT_MAX}</span>
      <span className="c-tool-links">
        ${withTime && html`<button type="button" className="link-btn" onClick=${addTime}>${t('addCurrentTime')}</button>`}
        <button type="button" className="link-btn" onClick=${() => setPick(p => (p ? null : newPick()))} aria-expanded=${!!pick}>${t('addLecture')}</button>
      </span>
    </div>
    ${pick && html`<${MentionPicker} pick=${pick} setPick=${setPick}
      onInsert=${(s) => { append(s); setPick(null); setSent(false); }} onClose=${() => setPick(null)} />`}
    ${error && html`<p className="form-error">${error}</p>`}
    ${sent && !compact && html`<p className="c-sent">${t('commentSent')}</p>`}
    <div className="c-actions">
      <button className="small-btn c-send" type="submit" disabled=${busy || (!text.trim() && !pick)}>
        ${busy ? t('pleaseWait') : (submitLabel || (compact ? t('sendReply') : t('sendComment')))}
      </button>
      ${onCancel && html`<button type="button" className="link-btn muted" onClick=${onCancel}>${t('cancel')}</button>`}
    </div>
  </form>`;
}

// صندوق التعليقات بمستويين: تعليق ثم ردود عليه
// مطويّ افتراضيًا حتى تبقى الصفحة نظيفة
// قائمة ⋯ على التعليق، موحّدة في تعليقات اللقاءات والمجتمع:
// صاحب التعليق خلال المهلة: تعديل وحذف. غيره: إبلاغ. المشرف: تجاهل البلاغات وحذف
// replies: الردود على التعليق (تُحذف معه). reports: شجرة البلاغات
function CommentMenu({ c, lid, replies, reports, onEdit, onNotice }) {
  // pos: مكان القائمة على الشاشة نفسها (لا داخل صندوق التعليقات الذي يقصّ ما يخرج عن حوافه)، أو null وهي مغلقة
  const [pos, setPos] = useState(null);
  const open = !!pos;
  const setOpen = (v) => { if (!v) setPos(null); };
  const [busy, setBusy] = useState(false);
  const boxRef = useRef(null);
  const btnRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setPos(null); };
    const away = () => setPos(null);
    document.addEventListener('click', outside);
    window.addEventListener('scroll', away, { passive: true });
    window.addEventListener('resize', away);
    return () => { document.removeEventListener('click', outside); window.removeEventListener('scroll', away); window.removeEventListener('resize', away); };
  }, [open]);
  // تُفتح تحت الزر، وإن لم تتسع المساحة أسفله (آخر تعليق في الصفحة) تُفتح فوقه
  const toggle = (count) => {
    if (open) return setPos(null);
    const r = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    // قائمة صاحب التعليق أعرض قليلًا وتحمل ملاحظة المهلة أسفل الخيارين
    const width = own ? 176 : 150, height = count * 40 + 14 + (own ? 50 : 0);
    const left = Math.max(8, Math.min(r.left, vw - width - 8));
    const below = vh - r.bottom - 96;          // يُترك مكان المشغّل الصغير أسفل الشاشة
    setPos(below >= height || r.top < height + 8
      ? { left, top: r.bottom + 4, width }
      : { left, bottom: vh - r.top + 4, width });
  };

  const own = canModifyOwn(c);
  const me = reactions.mine();
  const node = reports[c.id];
  const reportCount = reactions.count(node);
  const reported = !!(me && node && node[me]);
  const rs = replies || [];

  const report = async () => {
    setOpen(false);
    if (!navigator.onLine) return onNotice(t('needOnline'));
    const ok = await reactions.report(c.id, lid);
    onNotice(ok ? t('reportSent') : t('saveFailed'));
  };
  const del = async () => {
    setOpen(false);
    if (busy) return;
    if (!window.confirm(rs.length ? t('deleteOwnWithReplies', { n: rs.length }) : t('deleteOwnConfirm'))) return;
    setBusy(true);
    // المشرف يحذف بصلاحيته في أي وقت، وصاحب التعليق بصلاحية المهلة
    const r = staff.isMod ? await commentsApi.remove(lid, c, rs) : await commentsApi.removeOwn(lid, c, rs);
    setBusy(false);
    if (r.error) onNotice(t(r.error === 'commentFailed' ? 'deleteFailed' : r.error));
  };

  const items = [];
  if (own) items.push(html`<button key="e" className="menu-item" onClick=${() => { setOpen(false); onEdit(c); }}>${t('edit')}</button>`);
  if (account.loggedIn && !isMine(c) && !c.a) items.push(reported
    ? html`<span key="r" className="menu-item muted">${t('reported')}</span>`
    : html`<button key="r" className="menu-item" onClick=${report}>${t('reportPost')}</button>`);
  if (staff.isMod && reportCount > 0) items.push(html`<button key="s" className="menu-item" onClick=${() => { setOpen(false); reactions.clearReports(c.id); }}>${t('ignoreReports')}</button>`);
  if (own || staff.isMod) items.push(html`<button key="d" className="menu-item danger" onClick=${del}>${t('delete')}</button>`);
  if (!items.length) return null;
  return html`<span className="post-menu" ref=${boxRef}>
    <button ref=${btnRef} className="dots-btn" disabled=${busy} onClick=${() => toggle(items.length)} aria-label=${t('moreOptions')} aria-expanded=${open}>
      <${Icon} name="dots" size=${18} />
    </button>
    ${open && html`<span className="menu-pop menu-fixed" role="menu" style=${pos}>
      ${items}
      ${own && html`<span className="menu-note">${t('ownWindowNote')}</span>`}
    </span>`}
  </span>`;
}

// تعديل نص تعليق في مكانه
function CommentEdit({ lid, c, onDone }) {
  const [text, setText] = useState(c.t);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true); setError(null);
    const r = await commentsApi.edit(lid, c, text);
    setBusy(false);
    if (r.error) return setError(r.error);
    onDone();
  };
  return html`<form className="c-form c-edit" onSubmit=${save}>
    <textarea value=${text} maxLength=${COMMENT_MAX} rows="3" autoFocus aria-label=${t('edit')}
      onInput=${e => { setText(e.target.value); setError(null); }}></textarea>
    ${error && html`<p className="form-error">${t(error)}</p>`}
    <div className="c-actions">
      <button className="small-btn c-send" type="submit" disabled=${busy || !text.trim()}>${busy ? t('pleaseWait') : t('save')}</button>
      <button type="button" className="link-btn muted" onClick=${onDone}>${t('cancel')}</button>
    </div>
  </form>`;
}

// وقت التعليق، ومعه «معدّل» إن عدّله صاحبه
const commentWhen = (c) => relTime(c.ts) + (c.ed ? ' · ' + t('edited') : '');

function CommentsBox({ lid, list, getTime, onTime, startOpen, title }) {
  useAccountVersion();
  const focus = pendingFocus && pendingFocus.lid === lid ? pendingFocus.cid : null;
  const [open, setOpen] = useState(!!startOpen || !!focus);
  const [sort, setSort] = useState('new');
  const [replyFor, setReplyFor] = useState(null);
  const [expanded, setExpanded] = useState(() => (focus ? { [focus]: true } : {}));
  const [highlight, setHighlight] = useState(focus);
  const maxSec = maxSecOf(lid);
  useStaffVersion();
  const canWrite = commentsApi.canWrite();
  useProgressVersion();

  // الجديد يُحسب مرة عند فتح الصندوق، ثم يُعلَّم كمقروء
  const [seenBase, setSeenBase] = useState(null);
  const unread = list.filter(c => isNewComment(c, lid)).length;
  useEffect(() => {
    if (!open || !list.length) return;
    if (seenBase == null) {
      setSeenBase(progress.seenAt(lid));
      // فتح الردود التي فيها رد جديد على المستخدم
      const ex = {};
      list.forEach(c => { if (c.p && isReplyToMe(c, lid)) ex[c.p] = true; });
      if (Object.keys(ex).length) setExpanded(x => ({ ...x, ...ex }));
    }
    progress.markSeen(lid, maxTs(list));
  }, [open, list, lid]);
  const wasNew = (c) => seenBase != null && (c.ts || 0) > seenBase && !isMine(c);
  const toMe = (c) => wasNew(c) && ((account.nick && c.r === account.nick) || (staff.uid && c.ra === staff.uid));

  // قائمة ⋯ : تعديل وحذف لصاحب التعليق خلال المهلة، وإبلاغ لغيره، وحذف للمشرف
  const reports = useReactionTree(reactions.watchReports);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);
  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 3500); };
  // القلوب: قلوب هذا اللقاء فقط، ولا يظهر من ضغطها
  const [hearts, setHearts] = useState({});
  useEffect(() => reactions.watchLectureHearts(lid, setHearts), [lid]);
  const me = reactions.mine();
  const myHeart = (id) => !!(me && hearts[id] && hearts[id][me]);
  const toggleHeart = async (id) => {
    if (!account.loggedIn) return go('#/account');
    if (!navigator.onLine) return flash(t('needOnline'));
    const ok = await reactions.setHeart(id, !myHeart(id), lid);
    if (ok === false) flash(t('saveFailed'));
  };
  // خانة الكتابة مطوية خلف زر «اكتب تعليقًا» حتى تظهر التعليقات مباشرة
  const [composing, setComposing] = useState(false);

  // فتح اللقاء من «أحدث التعليقات»: التمرير إلى التعليق وإبرازه
  useEffect(() => {
    if (!focus) return;
    pendingFocus = null;
    const id = setTimeout(() => {
      const el = document.getElementById('c-' + focus);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 400);
    const off = setTimeout(() => setHighlight(null), 3500);
    return () => { clearTimeout(id); clearTimeout(off); };
  }, [focus, list.length]);

  const { tops, replies } = useMemo(() => {
    const tops = [], replies = {};
    list.forEach(c => {
      if (c.p) (replies[c.p] = replies[c.p] || []).push(c);
      else tops.push(c);
    });
    Object.values(replies).forEach(r => r.sort((a, b) => (a.ts || 0) - (b.ts || 0)));
    if (sort === 'time') tops.sort((a, b) => (a.s ?? Infinity) - (b.s ?? Infinity) || (b.ts || 0) - (a.ts || 0));
    else tops.sort((a, b) => (b.ts || 0) - (a.ts || 0));
    return { tops, replies };
  }, [list, sort]);

  const replyButton = (top, target) => canWrite && html`<button onClick=${() => setReplyFor({ top: top.id, n: target.n, a: target.a, pf: target.pf })}>${t('reply')}</button>`;

  const item = (c, top, isReply) => html`<li key=${c.id} id=${'c-' + c.id} className=${'c-item' + (highlight === c.id ? ' focus' : '') + (wasNew(c) ? ' is-new' : '')}>
    <div className="c-meta"><${CommentAuthor} c=${c} toMe=${toMe(c)} /><span>${commentWhen(c)}</span></div>
    ${editing === c.id
      ? html`<${CommentEdit} lid=${lid} c=${c} onDone=${() => setEditing(null)} />`
      : html`<${CommentText} text=${c.t} maxSec=${maxSec} onTime=${onTime} replyTo=${isReply && (c.r || c.ra) ? authorName(c.r, c.ra, c.rp) : null} />`}
    <div className="c-foot">
      <${HeartButton} small count=${reactions.count(hearts[c.id])} mine=${myHeart(c.id)} onToggle=${() => toggleHeart(c.id)} />
      ${replyButton(top, c)}
      ${!isReply && (replies[c.id] || []).length > 0 && html`<button onClick=${() => setExpanded(x => ({ ...x, [c.id]: !x[c.id] }))}>
        ${expanded[c.id] ? t('hideReplies') : t('showReplies', { n: replies[c.id].length })}
      </button>`}
      <${CommentMenu} c=${c} lid=${lid} replies=${isReply ? [] : (replies[c.id] || [])} reports=${reports}
        onEdit=${(x) => setEditing(x.id)} onNotice=${flash} />
    </div>
    ${!isReply && (expanded[c.id] || replyFor && replyFor.top === c.id) && html`<ul className="replies">
      ${expanded[c.id] && (replies[c.id] || []).map(r => item(r, c, true))}
      ${replyFor && replyFor.top === c.id && html`<li key="form">
        <${CommentForm} lid=${lid} compact parent=${{ id: c.id, n: replyFor.n, a: replyFor.a, pf: replyFor.pf }} getTime=${getTime}
          onDone=${() => { setReplyFor(null); setExpanded(x => ({ ...x, [c.id]: true })); }}
          onCancel=${() => setReplyFor(null)} />
      </li>`}
    </ul>`}
  </li>`;

  return html`<section className="comments">
    <button className="c-toggle" onClick=${() => setOpen(o => !o)} aria-expanded=${open}>
      <span>${title || t('comments')}</span>
      <span className="c-count">${list.length}</span>
      ${!open && unread > 0 && html`<span className="c-new">${t('newCount', { n: unread })}</span>`}
      <span className=${'chev' + (open ? ' chev-open' : '')} aria-hidden="true">⌄</span>
    </button>

    ${open && html`<div className="c-body">
      ${notice && html`<p className="toast toast-float" role="status">${notice}</p>`}
      ${!composing
        ? html`<button className="composer-fake" onClick=${() => setComposing(true)}>${t('writeComment')}</button>`
        : canWrite
          ? html`<${CommentForm} lid=${lid} getTime=${getTime} autoFocus
              onDone=${() => { setComposing(false); setSort('new'); flash(t('commentSent')); }} onCancel=${() => setComposing(false)} />`
          : html`<div className="c-login">
              <p>${account.loggedIn ? t('commentPreparing') : t('commentNeedName')}</p>
              ${!account.loggedIn && html`<button className="small-btn" onClick=${() => go('#/account')}>${t('createNameShort')}</button>`}
            </div>`}

      ${maxSec > 0 && tops.length > 1 && html`<div className="c-sort">
        <button className=${sort === 'new' ? 'on' : ''} onClick=${() => setSort('new')}>${t('sortNewest')}</button>
        <button className=${sort === 'time' ? 'on' : ''} onClick=${() => setSort('time')}>${t('sortByTime')}</button>
      </div>`}

      ${list === LOADING_LIST ? html`<${Skeleton} />` : list.length === 0 && html`<p className="hint center-text">${t('noComments')}</p>`}
      <ul className="c-list">${tops.map(c => item(c, c, false))}</ul>
    </div>`}
  </section>`;
}

// أحدث التعليقات من كل اللقاءات (في صفحة الكورس)
function RecentComments({ player }) {
  useProgressVersion();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState(10);
  const list = useRecentFeed(limit);
  const [newIds, setNewIds] = useState(null);
  const unread = list.filter(c => isNewComment(c, c.l)).length;

  // عند الفتح: نحفظ الجديد لإبرازه، ثم نعلّمه كمقروء
  useEffect(() => {
    if (!open || !list.length) return;
    if (newIds == null) setNewIds(new Set(list.filter(c => isNewComment(c, c.l)).map(c => c.id)));
    const perLecture = {};
    list.forEach(c => { perLecture[c.l] = Math.max(perLecture[c.l] || 0, c.ts || 0); });
    Object.entries(perLecture).forEach(([l, ts]) => progress.markSeen(l, ts));
  }, [open, list]);

  const openComment = (c) => {
    pendingFocus = { lid: c.l, cid: c.c };
    go('#/lecture/' + c.l);
  };
  const openAt = (c, sec) => {
    progress.setPosition(c.l, sec);
    player.playLecture(c.l);
    go('#/lecture/' + c.l);
  };

  return html`<section className="comments">
    <button className="c-toggle" onClick=${() => setOpen(o => !o)} aria-expanded=${open}>
      <span>${t('recentComments')}</span>
      ${!open && unread > 0 && html`<span className="c-new">${t('newCount', { n: unread })}</span>`}
      <span className=${'chev' + (open ? ' chev-open' : '')} aria-hidden="true">⌄</span>
    </button>
    ${open && html`<div className="c-body">
      ${list === LOADING_LIST ? html`<${Skeleton} />` : list.length === 0 && html`<p className="hint center-text">${t('noComments')}</p>`}
      <ul className="c-list">
        ${list.map(c => {
          const isNew = newIds && newIds.has(c.id);
          return html`<li key=${c.id} className=${'c-item feed-item' + (isNew ? ' is-new' : '')} onClick=${() => openComment(c)}>
            <p className="feed-lecture">${LECTURE_BY_ID[c.l].title}</p>
            <div className="c-meta"><${CommentAuthor} c=${c} toMe=${isNew && ((account.nick && c.r === account.nick) || (staff.uid && c.ra === staff.uid))} /><span>${relTime(c.ts)}</span></div>
            <${CommentText} text=${c.t} maxSec=${maxSecOf(c.l)} onTime=${(sec) => openAt(c, sec)} />
          </li>`;
        })}
      </ul>
      ${list.length >= limit && html`<button className="small-btn feed-more" onClick=${() => setLimit(l => l + 10)}>${t('showMore')}</button>`}
    </div>`}
  </section>`;
}

const STATUS_KEY = {
  loading: 'statusLoading', next: 'statusNext', blocked: 'statusBlocked',
  error: 'statusError', offline: 'statusOffline',
};

function StatusLine({ active, status, idleText, onRetry }) {
  const isWarn = status === 'error' || status === 'blocked' || status === 'offline';
  return html`<div className="status">
    ${active && STATUS_KEY[status] && html`<p className=${isWarn ? 'warn' : ''}>${t(STATUS_KEY[status])}</p>`}
    ${!active && idleText && html`<p>${idleText}</p>`}
    ${active && status === 'error' && html`<button className="small-btn" onClick=${onRetry}>${t('retry')}</button>`}
    ${active && status === 'error' && html`<button className="link-btn muted" onClick=${() => go('#/feedback')}>${t('reportProblem')}</button>`}
  </div>`;
}

function PlayButton({ active, status, onClick, size = 72 }) {
  const busy = active && (status === 'loading' || status === 'next');
  const showPause = active && status !== 'blocked' && status !== 'offline';
  return html`<button className=${'play' + (showPause && !busy ? ' play-btn-glow' : '')}
      style=${{ width: size, height: size }}
      onClick=${onClick} aria-label=${showPause ? t('pause') : t('play')}>
    ${busy ? html`<span className="spinner"></span>` : html`<${Icon} name=${showPause ? 'pause' : 'play'} size=${Math.round(size * 0.38)} />`}
  </button>`;
}

// شارة "بث مباشر" أو "متأخر عن البث" مع زر العودة
function LiveBadge({ behind, onGoLive }) {
  if (behind) {
    return html`<div className="live behind">
      <span>${t('behindLive')}</span>
      <button className="go-live" onClick=${onGoLive}><${LiveDot} />${t('goLive')}</button>
    </div>`;
  }
  return html`<div className="live"><${LiveDot} />${t('live')}</div>`;
}

// =====================
// الصفحة الرئيسية
// =====================
function HomePage({ player, users }) {
  const now = useClock();   // الساعة هنا فقط، لا في الموقع كله
  useProgressVersion();
  const [mode, setModeState] = useState(() => {
    if (player.mode === 'normal' || player.mode === 'fast') return player.mode;
    return storage.get(RADIO_MODE_KEY) === 'fast' ? 'fast' : 'normal';
  });
  // اختيار السرعة الأخرى أثناء التشغيل ينقل البث إليها فورًا، فيبقى الزر مطابقًا لما يُسمع
  // اختيار السرعة يغيّر العرض فقط ولا يلمس الصوت؛ التبديل يحدث عند الضغط على التشغيل
  const pickMode = (m) => { setModeState(m); storage.set(RADIO_MODE_KEY, m); };
  const radioPlaying = player.isPlaying && MODES.includes(player.mode) ? player.mode : null;
  const otherPlaying = radioPlaying && radioPlaying !== mode;
  // إذا تغيّرت السرعة المشغّلة من مكان آخر يتبعها الاختيار
  useEffect(() => {
    if (player.isPlaying && MODES.includes(player.mode) && player.mode !== mode) setModeState(player.mode);
  }, [player.isPlaying, player.mode]);
  const rv = radioView(player, mode, now);

  // «ابدأ من هنا»: رسالة للجميع؛ «حسنًا» تخفيها حتى الغد، و«لا تظهر مرة أخرى» نهائيًا
  const [introOff, setIntroOff] = useState(() =>
    storage.get(INTRO_NEVER_KEY) === '1' || storage.get(INTRO_DAY_KEY) === dayKey());
  const closeIntro = (never) => {
    storage.set(never ? INTRO_NEVER_KEY : INTRO_DAY_KEY, never ? '1' : dayKey());
    setIntroOff(true);
  };
  const showIntro = !introOff;

  // تذكير بالاسم الخاص بعد 20 دقيقة استماع دون حساب، ويعود بعد أسبوع إن أُغلق
  const [nudgeOff, setNudgeOff] = useState(() => Date.now() - parseInt(storage.get(NUDGE_KEY) || '0', 10) < NUDGE_AGAIN_MS);
  const showNudge = !showIntro && !nudgeOff && !account.loggedIn && progress.stats('0000', '9999').total >= NUDGE_AFTER_SEC;
  const closeNudge = () => { storage.set(NUDGE_KEY, String(Date.now())); setNudgeOff(true); };

  // كارت واحد مفتوح في المرة، ويبدأ مطويًا دائمًا عند دخول الصفحة الرئيسية
  const [open, setOpenState] = useState('');
  // عند طي كارت الراديو يعود الاختيار إلى السرعة المشغّلة، فيبقى العنوان والزر صحيحين
  const setOpen = (v) => {
    setOpenState(v);
    if (v !== 'radio' && otherPlaying) setModeState(radioPlaying);
  };
  const toggle = (k) => setOpen(open === k ? '' : k);

  // تشغيل الراديو من الكارت المطوي يفتحه في الضغطة نفسها
  const radioToggle = () => {
    if (!rv.active) setOpen('radio');
    player.toggleRadio(mode);
  };




  return html`<div className="page home">
    <div className="topbar">
      <${TotalStats} />
      <div className="top-left">
        <${NameChip} />
        <${OnlineBadge} users=${users} />
      </div>
    </div>

    <header className="hero">
      <h1>${t('appName')}</h1>
    </header>

    ${showIntro && html`<div className="modal-back" role="presentation">
      <div className="modal intro" role="dialog" aria-modal="true" aria-labelledby="intro-title">
        <p className="intro-title" id="intro-title">${t('introTitle')}</p>
        <ul>
          <li>${t('courseInfo')}</li>
          ${!account.loggedIn && html`<li>${t('intro3')}</li>`}
          <li>${t('introPrivacy')}</li>
        </ul>
        <div className="modal-actions">
          <button className="small-btn" onClick=${() => closeIntro(false)}>${t('introOk')}</button>
          <button className="link-btn muted" onClick=${() => closeIntro(true)}>${t('introNever')}</button>
        </div>
      </div>
    </div>`}

    ${showNudge && html`<div className="nudge">
      <p>${t('nudgeText')}</p>
      <div className="c-actions">
        <button className="small-btn" onClick=${() => go('#/account')}>${t('nudgeBtn')}</button>
        <button className="link-btn muted" onClick=${closeNudge}>${t('introGotIt')}</button>
      </div>
    </div>`}

    <section className="section">
      <div className=${'card tint-radio' + (mode === 'fast' ? ' mode-fast' : '') + (rv.active ? ' card-active' : '')}>
        <div className="card-row">
          <button className="card-toggle" onClick=${() => toggle('radio')} aria-expanded=${open === 'radio'}>
            <span className="title-icon"><${Icon} name="radio" size=${18} /></span>
            <span className="card-title">${t('radioSection')}</span>
            <span className=${'live-mini' + (rv.behind ? ' behind' : '')}><${LiveDot} />${t(MODE_SHORT[mode])}</span>
            <span className=${'chev' + (open === 'radio' ? ' chev-open' : '')} aria-hidden="true">⌄</span>
          </button>
          <${PlayButton} size=${46} active=${rv.active} status=${rv.status} onClick=${radioToggle} />
        </div>
        ${open === 'radio' && html`<div className="card-body">
          <div className="card-line">
            <${LiveBadge} behind=${rv.behind} onGoLive=${player.goLive} />
            <${InfoTip} label=${t('infoLabel')} text=${t(MODE_INFO[mode])} />
          </div>
          <div className="seg" role="tablist" aria-label=${t('radioSpeed')}>
            ${MODES.map(m => html`<button key=${m} role="tab" aria-selected=${mode === m}
                className=${mode === m ? 'on' : ''} onClick=${() => pickMode(m)}>${t(MODE_SHORT[m])}</button>`)}
          </div>
          ${otherPlaying
            ? html`<small className="seg-hint seg-hint-playing">${t('otherModePlaying', { name: t(radioPlaying === 'fast' ? 'fastRadio' : 'normalRadio') })}</small>`
            : html`<small className="seg-hint seg-hint-mode">${t(mode === 'normal' ? 'normalCountsHint' : 'fastReviewHint')}</small>`}
          <div className="now">
            <small>${t('nowPlayingLabel')}</small>
            <p className="now-title">${rv.s.track.title}</p>
          </div>
          <${StatusLine} active=${rv.active} status=${rv.status} onRetry=${player.retry} />
          <button className="row-link" onClick=${() => go('#/radio/' + mode)} aria-label=${t('radioDetails')}>
            <span>${t('radioDetails')}</span>
            <span className="row-arrow" aria-hidden="true">‹</span>
          </button>
        </div>`}
        ${open !== 'radio' && rv.active && STATUS_KEY[rv.status] && html`<${StatusLine} active=${rv.active} status=${rv.status} onRetry=${player.retry} />`}
      </div>
    </section>

    <footer className="foot">
      <${InstallButton} />
      <${FacebookLink} />
    </footer>
    <p className="foot-link"><button className="link-btn muted" onClick=${() => go('#/feedback')}>${t('reportProblem')}</button></p>
  </div>`;
}

// =====================
// صفحة الراديو
// =====================
function RadioPage({ mode, player, users }) {
  const now = useClock();
  const rv = radioView(player, mode, now);
  const { s, time } = rv;
  const pct = Math.min(100, (time / s.track.duration) * 100 || 0);
  const comments = useComments(mode === 'normal' ? s.track.id : null);

  // من الراديو: يُفتح اللقاء في الكورس على اللحظة المذكورة ويتوقف الراديو
  const openAt = (sec) => {
    progress.setPosition(s.track.id, sec);
    player.playLecture(s.track.id);
    go('#/lecture/' + s.track.id);
  };

  return html`<div className="page radio">
    <div className="topbar">
      <${BackButton} to="#/" />
      <div className="top-left">
        <${NameChip} />
        <${OnlineBadge} users=${users} />
      </div>
    </div>
    <div className="panel-wrap">
      <div className=${'panel tint-radio' + (mode === 'fast' ? ' mode-fast' : '')}>
        <div className="panel-head">
          <h1>
            ${t(MODE_LABEL[mode])}
            <${InfoTip} label=${t('infoLabel')} text=${t(MODE_INFO[mode])} />
          </h1>
          <${LiveBadge} behind=${rv.behind} onGoLive=${player.goLive} />
        </div>

        <div className="now">
          <p className="now-title">${s.track.title}</p>
          ${!rv.behind && html`<p className="now-next">${t('next', { title: s.next.title })}</p>`}
        </div>

        <${PlayButton} active=${rv.active} status=${rv.status} onClick=${() => player.toggleRadio(mode)} />
        <${StatusLine} active=${rv.active} status=${rv.status} onRetry=${player.retry} />

        <div className="progress">
          <div className="times"><span>${fmtTime(time)}</span><span>${fmtTime(s.track.duration)}</span></div>
          <${MiniBar} value=${pct} />
        </div>

        <div className="center"><${FacebookLink} /></div>
      </div>
    </div>
    ${mode === 'normal' && html`<${CommentsBox} key=${s.track.id} lid=${s.track.id} list=${comments}
      getTime=${() => time} onTime=${openAt} />`}
  </div>`;
}

// =====================
// صفحة الكورس
// =====================
// حجم الملف بالميغابايت
const fmtSize = (bytes) => t('sizeMB', { n: bytes >= 10485760 ? Math.round(bytes / 1048576) : Math.max(0.1, Math.round(bytes / 104857.6) / 10) });

// تحميل لقاء للاستماع دون اتصال: أيقونة صغيرة تتغير بحسب الحالة،
// والضغط عليها يفتح نافذة فيها الحجم وزر التحميل أو الإلغاء أو الحذف
function OfflineControl({ id, variant }) {
  useOfflineVersion();
  useEffect(() => { offline.loadSizes(); }, []);
  if (!offline.supported) return null;
  const s = offline.state(variant, id);
  const pct = (s.st === 'loading' || s.st === 'partial') && s.total ? Math.min(100, s.loaded / s.total * 100) : 0;
  const R = 9, C = 2 * Math.PI * R;

  const button = s.st === 'loading' || s.st === 'partial'
    ? html`<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" className=${s.st === 'loading' && !s.total ? 'dl-spin' : ''}>
        <circle cx="12" cy="12" r=${R} fill="none" stroke="currentColor" strokeOpacity=".25" strokeWidth="2.5"></circle>
        <circle cx="12" cy="12" r=${R} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"
          strokeDasharray=${C} strokeDashoffset=${C * (1 - (s.total ? pct / 100 : 0.25))} transform="rotate(-90 12 12)"></circle>
      </svg>`
    : html`<${Icon} name=${s.st === 'done' ? 'saved' : 'download'} size=${18} />`;

  // نسبة التحميل ظاهرة بجانب الأيقونة طوال التحميل، دون الحاجة إلى فتح النافذة
  return html`<span className="dl-wrap">
    ${s.st === 'loading' && s.total > 0 && html`<bdi className="dl-pct" dir="ltr">${Math.floor(pct)}%</bdi>`}
    <${Popover} label=${t('dlLabel')} btnClass=${'dl-icon dl-' + s.st} button=${button} keepOpen>
    ${s.st === 'loading' && html`<span className="dl-pop">
      <b>${t('dlLoading')} <bdi dir="ltr">${s.total ? Math.floor(pct) + '%' : ''}</bdi></b>
      <span>${s.total ? t('dlLoadedOf', { a: fmtSize(s.loaded), b: fmtSize(s.total) }) : fmtSize(s.loaded)}</span>
      ${s.waiting && html`<span className="warn">${t('dlWaitingNet')}</span>`}
      ${s.resumable === false && html`<span className="warn">${t('dlNoResume')}</span>`}
      <span>${t('dlKeepOpen')}</span>
      <button className="small-btn" onClick=${() => offline.cancel(variant, id)}>${s.resumable === true ? t('dlPause') : t('dlCancel')}</button>
    </span>`}
    ${s.st === 'partial' && html`<span className="dl-pop">
      <b>${t('dlPaused', { p: Math.floor(pct) })}</b>
      <span>${t('dlLoadedOf', { a: fmtSize(s.loaded), b: fmtSize(s.total) })}</span>
      <span>${t('dlResumeHint')}</span>
      ${s.error && html`<span className="warn">${t(s.error)}</span>`}
      <span className="dl-actions">
        <button className="small-btn dl-go" onClick=${() => offline.download(variant, id)}>${t('dlResume')}</button>
        <button className="small-btn danger" onClick=${() => offline.remove(variant, id)}>${t('delete')}</button>
      </span>
    </span>`}
    ${s.st === 'done' && html`<span className="dl-pop">
      <b>${t('dlDone')}</b>
      <span>${fmtSize(s.size)}</span>
      <button className="small-btn danger" onClick=${() => { if (window.confirm(t('dlRemoveConfirm'))) offline.remove(variant, id); }}>${t('dlRemove')}</button>
    </span>`}
    ${(s.st === 'none' || s.st === 'error') && html`<span className="dl-pop">
      <b>${t('dlButton')}</b>
      ${s.size > 0 && html`<span>${t('dlSize', { size: fmtSize(s.size) })}</span>`}
      ${s.st === 'error' && html`<span className="warn">${t(s.error)}</span>`}
      <button className="small-btn dl-go" onClick=${() => offline.download(variant, id)}>${s.st === 'error' ? t('dlRetry') : t('dlStart')}</button>
    </span>`}
  <//></span>`;
}

function CoursePage({ player, users }) {
  useProgressVersion();
  useOfflineVersion();
  const online = useOnline();
  const sum = progress.summary();
  const contId = progress.continueId();
  const counts = useCommentCounts();
  const feed = useRecentFeed(100);
  const newBy = {};
  feed.forEach(c => { if (isNewComment(c, c.l)) newBy[c.l] = true; });
  const saved = offline.usage();

  const continueNow = () => { player.playLecture(contId); go('#/lecture/' + contId); };
  const removeAll = () => { if (window.confirm(t('dlRemoveAllConfirm'))) offline.removeAll(); };

  // صف لقاء في القائمة. الأساسيات (COURSE_HEAD) داخل إطار واحد في أول الكورس
  const coreDone = COURSE_HEAD.filter(id => progress.isDone(id)).length;
  const lessonRow = (id) => {
    const pct = progress.percent(id);
    const done = progress.isDone(id);
    const n = counts[id] || 0;
    const playing = player.isPlaying && player.mode === 'lecture' && player.lectureId === id;
    const isSaved = offline.has('normal', id);
    const isPartial = !isSaved && offline.state('normal', id).st === 'partial';
    return html`<li key=${id}>
      <button id=${'lesson-' + id} className=${'lesson' + (playing ? ' lesson-playing' : '') + (done ? ' lesson-done' : '')}
          onClick=${() => go('#/lecture/' + id)}>
        <span className="lesson-body">
          <span className="lesson-title">${LECTURE_BY_ID[id].title}</span>
          <span className="lesson-meta">
            ${fmtTime(LECTURE_BY_ID[id].normal)}
            ${pct ? html`<span> · ${t('heardLabel')} <${Pct} value=${pct + '%'} /></span>` : ''}
            ${playing ? html`<span> · ${t('playingHere')}</span>` : ''}
          </span>
          ${pct > 0 && !done && html`<${HeardBar} id=${id} />`}
        </span>
        ${(done || n > 0 || newBy[id] || notes.has(id) || isSaved || isPartial) && html`<span className="lesson-side">
          ${done && html`<span className="done-badge" aria-label=${t('lectureDone')}><${Icon} name="check" size=${14} /></span>`}
          ${isSaved && html`<span className="note-badge" aria-label=${t('dlDone')}><${Icon} name="saved" size=${14} /></span>`}
          ${isPartial && html`<span className="note-badge dl-partial-badge" aria-label=${t('dlPartialBadge')}><${Icon} name="download" size=${14} /></span>`}
          ${notes.has(id) && html`<span className="note-badge" aria-label=${t('lectureHasNotes')}><${Icon} name="note" size=${13} /></span>`}
          ${n > 0 && html`<span className=${'c-badge' + (newBy[id] ? ' new' : '')} aria-label=${t('commentsCount', { n })}><${Icon} name="chat" size=${13} />${n}</span>`}
        </span>`}
      </button>
    </li>`;
  };

  return html`<div className="page course">
    <div className="topbar">
      <span></span>
      <div className="top-left">
        <${NameChip} />
        <${OnlineBadge} users=${users} />
      </div>
    </div>

    <div className="panel summary tint-course">
      <h1>${t('coursePageTitle')}
        <${InfoTip} label=${t('infoLabel')} text=${t('courseInfo')}>
          ${(saved.count > 0 || saved.partial > 0) && html`<span className="dl-pop dl-pop-extra">
            <span>${saved.count > 0 ? t('dlUsage', { n: saved.count, size: fmtSize(saved.bytes) }) : t('dlUsagePartialOnly', { n: saved.partial, size: fmtSize(saved.bytes) })}</span>
            ${saved.count > 0 && saved.partial > 0 && html`<span>${t('dlUsagePartial', { n: saved.partial })}</span>`}
            <button className="small-btn danger" onClick=${removeAll}>${t('dlRemoveAll')}</button>
          </span>`}
        <//>
      </h1>
      <div className="big-pct"><${Pct} value=${sum.percent} /></div>
      <${MiniBar} value=${sum.percent} />
      <div className="summary-foot">
        <span className="hint">${t('doneOf', { done: sum.done, count: sum.count })}</span>
        <button className="report-btn" onClick=${() => go('#/report')}><${Icon} name="chart" size=${15} />${t('report')}</button>
      </div>
      ${contId && html`<button className="cta" onClick=${continueNow}>
        ${progress.hasAny() ? t('continueFrom') : t('startCourse')}
      </button>`}
    </div>

    ${!online && html`<p className="tab-hint warn">${t('offlineOnlySaved')}</p>`}

    <${RecentComments} player=${player} />

    <ol className="lessons">
      <li className=${'core-group' + (coreDone === COURSE_HEAD.length ? ' core-complete' : '')}>
        <div className="core-head">
          <span className="core-leaf"><${Icon} name="leaf" size=${15} /></span>
          <b>${t('coreTitle')}</b>
          <span className="core-count">${t('doneOf', { done: coreDone, count: COURSE_HEAD.length })}</span>
        </div>
        <div className="core-bar" aria-hidden="true"><span style=${{ width: (coreDone / COURSE_HEAD.length * 100) + '%' }}></span></div>
        <ol className="lessons core-list">${COURSE_HEAD.map(lessonRow)}</ol>
      </li>
      ${COURSE_ORDER.filter(id => !COURSE_HEAD.includes(id)).map(lessonRow)}
    </ol>
  </div>`;
}

// =====================
// ملاحظات المستخدم الخاصة على اللقاء
// كل ملاحظة صف مستقل: وقتها على اليمين ونصها على اليسار
// «أضف ملاحظة» يلتقط وقت الاستماع لحظة الضغط، ويبقى الصوت يعمل أثناء الكتابة
// =====================
const NOTE_JUMP_BACK = 5;   // الضغط على وقت الملاحظة يرجع قبله قليلًا، لتُسمع الجملة من أولها

// محرّر ملاحظة جديدة أو موجودة. إذا أُغلقت الصفحة قبل الحفظ يُحفظ المكتوب تلقائيًا
function NoteEditor({ lid, note, sec, maxSec, getTime, onClose, saveRef }) {
  const [text, setText] = useState(note ? note.x : '');
  const [time, setTime] = useState(sec != null ? fmtTime(sec) : '');
  const [error, setError] = useState(null);
  const max = notes.room(lid, note ? note.id : null);
  const draft = useRef({ text, time });
  draft.current = { text, time };
  const closed = useRef(false);

  // يعيد الثواني، أو null بلا وقت، أو undefined إذا كان الوقت المكتوب غير صحيح
  const readTime = (v) => {
    if (!String(v).trim()) return null;
    const s = parseLooseTime(v);
    return s == null || s > maxSec ? undefined : s;
  };
  const store = (x, s) => (note ? notes.update(lid, note.id, s, x) : notes.add(lid, s, x) != null);

  // closeIfEmpty: الحفظ من زر رأس القسم يغلق المحرّر إذا لم يُكتب شيء
  const save = (e, closeIfEmpty) => {
    if (e) e.preventDefault();
    if (closeIfEmpty && !note && !text.trim()) return cancel();
    const s = readTime(time);
    if (s === undefined) return setError('mentionBadTime');
    if (!text.trim()) { if (!note) return setError('noteEmpty'); }
    if (!store(text, s)) return setError('notesFull');
    closed.current = true;
    onClose();
  };
  const cancel = () => { closed.current = true; onClose(); };
  if (saveRef) saveRef.current = () => save(null, true);
  const del = () => {
    if (!window.confirm(t('noteDeleteConfirm'))) return;
    closed.current = true;
    notes.remove(lid, note.id);
    onClose();
  };

  useEffect(() => () => {
    if (closed.current) return;
    const d = draft.current;
    if (!d.text.trim() || (note && d.text === note.x)) return;
    const s = readTime(d.time);
    store(d.text, s === undefined ? (note ? note.s : null) : s);
  }, []);

  return html`<form className="note-edit" onSubmit=${save}>
    <div className="note-edit-time">
      <input value=${time} dir="ltr" inputMode="text" autoComplete="off" placeholder=${t('noteNoTime')}
        aria-label=${t('noteTimeLabel')} onInput=${e => { setTime(e.target.value); setError(null); }} />
      <button type="button" className="link-btn" onClick=${() => { setTime(fmtTime(getTime())); setError(null); }}>${t('noteNow')}</button>
      ${time && html`<button type="button" className="link-btn muted" onClick=${() => { setTime(''); setError(null); }}>${t('noteClearTime')}</button>`}
    </div>
    <textarea value=${text} maxLength=${max} rows="3" autoFocus placeholder=${t('notePlaceholder')}
      aria-label=${t('myNotes')} onInput=${e => { setText(e.target.value); setError(null); }}></textarea>
    ${error && html`<p className="form-error">${t(error)}</p>`}
    <div className="c-actions">
      <button className="small-btn c-send" type="submit" disabled=${!note && !text.trim()}>${t('save')}</button>
      <button type="button" className="link-btn muted" onClick=${cancel}>${t('cancel')}</button>
      <span className="hint note-len">${text.length}/${max}</span>
      ${note && html`<button type="button" className="note-del" onClick=${del} aria-label=${t('delete')}><${Icon} name="trash" size=${16} /></button>`}
    </div>
  </form>`;
}

// readOnly: في الكورس عالسريع تُعرض الملاحظات للقراءة فقط، لأن أوقاتها على السرعة العادية
function NotesBox({ id, getTime, onTime, readOnly }) {
  const [, force] = useState(0);
  useEffect(() => notes.subscribe(() => force(x => x + 1)), []);
  useAccountVersion();
  const [open, setOpen] = useState(false);
  const [edit, setEdit] = useState(null);       // { id } لملاحظة موجودة، أو { sec } لملاحظة جديدة
  const [copied, setCopied] = useState(false);
  const list = notes.list(id);
  const maxSec = LECTURE_BY_ID[id].normal;
  const full = notes.room(id, null) < 1;

  const adding = !!(open && edit && !edit.id);
  const saveRef = useRef(null);
  // الزر نفسه: يفتح ملاحظة جديدة بوقت الاستماع الحالي، وإذا كانت مفتوحة يحفظها ويغلقها
  const addNew = () => {
    if (adding && saveRef.current) return saveRef.current();
    setOpen(true); setEdit({ sec: Math.floor(getTime()), k: Date.now() });
  };
  const copyAll = async () => {
    const body = list.map(n => (n.s != null ? fmtTime(n.s) + '  ' : '') + n.x).join('\n');
    try {
      await navigator.clipboard.writeText(shortTitle(id) + '\n' + body);
      setCopied(true); setTimeout(() => setCopied(false), 2000);
    } catch (e) {}
  };

  return html`<section className="comments notes">
    <div className="notes-head">
      <button className="c-toggle" onClick=${() => setOpen(o => !o)} aria-expanded=${open}>
        <${Icon} name="note" size=${16} />
        <span>${t('myNotes')}</span>
        ${list.length > 0 && html`<span className="c-count">${list.length}</span>`}
        <span className=${'chev' + (open ? ' chev-open' : '')} aria-hidden="true">⌄</span>
      </button>
      ${!readOnly && (!full || adding) && html`<button className="note-add" onClick=${addNew}>
        <${Icon} name=${adding ? 'check' : 'plus'} size=${14} />${adding ? t('save') : t('noteAdd')}
      </button>`}
    </div>
    ${open && html`<div className="c-body">
      ${edit && !edit.id && html`<${NoteEditor} key=${'new' + edit.k} lid=${id} sec=${edit.sec} maxSec=${maxSec}
        getTime=${getTime} onClose=${() => setEdit(null)} saveRef=${saveRef} />`}

      ${list.length === 0 && !edit && html`<p className="hint center-text">${readOnly ? t('notesNone') : t('notesEmpty')}</p>`}

      ${list.length > 0 && html`<ul className="note-list">
        ${list.map(n => (edit && edit.id === n.id
          ? html`<li key=${n.id} className="note-row editing">
              <${NoteEditor} lid=${id} note=${n} sec=${n.s} maxSec=${maxSec} getTime=${getTime} onClose=${() => setEdit(null)} />
            </li>`
          : html`<li key=${n.id} className="note-row">
              ${n.s == null ? html`<span className="note-time none" aria-hidden="true">—</span>`
                : readOnly ? html`<span className="note-time" dir="ltr">${fmtTime(n.s)}</span>`
                : html`<button className="note-time time-chip" dir="ltr" onClick=${() => onTime(Math.max(0, n.s - NOTE_JUMP_BACK))}
                    aria-label=${t('jumpTo', { t: fmtTime(n.s) })}>${fmtTime(n.s)}</button>`}
              <div className="note-text"><${CommentText} clamp=${false} text=${n.x} maxSec=${readOnly ? 0 : maxSec} onTime=${onTime} /></div>
              ${!readOnly && html`<button className="note-edit-btn" onClick=${() => setEdit({ id: n.id })} aria-label=${t('notesEdit')}>
                <${Icon} name="note" size=${15} />
              </button>`}
            </li>`))}
      </ul>`}

      ${!readOnly && full && html`<p className="hint">${t('notesFull')}</p>`}
      <div className="c-tools">
        <span className="hint notes-foot">
          ${readOnly ? t('notesFastHint') : html`<${React.Fragment}>${t('notesPrivate')}
            <${InfoTip} label=${t('infoLabel')} text=${account.loggedIn ? t('notesPrivateAcc') : t('notesPrivateLocal')} /><//>`}
        </span>
        ${list.length > 0 && html`<button type="button" className="link-btn" onClick=${copyAll}>${copied ? t('copied') : t('notesCopyAll')}</button>`}
      </div>
    </div>`}
  </section>`;
}

// =====================
// صفحة اللقاء
// =====================
// تاريخ نشر اللقاء بصيغة مقروءة، مثل «12 مارس 2024»
function fmtPubDate(d) {
  try {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e) { return d; }
}
function usePublished() {
  const [, force] = useState(0);
  useEffect(() => published.subscribe(() => force(x => x + 1)), []);
}
// سطر صغير تحت عنوان اللقاء: «نُشر في ...»، والضغط عليه يفتح المنشور الأصلي إن وُضع رابطه
function PublishedLine({ lid }) {
  usePublished();
  const p = published.get(lid);
  if (!p) return null;
  const text = t('publishedOn', { d: fmtPubDate(p.d) });
  return html`<p className="pub-line">${p.u
    ? html`<a href=${p.u} target="_blank" rel="noopener noreferrer">${text}<span className="pub-arrow"><${Icon} name="external" size=${12} /></span></a>`
    : text}</p>`;
}

// تواريخ نشر اللقاءات في صفحة المميزين (للمالك): اختيار اللقاء ثم التاريخ والرابط
function PublishedAdmin() {
  usePublished();
  const all = published.all();
  const [lid, setLid] = useState(() => COURSE_ORDER.find(id => !all[id]) || COURSE_ORDER[0]);
  const cur = all[lid];
  const [date, setDate] = useState(cur ? cur.d : '');
  const [url, setUrl] = useState(cur && cur.u ? cur.u : '');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const pick = (id) => { const p = published.all()[id]; setLid(id); setDate(p ? p.d : ''); setUrl(p && p.u ? p.u : ''); setMsg(null); };

  const save = async (e) => {
    e.preventDefault();
    setMsg(null);
    if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(date)) return setMsg('pubBadDate');
    const u = url.trim();
    if (u && !validHttpsUrl(u)) return setMsg('pubBadUrl');
    setBusy(true);
    const r = await staff.savePublished(lid, date, u);
    setBusy(false);
    setMsg(r.error || 'pubSaved');
  };
  const remove = async (id) => {
    if (!window.confirm(t('pubDeleteConfirm', { title: shortTitle(id) }))) return;
    setBusy(true); setMsg(null);
    const r = await staff.removePublished(id);
    setBusy(false);
    if (r.error) return setMsg(r.error);
    if (id === lid) { setDate(''); setUrl(''); }
  };
  const saved = COURSE_ORDER.filter(id => all[id]);

  return html`<div className="lec-admin pub-admin">
    <form onSubmit=${save}>
      <select className="name-input" value=${lid} onChange=${e => pick(e.target.value)} aria-label=${t('pubLecture')}>
        ${COURSE_ORDER.map(id => html`<option key=${id} value=${id}>${(all[id] ? '✓ ' : '') + LECTURE_BY_ID[id].title}</option>`)}
      </select>
      <label className="pub-field"><small>${t('pubDate')}</small>
        <input type="date" dir="ltr" value=${date} max="2100-12-31" onInput=${e => { setDate(e.target.value); setMsg(null); }} />
      </label>
      <label className="pub-field"><small>${t('pubUrl')}</small>
        <input dir="ltr" className="lec-url" value=${url} placeholder="https://…" autoComplete="off" autoCapitalize="off" spellCheck="false"
          onInput=${e => { setUrl(e.target.value.trim()); setMsg(null); }} />
      </label>
      <button className="cta" type="submit" disabled=${busy || !date}>${busy ? t('pleaseWait') : cur ? t('lecSaveEdit') : t('save')}</button>
      ${msg && html`<p className=${msg === 'pubSaved' ? 'hint lec-ok' : 'form-error'}>${t(msg)}</p>`}
    </form>
    ${saved.length > 0 && html`<ul className="staff-list">
      ${saved.map(id => html`<li key=${id}>
        <span><b>${shortTitle(id)}</b><br /><span className="hint">${fmtPubDate(all[id].d)}${all[id].u ? '' : ' · ' + t('pubNoLink')}</span></span>
        <span className="lec-actions">
          <button className="link-btn" disabled=${busy} onClick=${() => pick(id)}>${t('edit')}</button>
          <button className="link-btn muted" disabled=${busy} onClick=${() => remove(id)}>${t('delete')}</button>
        </span>
      </li>`)}
    </ul>`}
  </div>`;
}

// ملفات السكتات في صفحة المميزين (للمالك): اختيار اللقاء ثم رفع ملف Audacity كما هو
function SilencesAdmin() {
  useSilencesVersion();
  const [lid, setLid] = useState(COURSE_ORDER[0]);
  const [pending, setPending] = useState(null);   // { str, count, removed } بعد قراءة الملف وقبل الحفظ
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [names, setNames] = useState({});
  const saved = COURSE_ORDER.filter(id => silences.available(id));
  useEffect(() => { let on = true; staff.loadSilenceNames().then(n => { if (on) setNames(n); }); return () => { on = false; }; }, [saved.join(',')]);

  const onFile = async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    setMsg(null); setPending(null);
    if (!f) return;
    if (f.size > 500000) return setMsg('silBadFile');
    const rows = parseAudacityLabels(await f.text());
    if (!rows) return setMsg('silBadFile');
    const str = encodeSilences(rows);
    const removed = skipRangesOf(rows).reduce((s, x) => s + (x[1] - x[0]), 0);
    if (str.length > 20000) return setMsg('silTooBig');
    setPending({ str, count: rows.length, removed, name: f.name });
  };
  const save = async () => {
    if (!pending) return;
    setBusy(true); setMsg(null);
    const r = await staff.saveSilences(lid, pending.str, pending.name);
    setBusy(false);
    if (r.error) return setMsg(r.error);
    setNames(n => ({ ...n, [lid]: pending.name }));
    setPending(null); setMsg('silSaved');
  };
  const remove = async (id) => {
    if (!window.confirm(t('silDeleteConfirm', { title: shortTitle(id) }))) return;
    setBusy(true); setMsg(null);
    const r = await staff.removeSilences(id);
    setBusy(false);
    if (r.error) setMsg(r.error);
  };
  const dur = LECTURE_BY_ID[lid].normal;
  const mins = (s) => Math.round(s / 60);

  return html`<div className="lec-admin sil-admin">
    <select className="name-input" value=${lid} onChange=${e => { setLid(e.target.value); setPending(null); setMsg(null); }} aria-label=${t('pubLecture')}>
      ${COURSE_ORDER.map(id => html`<option key=${id} value=${id}>${(silences.available(id) ? '✓ ' : '') + LECTURE_BY_ID[id].title}</option>`)}
    </select>
    <label className="pub-field"><small>${t('silFile')}</small>
      <input type="file" onChange=${onFile} />
    </label>
    ${pending && html`<div className="sil-preview">
      <p>${t('silCount', { n: pending.count })}</p>
      <p>${t('silBefore', { m: mins(dur) })}</p>
      <p>${t('silAfter', { m: mins(dur - pending.removed) })}</p>
      <button className="cta" type="button" disabled=${busy} onClick=${save}>${busy ? t('pleaseWait') : silences.available(lid) ? t('lecSaveEdit') : t('save')}</button>
    </div>`}
    ${msg && html`<p className=${msg === 'silSaved' ? 'hint lec-ok' : 'form-error'}>${t(msg)}</p>`}
    ${saved.length > 0 && html`<ul className="staff-list">
      ${saved.map(id => html`<li key=${id}>
        <span><b>${shortTitle(id)}</b><br /><span className="hint" dir="auto">${names[id] && names[id] !== '-' ? names[id] : t('silNoName')}</span>
          ${silences.stamp(id) && html`<br /><span className="hint">${t('silUploadedOn', { d: new Date(silences.stamp(id)).toLocaleDateString('ar-EG-u-nu-latn', { day: 'numeric', month: 'long', year: 'numeric' }) })}</span>`}</span>
        <span className="lec-actions">
          <button className="link-btn" disabled=${busy} onClick=${() => { setLid(id); setPending(null); setMsg(null); }}>${t('silReplace')}</button>
          <button className="link-btn muted" disabled=${busy} onClick=${() => remove(id)}>${t('delete')}</button>
        </span>
      </li>`)}
    </ul>`}
  </div>`;
}

// اقتراح تحميل اللقاء عند ضعف الاتصال، ثم متابعة نسبة التحميل في السطر نفسه
function SlowNetHint({ id, onClose }) {
  useOfflineVersion();
  const s = offline.state('normal', id);
  if (s.st === 'done') return null;
  const loading = s.st === 'loading' || s.st === 'partial';
  return html`<div className="slow-net" role="status">
    <span>${loading
      ? t('slowNetLoading', { p: s.total ? Math.floor(s.loaded / s.total * 100) : 0 })
      : t('slowNetHint')}</span>
    ${!loading && html`<button className="small-btn dl-go" onClick=${() => offline.download('normal', id)}>${t('slowNetDownload')}</button>`}
    <button className="inapp-x slow-net-x" onClick=${onClose} aria-label=${t('inAppClose')}>×</button>
  </div>`;
}

const FAST_TOLD_KEY = 'sil_unlock_told';
function LecturePage({ id, variant, player }) {
  useProgressVersion();
  const online = useOnline();
  const fast = variant === 'fast';
  const lec = LECTURE_BY_ID[id];
  const duration = lec[variant];
  const savedPos = () => (fast ? progress.fastPosition(id) : progress.position(id));
  const current = player.mode === 'lecture' && player.lectureId === id && player.variant === variant;
  const active = current && player.isPlaying;
  const time = current ? player.currentTime : savedPos();
  const status = active ? player.status : 'idle';
  const heard = progress.percent(id);
  const done = progress.isDone(id);
  const prev = lecturePrev(id, variant), next = lectureNext(id, variant);
  const comments = useComments(fast ? null : id);
  const marks = useMemo(() => comments.filter(c => typeof c.s === 'number').map(c => c.s), [comments]);
  const [, bump] = useState(0);
  useEffect(() => notes.subscribe(() => bump(x => x + 1)), []);
  const noteMarks = fast ? [] : notes.list(id).filter(n => n.s != null).map(n => n.s);
  const getTime = () => (current ? player.currentTime : savedPos());

  // الضغط على وقت في تعليق أو ملاحظة: الانتقال إلى تلك اللحظة وتشغيلها
  const jumpTo = (sec) => {
    player.seekLecture(id, sec, variant);
    if (!active) player.playLecture(id, variant);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // سحب الشريط: يُعرض الموضع أثناء السحب ثم يُطبّق عند الإفلات
  const [dragging, setDragging] = useState(null);
  const shown = dragging != null ? dragging : time;
  const commit = () => { if (dragging != null) { player.seekLecture(id, dragging, variant); setDragging(null); } };
  const skipBy = (d) => (current ? player.skip(d) : player.seekLecture(id, time + d, variant));

  // عند أول لقاء يكتمل أثناء الاستماع: تنبيه لمرة واحدة بأن نسخته «عالسريع» صارت متاحة
  const [unlocked, setUnlocked] = useState(false);
  const wasDone = useRef(done);
  useEffect(() => {
    if (done && !wasDone.current && !fast && silences.available(id) && !storage.get(FAST_TOLD_KEY)) {
      storage.set(FAST_TOLD_KEY, '1');
      setUnlocked(true);
      const id2 = setTimeout(() => setUnlocked(false), 9000);
      wasDone.current = done;
      return () => clearTimeout(id2);
    }
    wasDone.current = done;
  }, [done]);

  // «حذف السكتات»: يظهر في اللقاءات التي لها ملف سكتات، ويُفتح بعد إكمال اللقاء
  useSilencesVersion();
  useEffect(() => { silences.load(id); }, [id]);
  const silHas = !fast && silences.available(id);
  const silLocked = silenceLocked(id);
  const silOpen = !silLocked && silences.ready(id);
  const silOn = current && player.skipSil;
  // تذكير قبل كل تشغيل لحذف السكتات
  const [silAsk, setSilAsk] = useState(false);
  const silEnable = () => { setSilAsk(false); if (current) player.setSkipSil(true); else { player.playLecture(id, variant); player.setSkipSil(true); } };

  // «أكمل من»: إذا كان المستمع يعيد جزءًا سمعه، زر يقفز إلى أول جزء لم يسمعه بعد
  const resumeAt = fast || dragging != null ? null : progress.nextUnheard(id, time);

  // مفتاح السرعة: «عالسريع» مقفل حتى يكتمل اللقاء على السرعة العادية،
  // والضغط عليه وهو مقفل يفتح نافذة صغيرة فيها السبب
  const pick = (v) => {
    if (v === variant) return;
    if (active) player.stop();          // لا يبقى صوت نسخة يعمل والصفحة تعرض الأخرى
    go(lectureHash(id, v));
  };

  return html`<div className=${'page lecture' + (fast ? ' variant-fast' : '')}>
    <div className="topbar">
      <${BackButton} to="#/course" />
      <div className="top-left"><${NameChip} /></div>
    </div>

    <div className="panel-wrap">
      <div className="panel tint-course">
        <p className="lecture-title">${lec.title}</p>
        <${PublishedLine} lid=${id} />

        <div className="speed-row">
          ${silHas && !silLocked ? (silOpen
            ? html`<button className=${'sil-toggle' + (silOn ? ' on' : '')} role="switch" aria-checked=${silOn}
                onClick=${() => { if (silOn) player.setSkipSil(false); else setSilAsk(true); }}>
                <span className="sil-knob" aria-hidden="true"></span>
                <span className="sil-label">${t('skipSilences')}</span>
                <small>${t('skipSilencesSaves', { m: Math.round((lec.normal - silences.total(id)) / 60) })}</small>
              </button>`
            : html`<${Popover} label=${t('skipSilences')} wrapClass="seg-pop sil-pop" btnClass="sil-toggle sil-toggle-locked"
                button=${html`<${React.Fragment}><${Icon} name="lock" size=${13} /><span className="sil-label">${t('skipSilences')}</span><//>`}>${t('pleaseWait')}<//>`)
          : null}
          <${OfflineControl} id=${id} variant=${variant} />
        </div>

        ${silAsk && html`<div className="modal-back" onClick=${() => setSilAsk(false)}>
          <div className="modal sil-ask" role="dialog" aria-modal="true" onClick=${e => e.stopPropagation()}>
            <p>${t('skipSilencesAdvice')}</p>
            <div className="modal-actions">
              <button className="cta" onClick=${() => setSilAsk(false)}>${t('skipSilencesStay')}</button>
              <button className="link-btn muted" onClick=${silEnable}>${t('skipSilencesGo')}</button>
            </div>
          </div>
        </div>`}

        <${SeekBar} id=${id} value=${shown} duration=${duration} marks=${fast ? [] : marks} noteMarks=${noteMarks} plain=${fast}
          onInput=${setDragging} onCommit=${commit} />
        <div className="times">
          <span>${fmtTime(shown)}</span>
          ${resumeAt != null ? html`<button className="resume-chip" onClick=${() => { player.seekLecture(id, resumeAt, variant); if (!active) player.playLecture(id, variant); }}>
            ${t('resumeFrom')} <bdi dir="ltr">${fmtTime(resumeAt)}</bdi>
          </button>` : !fast && (done || heard > 0) && html`<span className=${'times-heard' + (done ? ' heard-done' : '')}>
            ${done ? html`<${React.Fragment}><${Icon} name="check" size=${12} /> ${t('lectureDone')}<//>`
              : html`<${React.Fragment}>${t('heardLabel')} <${Pct} value=${heard + '%'} /><//>`}
          </span>`}
          <span>${fmtTime(duration)}</span>
        </div>

        <div className="controls">
          <button className="skip skip-nav" disabled=${!prev} onClick=${() => prev && go(lectureHash(prev, variant))} aria-label=${t('prevLecture')}>
            <${Icon} name="toRight" size=${17} />
          </button>
          <button className="skip" onClick=${() => skipBy(-SKIP_SECONDS)} aria-label=${t('back15')}>−15</button>
          <${PlayButton} active=${active} status=${status} onClick=${() => player.toggleLecture(id, variant)} />
          <button className="skip" onClick=${() => skipBy(SKIP_SECONDS)} aria-label=${t('forward15')}>+15</button>
          <button className="skip skip-nav" disabled=${!next} onClick=${() => next && go(lectureHash(next, variant))} aria-label=${t('nextLecture')}>
            <${Icon} name="toLeft" size=${17} />
          </button>
        </div>

        <${StatusLine} active=${active} status=${status} onRetry=${player.retry} />
        ${current && player.slowNet === id && html`<${SlowNetHint} id=${id} onClose=${player.hideSlowNet} />`}
      </div>
    </div>
    <${NotesBox} id=${id} getTime=${getTime} onTime=${jumpTo} readOnly=${fast} />
    ${!fast && (online
      ? html`<${CommentsBox} lid=${id} list=${comments} getTime=${getTime} onTime=${jumpTo} />`
      : html`<p className="tab-hint">${t('commentsNeedNet')}</p>`)}
    <p className="foot-link"><button className="link-btn muted" onClick=${() => go('#/feedback')}>${t('reportProblem')}</button></p>
    ${unlocked && html`<p className="toast toast-float" role="status" onClick=${() => setUnlocked(false)}>${t('silUnlocked')}</p>`}
  </div>`;
}

// =====================
// التعليقات العامة على الموقع
// =====================
// =====================
// المجتمع: منشورات وردود، وقلب أبيض يظهر عدده فقط، وإبلاغ يخفي المنشور عند 3 بلاغات
// المنشورات هي التعليقات العامة نفسها، فلا يضيع شيء مما كُتب سابقًا
// =====================
function useReactionTree(watchFn) {
  const [tree, setTree] = useState({});
  useEffect(() => watchFn(setTree), []);
  return tree;
}

// القلب ينبض عند الضغط ويهتز الهاتف اهتزازة خفيفة
function HeartButton({ count, mine, onToggle, small }) {
  const [pop, setPop] = useState(false);
  const press = () => {
    if (!mine) {
      setPop(true);
      setTimeout(() => setPop(false), 450);
      try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) {}
    }
    onToggle();
  };
  return html`<button className=${'heart-btn' + (mine ? ' on' : '') + (small ? ' small' : '') + (pop ? ' pop' : '')} onClick=${press}
    aria-pressed=${mine} aria-label=${mine ? t('unheart') : t('heart')}>
    <${Icon} name=${mine ? 'heartFill' : 'heart'} size=${small ? 15 : 18} />
    ${count > 0 && html`<span>${count}</span>`}
  </button>`;
}

function CommunityPage({ focus }) {
  useAccountVersion();
  useStaffVersion();
  useProgressVersion();
  const list = useComments(GENERAL_ID);
  const hearts = useReactionTree(reactions.watchHearts);
  const reports = useReactionTree(reactions.watchReports);
  const [sort, setSortState] = useState(() => storage.get(COMMUNITY_SORT_KEY) || 'active');
  const setSort = (v) => { setSortState(v); storage.set(COMMUNITY_SORT_KEY, v); };
  const [composing, setComposing] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [replyTo, setReplyTo] = useState({});     // لكل منشور: من يُرد عليه { n, a, pf }
  const [notice, setNotice] = useState(null);
  const canWrite = commentsApi.canWrite();

  // الجديد منذ آخر زيارة، ثم يُعلَّم كمقروء
  const [seenBase, setSeenBase] = useState(null);
  useEffect(() => {
    if (!list.length) return;
    if (seenBase == null) setSeenBase(progress.seenAt(GENERAL_ID));
    progress.markSeen(GENERAL_ID, maxTs(list));
  }, [list]);
  const isNew = (c) => seenBase != null && (c.ts || 0) > seenBase && !isMine(c);

  const me = reactions.mine();
  const heartCount = (id) => reactions.count(hearts[id]);
  const myHeart = (id) => !!(me && hearts[id] && hearts[id][me]);
  const reportCount = (id) => reactions.count(reports[id]);
  const myReport = (id) => !!(me && reports[id] && reports[id][me]);
  const visible = () => true;

  const { posts, replies } = useMemo(() => {
    const posts = [], replies = {};
    list.forEach(c => {
      if (c.p) (replies[c.p] = replies[c.p] || []).push(c);
      else posts.push(c);
    });
    Object.values(replies).forEach(r => r.sort((a, b) => (a.ts || 0) - (b.ts || 0)));
    // آخر نشاط: آخر رد أو وقت المنشور نفسه
    const activity = (p) => Math.max(p.ts || 0, ...(replies[p.id] || []).map(r => r.ts || 0));
    posts.sort((a, b) => sort === 'active' ? activity(b) - activity(a) : (b.ts || 0) - (a.ts || 0));
    return { posts, replies };
  }, [list, sort]);

  const flash = (msg) => { setNotice(msg); setTimeout(() => setNotice(null), 3000); };
  const toggleHeart = async (id) => {
    if (!account.loggedIn) return go('#/account');
    if (!navigator.onLine) return flash(t('needOnline'));
    const ok = await reactions.setHeart(id, !myHeart(id));
    if (ok === false) flash(t('saveFailed'));
  };
  // قائمة ⋯ : تعديل وحذف لصاحب المنشور خلال المهلة، وإبلاغ لغيره، وللمشرف تجاهل البلاغات والحذف
  const [editing, setEditing] = useState(null);
  const menu = (c, isReply) => html`<${CommentMenu} c=${c} lid=${GENERAL_ID} replies=${isReply ? [] : (replies[c.id] || [])} reports=${reports}
    onEdit=${(x) => setEditing(x.id)} onNotice=${flash} />`;
  const body = (c, replyName) => (editing === c.id
    ? html`<${CommentEdit} lid=${GENERAL_ID} c=${c} onDone=${() => setEditing(null)} />`
    : html`<${CommentText} text=${c.t} maxSec=${0} replyTo=${replyName} />`);

  // عدد البلاغات يظهر للمشرفين فقط، والقرار لهم
  const hiddenNote = (c) => staff.isMod && reportCount(c.id) > 0 && html`<p className="hidden-note">${t('reportsCount', { n: reportCount(c.id) })}</p>`;

  const replyItem = (c, post) => html`<li key=${c.id} className=${'reply' + (isNew(c) ? ' is-new' : '')}>
    <div className="c-meta"><${CommentAuthor} c=${c} toMe=${isNew(c) && ((account.nick && c.r === account.nick) || (staff.uid && c.ra === staff.uid))} /><span>${commentWhen(c)}</span></div>
    ${hiddenNote(c)}
    ${body(c, (c.r || c.ra) ? authorName(c.r, c.ra, c.rp) : null)}
    <div className="post-acts">
      <${HeartButton} small count=${heartCount(c.id)} mine=${myHeart(c.id)} onToggle=${() => toggleHeart(c.id)} />
      ${canWrite && html`<button className="act-btn" onClick=${() => setReplyTo(x => ({ ...x, [post.id]: { n: c.n, a: c.a, pf: c.pf } }))}>${t('reply')}</button>`}
      ${menu(c, true)}
    </div>
  </li>`;

  const postItem = (p) => {
    const rs = (replies[p.id] || []).filter(visible);
    const open = !!expanded[p.id];
    const target = replyTo[p.id] || { n: p.n, a: p.a, pf: p.pf };
    const newReplies = rs.filter(isNew).length;
    return html`<article key=${p.id} id=${'c-' + p.id} className=${'post' + (isNew(p) ? ' is-new' : '')}>
      <div className="c-meta">
        <${CommentAuthor} c=${p} />
        <span>${commentWhen(p)}${isNew(p) && html`<i className="new-dot" aria-label=${t('newComments')}></i>`}</span>
      </div>
      ${hiddenNote(p)}
      ${body(p, null)}
      <div className="post-acts">
        <${HeartButton} count=${heartCount(p.id)} mine=${myHeart(p.id)} onToggle=${() => toggleHeart(p.id)} />
        <button className=${'act-btn' + (open ? ' on' : '')} onClick=${() => setExpanded(x => ({ ...x, [p.id]: !open }))} aria-expanded=${open}>
          <${Icon} name="chat" size=${16} />
          <span>${open ? t('hideReplies') : rs.length ? t('repliesN', { n: rs.length }) : t('reply')}</span>
          ${!open && newReplies > 0 && html`<i className="new-dot"></i>`}
        </button>
        ${menu(p, false)}
      </div>
      ${open && html`<div className="post-replies">
        ${rs.length > 0 && html`<ul className="reply-list">${rs.map(r => replyItem(r, p))}</ul>`}
        ${canWrite
          ? html`<${CommentForm} key=${p.id + '-' + (target.n || target.a)} lid=${GENERAL_ID} compact parent=${{ id: p.id, ...target }}
              onDone=${() => setReplyTo(x => ({ ...x, [p.id]: null }))}
              onCancel=${replyTo[p.id] ? () => setReplyTo(x => ({ ...x, [p.id]: null })) : null} />`
          : html`<button className="link-btn" onClick=${() => go('#/account')}>${t('createNameShort')}</button>`}
      </div>`}
    </article>`;
  };

  const shown = posts.filter(visible);

  // فتح منشور محدد (من قائمة البلاغات): يُفتح منشوره ويُمرَّر إليه
  useEffect(() => {
    if (!focus || !list.length) return;
    const c = list.find(x => x.id === focus);
    if (!c) return;
    const top = c.p || c.id;
    setExpanded(x => ({ ...x, [top]: true }));
    setTimeout(() => { const el = document.getElementById('c-' + top); if (el) el.scrollIntoView({ block: 'center' }); }, 100);
  }, [focus, list.length]);

  return html`<div className="page community">
    <div className="topbar">
      <span></span>
      <div className="top-left"><${NameChip} /></div>
    </div>
    <h1 className="acc-title center-text">${t('community')}</h1>

    <div className="composer">
      ${!canWrite
        ? html`<div className="c-login">
            <p>${account.loggedIn ? t('commentPreparing') : t('commentNeedName')}</p>
            ${!account.loggedIn && html`<button className="small-btn" onClick=${() => go('#/account')}>${t('createNameShort')}</button>`}
          </div>`
        : composing
          ? html`<${CommentForm} lid=${GENERAL_ID} placeholder=${t('writePost')} submitLabel=${t('publish')} autoFocus
              onDone=${() => { setComposing(false); setSort('new'); }} onCancel=${() => setComposing(false)} />`
          : html`<button className="composer-fake" onClick=${() => setComposing(true)}>${t('writePost')}</button>`}
    </div>

    ${shown.length > 1 && html`<div className="pill-sort">
      <button className=${sort === 'active' ? 'on' : ''} onClick=${() => setSort('active')}>${t('sortActive')}</button>
      <button className=${sort === 'new' ? 'on' : ''} onClick=${() => setSort('new')}>${t('sortNewest')}</button>
    </div>`}

    ${notice && html`<p className="toast toast-float" role="status">${notice}</p>`}
    ${list === LOADING_LIST ? html`<${Skeleton} rows=${4} />` : shown.length === 0 && html`<p className="hint center-text">${t('noPosts')}</p>`}
    <div className="post-list">${shown.map(postItem)}</div>
  </div>`;
}

// =====================
// الإبلاغ عن مشكلة
// =====================
function FeedbackPage() {
  const [type, setType] = useState(null);
  const [text, setText] = useState('');
  const [tech, setTech] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const r = await feedbackApi.send({ type, text, tech });
    setBusy(false);
    if (r.error) setError(t(r.error, { s: Math.ceil(feedbackApi.waitLeft() / 1000) }));
    else setDone(true);
  };
  if (done) return html`<div className="page account">
    <div className="topbar"><${BackButton} to="#/" /></div>
    <div className="panel center">
      <span className="success-icon"><${Icon} name="check" size=${28} /></span>
      <p className="success-text">${t('feedbackThanks')}</p>
      <button className="cta" onClick=${() => go('#/')}>${t('continueListening')}</button>
    </div>
  </div>`;
  return html`<div className="page account">
    <div className="topbar"><${BackButton} to="#/" /></div>
    <form className="panel feedback" onSubmit=${submit}>
      <h1 className="acc-title">${t('feedbackTitle')}</h1>
      <p className="acc-line">${t('feedbackIntro')}</p>
      <div className="fb-types" role="radiogroup" aria-label=${t('feedbackTypeLabel')}>
        ${FEEDBACK_TYPES.map(k => html`<button type="button" key=${k} role="radio" aria-checked=${type === k}
          className=${type === k ? 'on' : ''} onClick=${() => { setType(k); setError(null); }}>${t('fbType_' + k)}</button>`)}
      </div>
      <textarea className="fb-text" value=${text} maxLength=${FEEDBACK_MAX} rows="5" placeholder=${t('feedbackPlaceholder')}
        onInput=${e => setText(e.target.value)} aria-label=${t('feedbackPlaceholder')}></textarea>
      <label className="code-check fb-tech">
        <input type="checkbox" checked=${tech} onChange=${e => setTech(e.target.checked)} />
        <span>${t('feedbackTech')}</span>
      </label>
      <p className="hint">${t('feedbackTechHint')}</p>
      ${error && html`<p className="form-error">${error}</p>`}
      <button className="cta" type="submit" disabled=${busy || !type}>${busy ? t('pleaseWait') : t('feedbackSend')}</button>
    </form>
  </div>`;
}

// التعليقات التي عليها بلاغات (للمشرفين): منشورات المجتمع وتعليقات اللقاءات
// البلاغ لا يحذف شيئًا: الحذف من هنا أو من قائمة التعليق فقط
function ReportedPosts() {
  const general = useComments(GENERAL_ID);
  const reports = useReactionTree(reactions.watchReports);
  const [lectureRows, setLectureRows] = useState({});   // معرّف التعليق → { lid, c }، أو null إذا لم يعد موجودًا
  const [busy, setBusy] = useState(null);

  // بلاغات تعليقات اللقاءات تحمل معرّف اللقاء كقيمة
  const wanted = Object.entries(reports).map(([cid, node]) => {
    const lid = Object.values(node || {}).find(v => typeof v === 'string' && LECTURE_BY_ID[v]);
    return lid ? { cid, lid } : null;
  }).filter(Boolean);
  const wantedKey = wanted.map(w => w.cid).sort().join(',');
  useEffect(() => {
    let on = true;
    wanted.forEach(w => {
      if (lectureRows[w.cid] !== undefined) return;
      database.ref('/comments/' + w.lid + '/' + w.cid).once('value').then(snap => {
        if (!on) return;
        const v = snap.val();
        const row = v && typeof v.t === 'string' ? { lid: w.lid, c: { id: w.cid, ...v } } : null;
        setLectureRows(x => ({ ...x, [w.cid]: row }));
        if (!row && staff.isMod) reactions.clearReports(w.cid);      // تعليق حذفه صاحبه: تُزال بلاغاته
      }).catch(() => {});
    });
    return () => { on = false; };
  }, [wantedKey]);

  const rows = [
    ...general.map(c => ({ lid: GENERAL_ID, c })),
    ...wanted.map(w => lectureRows[w.cid]).filter(Boolean),
  ].map(r => ({ ...r, n: reactions.count(reports[r.c.id]) })).filter(r => r.n > 0).sort((a, b) => b.n - a.n);

  const open = (r) => {
    if (r.lid === GENERAL_ID) return go('#/community?c=' + r.c.id);
    pendingFocus = { lid: r.lid, cid: r.c.p || r.c.id };
    go('#/lecture/' + r.lid);
  };
  const del = async (r) => {
    if (!window.confirm(t('deleteConfirm'))) return;
    setBusy(r.c.id);
    let replies = [];
    try {
      if (r.c.p) replies = [];
      else if (r.lid === GENERAL_ID) replies = general.filter(x => x.p === r.c.id);
      else {
        const snap = await database.ref('/comments/' + r.lid).orderByChild('p').equalTo(r.c.id).once('value');
        snap.forEach(ch => { replies.push({ id: ch.key, ...ch.val() }); });
      }
    } catch (e) {}
    const res = await commentsApi.remove(r.lid, r.c, replies);
    setBusy(null);
    if (res.ok) {
      reactions.clearReports(r.c.id);
      if (r.lid !== GENERAL_ID) setLectureRows(x => ({ ...x, [r.c.id]: null }));
    }
  };

  if (!rows.length) return html`<p className="hint">${t('reportedNone')}</p>`;
  return html`<ul className="fb-list">${rows.map((r) => html`<li key=${r.c.id} className="fb-item">
    <div className="c-meta"><${CommentAuthor} c=${r.c} /><span>${t('reportsCount', { n: r.n })}</span></div>
    <p className="hint">${r.lid === GENERAL_ID ? t('community') : shortTitle(r.lid)}${r.c.p ? ' · ' + t('reply') : ''}</p>
    <p className="c-text">${r.c.t}</p>
    <div className="c-actions">
      <button className="small-btn" onClick=${() => open(r)}>${t('openPost')}</button>
      <button className="link-btn muted" onClick=${() => reactions.clearReports(r.c.id)}>${t('ignoreReports')}</button>
      ${staff.isMod && html`<button className="link-btn danger-link" disabled=${busy === r.c.id} onClick=${() => del(r)}>${t('delete')}</button>`}
    </div>
  </li>`)}</ul>`;
}

// قائمة البلاغات في صفحة المالك
function FeedbackList() {
  const [list, setList] = useState(null);
  const [openId, setOpenId] = useState(null);
  const [copiedId, setCopiedId] = useState(null);
  useEffect(() => feedbackApi.watch(setList), []);
  // نسخ البلاغ كاملًا: النوع والنص ورقم النسخة وتفاصيل الخطأ
  const copyOne = async (f, info) => {
    const text = [t('fbType_' + f.ty) + ' · v' + f.v + ' · ' + new Date(f.ts).toISOString(), f.t || '', info ? JSON.stringify(info, null, 1) : (f.i || '')]
      .filter(Boolean).join('\n');
    try { await navigator.clipboard.writeText(text); setCopiedId(f.id); setTimeout(() => setCopiedId(null), 2000); } catch (e) {}
  };
  if (!list) return html`<p className="hint">${t('pleaseWait')}</p>`;
  if (!list.length) return html`<p className="hint">${t('feedbackNone')}</p>`;
  return html`<ul className="fb-list">${list.map(f => {
    let info = null;
    try { info = f.i ? JSON.parse(f.i) : null; } catch (e) {}
    return html`<li key=${f.id} className="fb-item">
      <div className="c-meta"><b>${t('fbType_' + f.ty)}</b><span>${relTime(f.ts)} · v${f.v}</span></div>
      ${f.t && html`<p className="c-text">${f.t}</p>`}
      ${info && html`<button className="link-btn muted" onClick=${() => setOpenId(openId === f.id ? null : f.id)}>${t('feedbackDetails')}</button>`}
      ${info && openId === f.id && html`<pre className="fb-info" dir="ltr">${JSON.stringify(info, null, 1)}</pre>`}
      <div className="c-actions">
        <button className="small-btn" onClick=${() => feedbackApi.resolve(f.id)}>${t('feedbackResolved')}</button>
        <button className="small-btn" onClick=${() => copyOne(f, info)}>${copiedId === f.id ? t('copied') : t('copy')}</button>
      </div>
    </li>`;
  })}</ul>`;
}

// =====================
// صفحة المميزين (سرية، تُفتح من الرابط فقط)
// =====================
// =====================
// إضافة اللقاءات من صفحة المميزين (للمالك)
// =====================
// قياس مدة ملف صوتي من رابطه. يعيد الثواني، أو null إذا تعذّر فتح الرابط
function measureAudio(url) {
  return new Promise(resolve => {
    let done = false;
    const a = new Audio();
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { a.removeAttribute('src'); a.load(); } catch (e) {} resolve(v); };
    const timer = setTimeout(() => finish(null), 25000);
    a.preload = 'metadata';
    a.onloadedmetadata = () => finish(isFinite(a.duration) && a.duration > 0 ? Math.round(a.duration) : null);
    a.onerror = () => finish(null);
    a.src = url;
  });
}

// ملفات mp3 الموجودة في صفحتي الأرشيف المعتادتين، مع مددها إن ذكرها الأرشيف
async function loadArchiveFiles() {
  const out = { normal: [], fast: [] };
  const parseLen = (x) => {
    if (x == null) return null;
    const s = String(x);
    const v = s.includes(':') ? parseLooseTime(s) : parseFloat(s);
    return v > 0 && isFinite(v) ? Math.round(v) : null;
  };
  await Promise.all(['normal', 'fast'].map(async mode => {
    try {
      const item = /\/download\/([^/]+)\//.exec(ARCHIVE_DIR[mode])[1];
      const res = await fetch('https://archive.org/metadata/' + item + '/files', { credentials: 'omit' });
      if (!res.ok) return;
      const j = await res.json();
      ((j && (j.result || j.files)) || []).forEach(f => {
        if (f && typeof f.name === 'string' && /\.mp3$/i.test(f.name)) out[mode].push({ name: f.name.replace(/\.mp3$/i, ''), sec: parseLen(f.length) });
      });
    } catch (e) {}
  }));
  return out;
}

const splitHMS = (sec) => (sec > 0 ? { h: String(Math.floor(sec / 3600)), m: String(Math.floor(sec % 3600 / 60)), s: String(sec % 60) } : { h: '', m: '', s: '' });
const joinHMS = (d) => (parseInt(d.h, 10) || 0) * 3600 + (parseInt(d.m, 10) || 0) * 60 + (parseInt(d.s, 10) || 0);
const fileOfUrl = (url) => { try { return decodeURIComponent(url.split('/').pop()).replace(/\.mp3$/i, ''); } catch (e) { return ''; } };
const lectureNameOnly = (title) => String(title || '').replace(/^\s*لقاء\s*[0-9٠-٩]+\s*[-–—:،,]*\s*/, '').trim();

// رابط نسخة واحدة ومدتها: من صفحة الأرشيف المعتادة (يُكتب اسم الملف فقط) أو رابط كامل آخر
function LectureSource({ mode, value, onChange, files }) {
  const set = (patch) => onChange(Object.assign({}, value, patch));
  const url = lectureSourceUrl(mode, value);
  const entered = joinHMS(value);
  const measure = async (v = value) => {
    const u = lectureSourceUrl(mode, v);
    if (!validMp3Url(u) || v.checking) return;
    if (v.measuredFor === u && v.measured != null) return;          // قيس هذا الرابط من قبل
    onChange(Object.assign({}, v, { checking: true }));
    const sec = await measureAudio(u);
    // الحالة قد تكون تغيّرت أثناء القياس: تُحدَّث من آخر قيمة، ولا تُمس مدة كتبها المالك
    onChange(prev => {
      const next = Object.assign({}, prev, { checking: false });
      if (lectureSourceUrl(mode, prev) !== u) return next;
      Object.assign(next, { measured: sec == null ? 'fail' : sec, measuredFor: u });
      if (sec != null && !joinHMS(prev)) Object.assign(next, splitHMS(sec));
      return next;
    });
  };
  const pickFile = (f) => {
    const next = Object.assign({}, value, { src: 'archive', file: f.name, measured: null });
    if (f.sec) { Object.assign(next, splitHMS(f.sec), { measured: f.sec, measuredFor: lectureSourceUrl(mode, next) }); onChange(next); }
    else measure(next);
  };
  const fresh = value.measuredFor === url;
  const differs = fresh && typeof value.measured === 'number' && entered > 0 && Math.abs(entered - value.measured) > 3;

  return html`<fieldset className="lec-src">
    <legend>${t(mode === 'normal' ? 'lecSrcNormal' : 'lecSrcFast')}</legend>
    <div className="seg lec-seg" role="tablist">
      <button type="button" role="tab" aria-selected=${value.src === 'archive'} className=${value.src === 'archive' ? 'on' : ''} onClick=${() => set({ src: 'archive' })}>${t('lecFromArchive')}</button>
      <button type="button" role="tab" aria-selected=${value.src === 'url'} className=${value.src === 'url' ? 'on' : ''} onClick=${() => set({ src: 'url' })}>${t('lecFromUrl')}</button>
    </div>
    ${value.src === 'archive'
      ? html`<${React.Fragment}>
          <div className="lec-file" dir="ltr">
            <span className="lec-fix" title=${ARCHIVE_DIR[mode]}>…/${ARCHIVE_DIR[mode].split('/').slice(-2, -1)[0]}/</span>
            <input value=${value.file} placeholder=${t('lecFilePh')} aria-label=${t('lecFilePh')} autoComplete="off" autoCapitalize="off" spellCheck="false"
              onInput=${e => set({ file: e.target.value.replace(/\.mp3$/i, '') })} onBlur=${() => measure()} />
            <span className="lec-fix">.mp3</span>
          </div>
          ${files.length > 0 && html`<div className="lec-files">
            ${files.map(f => html`<button type="button" key=${f.name} dir="ltr" className=${'lec-chip' + (value.file === f.name ? ' on' : '')} onClick=${() => pickFile(f)}>${f.name}</button>`)}
          </div>`}
        <//>`
      : html`<input className="name-input lec-url" dir="ltr" value=${value.url} placeholder="https://…/file.mp3" aria-label=${t('lecFromUrl')}
          autoComplete="off" autoCapitalize="off" spellCheck="false" onInput=${e => set({ url: e.target.value.trim().replace(/ /g, '%20') })} onBlur=${() => measure()} />`}
    <div className="lec-dur">
      <span className="hint">${t('lecDuration')}</span>
      ${[['h', 'lecHours'], ['m', 'lecMinutes'], ['s', 'lecSeconds']].map(([k, label]) => html`<label key=${k}>
        <input inputMode="numeric" maxLength="2" dir="ltr" value=${value[k]} aria-label=${t(label)}
          onInput=${e => set({ [k]: e.target.value.replace(/[^0-9]/g, '') })} />
        <small>${t(label)}</small>
      </label>`)}
    </div>
    ${value.checking && html`<p className="hint">${t('lecChecking')}</p>`}
    ${!value.checking && fresh && value.measured === 'fail' && html`<p className="form-error">${t('lecLinkFailed')}</p>`}
    ${!value.checking && fresh && typeof value.measured === 'number' && !differs && html`<p className="hint lec-ok"><${Icon} name="check" size=${12} /> ${t('lecLinkOk')}</p>`}
    ${!value.checking && differs && html`<p className="form-error">${t('lecDurDiffers', { t: fmtTime(value.measured) })}
      <button type="button" className="link-btn" onClick=${() => set(splitHMS(value.measured))}>${t('lecUseMeasured')}</button></p>`}
  </fieldset>`;
}
const emptySource = () => ({ src: 'archive', file: '', url: '', h: '', m: '', s: '', measured: null, measuredFor: null, checking: false });
function lectureSourceUrl(mode, v) {
  if (v.src === 'url') return v.url;
  const f = String(v.file || '').trim();
  return f ? ARCHIVE_DIR[mode] + encodeURIComponent(f) + '.mp3' : '';
}
const sourceFromUrl = (mode, url, sec) => Object.assign(emptySource(), splitHMS(sec),
  url.startsWith(ARCHIVE_DIR[mode]) ? { src: 'archive', file: fileOfUrl(url) } : { src: 'url', url });

function LectureAdmin() {
  const [, force] = useState(0);
  useEffect(() => extraLectures.subscribe(() => force(x => x + 1)), []);
  const added = extraLectures.raw ? cleanExtraLectures(extraLectures.raw) : EXTRA_LECTURES;
  const nextNum = () => {
    const nums = LECTURES.concat(added).filter(l => l.id[0] === 'L').map(l => parseInt(l.id.slice(1), 10));
    return String(Math.min(99, Math.max(0, ...nums) + 1));
  };
  const [editing, setEditing] = useState(null);       // معرّف اللقاء الجاري تعديله
  const [num, setNum] = useState(nextNum);
  const [name, setName] = useState('');
  const [normal, setNormal] = useState(emptySource);
  const [fast, setFast] = useState(emptySource);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  // تاريخ النشر ورابطه: اختياريان، ويُحفظان مع اللقاء في فرع published
  const [pubDate, setPubDate] = useState('');
  const [pubUrl, setPubUrl] = useState('');
  const [files, setFiles] = useState({ normal: [], fast: [] });
  useEffect(() => { let on = true; loadArchiveFiles().then(f => { if (on) setFiles(f); }); return () => { on = false; }; }, []);

  // ملفات الأرشيف التي لم تُستعمل في أي لقاء بعد
  const usedFiles = (mode) => new Set(LECTURES.concat(added).filter(l => l.id !== editing).map(l => fileOfUrl(l.extra ? l.url[mode] : mediaUrl(mode, l.id))));
  const freeFiles = (mode) => { const used = usedFiles(mode); return files[mode].filter(f => !used.has(f.name)); };

  const n = parseInt(num, 10);
  const id = n >= 1 && n <= 99 ? 'L' + String(n).padStart(2, '0') : null;
  const cleanName = lectureNameOnly(name);
  const title = id && cleanName ? t('lecTitleFmt', { n, name: cleanName }) : '';
  const taken = id && id !== editing && (STATIC_LECTURE_IDS.has(id) || added.some(l => l.id === id));
  const reset = () => { setEditing(null); setNum(nextNum()); setName(''); setNormal(emptySource()); setFast(emptySource()); setPubDate(''); setPubUrl(''); };

  const startEdit = (l) => {
    setMsg(null); setEditing(l.id); setNum(String(parseInt(l.id.slice(1), 10))); setName(lectureNameOnly(l.title));
    setNormal(sourceFromUrl('normal', l.url.normal, l.normal)); setFast(sourceFromUrl('fast', l.url.fast, l.fast));
    const p = published.get(l.id);
    setPubDate(p ? p.d : ''); setPubUrl(p && p.u ? p.u : '');
  };
  const save = async (e) => {
    e.preventDefault();
    setMsg(null);
    const un = lectureSourceUrl('normal', normal), uf = lectureSourceUrl('fast', fast);
    const sn = joinHMS(normal), sf = joinHMS(fast);
    if (!id) return setMsg('lecBadNumber');
    if (taken) return setMsg('lecNumberTaken');
    if (!cleanName) return setMsg('lecNoName');
    if (!validMp3Url(un) || !validMp3Url(uf)) return setMsg('lecBadUrl');
    if (!validSeconds(sn) || !validSeconds(sf)) return setMsg('lecBadDuration');
    if (pubUrl && !validHttpsUrl(pubUrl)) return setMsg('pubBadUrl');
    if (pubUrl && !pubDate) return setMsg('pubBadDate');
    const unchecked = [[normal, un], [fast, uf]].some(([v, u]) => v.measuredFor !== u || typeof v.measured !== 'number');
    const summary = t('lecConfirm', { title, normal: fmtTime(sn), fast: fmtTime(sf) }) + (unchecked ? '\n\n' + t('lecConfirmUnchecked') : '');
    if (!window.confirm(summary)) return;
    setBusy(true);
    const old = editing && added.find(l => l.id === editing);
    const r = await staff.saveLecture(id, { title: title.slice(0, 120), normal: sn, fast: sf, urlNormal: un, urlFast: uf }, old && old.from);
    if (!r.error && pubDate) await staff.savePublished(id, pubDate, pubUrl);
    setBusy(false);
    if (r.error) return setMsg(r.error);
    reset();
    setMsg('lecSaved');
    setTimeout(() => location.reload(), 1500);     // تُعاد الصفحة لتُبنى القوائم وجدول الراديو باللقاء الجديد
  };
  const remove = async (l) => {
    if (!window.confirm(t('lecDeleteConfirm', { title: l.title }))) return;
    setBusy(true); setMsg(null);
    const r = await staff.removeLecture(l.id);
    setBusy(false);
    if (r.error) return setMsg(r.error);
    if (editing === l.id) reset();
    setMsg('lecDeleted');
    setTimeout(() => location.reload(), 1500);
  };

  return html`<div className="lec-admin">
    <form onSubmit=${save}>
      <div className="lec-head">
        <label className="lec-num"><small>${t('lecNumber')}</small>
          <input inputMode="numeric" maxLength="2" dir="ltr" value=${num} disabled=${!!editing} onInput=${e => setNum(e.target.value.replace(/[^0-9]/g, ''))} />
        </label>
        <label className="lec-name"><small>${t('lecName')}</small>
          <input value=${name} maxLength="100" placeholder=${t('lecNamePh')} onInput=${e => setName(e.target.value)} />
        </label>
      </div>
      ${title && html`<p className="hint">${t('lecPreview')} <b>${title}</b></p>`}
      ${taken && html`<p className="form-error">${t('lecNumberTaken')}</p>`}
      <${LectureSource} mode="normal" value=${normal} onChange=${setNormal} files=${freeFiles('normal')} />
      <${LectureSource} mode="fast" value=${fast} onChange=${setFast} files=${freeFiles('fast')} />
      <fieldset className="lec-src">
        <legend>${t('pubOptional')}</legend>
        <label className="pub-field"><small>${t('pubDate')}</small>
          <input type="date" dir="ltr" value=${pubDate} max="2100-12-31" onInput=${e => setPubDate(e.target.value)} />
        </label>
        <label className="pub-field"><small>${t('pubUrl')}</small>
          <input dir="ltr" className="lec-url" value=${pubUrl} placeholder="https://…" autoComplete="off" autoCapitalize="off" spellCheck="false"
            onInput=${e => setPubUrl(e.target.value.trim())} />
        </label>
      </fieldset>
      <button className="cta" type="submit" disabled=${busy}>${busy ? t('pleaseWait') : editing ? t('lecSaveEdit') : t('lecAdd')}</button>
      ${editing && html`<button type="button" className="link-btn muted center-text" onClick=${() => { reset(); setMsg(null); }}>${t('cancel')}</button>`}
      ${msg && html`<p className=${msg === 'lecSaved' || msg === 'lecDeleted' ? 'hint lec-ok' : 'form-error'}>${t(msg)}</p>`}
    </form>
    ${added.length > 0 && html`<ul className="staff-list">
      ${added.map(l => html`<li key=${l.id}>
        <span><b>${l.title}</b><br /><span className="hint">${t('lecDurations', { normal: fmtTime(l.normal), fast: fmtTime(l.fast) })}</span></span>
        <span className="lec-actions">
          <button className="link-btn" disabled=${busy} onClick=${() => startEdit(l)}>${t('edit')}</button>
          <button className="link-btn muted" disabled=${busy} onClick=${() => remove(l)}>${t('delete')}</button>
        </span>
      </li>`)}
    </ul>`}
  </div>`;
}

// من هم متصلون الآن وأين (للمالك): يوضّح الفرق بين من يستمع ومن فتح الموقع فقط
const PLACE_LABEL = { home: 'placeHome', course: 'sourceCourse', normal: 'sourceNormal', fast: 'sourceFast' };
function StaffOnline({ users }) {
  const by = {};
  users.forEach(u => { const k = PLACE_LABEL[u.at] ? u.at : 'home'; by[k] = (by[k] || 0) + 1; });
  const now = serverNow();
  const ago = (ts) => {
    const m = Math.max(0, Math.round((now - (ts || now)) / 60000));
    return m < 60 ? t('minutesOnly', { m }) : t('hoursMinutes', { h: Math.floor(m / 60), m: m % 60 });
  };
  const sorted = [...users].sort((a, b) => (a.since || 0) - (b.since || 0));
  return html`<div className="staff-online">
    <div className="rep-grid">
      <div><b>${users.filter(u => LISTEN_PLACES.includes(u.at)).length}</b><small>${t('staffOnlineListening')}</small></div>
      <div><b>${users.length}</b><small>${t('staffOnlineAll')}</small></div>
    </div>
    <ul className="staff-list">
      ${sorted.map((u, i) => html`<li key=${i}>
        <span><bdi dir="ltr">${u.countryCode || '—'}</bdi> · ${t(PLACE_LABEL[u.at] || 'placeHome')}</span>
        <span className="hint">${t('staffOnlineSince', { t: ago(u.since) })}</span>
      </li>`)}
    </ul>
  </div>`;
}

// عدد المستمعين في كل مرتبة، من /badges المقروءة للجميع
function StaffBadges() {
  const by = { core: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  Object.keys(badges.all()).forEach(n => {
    const l = badges.levelOf(n);
    if (l === 0) by.core++; else if (l >= 1) by[l]++;
  });
  return html`<div className="rep-grid">
    <div><b>${by.core}</b><small>${t('badgeCore')}</small></div>
    ${[1, 2, 3, 4, 5].map(l => html`<div key=${l}><b>${by[l]}</b><small>${t('staffBadgeLevel', { n: l })}</small></div>`)}
  </div>`;
}

// تقرير الاستماع من بيانات الحسابات (للمالك). يُحمَّل بزر، لا تلقائيًا، حتى لا يستهلك التنزيل
const STAFF_PERIODS = [{ key: '7', days: 7 }, { key: '30', days: 30 }, { key: 'all', days: 0 }];
function StaffReport() {
  const [users, setUsers] = useState(null);
  const [anon, setAnon] = useState([]);
  const [who, setWho] = useState('all');   // all | members | anon
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [period, setPeriod] = useState('30');
  const [siteSec, setSiteSec] = useState(null);

  const load = async () => {
    setBusy(true); setError(null);
    const r = await staff.loadUsers();
    if (r.error) { setBusy(false); return setError(r.error); }
    const a = await staff.loadAnon(new Set(r.users.map(u => u.an).filter(Boolean)));
    setBusy(false);
    setUsers(r.users);
    setAnon(a.users || []);
    try { setSiteSec((await database.ref('/stats/listen_seconds').once('value')).val() || 0); } catch (e) {}
  };

  if (!users) {
    return html`<div>
      <p className="acc-line">${t('staffReportHint')}</p>
      <button className="small-btn" disabled=${busy} onClick=${load}>${busy ? t('pleaseWait') : t('staffReportLoad')}</button>
      ${error && html`<p className="form-error">${t(error)}</p>`}
    </div>`;
  }

  const p = STAFF_PERIODS.find(x => x.key === period);
  const today = new Date();
  const group = who === 'members' ? users : who === 'anon' ? anon : users.concat(anon);
  const r = withRadio(buildListenReport(group, p.days ? dayKey(addDays(today, -(p.days - 1))) : '00000000', dayKey(today), !p.days));
  const srcTotal = r.c + r.r;
  const coreDone = group.filter(u => u.d && u.d.core).length;
  const fullDone = group.filter(u => u.d && u.d.lvl >= 1).length;
  return html`<div className="staff-report">
    <div className="seg seg-3" role="tablist">
      ${[['all', 'staffWhoAll', users.length + anon.length], ['members', 'staffWhoMembers', users.length], ['anon', 'staffWhoAnon', anon.length]].map(([k, l, n]) =>
        html`<button key=${k} role="tab" aria-selected=${who === k} className=${who === k ? 'on' : ''} onClick=${() => setWho(k)}>${t(l)} <bdi>${n}</bdi></button>`)}
    </div>
    <div className="seg seg-3" role="tablist">
      ${STAFF_PERIODS.map(x => html`<button key=${x.key} role="tab" aria-selected=${period === x.key}
        className=${period === x.key ? 'on' : ''} onClick=${() => setPeriod(x.key)}>${t('staffPeriod' + x.key)}</button>`)}
    </div>

    <div className="rep-grid">
      <div><b>${r.listeners}</b><small>${t('staffRepListeners', { n: r.accounts })}</small></div>
      <div><b>${r.total > 0 ? fmtListen(r.total) : '—'}</b><small>${t('staffRepTotal')}</small></div>
      <div><b>${r.listeners ? fmtListen(r.total / r.listeners) : '—'}</b><small>${t('staffRepAverage')}</small></div>
      <div><b>${siteSec != null ? fmtHours(siteSec) : '—'}</b><small>${t('staffRepSite')}</small></div>
      <div><b>${coreDone}</b><small>${t('badgeCore')}</small></div>
      <div><b>${fullDone}</b><small>${t('staffRepFullDone')}</small></div>
    </div>

    ${srcTotal > 0 && html`<${React.Fragment}>
      <h3>${t('staffRepSources')}</h3>
      <div className="src-bar">
        ${SOURCES.map(s => r[s.key] > 0 && html`<span key=${s.key} className=${s.cls} style=${{ width: (r[s.key] / srcTotal * 100) + '%' }}></span>`)}
      </div>
      <ul className="src-legend">
        ${[...SOURCES].sort((a, b) => r[b.key] - r[a.key]).map(s => html`<li key=${s.key}>
          <span className=${'dot ' + s.cls}></span>${t(s.label)}
          <b>${r[s.key] > 0 ? fmtListen(r[s.key]) : '—'} <${Pct} value=${Math.round(r[s.key] / srcTotal * 100) + '%'} /></b>
        </li>`)}
        ${r.legacy > 0 && html`<li><span className="dot"></span>${t('staffRepLegacy')}<b>${fmtListen(r.legacy)}</b></li>`}
      </ul>
    <//>`}

    ${r.lectures.length > 0 && html`<${React.Fragment}>
      <h3>${t('staffRepLectures')}</h3>
      <ul className="staff-list">
        ${r.lectures.slice(0, 10).map(e => html`<li key=${e.id}>
          <span><b>${shortTitle(e.id)}</b> · ${e.sec > 0 ? fmtListen(e.sec) : '—'}</span>
          <span className="hint">${t('staffRepLecMeta', { people: e.people, done: e.done })}</span>
        </li>`)}
      </ul>
    <//>`}

    ${r.top.length > 0 && html`<${React.Fragment}>
      <h3>${t('staffRepTop')}</h3>
      <ul className="staff-list">
        ${r.top.slice(0, 10).map((u, i) => html`<li key=${i}>
          <span className="top-who">${u.anon ? html`<span className="who-anon" aria-hidden="true"></span>${t('staffWhoAnonOne')}` : html`<${Icon} name="user" size=${14} />${t('staffWhoMemberOne')}`}</span>
          <span className="hint">${fmtListen(u.sec)}</span>
        </li>`)}
      </ul>
    <//>`}

    ${r.listeners === 0 && html`<p className="hint center-text">${t('staffRepEmpty')}</p>`}
    <button className="link-btn muted" disabled=${busy} onClick=${load}>${busy ? t('pleaseWait') : t('staffReportReload')}</button>
  </div>`;
}

// قسم مطوي في صفحة المميزين: يُفتح بالضغط على عنوانه، ولا يُحمَّل محتواه قبل فتحه
const StaffOpenCtx = React.createContext(null);
function StaffSection({ title, badge, children }) {
  const ctx = useContext(StaffOpenCtx);
  const ref = useRef(null);
  const open = ctx.open === title;
  useEffect(() => {
    if (open && ref.current) requestAnimationFrame(() => ref.current && ref.current.scrollIntoView({ block: 'start', behavior: 'smooth' }));
  }, [open]);
  return html`<section ref=${ref} className=${'staff-sec' + (open ? ' open' : '')}>
    <button className="staff-sec-head" onClick=${() => ctx.setOpen(open ? null : title)} aria-expanded=${open}>
      <span>${title}</span>
      ${badge > 0 && html`<span className="c-count">${badge}</span>`}
      <span className=${'chev' + (open ? ' chev-open' : '')} aria-hidden="true">⌄</span>
    </button>
    ${open && html`<div className="staff-sec-body">${children}</div>`}
  </section>`;
}

// عدد البلاغات المفتوحة، ليظهر بجانب عنوان القسم دون فتحه (للمالك فقط)
function useFeedbackCount(enabled) {
  const [n, setN] = useState(0);
  useEffect(() => (enabled ? feedbackApi.watch(list => setN(list.length)) : undefined), [enabled]);
  return enabled ? n : 0;
}

function StaffPage({ users }) {
  const feedbackCount = useFeedbackCount(!!staff.isOwner);
  const reportedCount = Object.keys(useReactionTree(reactions.watchReports)).length;
  useStaffVersion();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [mod, setMod] = useState(false);
  const [copied, setCopied] = useState(false);
  const [openSec, setOpenSec] = useState(null);   // قسم واحد مفتوح في كل مرة
  const secCtx = useMemo(() => ({ open: openSec, setOpen: setOpenSec }), [openSec]);

  const signIn = async () => {
    setBusy(true); setMsg(null);
    const r = await staff.signIn();
    setBusy(false);
    if (r.error) setMsg(t(r.error));
  };
  const copyUid = async () => {
    try { await navigator.clipboard.writeText(staff.uid); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch (e) {}
  };
  const countSubs = async () => {
    setBusy(true); setMsg(null);
    const r = await staff.countSubscribers();
    setBusy(false);
    setMsg(r.error ? t(r.error) : t('staffCountDone', { n: r.n }));
  };
  const addOne = async (e) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const r = await staff.add(uid, name, mod);
    setBusy(false);
    if (r.error) setMsg(t(r.error));
    else { setUid(''); setName(''); setMod(false); }
  };

  return html`<div className="page staff">
    <div className="topbar"><${BackButton} to="#/" /></div>
    <div className="panel">
      <h1 className="acc-title">${t('staffTitle')}</h1>

      ${!staff.user
        ? html`<button className="cta" disabled=${busy} onClick=${signIn}>${busy ? t('pleaseWait') : t('staffSignIn')}</button>`
        : html`<div className="staff-box">
            <p className="acc-line">${staff.user.email || ''}</p>
            ${staff.isStaff
              ? html`<p className="acc-line"><b className="staff-name"><span className="staff-check"><${Icon} name="check" size=${11} /></span>${staff.name}</b>
                  · ${staff.isOwner ? t('staffOwner') : staff.isMod ? t('staffMod') : t('staffMember')}</p>`
              : html`<p className="acc-line">${t('staffNotYet')}</p>`}
            <div className="uid-row">
              <code dir="ltr">${staff.uid}</code>
              <button className="small-btn" onClick=${copyUid}>${copied ? t('copied') : t('copy')}</button>
            </div>
          </div>`}

      ${staff.isOwner && html`<${StaffOpenCtx.Provider} value=${secCtx}><div className="staff-admin">
        <${StaffSection} title=${t('feedbackListTitle')} badge=${feedbackCount}><${FeedbackList} /><//>
        <${StaffSection} title=${t('reportedPostsTitle')} badge=${reportedCount}><${ReportedPosts} /><//>
        <${StaffSection} title=${t('staffOnlineTitle')} badge=${users.length}><${StaffOnline} users=${users} /><//>
        <${StaffSection} title=${t('staffReportTitle')}><${StaffReport} /><//>
        <${StaffSection} title=${t('staffBadgesTitle')}><${StaffBadges} /><//>
        <${StaffSection} title=${t('lecAdminTitle')}><${LectureAdmin} /><//>
        <${StaffSection} title=${t('pubAdminTitle')} badge=${Object.keys(published.all()).length}><${PublishedAdmin} /><//>
        <${StaffSection} title=${t('silAdminTitle')} badge=${silences.list().length}><${SilencesAdmin} /><//>
        <${StaffSection} title=${t('staffMembersTitle')} badge=${Object.keys(staff.list).length}>
          <form onSubmit=${addOne}>
            <input className="name-input" dir="ltr" placeholder=${t('staffUidPh')} value=${uid} onInput=${e => setUid(e.target.value)} aria-label=${t('staffUidPh')} />
            <input className="name-input" placeholder=${t('staffNamePh')} value=${name} onInput=${e => setName(e.target.value)} aria-label=${t('staffNamePh')} />
            <label className="check-row"><input type="checkbox" checked=${mod} onChange=${e => setMod(e.target.checked)} />${t('staffCanDelete')}</label>
            <button className="cta" type="submit" disabled=${busy || !uid.trim() || !name.trim()}>${t('staffAdd')}</button>
          </form>
          <ul className="staff-list">
            ${Object.entries(staff.list).map(([id, s]) => html`<li key=${id}>
              <span><b>${s.name}</b> · ${s.owner ? t('staffOwner') : s.mod ? t('staffMod') : t('staffMember')}</span>
              ${!s.owner && html`<button className="link-btn muted" onClick=${() => window.confirm(t('staffRemoveConfirm', { name: s.name })) && staff.remove(id)}>${t('delete')}</button>`}
            </li>`)}
          </ul>
        <//>
        <${StaffSection} title=${t('staffCountTitle')}>
          <p className="acc-line">${t('staffCountHint')}</p>
          <button className="small-btn" disabled=${busy} onClick=${countSubs}>${busy ? t('pleaseWait') : t('staffCountBtn')}</button>
        <//>
      </div><//>`}

      ${msg && html`<p className="form-error">${msg}</p>`}
      ${staff.user && html`<button className="link-btn muted center-text" onClick=${() => staff.signOut()}>${t('staffSignOut')}</button>`}
    </div>
  </div>`;
}

// =====================
// التقرير
// =====================
const PERIODS = ['day', 'week', 'month', 'year'];
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// حدود الفترة وأعمدتها: الأسبوع يبدأ يوم السبت، والسنة هي آخر 12 شهرًا
function periodRange(period, offset = 0) {
  const today = atMidnight(new Date());
  if (period === 'day') {
    const d = addDays(today, -offset);
    return { from: d, to: d, buckets: [] };
  }
  if (period === 'week') {
    const start = addDays(today, -((today.getDay() + 1) % 7) - 7 * offset);
    const buckets = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      return { from: d, to: d, label: t('weekdays').split(',')[i], today: +d === +today };
    });
    return { from: start, to: addDays(start, 6), buckets };
  }
  if (period === 'month') {
    const start = new Date(today.getFullYear(), today.getMonth() - offset, 1);
    const end = new Date(start.getFullYear(), start.getMonth() + 1, 0);
    const buckets = Array.from({ length: end.getDate() }, (_, i) => {
      const d = addDays(start, i);
      return { from: d, to: d, label: String(i + 1), today: +d === +today };
    });
    return { from: start, to: end, buckets };
  }
  const first = new Date(today.getFullYear(), today.getMonth() - 11 - 12 * offset, 1);
  const buckets = Array.from({ length: 12 }, (_, i) => {
    const from = new Date(first.getFullYear(), first.getMonth() + i, 1);
    const to = new Date(from.getFullYear(), from.getMonth() + 1, 0);
    return { from, to, label: String(from.getMonth() + 1), today: offset === 0 && i === 11 };
  });
  return { from: first, to: buckets[11].to, buckets };
}

// وقت الاستماع: أقل من دقيقة يُكتب نصًا بدل الصفر
const fmtListen = (sec) => (sec > 0 && sec < 60 ? t('lessThanMinute') : fmtHours(sec));

// مصادر الاستماع في التقارير: الكورس والراديو (محطتا الراديو العادية والسريعة معًا)
const SOURCES = [
  { key: 'c', label: 'sourceCourse', cls: 'src-c' },
  { key: 'r', label: 'sourceRadio', cls: 'src-n' },
];
const withRadio = (o) => ({ ...o, r: (o.n || 0) + (o.f || 0) });

function ReportPage() {
  useProgressVersion();
  const [period, setPeriod] = useState('week');
  const r = periodRange(period);
  const st = withRadio(progress.stats(dayKey(r.from), dayKey(r.to)));
  const pr = periodRange(period, 1);
  const prev = progress.stats(dayKey(pr.from), dayKey(pr.to));
  const total = st.total;

  const bars = r.buckets.map(b => {
    const from = dayKey(b.from), to = dayKey(b.to);
    const src = { c: 0, n: 0, f: 0 };
    Object.entries(st.bySrc).forEach(([k, v]) => {
      if (k >= from && k <= to) { src.c += v.c; src.n += v.n; src.f += v.f; }
    });
    return { ...b, src: withRadio(src), s: src.c + src.n + src.f };
  });
  const maxBar = Math.max(60, ...bars.map(b => b.s));

  let compare = null;
  if (prev.total >= 60 && total >= 60) {
    const diff = Math.round((total - prev.total) / prev.total * 100);
    if (diff !== 0) compare = { up: diff > 0, text: t(diff > 0 ? 'moreThanPrev' : 'lessThanPrev', { n: Math.abs(diff), p: t('prev_' + period) }) };
  }

  return html`<div className="page report">
    <div className="topbar">
      <${BackButton} to="#/course" />
      <div className="top-left"><${NameChip} /></div>
    </div>

    <div className="panel tint-course">
      <h1 className="acc-title">${t('report')}</h1>
      <div className="seg seg-4" role="tablist">
        ${PERIODS.map(p => html`<button key=${p} role="tab" aria-selected=${period === p}
          className=${period === p ? 'on' : ''} onClick=${() => setPeriod(p)}>${t('period_' + p)}</button>`)}
      </div>

      ${total < 1
        ? html`<div className="empty-report">
            <span className="title-icon big"><${Icon} name="chart" size=${26} /></span>
            <p>${t('empty_' + period)}</p>
          </div>`
        : html`<div>
            <div className="rep-total">
              <small>${t('listenTime')}</small>
              <b>${fmtListen(total)}</b>
              ${compare && html`<span className=${'rep-compare' + (compare.up ? ' up' : '')}>${compare.up ? '↑' : '↓'} ${compare.text}</span>`}
            </div>

            <div className="src-bar" aria-hidden="true">
              ${SOURCES.map(s => st[s.key] > 0 && html`<span key=${s.key} className=${s.cls} style=${{ width: (st[s.key] / total * 100) + '%' }}></span>`)}
            </div>
            <ul className="src-legend">
              ${SOURCES.map(s => html`<li key=${s.key}><span className=${'dot ' + s.cls}></span>${t(s.label)}<b>${st[s.key] > 0 ? fmtListen(st[s.key]) : '—'}</b></li>`)}
            </ul>

            ${bars.length > 0 && html`<div className=${'chart chart-' + period} role="img" aria-label=${t('chartLabel')}>
              ${bars.map((b, i) => html`<div key=${i} className=${'col' + (b.today ? ' col-today' : '')}>
                <div className="col-bar">
                  <div className="col-stack" style=${{ height: (b.s / maxBar * 100) + '%' }}>
                    ${SOURCES.map(s => b.src[s.key] > 0 && html`<span key=${s.key} className=${s.cls} style=${{ flexGrow: b.src[s.key] }}></span>`)}
                  </div>
                </div>
                ${(period !== 'month' || i % 5 === 0 || b.today) && html`<small>${b.label}</small>`}
              </div>`)}
            </div>`}

            <div className="rep-grid">
              <div><b>${st.completed}</b><small>${t('completedInPeriod')}</small></div>
              <div><b>${st.activeDays}</b><small>${t('listenDays')}</small></div>
            </div>
            ${st.top && st.top.sec >= 60 && html`<div className="rep-top">
              <small>${t('mostListened')}</small>
              <b>${LECTURE_BY_ID[st.top.id].title}</b>
              <span className="hint">${fmtListen(st.top.sec)}</span>
            </div>`}
          </div>`}
    </div>
  </div>`;
}

// =====================
// تثبيت الموقع كتطبيق على الشاشة الرئيسية
// الزر ظاهر في كل المتصفحات: يثبّت مباشرة إن سمح المتصفح، وإلا يعرض الخطوات
// =====================
const IS_STANDALONE = (() => {
  try { return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true; }
  catch (e) { return false; }
})();
let installPrompt = null;
const installListeners = new Set();
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  installListeners.forEach(fn => fn());
});
window.addEventListener('appinstalled', () => { installPrompt = null; installListeners.forEach(fn => fn()); });

// خطوات التثبيت حسب المتصفح
function installSteps() {
  const ua = navigator.userAgent;
  if (IS_IOS) return 'installStepsIos';
  if (/SamsungBrowser/i.test(ua)) return 'installStepsSamsung';
  if (/Firefox/i.test(ua)) return 'installStepsFirefox';
  if (/Android/i.test(ua)) return 'installStepsAndroid';
  return 'installStepsDesktop';
}

function InstallButton() {
  const [, setV] = useState(0);
  const [help, setHelp] = useState(false);
  useEffect(() => {
    const fn = () => setV(x => x + 1);
    installListeners.add(fn);
    return () => installListeners.delete(fn);
  }, []);
  if (IS_STANDALONE) return null;

  const onClick = async () => {
    if (installPrompt) {
      const p = installPrompt;
      installPrompt = null;
      try { p.prompt(); await p.userChoice; } catch (e) {}
      setV(x => x + 1);
      return;
    }
    setHelp(true);
  };

  return html`<span>
    <button className="foot-btn" onClick=${onClick}><${Icon} name="download" size=${16} />${t('installApp')}</button>
    ${help && html`<div className="modal-back" onClick=${() => setHelp(false)}>
      <div className="modal" role="dialog" aria-modal="true" onClick=${e => e.stopPropagation()}>
        <h2><${Icon} name="download" size=${18} />${t('installTitle')}</h2>
        <ol>${t(installSteps()).split('|').map((s, i) => html`<li key=${i}>${s}</li>`)}</ol>
        <button className="cta" onClick=${() => setHelp(false)}>${t('gotIt')}</button>
      </div>
    </div>`}
  </span>`;
}


// =====================
// صفحة الاسم
// =====================
function AccountPage({ returnTo }) {
  useAccountVersion();
  useProgressVersion();
  const [tab, setTab] = useState('login');
  const [codeExample] = useState(randomCodeExample);
  const [shotOpen, setShotOpen] = useState(false);   // مثال مختلف في كل زيارة للصفحة
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [confirmOut, setConfirmOut] = useState(false);
  // اسم التعليقات: ما دام معدّلًا ولم يُحفظ يصبح الزر الكبير «حفظ»
  const [titleValue, setTitleValue] = useState(() => account.title);
  const [titleMsg, setTitleMsg] = useState(null);
  // إذا وصل اسم محفوظ من جهاز آخر يُعرض بدل القديم
  useEffect(() => { setTitleValue(account.title); }, [account.title]);
  const titleDirty = account.loggedIn && titleValue.trim() !== account.title;
  const saveTitle = async () => {
    const r = await account.setTitle(titleValue);
    if (r.error) return setTitleMsg({ err: true, text: t(r.error) });
    setTitleValue(account.title);
    setTitleMsg({ text: t('titleSaved') });
    setTimeout(() => setTitleMsg(m => (m && !m.err ? null : m)), 3000);
  };

  // بعد النجاح: رسالة قصيرة ثم العودة إلى الصفحة السابقة
  useEffect(() => {
    if (!success || success === 'savedAs') return;   // بعد الإنشاء تبقى شاشة «احفظ رمزك» حتى يؤكد الحفظ
    const id = setTimeout(() => go(returnTo), 1800);
    return () => clearTimeout(id);
  }, [success, returnTo]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    const res = tab === 'new' ? await account.create(value) : await account.login(value);
    setBusy(false);
    if (res.error) setError(res.error);
    else { setValue(''); setSuccess(tab === 'new' ? 'savedAs' : 'restoredAs'); }
  };

  const warn = html`<p className="name-warn">${t('nameWarning')}</p>`;
  const continueBtn = html`<button className="cta" onClick=${() => go(returnTo)}>${t('continueListening')}</button>`;

  if (success === 'savedAs' && account.loggedIn) {
    return html`<div className="page account">
      <div className="topbar"></div>
      <${SaveCodeScreen} code=${account.name} onDone=${() => go(returnTo)} />
    </div>`;
  }

  if (success && account.loggedIn) {
    return html`<div className="page account">
      <div className="topbar"><${BackButton} to=${returnTo} /></div>
      <div className="panel center">
        <span className="success-icon"><${Icon} name="check" size=${28} /></span>
        <p className="success-text">${t(success)} <bdi dir="ltr">${account.name}</bdi></p>
        ${warn}
        ${continueBtn}
      </div>
    </div>`;
  }

  if (account.loggedIn) {
    const hidden = account.isHidden();
    const sum = progress.summary();
    return html`<div className="page account">
      <div className="topbar"></div>
      <div className="panel">
        <h1 className="acc-title">${t('accountTitle')}</h1>
        <div className="acc-name">
          <bdi dir="ltr">${hidden ? '•'.repeat(Math.min(10, account.name.length)) : account.name}</bdi>
          <button className="eye" onClick=${() => account.setHidden(!hidden)}
            aria-label=${hidden ? t('showName') : t('hideName')}><${Icon} name=${hidden ? 'eye' : 'eyeOff'} /></button>
        </div>
        ${warn}
        <button className="link-btn" onClick=${() => setShotOpen(true)}>${t('codeShotOpen')}</button>
        ${shotOpen && html`<${CodeShot} code=${account.name} onClose=${() => setShotOpen(false)} />`}
        <p className="acc-line">${t('accountHint')}</p>
        <p className="acc-line">
          <span className=${'sync-dot sync-' + account.status}></span>
          ${t(SYNC_KEY[account.status] || 'syncIdle')}
          <button className="link-btn" onClick=${() => account.sync()}>${t('syncNow')}</button>
        </p>
        <p className="acc-line">${t('doneOf', { done: sum.done, count: sum.count })} · <${Pct} value=${sum.percent} /></p>
        ${account.nick && html`<${TitleEditor} value=${titleValue} msg=${titleMsg}
          setValue=${(v) => { setTitleValue(v); setTitleMsg(null); }} onSave=${saveTitle} />`}
        ${titleDirty
          ? html`<button className="cta" onClick=${saveTitle} disabled=${!titleValue.trim()}>${t('save')}</button>`
          : continueBtn}
        <div className="acc-out">
          ${confirmOut
            ? html`<div>
                <p className="acc-line">${t('logoutConfirm')}</p>
                <div className="nav">
                  <button className="small-btn danger" onClick=${async () => { await account.logout(); setConfirmOut(false); }}>${t('logoutYes')}</button>
                  <button className="small-btn" onClick=${() => setConfirmOut(false)}>${t('cancel')}</button>
                </div>
              </div>`
            : html`<button className="link-btn muted" onClick=${() => setConfirmOut(true)}>${t('logout')}</button>`}
        </div>
        <p className="foot-link"><button className="link-btn muted" onClick=${() => go('#/feedback')}>${t('reportProblem')}</button></p>
      </div>
    </div>`;
  }

  return html`<div className="page account">
    <div className="topbar"></div>
    <div className="panel">
      <h1 className="acc-title">${t('accountTitle')}</h1>
      <p className="acc-line">${t('accountIntro')}</p>

      <div className="seg" role="tablist">
        <button role="tab" aria-selected=${tab === 'login'} className=${tab === 'login' ? 'on' : ''}
          onClick=${() => { setTab('login'); setError(null); }}>${t('tabLogin')}</button>
        <button role="tab" aria-selected=${tab === 'new'} className=${tab === 'new' ? 'on' : ''}
          onClick=${() => { setTab('new'); setError(null); }}>${t('tabNew')}</button>
      </div>

      <form onSubmit=${submit}>
        <input className="name-input" dir="ltr" lang="en" value=${value} autoComplete="off" autoCapitalize="none"
          autoCorrect="off" spellCheck="false" placeholder=${tab === 'new' ? t('namePlaceholderNew', { ex: codeExample }) : t('namePlaceholderLogin')}
          onInput=${e => setValue(e.target.value)} aria-label=${t('accountTitle')} />
        ${tab === 'new' && /[\u0600-\u06FF]/.test(value.replace(/[٠-٩۰-۹]/g, '')) && html`<p className="form-error">${t('nameLatinOnly')}</p>`}
        ${tab === 'new' && html`<div className="name-tools"><span className="hint">${t('nameRules')}</span></div>`}
        ${tab === 'new' && html`<p className="hint code-tip">${t('codeTip')}</p>`}
        ${tab === 'new' && codeStrength(value) && html`<div className=${'strength strength-' + codeStrength(value)} aria-live="polite">
          <span className="strength-bar"><i></i><i></i><i></i></span>
          <span className="strength-label">${t('strength_' + codeStrength(value))}</span>
        </div>`}
        ${error && html`<p className="form-error">${t(error)}</p>`}
        ${tab === 'new' && html`<ul className="code-notes">
          <li>${t('codeNote1')}</li><li>${t('codeNote2')}</li><li>${t('codeNote3')}</li><li>${t('codeNote4')}</li>
        </ul>`}
        <button className="cta" type="submit" disabled=${busy || !value.trim()}>
          ${busy ? t('pleaseWait') : (tab === 'new' ? t('createName') : t('loginName'))}
        </button>
        ${tab === 'new' && progress.hasAny() && html`<p className="hint center-text">${t('mergeNote')}</p>`}
        ${tab === 'login' && html`<p className="hint center-text">${t('loginNote')}</p>`}
      </form>
    </div>
  </div>`;
}

// تغيير اللقب الذي يسبق الرقم في التعليقات؛ الحفظ من الزر الكبير أسفل الصفحة أو بزر الإدخال
function TitleEditor({ value, setValue, msg, onSave }) {
  return html`<form className="title-edit" onSubmit=${(e) => { e.preventDefault(); onSave(); }}>
    <label><small>${t('titleLabel')}</small>
      <div className="title-row">
        <input value=${value} maxLength=${TITLE_MAX} enterKeyHint="done"
          onInput=${e => setValue(e.target.value)} aria-label=${t('titleLabel')} />
        <bdi className="title-num">${account.nick}</bdi>
      </div>
    </label>
    ${msg ? html`<p className=${msg.err ? 'form-error' : 'hint title-ok'}>${msg.text}</p>` : html`<p className="hint">${t('titleHint')}</p>`}
  </form>`;
}

// شاشة «احفظ رمزك» بعد إنشاء رمز جديد: نسخ، وحفظه كصورة، وتأكيد قبل المتابعة
// =====================
// شاشة صفراء كاملة للقطة شاشة: لون لا يتكرر في معرض الصور فيسهل إيجادها بين آلاف الصور،
// والرمز وحده بلا أي كلام. بلا اسم الموقع ولا شعاره ولا أي كلمة عن الكورس،
// فمن يراها في المعرض لا يعرف أنها لهذا الموقع
// =====================
// صورة الرمز: صفراء والرمز وحده، تُرسم في الصفحة فلا يظهر فيها أي رابط
async function makeCodeImage(code) {
  try { await document.fonts.ready; } catch (e) {}
  const W = 1080, H = 1920;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.fillStyle = '#FFD60A'; x.fillRect(0, 0, W, H);
  // الرمز وحده في المنتصف، يصغر الخط إن طال الرمز
  x.direction = 'ltr'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillStyle = '#111';
  let size = 130;
  do { x.font = '800 ' + size + 'px ui-monospace, Menlo, Consolas, monospace'; size -= 4; } while (x.measureText(code).width > W - 160 && size > 40);
  x.fillText(code, W / 2, H / 2);
  return new Promise(res => c.toBlob(res, 'image/png'));
}
// الآيفون: قائمة المشاركة وفيها «حفظ الصورة» إلى الصور. غيره: تنزيل مباشر يظهر في معرض الصور
async function saveCodeImage(code) {
  const blob = await makeCodeImage(code);
  if (!blob) return false;
  const file = new File([blob], 'code.png', { type: 'image/png' });
  if (IS_IOS && navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return true; } catch (e) { if (e && e.name === 'AbortError') return false; }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'code.png';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return true;
}

function CodeShot({ code, onClose }) {
  const [saved, setSaved] = useState(false);
  const save = async () => { if (await saveCodeImage(code)) setSaved(true); };
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);
  return html`<div className="code-shot" role="dialog" aria-modal="true" aria-label=${t('codeShotTitle')}>
    <bdi className="code-shot-code" dir="ltr">${code}</bdi>
    <button className="code-shot-save" onClick=${save}>${saved ? t('codeShotSaved') : t('codeShotSave')}</button>
    <button className="code-shot-done" onClick=${onClose}>${t('codeShotDone')}</button>
  </div>`;
}

function SaveCodeScreen({ code, onDone }) {
  const [shot, setShot] = useState(true);   // تظهر مرة تلقائيًا بعد إنشاء الحساب
  const [copied, setCopied] = useState(false);
  const [checked, setChecked] = useState(false);
  const copy = async () => {
    try { await navigator.clipboard.writeText(code); }
    catch (e) {
      const ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta);
      ta.select(); try { document.execCommand('copy'); } catch (e2) {} ta.remove();
    }
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  };
  return html`<div className="panel center save-code">
    ${shot && html`<${CodeShot} code=${code} onClose=${() => setShot(false)} />`}
    <span className="success-icon"><${Icon} name="check" size=${28} /></span>
    <h1 className="acc-title">${t('saveCodeTitle')}</h1>
    <p className="acc-line">${t('saveCodeHint')}</p>
    <bdi className="code-big" dir="ltr">${code}</bdi>
    <div className="nav">
      <button className="small-btn" onClick=${copy}>${copied ? t('copied') : t('copyCode')}</button>
      <button className="small-btn" onClick=${() => setShot(true)}>${t('codeShotOpen')}</button>
    </div>
    <label className="code-check">
      <input type="checkbox" checked=${checked} onChange=${e => setChecked(e.target.checked)} />
      <span>${t('savedCodeCheck')}</span>
    </label>
    <button className="cta" disabled=${!checked} onClick=${onDone}>${t('continueListening')}</button>
  </div>`;
}

const SYNC_KEY = { syncing: 'syncSyncing', synced: 'syncSynced', error: 'syncError', idle: 'syncIdle' };

// =====================
// المشغّل المصغّر: يظهر أسفل الشاشة أثناء الاستماع في صفحة أخرى
// =====================
// تنبيه خفيف لمن يفتح الموقع من المتصفح الداخلي لتطبيق (فيسبوك، إنستغرام...)، حيث يتعطل الصوت أحيانًا
// سطر واحد أعلى الصفحة لا يغطي شيئًا، ويختفي نهائيًا على هذا الجهاز عند إغلاقه
const IN_APP_KEY = 'inapp_hint_off';
const isInAppBrowser = () => /FBAN|FBAV|FB_IAB|Instagram|Line\/|TikTok|musical_ly|Snapchat|Twitter/i.test(navigator.userAgent || '');
function InAppHint() {
  const [show, setShow] = useState(() => isInAppBrowser() && !storage.get(IN_APP_KEY));
  const [copied, setCopied] = useState(false);
  if (!show) return null;
  const close = () => { storage.set(IN_APP_KEY, '1'); setShow(false); };
  const page = location.href.split('#')[0];
  const android = /Android/i.test(navigator.userAgent || '');
  // على أندرويد: رابط يفتح الصفحة في كروم مباشرة. على غيره: نسخ الرابط للصقه في المتصفح
  const chrome = 'intent://' + page.replace(/^https?:\/\//, '') + '#Intent;scheme=https;package=com.android.chrome;end';
  const copy = async () => {
    try { await navigator.clipboard.writeText(page); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch (e) {}
  };
  return html`<div className="inapp" role="note">
    <span>${t('inAppHint')}</span>
    ${android
      ? html`<a className="inapp-go" href=${chrome}>${t('inAppOpen')}</a>`
      : html`<button className="inapp-go" onClick=${copy}>${copied ? t('copied') : t('inAppCopy')}</button>`}
    <button className="inapp-x" onClick=${close} aria-label=${t('inAppClose')}>×</button>
  </div>`;
}

// =====================
// شريط التنقّل السفلي: أربع خانات ثابتة كما في تطبيقات الهاتف. الخانة المفتوحة بلون الكورس
// وخلفها كبسولة خفيفة، والضغط عليها وهي مفتوحة يعيد الصفحة إلى أولها. يختفي مع لوحة المفاتيح
// وفي صفحة الإدارة. نقطة صغيرة على الكورس والمجتمع عند وجود تعليقات جديدة أو رد عليك
// =====================
const NAV_TABS = [
  { key: 'home', hash: '#/', icon: 'home', label: 'navHome' },
  { key: 'course', hash: '#/course', icon: 'book', label: 'navCourse' },
  { key: 'general', hash: '#/general', icon: 'chat', label: 'navCommunity' },
  { key: 'account', hash: '#/account', icon: 'user', label: 'navAccount' },
];
const NAV_HIDDEN = ['staff'];
const tabOf = (route) => (route.page === 'radio' ? 'home'
  : ['course', 'lecture', 'report'].includes(route.page) ? 'course'
  : route.page === 'general' ? 'general'
  : route.page === 'account' ? 'account'
  : route.page === 'home' ? 'home' : null);

function useKeyboardOpen() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const isField = (el) => el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !['checkbox', 'radio', 'range', 'button'].includes(el.type)));
    const on = (e) => { if (isField(e.target)) setOpen(true); };
    const off = () => setTimeout(() => setOpen(isField(document.activeElement)), 50);
    document.addEventListener('focusin', on);
    document.addEventListener('focusout', off);
    return () => { document.removeEventListener('focusin', on); document.removeEventListener('focusout', off); };
  }, []);
  return open;
}

function BottomNav({ route }) {
  const feed = useRecentFeed(100);
  const general = useComments(GENERAL_ID);
  const kb = useKeyboardOpen();
  if (NAV_HIDDEN.includes(route.page) || kb) return null;
  const current = tabOf(route);
  const dot = {
    course: feed.some(c => isReplyToMe(c, c.l)) ? 'me' : feed.some(c => isNewComment(c, c.l)) ? 'new' : null,
    general: general.some(c => isReplyToMe(c, GENERAL_ID)) ? 'me' : general.some(c => isNewComment(c, GENERAL_ID)) ? 'new' : null,
  };
  const press = (tab) => {
    if (normHash(location.hash) === tab.hash) { window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
    go(tab.hash);
  };
  return html`<nav className="bottom-nav" aria-label=${t('navLabel')}>
    ${NAV_TABS.map(tab => {
      const on = current === tab.key;
      return html`<button key=${tab.key} className=${'nav-item' + (on ? ' on' : '')} onClick=${() => press(tab)}
          aria-current=${on ? 'page' : undefined}>
        <span className="nav-pill">
          <${Icon} name=${tab.icon} size=${22} />
          ${dot[tab.key] && html`<span className=${'nav-dot' + (dot[tab.key] === 'me' ? ' me' : '')}
            aria-label=${t(dot[tab.key] === 'me' ? 'repliedToYou' : 'newComments')}></span>`}
        </span>
        <span className="nav-label">${t(tab.label)}</span>
      </button>`;
    })}
  </nav>`;
}

// المشغّل الصغير: يبقى ظاهرًا عند الإيقاف المؤقت، فيتحول زره إلى تشغيل يكمل من الموضع نفسه.
// وعند الإيقاف فقط يظهر × لإخفائه حتى التشغيل التالي
function MiniPlayer({ player, route }) {
  const [closed, setClosed] = useState(false);
  useEffect(() => { if (player.isPlaying) setClosed(false); }, [player.isPlaying]);
  if (closed || !player.mode) return null;
  const isLecture = player.mode === 'lecture';
  const fastCourse = isLecture && player.variant === 'fast';
  if (isLecture && route.page === 'lecture' && route.id === player.lectureId && route.variant === player.variant) return null;
  if (!isLecture && route.page === 'radio' && route.mode === player.mode) return null;
  const id = isLecture ? player.lectureId : (player.live && player.live.track.id);
  if (!id || !LECTURE_BY_ID[id]) return null;
  const paused = !player.isPlaying;
  // الراديو الموقوف دون موضع محفوظ لا معنى لإبقائه
  if (paused && !isLecture && !player.shifted) return null;
  const target = isLecture ? lectureHash(id, player.variant) : '#/radio/' + player.mode;
  const busy = !paused && (player.status === 'loading' || player.status === 'next');
  const toggle = () => {
    if (!paused) return player.stop();
    if (isLecture) player.playLecture(id, player.variant);
    else player.toggleRadio(player.mode);
  };
  return html`<div className=${'mini' + (isLecture ? '' : ' mini-radio') + (player.mode === 'fast' ? ' mode-fast' : '') + (fastCourse ? ' variant-fast' : '') + (paused ? ' mini-paused' : '')}>
    ${paused && html`<button className="mini-x" onClick=${() => setClosed(true)} aria-label=${t('miniClose')}>×</button>`}
    <button className="mini-info" onClick=${() => go(target)}>
      <b>${fastCourse ? t('courseFast') : t(MODE_LABEL[player.mode])}</b>
      <span>${LECTURE_BY_ID[id].title}</span>
    </button>
    <button className="mini-btn" onClick=${toggle} aria-label=${t(paused ? 'play' : 'pause')}>
      ${busy ? html`<span className="spinner small"></span>` : html`<${Icon} name=${paused ? 'play' : 'pause'} size=${18} />`}
    </button>
  </div>`;
}

// =====================
// شبكة أمان: إذا تعطلت صفحة يظهر تنبيه بدل شاشة متوقفة، ويُسجَّل الخطأ ليُرفق بالبلاغ
// =====================
class PageBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) {
    const where = ((info && info.componentStack) || '').trim().split('\n')[0] || '';
    try { errLog.add('page: ' + (error && error.message) + ' ' + where.trim()); } catch (e) {}
  }
  render() {
    if (!this.state.error) return this.props.children;
    const msg = String((this.state.error && this.state.error.message) || '');
    return html`<div className="page account">
      <div className="panel center">
        <h1 className="acc-title">${t('pageErrorTitle')}</h1>
        <p className="acc-line">${t('pageErrorHint')}</p>
        <p className="hint" dir="ltr">${msg.slice(0, 160)}</p>
        <button className="cta" onClick=${() => { this.setState({ error: null }); }}>${t('retry')}</button>
        <div className="nav">
          <button className="link-btn" onClick=${() => { this.setState({ error: null }); go('#/'); }}>${t('backHome')}</button>
          <button className="link-btn" onClick=${() => { this.setState({ error: null }); go('#/feedback'); }}>${t('reportProblem')}</button>
        </div>
      </div>
    </div>`;
  }
}

function useTitlesVersion() {
  const [, setV] = useState(0);
  useEffect(() => titles.subscribe(() => setV(v => v + 1)), []);
}

// =====================
// التطبيق الرئيسي
// =====================
function App() {
  const route = useRoute();
  useTitlesVersion();
  useBadgesVersion();
  // مستوى الصوت يُضبط من أزرار الجهاز
  const player = usePlayer(1);
  mentionPlayer = player;
  feedbackContext = {
    page: route.page, mode: player.mode || null, st: player.status || null, playing: !!player.isPlaying,
    // اللقاء المشغّل أو المفتوح، ونسخته (normal أو fast)
    lec: player.mode === 'lecture' ? player.lectureId : (player.live && player.live.track ? player.live.track.id : (route.id || null)),
    ver: player.mode === 'lecture' ? player.variant : (player.mode || route.variant || null),
  };

  // آخر صفحة قبل صفحة الاسم، للعودة إليها بعد الحفظ
  const returnRef = useRef('#/');
  if (route.page !== 'account') returnRef.current = location.hash || '#/';

  const pageAt = route.page === 'radio' ? route.mode
    : ['course', 'lecture', 'report'].includes(route.page) ? 'course' : 'home';
  const at = player.isPlaying ? (player.mode === 'lecture' ? 'course' : player.mode) : pageAt;
  const users = usePresence(at);


  // عنوان التبويب محايد مراعاةً للخصوصية
  useEffect(() => {
    document.title = route.page === 'radio' ? t(MODE_LABEL[route.mode])
      : route.page === 'course' ? t('coursePageTitle')
      : route.page === 'account' ? t('accountTitle')
      : route.page === 'report' ? t('report')
      : route.page === 'general' ? t('community')
      : route.page === 'staff' ? t('staffTitle')
      : route.page === 'feedback' ? t('feedbackTitle')
      : route.page === 'lecture' ? shortTitle(route.id)
      : IS_STANDALONE ? t('appShortName') : t('appName');
  }, [route]);

  let page;
  if (route.page === 'radio') {
    page = html`<${RadioPage} mode=${route.mode} player=${player} users=${users} />`;
  } else if (route.page === 'course') {
    page = html`<${CoursePage} player=${player} users=${users} />`;
  } else if (route.page === 'account') {
    page = html`<${AccountPage} returnTo=${returnRef.current} />`;
  } else if (route.page === 'report') {
    page = html`<${ReportPage} />`;
  } else if (route.page === 'general') {
    page = html`<${CommunityPage} focus=${route.focus} />`;
  } else if (route.page === 'staff') {
    page = html`<${StaffPage} users=${users} />`;
  } else if (route.page === 'feedback') {
    page = html`<${FeedbackPage} />`;
  } else if (route.page === 'lecture') {
    // عنوان النسخة السريعة للقاء لم يكتمل بعد يفتح النسخة العادية
    const v = route.variant === 'fast' && !progress.isDone(route.id) ? 'normal' : route.variant;
    page = html`<${LecturePage} key=${v + ':' + route.id} id=${route.id} variant=${v} player=${player} />`;
  } else {
    page = html`<${HomePage} player=${player} users=${users} />`;
  }

  return html`<div className="app" onContextMenu=${e => e.preventDefault()}>
    <${Stars} />
    <audio ref=${player.audioRef} preload="none" controlsList="nodownload" />
    <${InAppHint} />
    <${PageBoundary} key=${location.hash}>${page}<//>
    <${MiniPlayer} player=${player} route=${route} />
    <${BottomNav} route=${route} />
    <${CongratsModal} />
    <${CodeReminder} route=${route} />
  </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${PageBoundary}><${App} /><//>`);

// تسجيل ملف التطبيق (يحفظ واجهة الموقع لتفتح أسرع)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
