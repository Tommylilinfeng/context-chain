/**
 * sidebar.js — Unified sidebar + i18n
 *
 * All pages just need:
 *   <nav class="sidebar" id="sidebar"></nav>
 *   <script src="/sidebar.js"></script>
 *
 * Language toggle at bottom of sidebar. Preference in localStorage.
 * Only affects dashboard UI — no impact on pipelines or prompts.
 */

// ── SVG Icons (16x16 stroke-based) ──────────────────

var ICONS = {
  overview:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="5" height="5" rx="1"/><rect x="9.5" y="1.5" width="5" height="5" rx="1"/><rect x="1.5" y="9.5" width="5" height="5" rx="1"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/></svg>',
  decisions:     '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4h12M2 8h8M2 12h10"/></svg>',
  relationships: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="4" r="2"/><path d="M5.5 5.5L10.5 10.5M6 4h4"/></svg>',
  concerns:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="5" r="3"/><circle cx="11" cy="11" r="3"/><circle cx="12" cy="5" r="2"/><path d="M7.5 6.5L9.5 9.5"/></svg>',
  coverage:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="1.5" y="1.5" width="13" height="13" rx="2"/><path d="M1.5 6h13M6 1.5v13"/></svg>',
  dependencies:  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c-2 2-3 4-3 6.5s1 4.5 3 6.5M8 1.5c2 2 3 4 3 6.5s-1 4.5-3 6.5"/></svg>',
  feedback:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 13V5l3 4 3-6 3 3 3-2v9H2z"/></svg>',
  sessions:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 2h10a1 1 0 011 1v10a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1zM5 5h6M5 8h6M5 11h3"/></svg>',
  templates:     '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2h8a1 1 0 011 1v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z"/><path d="M6 5h4M6 8h4M6 11h2"/></svg>',
  pipeline:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v12M4 6l4-4 4 4M4 10l4 4 4-4"/></svg>',
  run:           '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M4 2.5v11l9-5.5z"/></svg>',
  schedule:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4.5V8l2.5 2.5"/></svg>',
  coldstart:     '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1v14M4 3l4 4 4-4M4 13l4-4 4 4M1 8h14"/></svg>',
  query:         '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h12M2 6h8M2 9h10M2 12h6"/><path d="M12 10l2 4"/></svg>',
  system:        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.9 2.9l1.4 1.4M11.7 11.7l1.4 1.4M13.1 2.9l-1.4 1.4M4.3 11.7l-1.4 1.4"/></svg>',
  history:       '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M8 4v4l3 2"/><path d="M1.5 8H3M8 1.5V3"/></svg>',
  scan:          '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h4M10 2h4M2 14h4M10 14h4M2 2v4M14 2v4M2 14v-4M14 14v-4"/><circle cx="8" cy="8" r="3"/></svg>',
  onboarding:    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8h12M8 2v12"/><circle cx="8" cy="8" r="6.5"/></svg>',
  group:         '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><path d="M6 4h4M4 6v4M12 6v4M6 12h4"/></svg>',
  localize:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.5"/><path d="M1.5 8h13M8 1.5c-2 2-3 4-3 6.5s1 4.5 3 6.5M8 1.5c2 2 3 4 3 6.5s-1 4.5-3 6.5"/></svg>',
  design:        '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h5v5H2zM9 2h5v5H9zM5.5 9v5M10.5 9v5M3 11.5h10"/></svg>',
  packages:      '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l6-2 6 2v8l-6 2-6-2V4z"/><path d="M8 6v8M2 4l6 2 6-2"/></svg>',
  architecture:  '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 1v3M4 7v7M8 7v7M12 7v7M2 14h12M5.5 4h5L12 7H4l1.5-3z"/></svg>',
  graph:         '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="4" r="2"/><circle cx="12" cy="4" r="2"/><circle cx="8" cy="12" r="2"/><path d="M5.7 5.3L9 10.5M10.3 5.3L9.3 10.2"/></svg>',
  search:        '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>',
}

// ── i18n ──────────────────────────────────────────────

