// =====================
// Firebase
// =====================
const firebaseConfig = {
  apiKey: "AIzaSyB-ILlMJfQkfCN8ZBashSVgEz-Ok1w1vss",
  authDomain: "walyast3fef.firebaseapp.com",
  projectId: "walyast3fef",
  storageBucket: "walyast3fef.firebasestorage.app",
  messagingSenderId: "646833730084",
  appId: "1:646833730084:web:2926a50695ed8ebefddeb1",
  measurementId: "G-JB4JXZ3ZYL",
  databaseURL: "https://walyast3fef-default-rtdb.europe-west1.firebasedatabase.app"
};
firebase.initializeApp(firebaseConfig);
const database = firebase.database();

// أُلغيت إحصاءات Google احترامًا لخصوصية المستمعين؛ الدالة باقية حتى لا يتغير باقي الكود
function logEvent(name) {}

// =====================
// وقت الخادم: البث يُحسب منه بدل ساعة الجهاز، فيسمع الجميع الموضع نفسه حتى لو كانت ساعة الجهاز خاطئة
// =====================
let SERVER_OFFSET = 0;
try {
  const saved = parseInt(localStorage.getItem('serverOffset') || '0', 10);
  if (Math.abs(saved) < 86400000) SERVER_OFFSET = saved;
} catch (e) {}
database.ref('.info/serverTimeOffset').on('value', snap => {
  const v = snap.val();
  if (typeof v === 'number' && Math.abs(v) < 86400000 * 365) {
    SERVER_OFFSET = v;
    try { localStorage.setItem('serverOffset', String(Math.round(v))); } catch (e) {}
  }
});
const serverNow = () => Date.now() + SERVER_OFFSET;

// أي حفظ ينتظر 10 ثوانٍ على الأكثر، ثم يُعد فاشلًا بدل أن يبقى معلقًا
const SAVE_TIMEOUT_MS = 10000;
function withTimeout(promise, ms = SAVE_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// =====================
// تخزين محلي آمن لا يتعطل في وضع التصفح الخاص
// =====================
const storage = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  getJSON(k) { try { return JSON.parse(this.get(k) || 'null'); } catch (e) { return null; } },
  setJSON(k, v) { this.set(k, JSON.stringify(v)); },
};

// أجهزة آبل لا تسمح بالتحكم في مستوى الصوت من الصفحة
const IS_IOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// =====================
// تحديد الدولة
// =====================

// بديل احتياطي من المنطقة الزمنية للجهاز عند تعذّر الخدمة الخارجية
const TZ_COUNTRY = {
  'Africa/Cairo': 'EG', 'Asia/Riyadh': 'SA', 'Asia/Dubai': 'AE', 'Asia/Kuwait': 'KW',
  'Asia/Qatar': 'QA', 'Asia/Bahrain': 'BH', 'Asia/Muscat': 'OM', 'Asia/Amman': 'JO',
  'Asia/Baghdad': 'IQ', 'Asia/Damascus': 'SY', 'Asia/Beirut': 'LB', 'Asia/Gaza': 'PS',
  'Asia/Hebron': 'PS', 'Asia/Aden': 'YE', 'Africa/Khartoum': 'SD', 'Africa/Tripoli': 'LY',
  'Africa/Tunis': 'TN', 'Africa/Algiers': 'DZ', 'Africa/Casablanca': 'MA', 'Africa/El_Aaiun': 'MA',
  'Africa/Nouakchott': 'MR', 'Africa/Mogadishu': 'SO', 'Africa/Djibouti': 'DJ',
  'Europe/Istanbul': 'TR', 'Europe/London': 'GB', 'Europe/Berlin': 'DE', 'Europe/Paris': 'FR',
  'Europe/Amsterdam': 'NL', 'Europe/Brussels': 'BE', 'Europe/Stockholm': 'SE', 'Europe/Rome': 'IT',
  'Europe/Madrid': 'ES', 'America/New_York': 'US', 'America/Chicago': 'US', 'America/Denver': 'US',
  'America/Los_Angeles': 'US', 'America/Toronto': 'CA', 'Australia/Sydney': 'AU',
  'Asia/Kuala_Lumpur': 'MY', 'Asia/Jakarta': 'ID', 'Asia/Karachi': 'PK',
};

