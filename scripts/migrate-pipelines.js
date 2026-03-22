// Migration: move flat template files to per-pipeline directories
const fs = require('fs');
const path = require('path');

const dataDir = path.resolve(__dirname, '../data');

// 1. Copy default-templates.json → pipelines/cold-start/templates.json
const src = path.join(dataDir, 'default-templates.json');
const dst = path.join(dataDir, 'pipelines/cold-start/templates.json');
if (fs.existsSync(src)) {
  fs.copyFileSync(src, dst);
  console.log('✓ Copied default-templates.json → pipelines/cold-start/templates.json');
}

// 2. Copy prompt-overrides.json → pipelines/cold-start/overrides.json
const overSrc = path.join(dataDir, 'prompt-overrides.json');
const overDst = path.join(dataDir, 'pipelines/cold-start/overrides.json');
if (fs.existsSync(overSrc)) {
  fs.copyFileSync(overSrc, overDst);
  console.log('✓ Copied prompt-overrides.json → pipelines/cold-start/overrides.json');
} else {
  fs.writeFileSync(overDst, '{}');
  console.log('✓ Created pipelines/cold-start/overrides.json (empty)');
}

// 3. Create full-analysis/overrides.json
fs.writeFileSync(path.join(dataDir, 'pipelines/full-analysis/overrides.json'), '{}');
console.log('✓ Created pipelines/full-analysis/overrides.json (empty)');

console.log('\nDone. Old files (default-templates.json, prompt-overrides.json) can be deleted.');