var I18N = {
  en: {
    'brand.name': 'Context Chain',
    'brand.tagline': 'grep finds what code does.<br>We record why it was written that way.',
    'nav.explore': 'Explore', 'nav.data': 'Data', 'nav.pipeline': 'Pipeline', 'nav.admin': 'Admin',
    'nav.packages': 'Packages', 'nav.architecture': 'Architecture',
    'nav.overview': 'Overview', 'nav.decisions': 'Decisions', 'nav.relationships': 'Relationships', 'nav.concerns': 'Concerns',
    'nav.coverage': 'Coverage', 'nav.dependencies': 'Dependencies', 'nav.feedback': 'Feedback',
    'nav.graph': 'Graph',
    'nav.sessions': 'Sessions', 'nav.templates': 'Templates',
    'nav.run': 'Run', 'nav.group': 'Group', 'nav.design': 'Design', 'nav.localize': 'Localize', 'nav.history': 'History', 'nav.schedule': 'Schedule',
    'nav.query': 'Query', 'nav.system': 'System',
    'nav.onboarding': 'Getting Started',
    'search.placeholder': 'Search...', 'search.inputPlaceholder': 'Search decisions, code, keywords...',
    'search.noResults': 'No results for', 'search.error': 'Search error',
    'onboarding.title': 'Getting Started', 'onboarding.subtitle': 'Set up Context Chain step by step',
    'overview.title': 'Overview', 'overview.subtitle': 'Real-time graph statistics from Memgraph',
    'decisions.title': 'Decisions', 'decisions.subtitle': 'Browse, search, and filter all design decisions',
    'relationships.title': 'Relationships', 'relationships.subtitle': 'Decision relationship graph',
    'concerns.title': 'Concern Analysis', 'concerns.subtitle': 'Community detection reveals clusters of related design decisions',
    'coverage.title': 'Coverage', 'coverage.subtitle': 'Decision coverage across repos and functions',
    'dependencies.title': 'Dependencies', 'dependencies.subtitle': 'Cross-repo and cross-service dependency map',
    'feedback.title': 'Feedback', 'feedback.subtitle': 'Which decisions are actually used by coding AI',
    'sessions.title': 'Sessions', 'sessions.subtitle': 'Ingest decisions from AI coding sessions',
    'templates.title': 'Templates', 'templates.subtitle': 'Manage analyze_function configuration templates',
    'pipeline.title': 'Pipeline', 'pipeline.subtitle': 'Prompt templates and pipeline configuration',
    'run.title': 'Run', 'run.subtitle': 'Execute analysis pipelines',
    'history.title': 'History', 'history.subtitle': 'Pipeline run statistics and token usage',
    'group.title': 'Group', 'group.subtitle': 'Connect related decisions via batch comparison',
    'design.title': 'Design Analysis', 'design.subtitle': 'Sub-module decomposition, design choices, and theme discovery',
    'localize.title': 'Localize', 'localize.subtitle': 'Translate decisions to other languages',
    'schedule.title': 'Schedule', 'schedule.subtitle': 'Automated pipeline scheduling',
    'query.title': 'Query', 'query.subtitle': 'Execute Cypher queries on the graph',
    'system.title': 'System', 'system.subtitle': 'Memgraph connection, config, and diagnostics',
    'architecture.title': 'Architecture', 'architecture.subtitle': 'Interactive architecture documentation and exploration',
  },
  zh: {
    'brand.name': 'Context Chain',
    'brand.tagline': 'grep 找的是代码写了什么<br>我们记录的是代码为什么这样写',
    'nav.explore': '浏览', 'nav.data': '数据', 'nav.pipeline': '管线', 'nav.admin': '管理',
    'nav.packages': '代码包', 'nav.architecture': '架构文档',
    'nav.overview': '概览', 'nav.decisions': '决策', 'nav.relationships': '关系图', 'nav.concerns': '关注点',
    'nav.coverage': '覆盖率', 'nav.dependencies': '依赖', 'nav.feedback': '反馈',
    'nav.graph': '图谱',
    'nav.sessions': 'Sessions', 'nav.templates': '模板',
    'nav.run': '运行', 'nav.group': '分组', 'nav.design': '设计分析', 'nav.localize': '翻译', 'nav.history': '历史', 'nav.schedule': '定时',
    'nav.onboarding': '快速开始',
    'nav.query': '查询', 'nav.system': '系统',
    'search.placeholder': '搜索...', 'search.inputPlaceholder': '搜索决策、代码、关键词...',
    'search.noResults': '无结果：', 'search.error': '搜索出错',
    'overview.title': '概览', 'overview.subtitle': '来自 Memgraph 的实时图谱统计',
    'decisions.title': '决策浏览器', 'decisions.subtitle': '浏览、搜索和过滤所有设计决策',
    'relationships.title': '决策关系', 'relationships.subtitle': '决策之间的因果/依赖/冲突关系图',
    'concerns.title': '关注点分析', 'concerns.subtitle': '社区检测发现相关设计决策的聚类',
    'coverage.title': '覆盖率', 'coverage.subtitle': '各 repo 和函数的决策覆盖情况',
    'dependencies.title': '依赖关系', 'dependencies.subtitle': '跨 repo、跨服务的依赖地图',
    'feedback.title': '反馈', 'feedback.subtitle': '哪些决策被 coding AI 实际使用了',
    'sessions.title': 'Sessions', 'sessions.subtitle': '从 AI 编码对话中摄入决策',
    'templates.title': '模板', 'templates.subtitle': '管理 analyze_function 配置模板',
    'pipeline.title': '管线配置', 'pipeline.subtitle': 'Prompt 模板与管线参数',
    'run.title': '运行', 'run.subtitle': '执行分析管线',
    'history.title': '历史', 'history.subtitle': '管线运行统计与 Token 用量',
    'group.title': '分组', 'group.subtitle': '通过批量比较连接相关决策',
    'design.title': '设计分析', 'design.subtitle': '子模块分解、设计选择与主题发现',
    'localize.title': '翻译', 'localize.subtitle': '将决策翻译成其他语言',
    'schedule.title': '定时任务', 'schedule.subtitle': '自动化管线调度',
    'onboarding.title': '快速开始', 'onboarding.subtitle': '按步骤设置 Context Chain',
    'query.title': '查询', 'query.subtitle': '直接执行 Cypher 查询',
    'system.title': '系统', 'system.subtitle': 'Memgraph 连接、配置和诊断',
    'architecture.title': '架构文档', 'architecture.subtitle': '交互式架构文档和代码探索',
  }
}