function countryFromTimezone() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return TZ_COUNTRY[tz] || 'XX';
  } catch (e) { return 'XX'; }
}

// البلد من المنطقة الزمنية للجهاز فقط، فلا يُرسل عنوان IP الزائر إلى أي خدمة خارجية
async function getCountryCode() { return countryFromTimezone(); }

// =====================
// اللقاءات
// normal و fast: مدة النسختين بالثواني (تُقاس بصفحة durations.html)
// لإضافة لقاء جديد: أضف سطرًا في آخر القائمة بالمدتين والعنوان
// =====================
// عند إضافة لقاء جديد: أضف له radioFrom: 'YYYY-MM-DD' بتاريخ الإضافة، حتى يدخل الراديو في الدورة التالية دون أن يقفز البث
const LECTURES = [
  { id: "c01", normal: 4963, fast: 2719, title: "الكورس الأساسي لقاء 1, الإباحية مشكلة ديناميكية الإباحية مشكلة نظامية" },
  { id: "c02", normal: 5498, fast: 2619, title: "الكورس الأساسي لقاء 2 تشوه التنبؤ و تشوه المثالية" },
  { id: "c03", normal: 6272, fast: 3036, title: "الكورس الأساسي لقاء 3 , تشوه التفكير بالتمني و تشوه التعريف" },
  { id: "c04", normal: 4739, fast: 2250, title: "الكورس الأساسي لقاء 4 , تشوه الينبغيات" },
  { id: "L01", normal: 5391, fast: 2714, title: "لقاء 1 - محاور التغيير" },
  { id: "L02", normal: 6534, fast: 2510, title: "لقاء 2 - قرار الإقلاع عن الإباحية" },
  { id: "L03", normal: 5158, fast: 2073, title: "لقاء 3 - بحس إن الإباحية فرصة صعب تتفوت" },
  { id: "L04", normal: 4132, fast: 1859, title: "لقاء 4 - الأفكار مسيطرة عليا وبتوقعني" },
  { id: "L05", normal: 5439, fast: 1828, title: "لقاء 5 - مغالطات الإدمان وعلاجه" },
  { id: "L06", normal: 5024, fast: 1989, title: "لقاء 6 - بخاف تنزل عليا مصيبة بعد الوقوع" },
  { id: "L07", normal: 5384, fast: 2193, title: "لقاء 7 - التعامل مع الخواطر والتفكير الجنسي" },
  { id: "L08", normal: 4940, fast: 2197, title: "لقاء 8 - هتفرج وابقى أتوب" },
  { id: "L09", normal: 5582, fast: 2850, title: "لقاء 9 - أنا هفضل أعاني بدون جنس كده كتير؟" },
  { id: "L10", normal: 3655, fast: 1752, title: "لقاء 10 - العلاج الشمولي للإباحية" },
  { id: "L11", normal: 3818, fast: 1642, title: "لقاء 11 - علاج اليأس وسرعة الإحباط" },
  { id: "L12", normal: 4432, fast: 2117, title: "لقاء 12 - كيف نتعامل مع الشعور بالشهوة" },
  { id: "L13", normal: 4426, fast: 2063, title: "لقاء 13 - ليه بتقدم فترة وبعدين بتراجع؟" },
  { id: "L14", normal: 5057, fast: 2193, title: "لقاء 14 - الفرق بين الخوف والرعب من المعصية" },
  { id: "L15", normal: 4985, fast: 2151, title: "لقاء 15 - طاعة قصاد معصية والدنيا ماشية!" },
  { id: "L16", normal: 4789, fast: 2345, title: "لقاء 16 - خطوات عملية لعلاج الإباحية" },
  { id: "L17", normal: 4490, fast: 2121, title: "لقاء 17 - علاج الإباحية فن مش بالعافية" },
  { id: "L18", normal: 4554, fast: 2251, title: "لقاء 18 - أتجوز ولا أستنى لما اتعافى؟" },
  { id: "L19", normal: 4636, fast: 1955, title: "لقاء 19 - ازاي اتعامل مع أعراض الانسحاب؟" },
  { id: "L20", normal: 4050, fast: 1978, title: "لقاء 20 - الفرق بين الزواج والإباحية" },
  { id: "L21", normal: 3421, fast: 1586, title: "لقاء 21 - خايف أقاوم وفي الآخر أنفجر" },
  { id: "L22", normal: 3455, fast: 1613, title: "لقاء 22 - الفرق بين التبطيل والتعافي" },
  { id: "L23", normal: 3906, fast: 2091, title: "لقاء 23 - ليه لما بقع بستحلاها ومش بعرف أوقف؟" },
  { id: "L24", normal: 3471, fast: 2002, title: "لقاء 24 - التعافي رحلة مش هدف" },
  { id: "L25", normal: 3751, fast: 2035, title: "لقاء 25 - مش مشكلة المرادي مانا كده كده بنتعافى" },
  { id: "L26", normal: 4583, fast: 2675, title: "لقاء 26 - الإباحية مش مشكلة إدمان" },
  { id: "L27", normal: 4040, fast: 2357, title: "لقاء 27 - الفرق بين الندم وجلد الذات" },
  { id: "L28", normal: 4011, fast: 2494, title: "لقاء 28 - التعافي زي بناء العضلات" },
  { id: "L29", normal: 3566, fast: 1883, title: "لقاء 29 - خدعوك فقالوا: الإباحية دمرت حياتك" },
  { id: "L30", normal: 3653, fast: 2066, title: "لقاء 30 - تقاوم ليه؟ مانت كده كده هتقع!" },
  { id: "L31", normal: 2980, fast: 1527, title: "لقاء 31 - هل المسار اللي بيتكون في المخ مش بيموت؟" },
  { id: "L32", normal: 3369, fast: 1912, title: "لقاء 32 - ذنب يعتاده الفينة بعد الفينة - الانهزامية" },
];

