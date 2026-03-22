const fs = require('fs');
const path = require('path');

const dir = path.resolve(__dirname, '../src/dashboard/public');
const files = fs.readdirSync(dir).filter(f => f.endsWith('.html'));

const navItems = [
  { href: '/overview', icon: '📊', label: 'Overview' },
  { href: '/decisions', icon: '💡', label: 'Decisions' },
  { href: '/coverage', icon: '🗺', label: 'Coverage' },
  { href: '/dependencies', icon: '🌐', label: 'Dependencies' },
  { href: '/pipeline', icon: '⚡', label: 'Pipeline' },
  { href: '/query', icon: '🔍', label: 'Query' },
  { href: '/system', icon: '⚙', label: 'System' },
  { href: '/cold-start', icon: '🧊', label: 'Cold Start' },
];

const fileToRoute = {
  'overview.html': '/overview',
  'decisions.html': '/decisions',
  'coverage.html': '/coverage',
  'dependencies.html': '/dependencies',
  'pipeline.html': '/pipeline',
  'query.html': '/query',
  'system.html': '/system',
  'cold-start.html': '/cold-start',
  'index.html': '/overview',
};

let fixed = 0;
for (const file of files) {
  const filepath = path.join(dir, file);
  let content = fs.readFileSync(filepath, 'utf-8');
  const activeRoute = fileToRoute[file];
  if (!activeRoute) continue;

  const navHtml = navItems.map(item => {
    const cls = item.href === activeRoute ? 'nav-item active' : 'nav-item';
    return `    <a href="${item.href}" class="${cls}"><span class="icon">${item.icon}</span> ${item.label}</a>`;
  }).join('\n');

  const newSidebarNav = `  <div class="sidebar-nav">\n${navHtml}\n  </div>`;

  const navStart = content.indexOf('<div class="sidebar-nav">');
  if (navStart === -1) {
    console.log('SKIP ' + file + ' — no sidebar-nav found');
    continue;
  }
  
  let depth = 0, navEnd = -1, i = navStart;
  while (i < content.length) {
    if (content.substring(i, i + 5) === '<div ') depth++;
    else if (content.substring(i, i + 6) === '</div>') {
      depth--;
      if (depth === 0) { navEnd = i + 6; break; }
    }
    i++;
  }

  if (navEnd === -1) {
    console.log('SKIP ' + file + ' — could not find closing div');
    continue;
  }

  content = content.substring(0, navStart) + newSidebarNav + content.substring(navEnd);
  fs.writeFileSync(filepath, content, 'utf-8');
  console.log('FIXED ' + file + ' (active=' + activeRoute + ')');
  fixed++;
}

console.log('\nDone: ' + fixed + ' files fixed');