var _lang = localStorage.getItem('ckg-lang') || 'en'

function t(key) { return I18N[_lang]?.[key] ?? I18N.en?.[key] ?? key }

var PAGE_KEY_MAP = {
  '/packages': 'packages',
  '/overview': 'overview', '/decisions': 'decisions', '/relationships': 'relationships', '/concerns': 'concerns',
  '/coverage': 'coverage', '/dependencies': 'dependencies', '/feedback': 'feedback',
  '/sessions': 'sessions', '/templates': 'templates', '/pipeline': 'pipeline',
  '/run': 'run', '/group': 'group', '/design': 'design', '/localize': 'localize', '/history': 'history', '/schedule': 'schedule',
  '/query': 'query', '/system': 'system', '/onboarding': 'onboarding',
  '/architecture': 'architecture',
}

function translatePageHero() {
  var pageKey = PAGE_KEY_MAP[location.pathname.replace(/\/$/, '') || '/overview']
  if (!pageKey) return
  var hero = document.querySelector('.page-hero')
  if (!hero) return
  var h2 = hero.querySelector('h2')
  if (h2) h2.textContent = t(pageKey + '.title')
  var sub = hero.querySelector('.subtitle')
  if (sub) sub.textContent = t(pageKey + '.subtitle')
}

// ── NAV contract ─────────────────────────────────
// Adding a new page:
//   1. Create public/{name}.html
//   2. Add entry below with href: '/{name}'
//   3. Route is auto-registered by server (public/*.html → GET /{name})
//   No manual route registration needed in server.ts.

var CHEVRON_SVG = '<svg class="section-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 2.5L8 6L4.5 9.5"/></svg>'

