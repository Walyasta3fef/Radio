const { useState, useEffect, useRef, useCallback, useMemo } = React;
const html = htm.bind(React.createElement);

const MODES = ['normal', 'fast'];
const MODE_LABEL = { normal: 'normalRadio', fast: 'fastRadio', lecture: 'course' };
const MODE_SHORT = { normal: 'speedNormal', fast: 'speedFast' };
const MODE_NOTE = { normal: 'normalNote', fast: 'fastNote' };
const MODE_INFO = { normal: 'normalInfo', fast: 'fastInfo' };
const SKIP_SECONDS = 15;
const BEHIND_SECONDS = 20;
const RADIO_MODE_KEY = 'radio_mode';

const STATIONS = Object.fromEntries(MODES.map(mode => [mode, createStation(mode,
  LECTURES.map(l => ({ id: l.id, title: l.title, duration: l[mode] })))]));

const fmtTime = (s) => {
  if (isNaN(s)) return '0:00';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
};
const fmtCount = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + t('million')
  : n >= 1000 ? (n / 1000).toFixed(1) + t('thousand') : n;
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
    const p = audioRef.current.play();
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

  // إعادة تحميل الملف الحالي من الموضع نفسه (بعد خطأ أو انقطاع)
  const reloadInPlace = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audio.getAttribute('src')) return;
    lastAttemptRef.current = Date.now();
    lastProgressRef.current = Date.now();
    if (!navigator.onLine) { updateStatus('offline'); return; }
    updateStatus('loading');
    resumeRef.current = audio.currentTime;
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
      resumeRef.current = forceReload && loadedKeyRef.current === key ? audio.currentTime : progress.position(id);
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
      setCurrentTime(ct);
      const id = trackedId();
      if (id && !audio.paused && !audio.seeking) {
        const prev = lastSampleRef.current;
        if (prev != null) {
          const d = ct - prev;
          if (d > 0 && d <= 3) progress.record(id, prev, ct);
        }
        lastSampleRef.current = ct;
      }
      if (modeRef.current === 'lecture' && id) progress.setPosition(id, ct);
    };
    const onSeeking = () => { lastSampleRef.current = null; };
    const onPlaying = () => {
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

      // الكورس والبث المتأخر: لا مزامنة مع البث، بل معالجة التعليق فقط
      if (modeRef.current === 'lecture' || shiftedRef.current) {
        const reload = modeRef.current === 'lecture' ? () => loadLecture(true) : reloadInPlace;
        if (st === 'error') { if (sinceAttempt > 8000) reload(); return; }
        if (audio.paused) { if (sinceAttempt > 6000) { lastAttemptRef.current = Date.now(); playAudio(); } return; }
        if (Date.now() - lastProgressRef.current > 15000 && sinceAttempt > 15000) reload();
        return;
      }

      const s = radioState();
      if (!s) return;
      if (radioKey(s) !== loadedKeyRef.current) return syncAndPlay();
      if (endedRef.current) return;
      if (st === 'error') { if (sinceAttempt > 8000) syncAndPlay(true); return; }
      if (audio.paused) { if (sinceAttempt > 6000) syncAndPlay(); return; }
      if (Date.now() - lastProgressRef.current > 15000 && sinceAttempt > 15000) return syncAndPlay(true);
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
};
function Icon({ name, size = 18 }) {
  return html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;
}

