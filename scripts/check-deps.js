// ⚠️ 系统文件 - 禁止修改、删除或重写。此脚本由平台维护，用于校验原生依赖版本。
const fs = require('fs');
const path = require('path');

const ALLOWED = JSON.parse(fs.readFileSync(path.join(__dirname, 'allowed-deps.json'), 'utf8'));
const BLOCKED = JSON.parse(fs.readFileSync(path.join(__dirname, 'blocked-native-deps.json'), 'utf8'));

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const deps = pkg.dependencies || {};
const errors = [];

for (const [name, version] of Object.entries(deps)) {
  if (name in BLOCKED) {
    errors.push(`  • ${name} — 沙箱未预装，APK 运行时会 crash（${BLOCKED[name]}）`);
  } else if (name in ALLOWED && version !== ALLOWED[name]) {
    errors.push(`  • ${name} 版本不匹配：${version}（应为 ${ALLOWED[name]}）`);
  }
}

if (errors.length > 0) {
  console.error('\n❌ 依赖检查未通过：\n');
  errors.forEach(e => console.error(e));
  console.error('\n原生模块必须使用模板 APK 预装的版本，黑名单中的原生包禁止引入。纯 JS 库不受限制。\n');
  process.exit(1);
}