var NAV = [
  { id: 'explore', titleKey: 'nav.explore', defaultOpen: true, items: [
    { href: '/overview',       iconKey: 'overview',      key: 'nav.overview' },
    { href: '/decisions',      iconKey: 'decisions',     key: 'nav.decisions' },
    { href: '/architecture',   iconKey: 'architecture',  key: 'nav.architecture' },
  ], subgroups: [
    { id: 'graph', titleKey: 'nav.graph', defaultOpen: false, items: [
      { href: '/relationships',  iconKey: 'relationships', key: 'nav.relationships' },
      { href: '/concerns',       iconKey: 'concerns',      key: 'nav.concerns' },
      { href: '/dependencies',   iconKey: 'dependencies',  key: 'nav.dependencies' },
      { href: '/coverage',       iconKey: 'coverage',      key: 'nav.coverage' },
    ]},
  ]},
  { id: 'data', titleKey: 'nav.data', defaultOpen: true, items: [
    { href: '/packages',     iconKey: 'packages',   key: 'nav.packages' },
    { href: '/feedback',     iconKey: 'feedback',   key: 'nav.feedback' },
    { href: '/sessions',     iconKey: 'sessions',   key: 'nav.sessions' },
  ]},
  { id: 'pipeline', titleKey: 'nav.pipeline', defaultOpen: false, items: [
    { href: '/run',          iconKey: 'run',        key: 'nav.run' },
    { href: '/design',       iconKey: 'design',     key: 'nav.design' },
    { href: '/group',        iconKey: 'group',      key: 'nav.group' },
    { href: '/localize',     iconKey: 'localize',   key: 'nav.localize' },
    { href: '/history',      iconKey: 'history',    key: 'nav.history' },
    { href: '/schedule',     iconKey: 'schedule',   key: 'nav.schedule' },
  ]},
  { id: 'admin', titleKey: 'nav.admin', defaultOpen: false, items: [
    { href: '/onboarding',   iconKey: 'onboarding', key: 'nav.onboarding' },
    { href: '/templates',    iconKey: 'templates',   key: 'nav.templates' },
    { href: '/query',        iconKey: 'query',       key: 'nav.query' },
    { href: '/system',       iconKey: 'system',      key: 'nav.system' },
  ]},
]

// ── Collapse state (localStorage) ──────────────────

function _collapseKey(id) { return 'ckg-nav-' + id }

function isOpen(id, defaultOpen) {
  var stored = localStorage.getItem(_collapseKey(id))
  if (stored !== null) return stored === '1'
  return defaultOpen
}

function toggleSection(id) {
  var key = _collapseKey(id)
  var cur = localStorage.getItem(key)
  // if never stored, it was showing default — toggle away from default
  var section = NAV.find(function(s) { return s.id === id })
  var sub = null
  NAV.forEach(function(s) { (s.subgroups || []).forEach(function(sg) { if (sg.id === id) sub = sg }) })
  var def = section ? section.defaultOpen : (sub ? sub.defaultOpen : true)
  var wasOpen = cur !== null ? cur === '1' : def
  localStorage.setItem(key, wasOpen ? '0' : '1')
  renderSidebar()
}

// Check if any href in items/subgroups matches current path
function sectionContainsPath(sec, path) {
  var found = sec.items.some(function(item) { return item.href === path })
  if (!found && sec.subgroups) {
    sec.subgroups.forEach(function(sg) {
      if (sg.items.some(function(item) { return item.href === path })) found = true
    })
  }
  return found
}

function renderNavItems(items, cur) {
  return items.map(function(item) {
    var active = cur === item.href ? ' active' : ''
    return '<a href="' + item.href + '" class="nav-item' + active + '"><span class="nav-icon">' + (ICONS[item.iconKey] || '') + '</span>' + t(item.key) + '</a>'
  }).join('')
}

