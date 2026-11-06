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
const analytics = firebase.analytics();
const database = firebase.database();

function logEvent(name) {
  try { analytics.logEvent(name); } catch (e) {}
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

// يحفظ الدولة يومًا كاملًا لتقليل الطلبات على الخدمة الخارجية
async function getCountryCode() {
  const cached = storage.getJSON('radio_country');
  if (cached && cached.code && Date.now() - cached.at < 86400000) return cached.code;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    const r = await fetch('https://ipapi.co/json/', { signal: ctrl.signal });
    clearTimeout(timer);
    const d = await r.json();
    if (d && typeof d.country_code === 'string' && /^[A-Z]{2}$/.test(d.country_code)) {
      storage.setJSON('radio_country', { code: d.country_code, at: Date.now() });
      return d.country_code;
    }
  } catch (e) {}
  return countryFromTimezone();
}

// =====================
// اللقاءات
// fast: مدة النسخة السريعة بالثواني
// مدد النسخة العادية تُجلب تلقائيًا من بيانات archive.org
// =====================
const LECTURES = [
  { id: "c01", fast: 2719, title: "الكورس الأساسي لقاء 1, الإباحية مشكلة ديناميكية الإباحية مشكلة نظامية" },
  { id: "c02", fast: 2619, title: "الكورس الأساسي لقاء 2 تشوه التنبؤ و تشوه المثالية" },
  { id: "c03", fast: 3036, title: "الكورس الأساسي لقاء 3 , تشوه التفكير بالتمني و تشوه التعريف" },
  { id: "c04", fast: 2250, title: "الكورس الأساسي لقاء 4 , تشوه الينبغيات" },
  { id: "L01", fast: 2714, title: "لقاء 1 - محاور التغيير" },
  { id: "L02", fast: 2510, title: "لقاء 2 - قرار الإقلاع عن الإباحية" },
  { id: "L03", fast: 2073, title: "لقاء 3 - بحس إن الإباحية فرصة صعب تتفوت" },
  { id: "L04", fast: 1859, title: "لقاء 4 - الأفكار مسيطرة عليا وبتوقعني" },
  { id: "L05", fast: 1828, title: "لقاء 5 - مغالطات الإدمان وعلاجه" },
  { id: "L06", fast: 1989, title: "لقاء 6 - بخاف تنزل عليا مصيبة بعد الوقوع" },
  { id: "L07", fast: 2193, title: "لقاء 7 - التعامل مع الخواطر والتفكير الجنسي" },
  { id: "L08", fast: 2197, title: "لقاء 8 - هتفرج وابقى أتوب" },
  { id: "L09", fast: 2850, title: "لقاء 9 - أنا هفضل أعاني بدون جنس كده كتير؟" },
  { id: "L10", fast: 1752, title: "لقاء 10 - العلاج الشمولي للإباحية" },
  { id: "L11", fast: 1642, title: "لقاء 11 - علاج اليأس وسرعة الإحباط" },
  { id: "L12", fast: 2117, title: "لقاء 12 - كيف نتعامل مع الشعور بالشهوة" },
  { id: "L13", fast: 2063, title: "لقاء 13 - ليه بتقدم فترة وبعدين بتراجع؟" },
  { id: "L14", fast: 2193, title: "لقاء 14 - الفرق بين الخوف والرعب من المعصية" },
  { id: "L15", fast: 2151, title: "لقاء 15 - طاعة قصاد معصية والدنيا ماشية!" },
  { id: "L16", fast: 2345, title: "لقاء 16 - خطوات عملية لعلاج الإباحية" },
  { id: "L17", fast: 2121, title: "لقاء 17 - علاج الإباحية فن مش بالعافية" },
  { id: "L18", fast: 2251, title: "لقاء 18 - أتجوز ولا أستنى لما اتعافى؟" },
  { id: "L19", fast: 1955, title: "لقاء 19 - ازاي اتعامل مع أعراض الانسحاب؟" },
  { id: "L20", fast: 1978, title: "لقاء 20 - الفرق بين الزواج والإباحية" },
  { id: "L21", fast: 1586, title: "لقاء 21 - خايف أقاوم وفي الآخر أنفجر" },
  { id: "L22", fast: 1613, title: "لقاء 22 - الفرق بين التبطيل والتعافي" },
  { id: "L23", fast: 2091, title: "لقاء 23 - ليه لما بقع بستحلاها ومش بعرف أوقف؟" },
  { id: "L24", fast: 2002, title: "لقاء 24 - التعافي رحلة مش هدف" },
  { id: "L25", fast: 2035, title: "لقاء 25 - مش مشكلة المرادي مانا كده كده بنتعافى" },
  { id: "L26", fast: 2675, title: "لقاء 26 - الإباحية مش مشكلة إدمان" },
  { id: "L27", fast: 2357, title: "لقاء 27 - الفرق بين الندم وجلد الذات" },
  { id: "L28", fast: 2494, title: "لقاء 28 - التعافي زي بناء العضلات" },
  { id: "L29", fast: 1883, title: "لقاء 29 - خدعوك فقالوا: الإباحية دمرت حياتك" },
  { id: "L30", fast: 2066, title: "لقاء 30 - تقاوم ليه؟ مانت كده كده هتقع!" },
  { id: "L31", fast: 1527, title: "لقاء 31 - هل المسار اللي بيتكون في المخ مش بيموت؟" },
  { id: "L32", fast: 1912, title: "لقاء 32 - ذنب يعتاده الفينة بعد الفينة - الانهزامية" },
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
const mediaUrl = (mode, id) => MEDIA_BASES[mode][id[0]] + id.slice(1) + '.mp3';

// =====================
// مدد النسخة العادية من بيانات archive.org
// تُحفظ على الجهاز أسبوعًا، وتُستخدم النسخة المحفوظة إذا تعذّر الاتصال
// =====================
const NORMAL_META_URL = atob('aHR0cHM6Ly9hcmNoaXZlLm9yZy9tZXRhZGF0YS93YWx5YXN0YWFmZWZNUDMvZmlsZXM=');
const NORMAL_CACHE_KEY = 'radio_normal_durations_v1';

function parseLength(v) {
  if (v == null) return 0;
  const s = String(v);
  if (s.includes(':')) return s.split(':').reduce((acc, p) => acc * 60 + parseFloat(p || 0), 0);
  return parseFloat(s) || 0;
}

const isComplete = (map) => !!map && LECTURES.every(l => map[l.id] > 0);

async function loadNormalDurations() {
  const cached = storage.getJSON(NORMAL_CACHE_KEY);
  if (cached && isComplete(cached.map) && Date.now() - cached.at < 7 * 86400000) return cached.map;

  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    const r = await fetch(NORMAL_META_URL, { signal: ctrl.signal });
    clearTimeout(timer);
    const d = await r.json();
    const files = Array.isArray(d) ? d : (d && d.result) || [];
    const map = {};
    files.forEach(f => {
      const m = /^Walyastaafef_(LIVE)?(\d{2})\.mp3$/.exec(f && f.name || '');
      if (!m) return;
      const len = Math.floor(parseLength(f.length));
      if (len > 0) map[(m[1] ? 'L' : 'c') + m[2]] = len;
    });
    if (isComplete(map)) {
      storage.setJSON(NORMAL_CACHE_KEY, { at: Date.now(), map });
      return map;
    }
  } catch (e) {}

  if (cached && isComplete(cached.map)) return cached.map;
  throw new Error('normal durations unavailable');
}
