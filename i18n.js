// =====================
// نصوص الواجهة في مكان واحد لتسهيل إضافة لغات أخرى لاحقًا
// =====================
const STRINGS = {
  appName: 'راديو العفة',
  tagline: 'لقاءات تعافٍ في بث مباشر موحّد لكل المستمعين',
  live: 'بث مباشر',

  normalRadio: 'الراديو العادي',
  normalRadioDesc: 'اللقاءات بسرعتها الأصلية',
  fastRadio: 'الراديو السريع',
  fastRadioDesc: 'اللقاءات بسرعة أعلى ومدة أقصر',
  course: 'الكورس المرتّب',
  courseDesc: 'استمع بالترتيب وتابع تقدّمك',
  soon: 'قريبًا',

  nowPlaying: 'يُبث الآن: {title}',
  next: 'التالي: {title}',
  listeners: '{n} مستمع',
  visits: 'زيارات',
  totalListeners: 'مستمعين',
  back: 'رجوع',
  playingHere: 'تستمع الآن',

  tapToListen: 'اضغط للاستماع إلى البث المباشر',
  play: 'تشغيل البث',
  pause: 'إيقاف البث',
  volume: 'مستوى الصوت',
  retry: 'إعادة المحاولة',

  statusLoading: 'جارٍ تجهيز البث...',
  statusNext: 'جارٍ الانتقال إلى اللقاء التالي...',
  statusBlocked: 'توقف البث، اضغط زر التشغيل للمتابعة',
  statusError: 'تعذّر تشغيل الصوت، ستُعاد المحاولة تلقائيًا',
  statusOffline: 'انقطع الاتصال بالإنترنت، سيُستأنف البث عند عودته',

  dataNoteLabel: 'معلومة عن استهلاك البيانات',
  dataNote: 'ملفات هذا الراديو أكبر، فهو يستهلك بيانات أكثر من الراديو السريع.',

  stationLoading: 'جارٍ تجهيز بيانات الراديو...',
  stationError: 'تعذّر تحميل بيانات الراديو',

  facebook: 'مجموعة فيسبوك',
  courseShort: 'الكورس الأساسي {n}',
  lectureShort: 'لقاء {n}',
  mediaArtist: 'راديو',
  thousand: 'ألف',
  million: 'م',
};

function t(key, vars) {
  let s = STRINGS[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