function renderSidebar() {
  var el = document.getElementById('sidebar')
  if (!el) return
  var cur = location.pathname.replace(/\/$/, '') || '/overview'
  var toggleLabel = _lang === 'en' ? '中' : 'EN'

  var navHtml = NAV.map(function(sec) {
    var containsCur = sectionContainsPath(sec, cur)
    var open = containsCur || isOpen(sec.id, sec.defaultOpen)
    var openCls = open ? ' open' : ''
    var html = '<div class="sidebar-section' + openCls + '" data-section="' + sec.id + '">'
      + '<span class="section-label">' + t(sec.titleKey) + '</span>'
      + CHEVRON_SVG
      + '</div>'

    if (open) {
      html += '<div class="section-items">'
      html += renderNavItems(sec.items, cur)

      // Render subgroups (e.g. Graph)
      if (sec.subgroups) {
        sec.subgroups.forEach(function(sg) {
          var sgContains = sg.items.some(function(item) { return item.href === cur })
          var sgOpen = sgContains || isOpen(sg.id, sg.defaultOpen)
          var sgOpenCls = sgOpen ? ' open' : ''
          html += '<div class="sidebar-subgroup' + sgOpenCls + '" data-section="' + sg.id + '">'
            + '<span class="subgroup-icon">' + (ICONS[sg.id] || '') + '</span>'
            + '<span class="subgroup-label">' + t(sg.titleKey) + '</span>'
            + CHEVRON_SVG
            + '</div>'
          if (sgOpen) {
            html += '<div class="subgroup-items">'
            html += renderNavItems(sg.items, cur)
            html += '</div>'
          }
        })
      }
      html += '</div>'
    }
    return html
  }).join('')

  el.innerHTML = '<div class="sidebar-brand"><h1>' + t('brand.name') + '</h1></div>'
    + '<div class="sidebar-search"><div class="search-input-wrap" id="searchTrigger"><span class="search-icon">' + ICONS.search + '</span><span class="search-placeholder">' + t('search.placeholder') + '</span><kbd class="search-kbd">/</kbd></div></div>'
    + '<div class="sidebar-nav">' + navHtml + '</div>'
    + '<div class="sidebar-footer"><button class="lang-toggle" id="langToggleBtn">' + toggleLabel + '</button></div>'

  // Bind section toggle clicks
  el.querySelectorAll('.sidebar-section, .sidebar-subgroup').forEach(function(header) {
    header.addEventListener('click', function() {
      toggleSection(header.dataset.section)
    })
  })

  document.getElementById('langToggleBtn').addEventListener('click', function() {
    _lang = _lang === 'en' ? 'zh' : 'en'
    localStorage.setItem('ckg-lang', _lang)
    renderSidebar()
    translatePageHero()
  })
  document.getElementById('searchTrigger').addEventListener('click', function() { openSearch() })
}

