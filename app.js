const { useState, useEffect, useRef, useCallback, useMemo } = React;
const html = htm.bind(React.createElement);

const MODES = ['normal', 'fast'];
const MODE_LABEL = { normal: 'normalRadio', fast: 'fastRadio', lecture: 'course' };
const MODE_SHORT = { normal: 'speedNormal', fast: 'speedFast' };
const MODE_INFO = { normal: 'normalInfo', fast: 'fastInfo' };
const SKIP_SECONDS = 15;
const BEHIND_SECONDS = 20;
const RADIO_MODE_KEY = 'radio_mode';
const HOME_OPEN_KEY = 'home_open_card';

const STATIONS = Object.fromEntries(MODES.map(mode => [mode, createStation(mode,
  LECTURES.map(l => ({ id: l.id, title: l.title, duration: l[mode] })))]));

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
  if (h === '#/course') return { page: 'course' };
  if (h === '#/account') return { page: 'account' };
  if (h === '#/report') return { page: 'report' };
  if (h === '#/general') return { page: 'general' };
  if (h === '#/staff') return { page: 'staff' };
  m = /^#\/lecture\/(\w+)$/.exec(h);
  if (m && LECTURE_BY_ID[m[1]]) return { page: 'lecture', id: m[1] };
  return { page: 'home' };
}
function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onHash = () => { setRoute(parseRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
const go = (hash) => { location.hash = hash; };

function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
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

// =====================
// المشغّل: مشغّل واحد للموقع كله يبقى يعمل أثناء التنقل
// mode: normal أو fast (بث مباشر) أو lecture (لقاء من الكورس)
// shifted: أوقف المستمع البث فصار متأخرًا عنه، فيكمل من حيث توقف
// حتى ينتهي اللقاء ثم يعود إلى البث المباشر
// =====================
function usePlayer(volume) {
  const audioRef = useRef(null);
  const modeRef = useRef(null);
  const lectureRef = useRef(null);
  const wantPlayRef = useRef(false);     // هل يريد المستخدم الاستماع الآن
  const loadedKeyRef = useRef(null);     // المحمّل حاليًا، مثل normal:L05 أو lecture:c01
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

  // اللقاء الذي يُحتسب الاستماع إليه الآن (النسخة العادية فقط)
  const trackedId = () => {
    const k = loadedKeyRef.current;
    if (!k || k.startsWith('fast:')) return null;
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

  const switchTo = (m, id = null) => {
    if (modeRef.current === m && lectureRef.current === id) return;
    lastAttemptRef.current = Date.now();
    if (audioRef.current) audioRef.current.pause();
    loadedKeyRef.current = null;
    lastSampleRef.current = null;
    modeRef.current = m;
    lectureRef.current = id;
    setShifted(false);
    setMode(m);
    setLectureId(id);
    setCurrentTime(id ? progress.position(id) : 0);
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
    if (!audio || !id) return;
    setMediaMeta(id);
    lastAttemptRef.current = Date.now();
    lastProgressRef.current = Date.now();
    if (!navigator.onLine) { updateStatus('offline'); return; }
    updateStatus('loading');

    const key = 'lecture:' + id;
    if (forceReload || loadedKeyRef.current !== key) {
      // عند إعادة المحاولة: موضع لم يُطبّق بعد، أو آخر موضع كان يعمل فيه، أو الموضع المحفوظ
      resumeRef.current = forceReload && loadedKeyRef.current === key
        ? (resumeRef.current != null ? resumeRef.current : goodPosition(progress.position(id)))
        : progress.position(id);
      loadedKeyRef.current = key;
      lastSampleRef.current = null;
      audio.src = mediaUrl('normal', id);
      audio.load();
    }
    playAudio();
  }, [updateStatus, playAudio]);

  const startPlaying = () => { wantPlayRef.current = true; setIsPlaying(true); };

  const playLecture = useCallback((id) => {
    switchTo('lecture', id);
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

  const toggleLecture = useCallback((id) => {
    if (wantPlayRef.current && modeRef.current === 'lecture' && lectureRef.current === id) {
      if (statusRef.current === 'blocked') return loadLecture();
      return stop();
    }
    playLecture(id);
  }, [playLecture, stop, loadLecture]);

  // التقديم والتأخير داخل لقاء من الكورس فقط
  const seekLecture = useCallback((id, sec) => {
    const dur = LECTURE_BY_ID[id].normal;
    sec = Math.max(0, Math.min(dur - 1, sec));
    const audio = audioRef.current;
    if (modeRef.current === 'lecture' && lectureRef.current === id && loadedKeyRef.current === 'lecture:' + id
        && audio && audio.readyState >= 1) {
      lastSampleRef.current = null;
      audio.currentTime = sec;
    } else if (modeRef.current === 'lecture' && lectureRef.current === id) {
      resumeRef.current = sec;
    }
    progress.setPosition(id, sec);
    setCurrentTime(sec);
  }, []);

  const skip = useCallback((delta) => {
    const id = lectureRef.current;
    if (modeRef.current !== 'lecture' || !id) return;
    const audio = audioRef.current;
    const base = audio && audio.readyState >= 1 ? audio.currentTime : progress.position(id);
    seekLecture(id, base + delta);
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
      // حماية إضافية: الوقت يتقدّم فالصوت يعمل، فلا داعي لعلامة التحميل
      if (wantPlayRef.current && statusRef.current === 'loading' && !audio.paused) updateStatus('playing');
      setCurrentTime(ct);
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
            if (id) progress.record(id, prev, ct);
          }
        }
        lastSampleRef.current = ct;
        // الصوت يعمل فعلًا من الموضع الصحيح: نحفظه مرجعًا لأي إعادة تحميل
        if (resumeRef.current == null && !pendingSeekRef.current && audio.readyState >= 3) {
          lastGoodRef.current = { key: loadedKeyRef.current, t: ct };
        }
      }
      // لا يُحفظ موضع اللقاء قبل الرجوع إلى مكانه بعد التحميل، حتى لا يُحفظ الصفر
      if (modeRef.current === 'lecture' && id && resumeRef.current == null) progress.setPosition(id, ct);
    };
    const onSeeking = () => { lastSampleRef.current = null; };
    const onPlaying = () => {
      stallsRef.current = 0;
      if (!wantPlayRef.current) return;
      updateStatus('playing');
      const id = loadedKeyRef.current && loadedKeyRef.current.split(':')[1];
      if (id) setMediaMeta(id);
    };
    const onWaiting = () => {
      if (wantPlayRef.current && statusRef.current !== 'next' && statusRef.current !== 'offline') updateStatus('loading');
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
        const id = lectureRef.current;
        progress.setPosition(id, 0);
        progress.save();
        const next = courseNext(id);
        if (next) {
          playLecture(next);
          if (location.hash === '#/lecture/' + id) go('#/lecture/' + next);
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
      if (wantPlayRef.current && audio.getAttribute('src')) updateStatus(navigator.onLine ? 'error' : 'offline');
    };
    const onOffline = () => { if (wantPlayRef.current) updateStatus('offline'); };
    const onOnline = () => {
      if (!wantPlayRef.current) return;
      if (!isRadio()) return loadLecture(true);
      if (shiftedRef.current) return reloadInPlace();
      syncAndPlay(true);
    };

    const events = {
      timeupdate: onTime, seeking: onSeeking, playing: onPlaying, waiting: onWaiting,
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
      set('seekto', (d) => { if (d && lectureRef.current) seekLecture(lectureRef.current, d.seekTime); });
      set('previoustrack', () => { const p = coursePrev(lectureRef.current); if (p) playLecture(p); });
      set('nexttrack', () => { const n = courseNext(lectureRef.current); if (n) playLecture(n); });
    } else {
      ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach(a => set(a, null));
    }
  }, [mode, resume, stop, skip, seekLecture, playLecture]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'; } catch (e) {}
  }, [isPlaying]);

  return {
    audioRef, mode, lectureId, isPlaying, status, live, shifted, currentTime,
    toggleRadio, goLive, toggleLecture, playLecture, seekLecture, skip, stop, retry,
  };
}

