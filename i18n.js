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
  courseInfo: 'يُحتسب تقدّمك من الاستماع بالسرعة العادية فقط، سواء من الكورس أو من الراديو العادي. يُعدّ اللقاء مكتملًا عند سماع 90% منه، والتقديم لا يُحتسب استماعًا. يُحفظ تقدّمك على هذا المتصفح.',
  doneOf: 'أكملت {done} من {count} لقاء',
  continueFrom: 'أكمل من حيث توقفت:',
  startCourse: 'ابدأ الكورس:',
  lecturesDone: 'لقاءات مكتملة',
  listenTime: 'وقت الاستماع',
  listenDays: 'أيام الاستماع',
  hoursMinutes: '{h} س {m} د',
  minutesOnly: '{m} د',
  heardPct: 'استمعت إلى {n}%',
  openInCourse: 'افتحه في الكورس',
  lectureOf: 'اللقاء {n} من {count}',
  lectureDone: 'مكتمل',
  seek: 'موضع الاستماع',
  back15: 'رجوع 15 ثانية',
  forward15: 'تقديم 15 ثانية',
  tapToStart: 'اضغط للبدء',
  resumeHint: 'ستُكمل من {t}',
  prevLecture: 'السابق',
  nextLecture: 'التالي',

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

  infoLabel: 'معلومات عن هذا الراديو',
  normalNote: 'ملفاته أكبر حجمًا وتستهلك بيانات أكثر',
  fastNote: 'الاستماع إليه لا يُحتسب في تقدّمك',
  normalInfo: 'ملفات هذا الراديو أكبر حجمًا، فهو يستهلك بيانات أكثر من الراديو السريع. والاستماع إليه يُحتسب في تقدّمك في الكورس.',
  fastInfo: 'الاستماع إلى هذا الراديو لا يُحتسب في تقدّمك في الكورس، لأن التقدّم يُحسب على السرعة العادية فقط. وملفاته أصغر حجمًا وتستهلك بيانات أقل.',

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