function injectStyles() {
  if (document.getElementById('ckg-sidebar-extra')) return
  var style = document.createElement('style')
  style.id = 'ckg-sidebar-extra'
  style.textContent = [
    '.sidebar-footer { padding:14px 16px; border-top:1px solid var(--border-subtle,#1b2230); }',
    '.lang-toggle { display:flex; align-items:center; justify-content:center; width:36px; height:30px; border-radius:8px; border:1px solid var(--border,#252d3a); background:var(--surface-2,#1a1f2a); color:var(--text-dim,#5a6580); font-size:12px; font-weight:600; cursor:pointer; transition:all 0.3s cubic-bezier(0.16,1,0.3,1); font-family:var(--sans,"DM Sans",sans-serif); }',
    '.lang-toggle:hover { color:var(--text,#e4e8f2); border-color:var(--accent,#4d8eff); background:var(--accent-surface,rgba(77,142,255,0.08)); box-shadow:0 0 12px rgba(77,142,255,0.1); }',
    '.sidebar-search { padding:14px 14px 6px; }',
    '.search-input-wrap { display:flex; align-items:center; gap:8px; padding:9px 14px; background:var(--surface-1,#141820); border:1px solid var(--border-subtle,#1b2230); border-radius:8px; cursor:pointer; transition:all 0.3s cubic-bezier(0.16,1,0.3,1); }',
    '.search-input-wrap:hover { border-color:var(--border-hover,#3a4458); background:var(--surface-2,#1a1f2a); box-shadow:0 0 12px rgba(77,142,255,0.06); }',
    '.search-icon { display:flex; align-items:center; color:var(--text-dim,#5a6580); opacity:0.6; }',
    '.search-placeholder { font-size:12px; color:var(--text-dim,#5a6580); flex:1; }',
    '.search-kbd { font-family:"JetBrains Mono",monospace; font-size:10px; padding:2px 7px; border-radius:4px; background:var(--surface-3,#222834); color:var(--text-dim,#5a6580); border:1px solid var(--border,#252d3a); }',
    '.search-overlay { display:none; position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.65); z-index:100; backdrop-filter:blur(8px); justify-content:center; padding-top:min(20vh,160px); }',
    '.search-overlay.open { display:flex; }',
    '.search-modal { width:600px; max-height:70vh; background:var(--surface-0,#0f1219); border:1px solid var(--border-hover,#3a4458); border-radius:16px; box-shadow:0 24px 80px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.03); overflow:hidden; display:flex; flex-direction:column; }',
    '.search-modal-input { padding:18px 22px; border-bottom:1px solid var(--border-subtle,#1b2230); display:flex; align-items:center; gap:12px; }',
    '.search-modal-input input { flex:1; background:transparent; border:none; outline:none; color:var(--text,#e4e8f2); font-size:16px; font-family:"DM Sans",sans-serif; }',
    '.search-modal-input input::placeholder { color:var(--text-dim,#5a6580); }',
    '.search-results { overflow-y:auto; flex:1; padding:8px; }',
    '.sr-section { padding:6px 14px; font-size:10px; font-weight:700; color:var(--text-dim,#5a6580); text-transform:uppercase; letter-spacing:1.2px; }',
    '.sr-item { display:flex; align-items:center; gap:10px; padding:10px 14px; border-radius:10px; cursor:pointer; transition:all 0.15s; text-decoration:none; }',
    '.sr-item:hover { background:var(--surface-2,#1a1f2a); }',
    '.sr-item .sr-icon { width:30px; height:30px; border-radius:8px; display:flex; align-items:center; justify-content:center; font-size:13px; flex-shrink:0; }',
    '.sr-item .sr-icon.decision { background:rgba(77,142,255,0.1); color:var(--accent,#4d8eff); }',
    '.sr-item .sr-icon.entity { background:rgba(52,210,123,0.1); color:var(--green,#34d27b); }',
    '.sr-item .sr-icon.keyword { background:rgba(232,185,49,0.1); color:var(--yellow,#e8b931); }',
    '.sr-item .sr-body { flex:1; min-width:0; }',
    '.sr-item .sr-title { font-size:13px; font-weight:500; color:var(--text,#e4e8f2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
    '.sr-item .sr-sub { font-size:11px; color:var(--text-dim,#5a6580); margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }',
    '.sr-item .sr-badge { font-size:10px; font-family:"JetBrains Mono",monospace; padding:2px 8px; border-radius:100px; background:var(--surface-3,#222834); color:var(--text-dim,#5a6580); flex-shrink:0; }',
    '.search-no-results { text-align:center; padding:30px; color:var(--text-dim,#5a6580); font-size:13px; }',
    '.nav-icon { width:20px; height:16px; display:flex; align-items:center; justify-content:center; flex-shrink:0; }',
    '.nav-icon svg { width:16px; height:16px; }',
    '.nav-item.active .nav-icon { color:var(--accent,#4d8eff); }',
  ].join('\n')
  document.head.appendChild(style)
}