// بيانات شاشة القفل: اسم مختصر محايد مراعاةً للخصوصية
function setMediaMeta(id) {
  if (!('mediaSession' in navigator)) return;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: id ? shortTitle(id) : t('mediaArtist'), artist: t('mediaArtist'), album: '',
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
function usePresence(at) {
  const [users, setUsers] = useState([]);
  const atRef = useRef(at);
  const myRefHolder = useRef(null);

  useEffect(() => {
    let code = null;
    let connected = false;
    let disposed = false;

    const register = () => {
      if (disposed || !connected || !code || myRefHolder.current) return;
      const ref = database.ref('/status').push();
      myRefHolder.current = ref;
      ref.onDisconnect().remove()
        .then(() => ref.set({ countryCode: code, at: atRef.current, since: firebase.database.ServerValue.TIMESTAMP }))
        .catch(console.error);
    };

    getCountryCode().then(c => { code = c; register(); });

    const connRef = database.ref('.info/connected');
    const onConn = connRef.on('value', snap => {
      connected = snap.val() === true;
      // عند انقطاع الاتصال يحذف الخادم السجل القديم، وعند العودة يُسجَّل من جديد
      if (!connected) { myRefHolder.current = null; return; }
      register();
    });

    const statusRef = database.ref('/status');
    const onStatus = statusRef.on('value', snap => {
      const list = [];
      snap.forEach(child => { const v = child.val(); if (v) list.push(v); });
      setUsers(list);
    });

    return () => {
      disposed = true;
      connRef.off('value', onConn);
      statusRef.off('value', onStatus);
      if (myRefHolder.current) myRefHolder.current.remove().catch(() => {});
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
  user: html`<g><circle cx="12" cy="8" r="4"></circle><path d="M4 21c0-4 4-6 8-6s8 2 8 6"></path></g>`,
  check: html`<path d="M5 12l5 5L20 7"></path>`,
  back: html`<path d="M9 6l6 6-6 6"></path>`,
  book: html`<g><path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"></path><path d="M4 19V5"></path><path d="M9 7h6"></path></g>`,
  radio: html`<g><circle cx="12" cy="12" r="2"></circle><path d="M8.5 8.5a5 5 0 0 0 0 7"></path><path d="M15.5 8.5a5 5 0 0 1 0 7"></path><path d="M5.6 5.6a9 9 0 0 0 0 12.8"></path><path d="M18.4 5.6a9 9 0 0 1 0 12.8"></path></g>`,
  chart: html`<g><path d="M4 20V10"></path><path d="M10 20V4"></path><path d="M16 20v-7"></path><path d="M22 20H2"></path></g>`,
  download: html`<g><path d="M12 3v12"></path><path d="M7 10l5 5 5-5"></path><path d="M5 21h14"></path></g>`,
  list: html`<g><path d="M9 6h11"></path><path d="M9 12h11"></path><path d="M9 18h11"></path><circle cx="4.5" cy="6" r="1"></circle><circle cx="4.5" cy="12" r="1"></circle><circle cx="4.5" cy="18" r="1"></circle></g>`,
  chat: html`<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"></path>`,
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

function OnlineBadge({ count }) {
  return html`<div className="chip" title=${t('listeners', { n: count })}><${LiveDot} />${count}</div>`;
}

function BackButton({ to }) {
  return html`<button className="back" onClick=${() => go(to)}>
    <${Icon} name="back" />${t('back')}
  </button>`;
}

// الاسم الخاص: يظهر صغيرًا في أعلى كل الصفحات
function NameChip() {
  useAccountVersion();
  if (!account.loggedIn) {
    return html`<button className="chip name-chip-cta" onClick=${() => go('#/account')}>
      <${Icon} name="user" size=${14} />${t('saveProgressShort')}
    </button>`;
  }
  const hidden = account.isHidden();
  const name = account.name;
  return html`<div className="chip name-chip">
    <button className="name-chip-main" onClick=${() => go('#/account')} aria-label=${t('accountTitle')}>
      <span className=${'sync-dot sync-' + account.status}></span>
      <bdi dir="ltr" className="name-value">${hidden ? '•'.repeat(Math.min(8, name.length)) : name}</bdi>
    </button>
    <button className="eye" onClick=${() => account.setHidden(!hidden)}
      aria-label=${hidden ? t('showName') : t('hideName')} title=${hidden ? t('showName') : t('hideName')}>
      <${Icon} name=${hidden ? 'eye' : 'eyeOff'} size=${15} />
    </button>
  </div>`;
}

function CountryFlags({ users }) {
  const stats = useMemo(() => {
    const counts = users.reduce((acc, u) => {
      const c = /^[A-Z]{2}$/.test(u.countryCode || '') ? u.countryCode : 'XX';
      acc[c] = (acc[c] || 0) + 1;
      return acc;
    }, {});
    return Object.entries(counts).map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count).slice(0, 4);
  }, [users]);
  if (!stats.length) return null;
  return html`<ul className="flags">
    ${stats.map(({ code, count }) => html`<li key=${code}>
      <b>${count}</b>
      ${code === 'XX' ? html`<span>🌐</span>`
        : html`<img src=${`https://flagcdn.com/w20/${code.toLowerCase()}.png`} width="20" alt=${code} />`}
    </li>`)}
  </ul>`;
}

// العدادات الظاهرة: عدد المشتركين وساعات الاستماع من الجميع
// (الزيارات والمستمعون القدامى ما زالوا يُحسبون في القاعدة لكن لا يظهرون)
// آخر قراءة تُحفظ على الجهاز وتظهر فورًا، حتى دون اتصال، ثم تتحدّث عند وصول الجديد
const STATS_CACHE_KEY = 'statsCache';
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

// معلومة صغيرة تظهر عند الضغط على الأيقونة بدل أن تشغل مساحة في الصفحة
// تُحسب مكانها لتبقى دائمًا داخل الشاشة
function InfoTip({ label, text }) {
  const [pos, setPos] = useState(null);
  const btnRef = useRef(null);
  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
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
    const w = Math.min(260, vw - 32);
    const left = Math.max(16, Math.min(vw - 16 - w, r.left + r.width / 2 - w / 2));
    setPos({ top: r.bottom + 8, left, width: w });
  };
  return html`<span className="info">
    <button ref=${btnRef} className="info-btn" aria-label=${label} aria-expanded=${!!pos} onClick=${openTip}>i</button>
    ${pos && html`<span className="info-pop" role="tooltip" style=${pos}>${text}</span>`}
  </span>`;
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
function SeekBar({ id, value, duration, marks, onInput, onCommit }) {
  const segs = progress.segments(id);
  const pos = Math.min(100, (value / duration) * 100 || 0);
  return html`<div className="seekbar">
    <div className="sb-marks" aria-hidden="true">
      ${(marks || []).map((s, i) => html`<span key=${i} className="sb-mark"
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
function useComments(lid) {
  const [list, setList] = useState([]);
  useEffect(() => {
    setList([]);
    if (!lid) return;
    return commentsApi.subscribe(lid, setList);
  }, [lid]);
  return list;
}

// أحدث التعليقات من كل اللقاءات، لمعرفة الجديد منها
function useRecentFeed(limit) {
  const [list, setList] = useState([]);
  useEffect(() => commentsApi.subscribeRecent(limit, setList), [limit]);
  return list;
}

function useCommentCounts() {
  const [counts, setCounts] = useState({});
  useEffect(() => commentsApi.subscribeCounts(setCounts), []);
  return counts;
}

const relTime = (() => {
  let rtf = null;
  try { rtf = new Intl.RelativeTimeFormat('ar', { numeric: 'auto' }); } catch (e) {}
  return (ts) => {
    if (!rtf || !ts) return '';
    const diff = (ts - Date.now()) / 1000;
    const steps = [[60, 'second', 1], [3600, 'minute', 60], [86400, 'hour', 3600], [2592000, 'day', 86400], [31536000, 'month', 2592000], [Infinity, 'year', 31536000]];
    for (const [lim, unit, div] of steps) {
      if (Math.abs(diff) < lim) return rtf.format(Math.round(diff / div), unit);
    }
    return '';
  };
})();

function useStaffVersion() {
  const [v, setV] = useState(0);
  useEffect(() => staff.subscribe(() => setV(x => x + 1)), []);
  return v;
}

// اسم صاحب التعليق: الاسم المميز بعلامة، أو «أخ ...»
// الاسم الظاهر: اسم المشرف، أو اللقب (افتراضيًا «أخ») ثم الرقم
const authorName = (n, a, pf) => (a && staff.nameOf(a)) || t('nickName', { p: pf || t('nickPrefix'), n });
function CommentAuthor({ c, toMe }) {
  const special = c.a && staff.nameOf(c.a);
  return html`<b className=${special ? 'staff-name' : ''}>
    ${special ? html`<span className="staff-check" aria-hidden="true"><${Icon} name="check" size=${11} /></span>` : ''}${authorName(c.n, c.a, c.pf)}
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

function CommentText({ text, maxSec, onTime, replyTo }) {
  const parts = splitRich(text, maxSec);
  return html`<${React.Fragment}>
    ${replyTo && html`<div className="c-reply-to">${t('replyTo')} <bdi>${replyTo}</bdi></div>`}
    <p className="c-text">
      ${parts.map((p, i) => p.lid
        ? html`<button key=${i} className="time-chip mention-chip" onClick=${(e) => { e.stopPropagation(); openMention(p.lid, p.time); }}
            aria-label=${t('openMention', { t: p.text })}><${Icon} name="play" size=${10} /><span>${p.text}</span></button>`
        : p.time != null && onTime
        ? html`<button key=${i} className="time-chip" dir="ltr" onClick=${(e) => { e.stopPropagation(); onTime(p.time); }}
            aria-label=${t('jumpTo', { t: p.text })}>${p.text}</button>`
        : html`<span key=${i}>${p.text}</span>`)}
    </p>
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
function CommentForm({ lid, parent, getTime, onDone, onCancel, compact }) {
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
    ${!compact && html`<div className="c-as">${t('commentAs')} <b>${staff.isStaff ? staff.name : authorName(account.nick, null, account.customTitle)}</b></div>`}
    <textarea value=${text} maxLength=${COMMENT_MAX} rows=${compact ? 2 : 3}
      placeholder=${compact ? t('replyPlaceholder', { name: authorName(parent.n, parent.a, parent.pf) }) : (withTime ? t('commentPlaceholder') : t('commentPlaceholderGeneral'))}
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
        ${busy ? t('pleaseWait') : (compact ? t('sendReply') : t('sendComment'))}
      </button>
      ${onCancel && html`<button type="button" className="link-btn muted" onClick=${onCancel}>${t('cancel')}</button>`}
    </div>
  </form>`;
}

// صندوق التعليقات بمستويين: تعليق ثم ردود عليه
// مطويّ افتراضيًا حتى تبقى الصفحة نظيفة
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

  // حذف تعليق (للمشرف فقط)
  const del = async (c, isReply) => {
    if (!window.confirm(t('deleteConfirm'))) return;
    await commentsApi.remove(lid, c, isReply ? [] : (replies[c.id] || []));
  };

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
    <div className="c-meta"><${CommentAuthor} c=${c} toMe=${toMe(c)} /><span>${relTime(c.ts)}</span></div>
    <${CommentText} text=${c.t} maxSec=${maxSec} onTime=${onTime} replyTo=${isReply && (c.r || c.ra) ? authorName(c.r, c.ra, c.rp) : null} />
    <div className="c-foot">
      ${replyButton(top, c)}
      ${staff.isMod && html`<button className="c-del" onClick=${() => del(c, isReply)}>${t('delete')}</button>`}
      ${!isReply && (replies[c.id] || []).length > 0 && html`<button onClick=${() => setExpanded(x => ({ ...x, [c.id]: !x[c.id] }))}>
        ${expanded[c.id] ? t('hideReplies') : t('showReplies', { n: replies[c.id].length })}
      </button>`}
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
      ${canWrite
        ? html`<${CommentForm} lid=${lid} getTime=${getTime} onDone=${() => setSort('new')} />`
        : html`<div className="c-login">
            <p>${account.loggedIn ? t('commentPreparing') : t('commentNeedName')}</p>
            ${!account.loggedIn && html`<button className="small-btn" onClick=${() => go('#/account')}>${t('createNameShort')}</button>`}
          </div>`}

      ${maxSec > 0 && tops.length > 1 && html`<div className="c-sort">
        <button className=${sort === 'new' ? 'on' : ''} onClick=${() => setSort('new')}>${t('sortNewest')}</button>
        <button className=${sort === 'time' ? 'on' : ''} onClick=${() => setSort('time')}>${t('sortByTime')}</button>
      </div>`}

      ${list.length === 0 && html`<p className="hint center-text">${t('noComments')}</p>`}
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
      ${list.length === 0 && html`<p className="hint center-text">${t('noComments')}</p>`}
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
function HomePage({ player, now, users }) {
  useProgressVersion();
  const sum = progress.summary();
  const contId = progress.continueId();
  const started = progress.hasAny();

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
  const count = users.filter(u => u.at === mode).length;

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

  // كارت واحد مفتوح في المرة، ويُحفظ آخر اختيار
  // إذا كان الراديو يعمل يُفتح كارته تلقائيًا
  const [open, setOpenState] = useState(() =>
    (player.isPlaying && MODES.includes(player.mode)) ? 'radio' : (storage.get(HOME_OPEN_KEY) || ''));
  // عند طي كارت الراديو يعود الاختيار إلى السرعة المشغّلة، فيبقى العنوان والزر صحيحين
  const setOpen = (v) => {
    setOpenState(v); storage.set(HOME_OPEN_KEY, v);
    if (v !== 'radio' && otherPlaying) setModeState(radioPlaying);
  };
  const toggle = (k) => setOpen(open === k ? '' : k);

  // تشغيل الراديو من الكارت المطوي يفتحه في الضغطة نفسها
  const radioToggle = () => {
    if (!rv.active) setOpen('radio');
    player.toggleRadio(mode);
  };

  // علامات التعليقات الجديدة
  const feed = useRecentFeed(100);
  const general = useComments(GENERAL_ID);
  const lectureNew = feed.filter(c => isNewComment(c, c.l)).length;
  const repliesToMe = feed.filter(c => isReplyToMe(c, c.l)).length;
  const generalNew = general.filter(c => isNewComment(c, GENERAL_ID)).length;

  // الكارت يضيء أثناء الاستماع إلى لقاء
  const courseActive = player.isPlaying && player.mode === 'lecture';



  return html`<div className="page home">
    <div className="topbar">
      <${TotalStats} />
      <div className="top-left">
        <${NameChip} />
        <${OnlineBadge} count=${users.length} />
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
          <li>${t('intro2')}</li>
          ${!account.loggedIn && html`<li>${t('intro3')}</li>`}
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
      <button className=${'card tint-course card-link' + (courseActive ? ' card-active' : '')} onClick=${() => go('#/course')}>
        <div className="card-row">
          <span className="card-toggle">
            <span className="title-icon"><${Icon} name="book" size=${18} /></span>
            <span className="card-title">${t('course')}${lectureNew > 0 && html`<span className="new-dot" aria-label=${t('newComments')}></span>`}</span>
            ${repliesToMe > 0 && html`<span className="to-me">${t('repliedToYou')}</span>`}
            <span className="pct"><${Pct} value=${sum.percent} /></span>
            <span className="row-arrow" aria-hidden="true">‹</span>
          </span>
        </div>
      </button>
    </section>

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
            <span>${t('listeners', { n: count })}</span>
            <span className="row-arrow" aria-hidden="true">‹</span>
          </button>
        </div>`}
        ${open !== 'radio' && rv.active && STATUS_KEY[rv.status] && html`<${StatusLine} active=${rv.active} status=${rv.status} onRetry=${player.retry} />`}
      </div>
    </section>

    <footer className="foot">
      <button className="foot-btn" onClick=${() => go('#/general')}><${Icon} name="chat" size=${16} />${t('generalComments')}
        ${generalNew > 0 && html`<span className="badge-new">${generalNew}</span>`}</button>
      <${InstallButton} />
      <${FacebookLink} />
    </footer>
  </div>`;
}

// =====================
// صفحة الراديو
// =====================
function RadioPage({ mode, player, now, users }) {
  const modeUsers = users.filter(u => u.at === mode);
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
        <${OnlineBadge} count=${modeUsers.length} />
      </div>
    </div>
    <div className="flags-row"><${CountryFlags} users=${modeUsers} /></div>
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
function CoursePage({ player, users }) {
  useProgressVersion();
  const sum = progress.summary();
  const contId = progress.continueId();
  const courseUsers = users.filter(u => u.at === 'course');
  const counts = useCommentCounts();
  const feed = useRecentFeed(100);
  const newBy = {};
  feed.forEach(c => { if (isNewComment(c, c.l)) newBy[c.l] = true; });

  const continueNow = () => { player.playLecture(contId); go('#/lecture/' + contId); };

  return html`<div className="page course">
    <div className="topbar">
      <${BackButton} to="#/" />
      <div className="top-left">
        <${NameChip} />
        <${OnlineBadge} count=${courseUsers.length} />
      </div>
    </div>

    <div className="panel summary tint-course">
      <h1>${t('coursePageTitle')}
        <${InfoTip} label=${t('infoLabel')} text=${t('courseInfo')} />
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

    <${RecentComments} player=${player} />

    <ol className="lessons">
      ${COURSE_ORDER.map((id) => {
        const pct = progress.percent(id);
        const done = progress.isDone(id);
        const n = counts[id] || 0;
        const playing = player.isPlaying && player.mode === 'lecture' && player.lectureId === id;
        return html`<li key=${id}>
          <button className=${'lesson' + (playing ? ' lesson-playing' : '') + (done ? ' lesson-done' : '')}
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
            ${(done || n > 0 || newBy[id] || notes.has(id)) && html`<span className="lesson-side">
              ${done && html`<span className="done-badge" aria-label=${t('lectureDone')}><${Icon} name="check" size=${14} /></span>`}
              ${notes.has(id) && html`<span className="note-badge" aria-label=${t('lectureHasNotes')}><${Icon} name="note" size=${13} /></span>`}
              ${n > 0 && html`<span className=${'c-badge' + (newBy[id] ? ' new' : '')} aria-label=${t('commentsCount', { n })}><${Icon} name="chat" size=${13} />${n}</span>`}
            </span>`}
          </button>
        </li>`;
      })}
    </ol>
  </div>`;
}

// ملاحظات المستخدم الخاصة على اللقاء: تُكتب وتُحفظ تلقائيًا، وتُعرض بأوقات قابلة للضغط
function NotesBox({ id, getTime, onTime }) {
  const [, force] = useState(0);
  useEffect(() => notes.subscribe(() => force(x => x + 1)), []);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const text = notes.get(id);
  const has = !!text.trim();
  const write = (v) => { setEditing(true); notes.set(id, v); };
  const addTime = () => write((text && !/\s$/.test(text) ? text + ' ' : text) + fmtTime(getTime()) + ' ');

  return html`<section className="comments notes">
    <button className="c-toggle" onClick=${() => setOpen(o => !o)} aria-expanded=${open}>
      <${Icon} name="note" size=${16} />
      <span>${t('myNotes')}</span>
      ${has && !open && html`<span className="c-count">${t('notesHas')}</span>`}
      <span className=${'chev' + (open ? ' chev-open' : '')} aria-hidden="true">⌄</span>
    </button>
    ${open && html`<div className="c-body">
      ${editing || !has ? html`<div className="c-form">
          <textarea value=${text} maxLength=${NOTE_MAX} rows="5" placeholder=${t('notesPlaceholder')}
            aria-label=${t('myNotes')} onInput=${e => write(e.target.value)}></textarea>
          <div className="c-tools">
            <span className="hint">${text.length}/${NOTE_MAX}</span>
            <span className="c-tool-links">
              <button type="button" className="link-btn" onClick=${addTime}>${t('addCurrentTime')}</button>
              ${has && html`<button type="button" className="link-btn" onClick=${() => setEditing(false)}>${t('notesDone')}</button>`}
            </span>
          </div>
        </div>`
      : html`<div className="note-view">
          <${CommentText} text=${text} maxSec=${LECTURE_BY_ID[id].normal} onTime=${onTime} />
          <div className="c-tools"><span></span>
            <button type="button" className="link-btn" onClick=${() => setEditing(true)}>${t('notesEdit')}</button>
          </div>
        </div>`}
      <p className="hint">${account.loggedIn ? t('notesPrivateAcc') : t('notesPrivateLocal')}</p>
    </div>`}
  </section>`;
}

// =====================
// صفحة اللقاء
// =====================
function LecturePage({ id, player }) {
  useProgressVersion();
  const lec = LECTURE_BY_ID[id];
  const current = player.mode === 'lecture' && player.lectureId === id;
  const active = current && player.isPlaying;
  const time = current ? player.currentTime : progress.position(id);
  const status = active ? player.status : 'idle';
  const heard = progress.percent(id);
  const done = progress.isDone(id);
  const prev = coursePrev(id), next = courseNext(id);
  const comments = useComments(id);
  const marks = useMemo(() => comments.filter(c => typeof c.s === 'number').map(c => c.s), [comments]);

  // الضغط على وقت في تعليق: الانتقال إلى تلك اللحظة وتشغيلها
  const jumpTo = (sec) => {
    player.seekLecture(id, sec);
    if (!active) player.playLecture(id);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // سحب الشريط: يُعرض الموضع أثناء السحب ثم يُطبّق عند الإفلات
  const [dragging, setDragging] = useState(null);
  const shown = dragging != null ? dragging : time;
  const commit = () => { if (dragging != null) { player.seekLecture(id, dragging); setDragging(null); } };

  return html`<div className="page lecture">
    <div className="topbar">
      <${BackButton} to="#/course" />
      <div className="top-left"><${NameChip} /></div>
    </div>

    <div className="panel-wrap">
      <div className="panel tint-course">
        <p className="lecture-title">${lec.title}</p>
        <p className=${'heard' + (done ? ' heard-done' : '')}>
          ${done ? '✓ ' + t('lectureDone') + ' · ' : ''}${t('heardLabel')} <${Pct} value=${heard + '%'} />
        </p>

        <${SeekBar} id=${id} value=${shown} duration=${lec.normal} marks=${marks}
          onInput=${setDragging} onCommit=${commit} />
        <div className="times"><span>${fmtTime(shown)}</span><span>${fmtTime(lec.normal)}</span></div>

        <div className="controls">
          <button className="skip" onClick=${() => current ? player.skip(-SKIP_SECONDS) : player.seekLecture(id, time - SKIP_SECONDS)}
            aria-label=${t('back15')}>−15</button>
          <${PlayButton} active=${active} status=${status} onClick=${() => player.toggleLecture(id)} />
          <button className="skip" onClick=${() => current ? player.skip(SKIP_SECONDS) : player.seekLecture(id, time + SKIP_SECONDS)}
            aria-label=${t('forward15')}>+15</button>
        </div>

        <${StatusLine} active=${active} status=${status} onRetry=${player.retry} />

        <div className="nav">
          <button className="small-btn" disabled=${!prev} onClick=${() => prev && go('#/lecture/' + prev)}>${t('prevLecture')}</button>
          <button className="small-btn" disabled=${!next} onClick=${() => next && go('#/lecture/' + next)}>${t('nextLecture')}</button>
        </div>
      </div>
    </div>
    <${NotesBox} id=${id} getTime=${() => (current ? player.currentTime : progress.position(id))} onTime=${jumpTo} />
    <${CommentsBox} lid=${id} list=${comments}
      getTime=${() => (current ? player.currentTime : progress.position(id))} onTime=${jumpTo} />
  </div>`;
}

// =====================
// التعليقات العامة على الموقع
// =====================
function GeneralPage() {
  const comments = useComments(GENERAL_ID);
  return html`<div className="page general">
    <div className="topbar">
      <${BackButton} to="#/" />
      <div className="top-left"><${NameChip} /></div>
    </div>
    <h1 className="acc-title center-text">${t('generalComments')}</h1>
    <${CommentsBox} lid=${GENERAL_ID} list=${comments} startOpen title=${t('comments')} />
  </div>`;
}

// =====================
// صفحة المميزين (سرية، تُفتح من الرابط فقط)
// =====================
function StaffPage() {
  useStaffVersion();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [uid, setUid] = useState('');
  const [name, setName] = useState('');
  const [mod, setMod] = useState(false);
  const [copied, setCopied] = useState(false);

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

      ${staff.isOwner && html`<div className="staff-admin">
        <h2>${t('staffAddTitle')}</h2>
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
        <h2>${t('staffCountTitle')}</h2>
        <p className="acc-line">${t('staffCountHint')}</p>
        <button className="small-btn" disabled=${busy} onClick=${countSubs}>${busy ? t('pleaseWait') : t('staffCountBtn')}</button>
      </div>`}

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

const SOURCES = [
  { key: 'c', label: 'sourceCourse', cls: 'src-c' },
  { key: 'n', label: 'sourceNormal', cls: 'src-n' },
  { key: 'f', label: 'sourceFast', cls: 'src-f' },
];

function ReportPage() {
  useProgressVersion();
  const [period, setPeriod] = useState('week');
  const r = periodRange(period);
  const st = progress.stats(dayKey(r.from), dayKey(r.to));
  const pr = periodRange(period, 1);
  const prev = progress.stats(dayKey(pr.from), dayKey(pr.to));
  const total = st.total;

  const bars = r.buckets.map(b => {
    const from = dayKey(b.from), to = dayKey(b.to);
    const src = { c: 0, n: 0, f: 0 };
    Object.entries(st.bySrc).forEach(([k, v]) => {
      if (k >= from && k <= to) { src.c += v.c; src.n += v.n; src.f += v.f; }
    });
    return { ...b, src, s: src.c + src.n + src.f };
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
  const [tab, setTab] = useState('new');
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [confirmOut, setConfirmOut] = useState(false);

  // بعد النجاح: رسالة قصيرة ثم العودة إلى الصفحة السابقة
  useEffect(() => {
    if (!success) return;
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
      <div className="topbar"><${BackButton} to=${returnTo} /></div>
      <div className="panel">
        <h1 className="acc-title">${t('accountTitle')}</h1>
        <div className="acc-name">
          <bdi dir="ltr">${hidden ? '•'.repeat(Math.min(10, account.name.length)) : account.name}</bdi>
          <button className="eye" onClick=${() => account.setHidden(!hidden)}
            aria-label=${hidden ? t('showName') : t('hideName')}><${Icon} name=${hidden ? 'eye' : 'eyeOff'} /></button>
        </div>
        ${warn}
        <p className="acc-line">${t('accountHint')}</p>
        <p className="acc-line">
          <span className=${'sync-dot sync-' + account.status}></span>
          ${t(SYNC_KEY[account.status] || 'syncIdle')}
          <button className="link-btn" onClick=${() => account.sync()}>${t('syncNow')}</button>
        </p>
        <p className="acc-line">${t('doneOf', { done: sum.done, count: sum.count })} · <${Pct} value=${sum.percent} /></p>
        ${account.nick && html`<${TitleEditor} />`}
        ${continueBtn}
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
      </div>
    </div>`;
  }

  return html`<div className="page account">
    <div className="topbar"><${BackButton} to=${returnTo} /></div>
    <div className="panel">
      <h1 className="acc-title">${t('accountTitle')}</h1>
      <p className="acc-line">${t('accountIntro')}</p>

      <div className="seg" role="tablist">
        <button role="tab" aria-selected=${tab === 'new'} className=${tab === 'new' ? 'on' : ''}
          onClick=${() => { setTab('new'); setError(null); }}>${t('tabNew')}</button>
        <button role="tab" aria-selected=${tab === 'login'} className=${tab === 'login' ? 'on' : ''}
          onClick=${() => { setTab('login'); setError(null); }}>${t('tabLogin')}</button>
      </div>

      <form onSubmit=${submit}>
        <input className="name-input" dir="ltr" value=${value} autoComplete="off" autoCapitalize="none"
          spellCheck="false" placeholder=${tab === 'new' ? t('namePlaceholderNew') : t('namePlaceholderLogin')}
          onInput=${e => setValue(e.target.value)} aria-label=${t('accountTitle')} />
        ${tab === 'new' && html`<div className="name-tools">
          <span className="hint">${t('nameRules')}</span>
          <button type="button" className="link-btn" onClick=${() => { setValue(suggestName()); setError(null); }}>${t('suggestName')}</button>
        </div>`}
        ${error && html`<p className="form-error">${t(error)}</p>`}
        ${tab === 'new' && warn}
        <button className="cta" type="submit" disabled=${busy || !value.trim()}>
          ${busy ? t('pleaseWait') : (tab === 'new' ? t('createName') : t('loginName'))}
        </button>
        ${tab === 'new' && progress.hasAny() && html`<p className="hint center-text">${t('mergeNote')}</p>`}
        ${tab === 'login' && html`<p className="hint center-text">${t('loginNote')}</p>`}
      </form>
    </div>
  </div>`;
}

// تغيير اللقب الذي يسبق الرقم في التعليقات
function TitleEditor() {
  const [value, setValue] = useState(account.title);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    const r = await account.setTitle(value);
    setBusy(false);
    setMsg(r.error ? { err: true, text: t(r.error) } : { text: t('titleSaved') });
  };
  return html`<form className="title-edit" onSubmit=${save}>
    <label><small>${t('titleLabel')}</small>
      <div className="title-row">
        <input value=${value} maxLength=${TITLE_MAX} onInput=${e => { setValue(e.target.value); setMsg(null); }} aria-label=${t('titleLabel')} />
        <bdi className="title-num">${account.nick}</bdi>
        <button className="small-btn" type="submit" disabled=${busy || !value.trim() || value.trim() === account.title}>${t('save')}</button>
      </div>
    </label>
    ${msg ? html`<p className=${msg.err ? 'form-error' : 'hint'}>${msg.text}</p>` : html`<p className="hint">${t('titleHint')}</p>`}
  </form>`;
}

const SYNC_KEY = { syncing: 'syncSyncing', synced: 'syncSynced', error: 'syncError', idle: 'syncIdle' };

// =====================
// المشغّل المصغّر: يظهر أسفل الشاشة أثناء الاستماع في صفحة أخرى
// =====================
function MiniPlayer({ player, route }) {
  if (!player.isPlaying) return null;
  const isLecture = player.mode === 'lecture';
  if (isLecture && route.page === 'lecture' && route.id === player.lectureId) return null;
  if (!isLecture && (route.page === 'radio' && route.mode === player.mode || route.page === 'home')) return null;
  const id = isLecture ? player.lectureId : (player.live && player.live.track.id);
  if (!id) return null;
  const target = isLecture ? '#/lecture/' + id : '#/radio/' + player.mode;
  const busy = player.status === 'loading' || player.status === 'next';
  return html`<div className=${'mini' + (isLecture ? '' : ' mini-radio') + (player.mode === 'fast' ? ' mode-fast' : '')}>
    <button className="mini-info" onClick=${() => go(target)}>
      <b>${t(MODE_LABEL[player.mode])}</b>
      <span>${LECTURE_BY_ID[id].title}</span>
    </button>
    <button className="mini-btn" onClick=${player.stop} aria-label=${t('pause')}>
      ${busy ? html`<span className="spinner small"></span>` : html`<${Icon} name="pause" size=${18} />`}
    </button>
  </div>`;
}

// =====================
// التطبيق الرئيسي
// =====================
function App() {
  const route = useRoute();
  const now = useClock();
  // مستوى الصوت يُضبط من أزرار الجهاز
  const player = usePlayer(1);
  mentionPlayer = player;

  // آخر صفحة قبل صفحة الاسم، للعودة إليها بعد الحفظ
  const returnRef = useRef('#/');
  if (route.page !== 'account') returnRef.current = location.hash || '#/';

  const pageAt = route.page === 'radio' ? route.mode
    : ['course', 'lecture', 'report'].includes(route.page) ? 'course' : 'home';
  const at = player.isPlaying ? (player.mode === 'lecture' ? 'course' : player.mode) : pageAt;
  const users = usePresence(at);

  // الإحصائيات الكلية
  useEffect(() => {
    const statsRef = database.ref('/stats');
    statsRef.child('total_visits').set(firebase.database.ServerValue.increment(1)).catch(() => {});
    if (!storage.get('hasVisitedRadio')) {
      statsRef.child('total_listeners').set(firebase.database.ServerValue.increment(1)).catch(() => {});
      storage.set('hasVisitedRadio', 'true');
    }
  }, []);

  // عنوان التبويب محايد مراعاةً للخصوصية
  useEffect(() => {
    document.title = route.page === 'radio' ? t(MODE_LABEL[route.mode])
      : route.page === 'course' ? t('coursePageTitle')
      : route.page === 'account' ? t('accountTitle')
      : route.page === 'report' ? t('report')
      : route.page === 'general' ? t('generalComments')
      : route.page === 'staff' ? t('staffTitle')
      : route.page === 'lecture' ? shortTitle(route.id)
      : IS_STANDALONE ? t('appShortName') : t('appName');
  }, [route]);

  let page;
  if (route.page === 'radio') {
    page = html`<${RadioPage} mode=${route.mode} player=${player} now=${now} users=${users} />`;
  } else if (route.page === 'course') {
    page = html`<${CoursePage} player=${player} users=${users} />`;
  } else if (route.page === 'account') {
    page = html`<${AccountPage} returnTo=${returnRef.current} />`;
  } else if (route.page === 'report') {
    page = html`<${ReportPage} />`;
  } else if (route.page === 'general') {
    page = html`<${GeneralPage} />`;
  } else if (route.page === 'staff') {
    page = html`<${StaffPage} />`;
  } else if (route.page === 'lecture') {
    page = html`<${LecturePage} key=${route.id} id=${route.id} player=${player} />`;
  } else {
    page = html`<${HomePage} player=${player} now=${now} users=${users} />`;
  }

  return html`<div className="app" onContextMenu=${e => e.preventDefault()}>
    <${Stars} />
    <audio ref=${player.audioRef} preload="none" controlsList="nodownload" />
    ${page}
    <${MiniPlayer} player=${player} route=${route} />
  </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);

// تسجيل ملف التطبيق (يحفظ واجهة الموقع لتفتح أسرع)
if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}