// =====================
// عناصر مشتركة
// =====================
function Stars() {
  const stars = useMemo(() => Array.from({ length: 60 }, (_, i) => ({
    id: i,
    size: Math.random() * 2.5 + 0.5,
    top: Math.random() * 100,
    left: Math.random() * 100,
    dur: (Math.random() * 4 + 2).toFixed(1),
    delay: (Math.random() * 5).toFixed(1),
    op: (Math.random() * 0.5 + 0.1).toFixed(2),
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

function TotalStats() {
  const [stats, setStats] = useState({ total_visits: 0, total_listeners: 0 });
  useEffect(() => {
    const ref = database.ref('/stats');
    const l = ref.on('value', snap => {
      const d = snap.val();
      if (d) setStats({ total_visits: d.total_visits || 0, total_listeners: d.total_listeners || 0 });
    });
    return () => ref.off('value', l);
  }, []);
  return html`<div className="chip stats">
    <div><b>${fmtCount(stats.total_visits)}</b><small>${t('visits')}</small></div>
    <span className="divider"></span>
    <div><b>${fmtCount(stats.total_listeners)}</b><small>${t('totalListeners')}</small></div>
  </div>`;
}

function FacebookLink() {
  return html`<a className="icon-btn" href="https://www.facebook.com/groups/1594701261071238"
      target="_blank" rel="noopener noreferrer" aria-label=${t('facebook')} title=${t('facebook')}>
    <svg width="20" height="20" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path fillRule="evenodd" d="M22 12c0-5.523-4.477-10-10-10S2 6.477 2 12c0 4.991 3.657 9.128 8.438 9.878v-6.987h-2.54V12h2.54V9.797c0-2.506 1.492-3.89 3.777-3.89 1.094 0 2.238.195 2.238.195v2.46h-1.26c-1.243 0-1.63.771-1.63 1.562V12h2.773l-.443 2.89h-2.33v6.988C18.343 21.128 22 16.991 22 12z" clipRule="evenodd"/>
    </svg>
  </a>`;
}

// معلومة صغيرة تظهر عند الضغط على الأيقونة بدل أن تشغل مساحة في الصفحة
function InfoTip({ label, text }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const id = setTimeout(() => document.addEventListener('click', close), 0);
    return () => { clearTimeout(id); document.removeEventListener('click', close); };
  }, [open]);
  return html`<span className="info">
    <button className="info-btn" aria-label=${label} aria-expanded=${open}
      onClick=${(e) => { e.stopPropagation(); setOpen(o => !o); }}>i</button>
    ${open && html`<span className="info-pop" role="tooltip">${text}</span>`}
  </span>`;
}

function MiniBar({ value }) {
  return html`<div className="bar"><div className="fill" style=${{ width: Math.min(100, value) + '%' }}></div></div>`;
}

// شريط الأجزاء المسموعة: تتلون الأجزاء التي سُمعت فعلًا فقط
function HeardBar({ id, position, duration }) {
  const segs = progress.segments(id);
  return html`<div className="bar heard-bar">
    ${segs.map(([a, b], i) => html`<span key=${i} className="heard-seg"
      style=${{ insetInlineStart: a + '%', width: Math.max(0.6, b - a) + '%' }}></span>`)}
    ${position != null && duration > 0 && html`<span className="heard-cursor"
      style=${{ insetInlineStart: Math.min(100, position / duration * 100) + '%' }}></span>`}
  </div>`;
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
  const pickMode = (m) => { setModeState(m); storage.set(RADIO_MODE_KEY, m); };
  const rv = radioView(player, mode, now);
  const count = users.filter(u => u.at === mode).length;

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

    <section className="section">
      <h2 className="section-title">${t('courseSection')}</h2>
      <div className=${'card course-card' + (player.isPlaying && player.mode === 'lecture' ? ' card-active' : '')}>
        <button className="card-main" onClick=${() => go('#/course')}>
          <div className="card-head">
            <span className="card-title">${t('course')}</span>
            <span className="pct"><${Pct} value=${sum.percent} /></span>
          </div>
          <${MiniBar} value=${sum.percent} />
          <p className="card-count">${t('doneOf', { done: sum.done, count: sum.count })}</p>
        </button>
        ${contId && html`<button className="continue" onClick=${() => go('#/lecture/' + contId)}>
          <span className="continue-text">
            <small>${started ? t('continueFrom') : t('startCourse')}</small>
            <b>${LECTURE_BY_ID[contId].title}</b>
          </span>
          <span className="continue-play"><${Icon} name="play" size=${16} /></span>
        </button>`}
      </div>
    </section>

    <section className="section">
      <h2 className="section-title">${t('radioSection')}</h2>
      <div className=${'card radio-card' + (rv.active ? ' card-active' : '')}>
        <div className="card-head">
          <${LiveBadge} behind=${rv.behind} onGoLive=${player.goLive} />
          <span className="card-count">${t('listeners', { n: count })}</span>
        </div>

        <div className="seg" role="tablist" aria-label=${t('radioSpeed')}>
          ${MODES.map(m => html`<button key=${m} role="tab" aria-selected=${mode === m}
              className=${mode === m ? 'on' : ''} onClick=${() => pickMode(m)}>${t(MODE_SHORT[m])}</button>`)}
        </div>
        <p className=${'mode-note mode-note-' + mode}>
          ${t(MODE_NOTE[mode])}
          <${InfoTip} label=${t('infoLabel')} text=${t(MODE_INFO[mode])} />
        </p>

        <div className="now">
          <small>${t('nowPlayingLabel')}</small>
          <p className="now-title">${rv.s.track.title}</p>
        </div>

        <${PlayButton} active=${rv.active} status=${rv.status} onClick=${() => player.toggleRadio(mode)} />
        <${StatusLine} active=${rv.active} status=${rv.status} onRetry=${player.retry} />

        <button className="link-btn center-self" onClick=${() => go('#/radio/' + mode)}>${t('radioDetails')}</button>
      </div>
    </section>

    <footer className="foot"><${FacebookLink} /></footer>
  </div>`;
}

// =====================
// صفحة الراديو
// =====================
function RadioPage({ mode, player, now, users, volume, onVolume }) {
  const modeUsers = users.filter(u => u.at === mode);
  const rv = radioView(player, mode, now);
  const { s, time } = rv;
  const pct = Math.min(100, (time / s.track.duration) * 100 || 0);

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
      <div className="panel-glow"></div>
      <div className="panel">
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
        <${StatusLine} active=${rv.active} status=${rv.status}
          idleText=${rv.behind ? t('resumeBehind') : t('tapToListen')} onRetry=${player.retry} />

        <div className="progress">
          <div className="times"><span>${fmtTime(time)}</span><span>${fmtTime(s.track.duration)}</span></div>
          <${MiniBar} value=${pct} />
        </div>

        ${!IS_IOS && html`<input type="range" min="0" max="1" step="0.01" value=${volume}
          onChange=${onVolume} aria-label=${t('volume')} className="volume" />`}

        <div className="center"><${FacebookLink} /></div>
      </div>
    </div>
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

  return html`<div className="page course">
    <div className="topbar">
      <${BackButton} to="#/" />
      <div className="top-left">
        <${NameChip} />
        <${OnlineBadge} count=${courseUsers.length} />
      </div>
    </div>

    <div className="panel summary">
      <h1>${t('course')}
        <${InfoTip} label=${t('infoLabel')} text=${t('courseInfo')} />
      </h1>
      <div className="big-pct"><${Pct} value=${sum.percent} /></div>
      <${MiniBar} value=${sum.percent} />
      <div className="stat-row">
        <div><b>${sum.done}/${sum.count}</b><small>${t('lecturesDone')}</small></div>
        <div><b>${fmtHours(sum.seconds)}</b><small>${t('listenTime')}</small></div>
        <div><b>${sum.days}</b><small>${t('listenDays')}</small></div>
      </div>
      ${contId && html`<button className="cta" onClick=${() => go('#/lecture/' + contId)}>
        ${progress.hasAny() ? t('continueFrom') : t('startCourse')}
      </button>`}
    </div>

    <ol className="lessons">
      ${COURSE_ORDER.map((id) => {
        const pct = progress.percent(id);
        const done = progress.isDone(id);
        const playing = player.isPlaying && player.mode === 'lecture' && player.lectureId === id;
        return html`<li key=${id}>
          <button className=${'lesson' + (playing ? ' lesson-playing' : '') + (done ? ' lesson-done' : '')}
              onClick=${() => go('#/lecture/' + id)}>
            <span className="lesson-body">
              <span className="lesson-title">${LECTURE_BY_ID[id].title}</span>
              <span className="lesson-meta">
                ${fmtTime(LECTURE_BY_ID[id].normal)}
                ${pct ? html`<span> · ${t('heardLabel')} <${Pct} value=${pct + '%'} /></span>` : ''}
                ${playing ? ' · ' + t('playingHere') : ''}
              </span>
              ${pct > 0 && !done && html`<${HeardBar} id=${id} />`}
            </span>
            ${done && html`<span className="done-badge" aria-label=${t('lectureDone')}><${Icon} name="check" size=${14} /></span>`}
          </button>
        </li>`;
      })}
    </ol>
  </div>`;
}

// =====================
// صفحة اللقاء
// =====================
function LecturePage({ id, player, volume, onVolume }) {
  useProgressVersion();
  const lec = LECTURE_BY_ID[id];
  const current = player.mode === 'lecture' && player.lectureId === id;
  const active = current && player.isPlaying;
  const time = current ? player.currentTime : progress.position(id);
  const status = active ? player.status : 'idle';
  const heard = progress.percent(id);
  const done = progress.isDone(id);
  const prev = coursePrev(id), next = courseNext(id);

  // سحب شريط التقدم: يُعرض الموضع أثناء السحب ثم يُطبّق عند الإفلات
  const [dragging, setDragging] = useState(null);
  const shown = dragging != null ? dragging : time;
  const commit = () => { if (dragging != null) { player.seekLecture(id, dragging); setDragging(null); } };

  return html`<div className="page lecture">
    <div className="topbar">
      <${BackButton} to="#/course" />
      <div className="top-left"><${NameChip} /></div>
    </div>

    <div className="panel-wrap">
      <div className="panel-glow"></div>
      <div className="panel">
        <p className="lecture-title">${lec.title}</p>
        <p className=${'heard' + (done ? ' heard-done' : '')}>
          ${done ? '✓ ' + t('lectureDone') + ' · ' : ''}${t('heardLabel')} <${Pct} value=${heard + '%'} />
        </p>

        <div className="seek">
          <input type="range" min="0" max=${lec.normal} step="1" value=${Math.floor(shown)}
            aria-label=${t('seek')}
            onInput=${e => setDragging(parseFloat(e.target.value))}
            onChange=${e => setDragging(parseFloat(e.target.value))}
            onMouseUp=${commit} onTouchEnd=${commit} onKeyUp=${commit} />
          <div className="times"><span>${fmtTime(shown)}</span><span>${fmtTime(lec.normal)}</span></div>
        </div>
        <div className="heard-map">
          <span className="heard-map-label">${t('heardMap')}</span>
          <${HeardBar} id=${id} position=${shown} duration=${lec.normal} />
        </div>

        <div className="controls">
          <button className="skip" onClick=${() => current ? player.skip(-SKIP_SECONDS) : player.seekLecture(id, time - SKIP_SECONDS)}
            aria-label=${t('back15')}>−15</button>
          <${PlayButton} active=${active} status=${status} onClick=${() => player.toggleLecture(id)} />
          <button className="skip" onClick=${() => current ? player.skip(SKIP_SECONDS) : player.seekLecture(id, time + SKIP_SECONDS)}
            aria-label=${t('forward15')}>+15</button>
        </div>

        <${StatusLine} active=${active} status=${status}
          idleText=${time > 0 ? t('resumeHint', { t: fmtTime(time) }) : t('tapToStart')} onRetry=${player.retry} />

        ${!IS_IOS && html`<input type="range" min="0" max="1" step="0.01" value=${volume}
          onChange=${onVolume} aria-label=${t('volume')} className="volume" />`}

        <div className="nav">
          <button className="small-btn" disabled=${!prev} onClick=${() => prev && go('#/lecture/' + prev)}>${t('prevLecture')}</button>
          <button className="small-btn" disabled=${!next} onClick=${() => next && go('#/lecture/' + next)}>${t('nextLecture')}</button>
        </div>
      </div>
    </div>
  </div>`;
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
  return html`<div className="mini">
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
  const [volume, setVolume] = useState(() => {
    const v = parseFloat(storage.get('radio_volume'));
    return isNaN(v) ? 0.7 : Math.min(1, Math.max(0, v));
  });
  const player = usePlayer(volume);

  // آخر صفحة قبل صفحة الاسم، للعودة إليها بعد الحفظ
  const returnRef = useRef('#/');
  if (route.page !== 'account') returnRef.current = location.hash || '#/';

  const pageAt = route.page === 'radio' ? route.mode
    : (route.page === 'course' || route.page === 'lecture') ? 'course' : 'home';
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
      : route.page === 'course' ? t('course')
      : route.page === 'account' ? t('accountTitle')
      : route.page === 'lecture' ? shortTitle(route.id)
      : t('appName');
  }, [route]);

  const onVolume = (e) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    storage.set('radio_volume', String(v));
  };

  let page;
  if (route.page === 'radio') {
    page = html`<${RadioPage} mode=${route.mode} player=${player} now=${now} users=${users}
      volume=${volume} onVolume=${onVolume} />`;
  } else if (route.page === 'course') {
    page = html`<${CoursePage} player=${player} users=${users} />`;
  } else if (route.page === 'account') {
    page = html`<${AccountPage} returnTo=${returnRef.current} />`;
  } else if (route.page === 'lecture') {
    page = html`<${LecturePage} key=${route.id} id=${route.id} player=${player} volume=${volume} onVolume=${onVolume} />`;
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
