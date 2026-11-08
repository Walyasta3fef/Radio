// فحص سريع قبل النشر: أخطاء الصياغة في ملفات JS، وتكرار مفاتيح النصوص في i18n.js
// التشغيل: node tools/check.js
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
let failed = false;

for (const f of fs.readdirSync(root).filter(f => f.endsWith('.js'))) {
  try { execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }); }
  catch (e) { failed = true; console.error('خطأ صياغة في ' + f + ':\n' + e.stderr.toString()); }
}

const i18n = fs.readFileSync(path.join(root, 'i18n.js'), 'utf8');
const seen = new Map();
i18n.split('\n').forEach((line, i) => {
  const m = line.match(/^ {2}([A-Za-z_]\w*):/);
  if (!m) return;
  if (seen.has(m[1])) { failed = true; console.error(`مفتاح مكرر في i18n.js: ${m[1]} (السطر ${seen.get(m[1])} والسطر ${i + 1})`); }
  else seen.set(m[1], i + 1);
});

if (failed) process.exit(1);
console.log('تم الفحص: لا أخطاء.');