var searchDebounce = null, searchOverlay = null
var SEARCH_ICON_LG = '<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/></svg>'
function ensureSearchOverlay() {
  if (document.getElementById('searchOverlay')) { searchOverlay = document.getElementById('searchOverlay'); return }
  var div = document.createElement('div'); div.id = 'searchOverlay'; div.className = 'search-overlay'
  div.innerHTML = '<div class="search-modal"><div class="search-modal-input"><span style="display:flex;align-items:center;color:var(--text-dim)">' + SEARCH_ICON_LG + '</span><input type="text" id="globalSearchInput" placeholder="' + t('search.inputPlaceholder') + '" autocomplete="off" spellcheck="false"><span style="font-size:11px;color:var(--text-dim)">ESC</span></div><div class="search-results" id="searchResults"></div></div>'
  document.body.appendChild(div); searchOverlay = div
  div.addEventListener('click', function(e) { if (e.target === div) closeSearch() })
  var input = document.getElementById('globalSearchInput')
  input.addEventListener('input', function() { clearTimeout(searchDebounce); searchDebounce = setTimeout(function() { doSearch(input.value) }, 250) })
  input.addEventListener('keydown', function(e) { if (e.key === 'Escape') closeSearch() })
}
function openSearch() { ensureSearchOverlay(); searchOverlay.classList.add('open'); var input = document.getElementById('globalSearchInput'); input.value = ''; input.focus(); document.getElementById('searchResults').innerHTML = '' }
function closeSearch() { if (searchOverlay) searchOverlay.classList.remove('open') }
window.closeGlobalSearch = closeSearch
function esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
var SR_ICONS = {
  decision: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 4h12M2 8h8M2 12h10"/></svg>',
  entity: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 6h4M6 10h4"/></svg>',
  keyword: '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 8h3l2-6v12M9 8h3l2-6v12"/></svg>',
}
async function doSearch(query) {
  query = query.trim(); var results = document.getElementById('searchResults')
  if (!query || query.length < 2) { results.innerHTML = ''; return }
  try {
    var res = await fetch('/api/search?q=' + encodeURIComponent(query)); var data = await res.json()
    if (data.error) { results.innerHTML = '<div class="search-no-results">' + esc(data.error) + '</div>'; return }
    var html = '', decisions = data.decisions||[], entities = data.entities||[], keywords = data.keywords||[]
    if (!decisions.length && !entities.length && !keywords.length) { results.innerHTML = '<div class="search-no-results">' + t('search.noResults') + ' "' + esc(query) + '"</div>'; return }
    if (decisions.length) { html += '<div class="sr-section">Decisions (' + decisions.length + ')</div>'; html += decisions.map(function(d) { return '<a class="sr-item" href="/decisions?q='+encodeURIComponent(query)+'" onclick="closeGlobalSearch()"><div class="sr-icon decision">'+SR_ICONS.decision+'</div><div class="sr-body"><div class="sr-title">'+esc(d.summary)+'</div><div class="sr-sub">'+((d.anchors||[]).join(', ')||(d.scope||[]).join(', ')||d.source||'')+'</div></div><span class="sr-badge">'+d.ftype+'</span></a>' }).join('') }
    if (entities.length) { html += '<div class="sr-section">Code Entities (' + entities.length + ')</div>'; html += entities.map(function(e) { return '<a class="sr-item" href="/coverage/'+encodeURIComponent(e.repo||'')+'" onclick="closeGlobalSearch()"><div class="sr-icon entity">'+SR_ICONS.entity+'</div><div class="sr-body"><div class="sr-title">'+esc(e.name)+'</div><div class="sr-sub">'+esc(e.repo)+' \u00b7 '+esc(e.path||'')+'</div></div><span class="sr-badge">'+e.type+'</span></a>' }).join('') }
    if (keywords.length) { html += '<div class="sr-section">By Keyword (' + keywords.length + ')</div>'; html += keywords.slice(0,5).map(function(k) { return '<a class="sr-item" href="/decisions?q='+encodeURIComponent((k.keywords||[])[0]||query)+'" onclick="closeGlobalSearch()"><div class="sr-icon keyword">'+SR_ICONS.keyword+'</div><div class="sr-body"><div class="sr-title">'+esc(k.summary)+'</div><div class="sr-sub">'+((k.keywords||[]).join(', '))+'</div></div><span class="sr-badge">'+k.ftype+'</span></a>' }).join('') }
    results.innerHTML = html
  } catch(err) { results.innerHTML = '<div class="search-no-results">' + t('search.error') + ': ' + esc(err.message) + '</div>' }
}
document.addEventListener('keydown', function(e) {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    var tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
    e.preventDefault(); openSearch()
  }
})
injectStyles(); renderSidebar(); translatePageHero()
