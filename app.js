const { useState, useEffect, useRef, useCallback, useMemo } = React;
const html = htm.bind(React.createElement);

const MODES = ['normal', 'fast'];
const MODE_LABEL = { normal: 'normalRadio', fast: 'fastRadio' };
const MODE_DESC = { normal: 'normalRadioDesc', fast: 'fastRadioDesc' };

const fmtTime = (s) => isNaN(s) ? '0:00' : `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const fmtCount = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + t('million')
  : n >= 1000 ? (n / 1000).toFixed(1) + t('thousand') : n;

// =====================
// التنقل بين الصفحات دون إعادة تحميل، فلا يتوقف الصوت
// =====================
function parseRoute() {
  const m = /^#\/radio\/(normal|fast)$/.exec(location.hash);
  return m ? { page: 'radio', mode: m[1] } : { page: 'home' };
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

// =====================
// المحطتان
// =====================
function useStations() {
  const [fast] = useState(() => createStation('fast',
    LECTURES.map(l => ({ id: l.id, title: l.title, duration: l.fast }))));
  const [normal, setNormal] = useState(null);
  const [normalError, setNormalError] = useState(false);

  const loadNormal = useCallback(() => {
    setNormalError(false);
    loadNormalDurations()
      .then(map => setNormal(createStation('normal',
        LECTURES.map(l => ({ id: l.id, title: l.title, duration: map[l.id] })))))
      .catch(() => setNormalError(true));
  }, []);
  useEffect(() => { loadNormal(); }, [loadNormal]);

  return { stations: { fast, normal }, normalError, loadNormal };
}

// =====================
// مشغّل البث: مشغّل واحد للموقع كله يبقى يعمل أثناء التنقل
// =====================
function useRadioEngine(stations, volume) {
  const audioRef = useRef(null);
  const stationsRef = useRef(stations);
  stationsRef.current = stations;

  const modeRef = useRef(null);          // المحطة الحالية في المشغّل
  const wantPlayRef = useRef(false);     // هل يريد المستخدم الاستماع الآن
  const loadedKeyRef = useRef(null);     // المحطة واللقاء المحمّلان حاليًا
  const statusRef = useRef('idle');
  const endedRef = useRef(false);
  const pendingSeekRef = useRef(false);
  const lastProgressRef = useRef(0);
  const lastAttemptRef = useRef(0);

  const [mode, setMode] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [status, setStatus] = useState('idle');
  const [live, setLive] = useState(null);
  const [currentTime, setCurrentTime] = useState(0);

  const updateStatus = useCallback((s) => { statusRef.current = s; setStatus(s); }, []);
  const stationState = () => {
    const st = stationsRef.current[modeRef.current];
    return st ? st.getState() : null;
  };
  const keyOf = (s) => modeRef.current + ':' + s.track.id;

  // ضبط المشغّل على موضع البث الحي ثم التشغيل
  const syncAndPlay = useCallback((forceReload = false) => {
    const audio = audioRef.current;
    const s = stationState();
    if (!audio || !s) return;
    setLive(s);
    endedRef.current = false;
    lastAttemptRef.current = Date.now();
    lastProgressRef.current = Date.now();
    if (!navigator.onLine) { updateStatus('offline'); return; }
    updateStatus('loading');

    const key = keyOf(s);
    if (forceReload || loadedKeyRef.current !== key) {
      loadedKeyRef.current = key;
      pendingSeekRef.current = true;
      audio.src = mediaUrl(modeRef.current, s.track.id);
      audio.load();
    } else if (audio.readyState >= 1) {
      audio.currentTime = s.position;
    } else {
      pendingSeekRef.current = true;
    }

    const p = audio.play();
    if (p && p.catch) {
      p.catch(err => {
        if (!wantPlayRef.current) return;
        const name = err && err.name;
        if (name === 'AbortError') return; // تغيّر المصدر أثناء التحميل
        updateStatus(name === 'NotAllowedError' ? 'blocked' : 'error');
      });
    }
  }, [updateStatus]);

  const start = useCallback((m) => {
    if (!stationsRef.current[m]) return;
    if (modeRef.current !== m) {
      // الانتقال من محطة إلى أخرى
      lastAttemptRef.current = Date.now();
      if (audioRef.current) audioRef.current.pause();
      loadedKeyRef.current = null;
      modeRef.current = m;
      setMode(m);
    }
    wantPlayRef.current = true;
    setIsPlaying(true);
    syncAndPlay();
    logEvent('playback_started_' + m);
  }, [syncAndPlay]);

  const stop = useCallback(() => {
    wantPlayRef.current = false;
    setIsPlaying(false);
    updateStatus('idle');
    if (audioRef.current) audioRef.current.pause();
    logEvent('playback_stopped');
  }, [updateStatus]);

  const toggle = useCallback((m) => {
    if (wantPlayRef.current && modeRef.current === m) {
      if (statusRef.current === 'blocked') return syncAndPlay();
      return stop();
    }
    start(m);
  }, [start, stop, syncAndPlay]);

  useEffect(() => { if (audioRef.current) audioRef.current.volume = volume; }, [volume]);

  // أحداث المشغّل
  useEffect(() => {
    const audio = audioRef.current;
    const onTime = () => { lastProgressRef.current = Date.now(); setCurrentTime(audio.currentTime); };
    const onPlaying = () => { if (wantPlayRef.current) updateStatus('playing'); };
    const onWaiting = () => {
      if (wantPlayRef.current && statusRef.current !== 'next' && statusRef.current !== 'offline') updateStatus('loading');
    };
    const onMeta = () => {
      if (!pendingSeekRef.current) return;
      pendingSeekRef.current = false;
      const s = stationState();
      if (s && keyOf(s) === loadedKeyRef.current) audio.currentTime = s.position;
    };
    const onEnded = () => {
      if (!wantPlayRef.current) return;
      const s = stationState();
      if (s && keyOf(s) !== loadedKeyRef.current) {
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
    };
    const onError = () => {
      if (wantPlayRef.current && audio.getAttribute('src')) updateStatus(navigator.onLine ? 'error' : 'offline');
    };
    const onOffline = () => { if (wantPlayRef.current) updateStatus('offline'); };
    const onOnline = () => { if (wantPlayRef.current) syncAndPlay(true); };

    audio.addEventListener('timeupdate', onTime);
    audio.addEventListener('playing', onPlaying);
    audio.addEventListener('waiting', onWaiting);
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('pause', onPause);
    audio.addEventListener('error', onError);
    window.addEventListener('offline', onOffline);
    window.addEventListener('online', onOnline);
    return () => {
      audio.removeEventListener('timeupdate', onTime);
      audio.removeEventListener('playing', onPlaying);
      audio.removeEventListener('waiting', onWaiting);
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('pause', onPause);
      audio.removeEventListener('error', onError);
      window.removeEventListener('offline', onOffline);
      window.removeEventListener('online', onOnline);
    };
  }, [syncAndPlay, updateStatus]);

  // المراقب: يعيد المشغّل لموضع البث إذا توقف أو علّق أو تأخر
  useEffect(() => {
    const tick = () => {
      if (!wantPlayRef.current) return;
      const audio = audioRef.current;
      const s = stationState();
      if (!audio || !s) return;

      const sinceAttempt = Date.now() - lastAttemptRef.current;
      const st = statusRef.current;

      if (st === 'blocked' || st === 'offline') return;
      if (keyOf(s) !== loadedKeyRef.current) return syncAndPlay();
      if (endedRef.current) return;
      if (st === 'error') { if (sinceAttempt > 8000) syncAndPlay(true); return; }
      if (audio.paused) { if (sinceAttempt > 6000) syncAndPlay(); return; }
      if (Date.now() - lastProgressRef.current > 15000 && sinceAttempt > 15000) return syncAndPlay(true);
      if (audio.readyState >= 3 && Math.abs(audio.currentTime - s.position) > 15) {
        audio.currentTime = s.position;
      }
    };
    const id = setInterval(tick, 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(id); document.removeEventListener('visibilitychange', onVisible); };
  }, [syncAndPlay]);

  // شاشة القفل والإشعارات: اسم مختصر محايد مراعاةً لخصوصية المستمع
  const liveId = live && live.track.id;
  useEffect(() => {
    if (!('mediaSession' in navigator) || !liveId) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: shortTitle(liveId), artist: t('mediaArtist'), album: '',
      });
    } catch (e) {}
  }, [liveId]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    const set = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) {}
    };
    set('play', () => { if (modeRef.current) start(modeRef.current); });
    set('pause', () => stop());
    set('stop', () => stop());
    ['seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'].forEach(a => set(a, null));
  }, [start, stop]);

  useEffect(() => {
    if (!('mediaSession' in navigator)) return;
    try { navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused'; } catch (e) {}
  }, [isPlaying]);

  return {
    audioRef, mode, isPlaying, status, live, currentTime, toggle, stop,
    retry: () => syncAndPlay(true),
  };
}

// =====================
// تسجيل الحضور
// كل زائر يسجّل نفسه فقط، ويُحذف تلقائيًا من الخادم عند انقطاع اتصاله
// at: المكان الذي يوجد فيه الزائر (home أو normal أو fast)
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
// عناصر الواجهة
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
  return html`<div className="chip"><${LiveDot} />${t('listeners', { n: count })}</div>`;
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

// =====================
// الصفحة الرئيسية
// =====================
function HomePage({ stations, normalError, engine, now, users }) {
  const card = (mode) => {
    const st = stations[mode];
    const s = st ? st.getState(now) : null;
    const playingHere = engine.isPlaying && engine.mode === mode;
    const count = users.filter(u => u.at === mode).length;
    return html`<button key=${mode} className=${'card' + (playingHere ? ' card-active' : '')}
        onClick=${() => go('#/radio/' + mode)}>
      <div className="card-head">
        <span className="card-title">${t(MODE_LABEL[mode])}</span>
        <span className="card-live"><${LiveDot} />${t('live')}</span>
      </div>
      <p className="card-desc">${t(MODE_DESC[mode])}</p>
      <p className="card-now">
        ${playingHere ? t('playingHere') + ' · ' : ''}
        ${s ? t('nowPlaying', { title: shortTitle(s.track.id) })
          : (mode === 'normal' && normalError ? t('stationError') : t('stationLoading'))}
      </p>
      <span className="card-count">${t('listeners', { n: count })}</span>
    </button>`;
  };

  return html`<div className="page home">
    <div className="topbar">
      <${TotalStats} />
      <${OnlineBadge} count=${users.length} />
    </div>
    <header className="hero">
      <h1>${t('appName')}</h1>
      <p>${t('tagline')}</p>
    </header>
    <div className="cards">
      ${MODES.map(card)}
      <div className="card card-disabled" aria-disabled="true">
        <div className="card-head">
          <span className="card-title">${t('course')}</span>
          <span className="badge">${t('soon')}</span>
        </div>
        <p className="card-desc">${t('courseDesc')}</p>
      </div>
    </div>
    <footer className="foot"><${FacebookLink} /></footer>
  </div>`;
}

// =====================
// صفحة الراديو
// =====================
const STATUS_KEY = {
  loading: 'statusLoading', next: 'statusNext', blocked: 'statusBlocked',
  error: 'statusError', offline: 'statusOffline',
};

function RadioPage({ mode, station, normalError, loadNormal, engine, now, users, volume, onVolume }) {
  const modeUsers = users.filter(u => u.at === mode);
  const active = engine.mode === mode && engine.isPlaying;

  const top = html`<div className="topbar">
    <button className="chip back" onClick=${() => go('#/')} aria-label=${t('back')}>→ ${t('back')}</button>
    <div className="top-left">
      <${OnlineBadge} count=${modeUsers.length} />
      <${CountryFlags} users=${modeUsers} />
    </div>
  </div>`;

  if (!station) {
    return html`<div className="page radio">${top}
      <div className="panel center">
        ${normalError
          ? html`<div className="center">
                 <p className="msg warn">${t('stationError')}</p>
                 <button className="small-btn" onClick=${loadNormal}>${t('retry')}</button>
               </div>`
          : html`<div className="center">
                 <span className="spinner light"></span>
                 <p className="msg">${t('stationLoading')}</p>
               </div>`}
      </div>
    </div>`;
  }

  const s = active && engine.live ? engine.live : station.getState(now);
  const time = active ? engine.currentTime : s.position;
  const status = active ? engine.status : 'idle';
  const busy = active && (status === 'loading' || status === 'next');
  const showPause = active && status !== 'blocked' && status !== 'offline';
  const progress = Math.min(100, (time / s.track.duration) * 100 || 0);
  const isWarn = status === 'error' || status === 'blocked' || status === 'offline';

  return html`<div className="page radio">${top}
    <div className="panel-wrap">
      <div className="panel-glow"></div>
      <div className="panel">
        <div className="panel-head">
          <h1>
            ${t(MODE_LABEL[mode])}
            ${mode === 'normal' && html`<${InfoTip} label=${t('dataNoteLabel')} text=${t('dataNote')} />`}
          </h1>
          <div className="live"><${LiveDot} />${t('live')}</div>
        </div>

        <div className="now">
          <p className="now-title">${s.track.title}</p>
          <p className="now-next">${t('next', { title: s.next.title })}</p>
        </div>

        <button className=${'play' + (showPause && !busy ? ' play-btn-glow' : '')}
            onClick=${() => engine.toggle(mode)} aria-label=${showPause ? t('pause') : t('play')}>
          ${busy ? html`<span className="spinner"></span>` : (showPause ? '⏸' : '▶')}
        </button>

        <div className="status">
          ${active && STATUS_KEY[status] && html`<p className=${isWarn ? 'warn' : ''}>${t(STATUS_KEY[status])}</p>`}
          ${!active && html`<p>${t('tapToListen')}</p>`}
          ${active && status === 'error' && html`<button className="small-btn" onClick=${engine.retry}>${t('retry')}</button>`}
        </div>

        <div className="progress">
          <div className="times"><span>${fmtTime(time)}</span><span>${fmtTime(s.track.duration)}</span></div>
          <div className="bar"><div className="fill" style=${{ width: progress + '%' }}></div></div>
        </div>

        ${!IS_IOS && html`<input type="range" min="0" max="1" step="0.01" value=${volume}
          onChange=${onVolume} aria-label=${t('volume')} className="volume" />`}

        <div className="center"><${FacebookLink} /></div>
      </div>
    </div>
  </div>`;
}

// =====================
// المشغّل المصغّر: يظهر أسفل الشاشة أثناء الاستماع في صفحة أخرى
// =====================
function MiniPlayer({ engine, route }) {
  if (!engine.isPlaying || !engine.live) return null;
  if (route.page === 'radio' && route.mode === engine.mode) return null;
  const busy = engine.status === 'loading' || engine.status === 'next';
  return html`<div className="mini">
    <button className="mini-info" onClick=${() => go('#/radio/' + engine.mode)}>
      <b>${t(MODE_LABEL[engine.mode])}</b>
      <span>${shortTitle(engine.live.track.id)}</span>
    </button>
    <button className="mini-btn" onClick=${engine.stop} aria-label=${t('pause')}>
      ${busy ? html`<span className="spinner small"></span>` : '⏸'}
    </button>
  </div>`;
}

// =====================
// التطبيق الرئيسي
// =====================
function App() {
  const route = useRoute();
  const now = useClock();
  const { stations, normalError, loadNormal } = useStations();
  const [volume, setVolume] = useState(() => {
    const v = parseFloat(storage.get('radio_volume'));
    return isNaN(v) ? 0.7 : Math.min(1, Math.max(0, v));
  });
  const engine = useRadioEngine(stations, volume);

  const at = engine.isPlaying ? engine.mode : (route.page === 'radio' ? route.mode : 'home');
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
    document.title = route.page === 'radio' ? t(MODE_LABEL[route.mode]) : t('appName');
  }, [route]);

  const onVolume = (e) => {
    const v = parseFloat(e.target.value);
    setVolume(v);
    storage.set('radio_volume', String(v));
  };

  return html`<div className="app" onContextMenu=${e => e.preventDefault()}>
    <${Stars} />
    <audio ref=${engine.audioRef} preload="none" controlsList="nodownload" />
    ${route.page === 'radio'
      ? html`<${RadioPage} mode=${route.mode} station=${stations[route.mode]}
          normalError=${normalError} loadNormal=${loadNormal} engine=${engine}
          now=${now} users=${users} volume=${volume} onVolume=${onVolume} />`
      : html`<${HomePage} stations=${stations} normalError=${normalError}
          engine=${engine} now=${now} users=${users} />`}
    <${MiniPlayer} engine=${engine} route=${route} />
  </div>`;
}

ReactDOM.createRoot(document.getElementById('root')).render(html`<${App} />`);
