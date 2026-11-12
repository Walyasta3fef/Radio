// =====================
// ملف التطبيق: يحفظ واجهة الموقع ليفتح أسرع
// يُجلب الأحدث من الإنترنت أولًا، والنسخة المحفوظة تُستخدم فقط عند انقطاع الاتصال
// الملفات الصوتية وFirebase لا تُحفظ هنا، واللقاءات التي يحمّلها المستخدم في مخزن audio-* منفصل لا يُحذف عند التحديث
// =====================
const CACHE = 'shell-v40';
const SHELL = [
  './', 'index.html', 'style.css', 'i18n.js', 'data.js', 'radio.js', 'progress.js',
  'notes.js', 'offline.js', 'account.js', 'staff.js', 'comments.js', 'feedback.js', 'app.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'lib/react.production.min.js', 'lib/react-dom.production.min.js', 'lib/htm.umd.js',
  'lib/firebase-app-compat.js', 'lib/firebase-database-compat.js', 'lib/firebase-auth-compat.js',
  'fonts/tajawal-arabic-400-normal.woff2', 'fonts/tajawal-latin-400-normal.woff2', 'fonts/tajawal-arabic-500-normal.woff2', 'fonts/tajawal-latin-500-normal.woff2', 'fonts/tajawal-arabic-700-normal.woff2', 'fonts/tajawal-latin-700-normal.woff2', 'fonts/tajawal-arabic-800-normal.woff2', 'fonts/tajawal-latin-800-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE && !k.startsWith('audio-')).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(r => r || (req.mode === 'navigate' ? caches.match('index.html') : undefined)))
  );
});