// الاسم المختصر المحايد لشاشة القفل: c01 ← الكورس الأساسي 1، L05 ← لقاء 5
const shortTitle = (id) =>
  t(id[0] === 'c' ? 'courseShort' : 'lectureShort', { n: parseInt(id.slice(1), 10) });

// =====================
// روابط الملفات
// =====================
const MEDIA_BASES = {
  fast: {
    c: atob('aHR0cHM6Ly9hcmNoaXZlLm9yZy9kb3dubG9hZC94V2FseWFzdGFhZmVmTXAzL194V2FseWFzdGFhZmVm'),
    L: atob('aHR0cHM6Ly9hcmNoaXZlLm9yZy9kb3dubG9hZC94V2FseWFzdGFhZmVmTXAzL3hXYWx5YXN0YWFmZWZfTElWRQ=='),
  },
  normal: {
    c: atob('aHR0cHM6Ly9hcmNoaXZlLm9yZy9kb3dubG9hZC93YWx5YXN0YWFmZWZNUDMvV2FseWFzdGFhZmVmXw=='),
    L: atob('aHR0cHM6Ly9hcmNoaXZlLm9yZy9kb3dubG9hZC93YWx5YXN0YWFmZWZNUDMvV2FseWFzdGFhZmVmXw==') + 'LIVE',
  },
};
// اللقاءات المضافة من صفحة المميزين تحمل روابطها الخاصة
const mediaUrl = (mode, id) => {
  const x = EXTRA_BY_ID[id];
  return x ? x.url[mode] : MEDIA_BASES[mode][id[0]] + id.slice(1) + '.mp3';
};
// مجلد الأرشيف المعتاد لكل نسخة (ما قبل اسم الملف)، لتسهيل كتابة الروابط عند إضافة لقاء
const ARCHIVE_DIR = {
  normal: MEDIA_BASES.normal.L.replace(/[^/]*$/, ''),
  fast: MEDIA_BASES.fast.L.replace(/[^/]*$/, ''),
};

// =====================
// ترتيب الكورس
// الترتيب المخصّص أولًا، ثم بقية اللقاءات بترتيبها الطبيعي
// أي لقاء جديد يُضاف إلى LECTURES يظهر تلقائيًا في آخر الكورس
// =====================
// =====================
// اللقاءات المضافة من صفحة المميزين (قاعدة البيانات: lectures/{id})
// تُقرأ عند فتح الصفحة من نسخة محفوظة على الجهاز، فتبقى القائمة ثابتة طوال الجلسة كما يتوقع باقي الكود،
// وتُحدَّث النسخة المحفوظة في الخلفية لتُطبَّق في الفتح التالي
// =====================
const EXTRA_LECTURES_KEY = 'afaf_lectures_v1';
const STATIC_LECTURE_IDS = new Set(LECTURES.map(l => l.id));
const validMp3Url = (u) => typeof u === 'string' && u.length <= 300 && /^https:\/\/[^\s]+\.mp3$/i.test(u);
const validSeconds = (n) => typeof n === 'number' && isFinite(n) && n >= 60 && n < 30000;

// تنظيف ما يأتي من قاعدة البيانات: يُقبل فقط ما اكتملت بياناته ولا يصطدم بلقاء أصلي
function cleanExtraLectures(raw) {
  const out = [];
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(raw).sort().forEach(id => {
    const v = raw[id];
    if (!/^L[0-9]{2}$/.test(id) || STATIC_LECTURE_IDS.has(id) || !v || typeof v !== 'object') return;
    if (typeof v.n !== 'string' || !v.n.trim() || !validSeconds(v.a) || !validSeconds(v.b)) return;
    if (!validMp3Url(v.ua) || !validMp3Url(v.ub)) return;
    out.push({
      id, title: v.n.trim().slice(0, 120), normal: Math.round(v.a), fast: Math.round(v.b),
      from: typeof v.from === 'number' ? v.from : 0, url: { normal: v.ua, fast: v.ub }, extra: true,
    });
  });
  return out;
}
const EXTRA_LECTURES_RAW = storage.get(EXTRA_LECTURES_KEY) || '';
const EXTRA_LECTURES = (() => { try { return cleanExtraLectures(JSON.parse(EXTRA_LECTURES_RAW || 'null')); } catch (e) { return []; } })();
const EXTRA_BY_ID = Object.fromEntries(EXTRA_LECTURES.map(l => [l.id, l]));
EXTRA_LECTURES.forEach(l => LECTURES.push(l));

// متابعة القائمة في قاعدة البيانات. عند تغيّرها تُحفظ، ثم تُعاد الصفحة مرة واحدة إن كانت في لحظاتها الأولى
// (قبل أن يبدأ الزائر استماعًا أو كتابة)، وإلا تُطبَّق في الفتح التالي
const extraLectures = (() => {
  const startedAt = Date.now();
  let latest = null;               // آخر ما وصل من القاعدة (خام)، أو null إذا لم يصل شيء بعد
  const listeners = new Set();
  const RELOAD_FLAG = 'afaf_lectures_reload';
  const listen = () => database.ref('/lectures').on('value', snap => {
    latest = snap.val() || {};
    const json = JSON.stringify(cleanExtraLectures(latest).map(l => [l.id, l.title, l.normal, l.fast, l.from, l.url.normal, l.url.fast]));
    const mine = JSON.stringify(EXTRA_LECTURES.map(l => [l.id, l.title, l.normal, l.fast, l.from, l.url.normal, l.url.fast]));
    storage.set(EXTRA_LECTURES_KEY, JSON.stringify(latest));
    listeners.forEach(fn => fn());
    if (json === mine) { try { sessionStorage.removeItem(RELOAD_FLAG); } catch (e) {} return; }
    let tried = '1';
    try { tried = sessionStorage.getItem(RELOAD_FLAG); } catch (e) {}
    const audio = document.querySelector('audio');
    const idle = Date.now() - startedAt < 8000 && (!audio || audio.paused) && !location.hash.startsWith('#/staff');
    if (idle && !tried) {
      try { sessionStorage.setItem(RELOAD_FLAG, '1'); } catch (e) { return; }
      location.reload();
    }
  }, () => {});                    // رفض القراءة (قواعد لم تُنشر بعد) لا يؤثر في شيء
  try { listen(); } catch (e) {}
  return {
    get raw() { return latest; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
})();

const COURSE_HEAD = ['c01', 'c02', 'c03', 'c04', 'L01', 'L02', 'L08'];
const COURSE_ORDER = [
  ...COURSE_HEAD,
  ...LECTURES.map(l => l.id).filter(id => !COURSE_HEAD.includes(id)),
];
const LECTURE_BY_ID = Object.fromEntries(LECTURES.map(l => [l.id, l]));
const courseIndex = (id) => COURSE_ORDER.indexOf(id);
const courseNext = (id) => COURSE_ORDER[courseIndex(id) + 1] || null;
const coursePrev = (id) => COURSE_ORDER[courseIndex(id) - 1] || null;
