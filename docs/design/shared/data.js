/* global window, location */
// Shared mock data and helpers for the three Repowatch design mocks.
// The data is invented but shaped like a real developer PC: ~30 repositories
// and worktrees under a few roots, covering every state the dashboard shows.
(function () {
  'use strict';

  const R = 'C:\\Users\\Nuno\\Desktop\\Repositorios\\';
  const D = 'C:\\Users\\Nuno\\Documents\\';

  function repo(name, fields) {
    return Object.assign(
      {
        name,
        path: R + name,
        branch: 'main',
        upstream: 'origin/main',
        defaultBranch: 'main',
        staged: 0,
        unstaged: 0,
        untracked: 0,
        conflicts: 0,
        ahead: 0,
        behind: 0,
        noUpstream: false,
        noRemote: false,
        detached: false,
        unmerged: [],
        stashes: 0,
        worktrees: 0,
        lost: 0,
        error: null,
        last: { msg: 'Update dependencies', ago: '3 days ago' },
      },
      fields,
    );
  }

  const repos = [
    repo('forja', {
      staged: 2,
      unstaged: 3,
      untracked: 1,
      ahead: 2,
      unmerged: [
        { name: 'feat/core-controller', ahead: 14 },
        { name: 'fix/runner-timeout', ahead: 3 },
      ],
      stashes: 1,
      worktrees: 2,
      last: { msg: 'Freeze specialist methods per run', ago: '2 hours ago' },
    }),
    repo('forja', {
      path: R + 'forja.worktrees\\core-controller',
      branch: 'feat/core-controller',
      upstream: 'origin/feat/core-controller',
      unstaged: 5,
      untracked: 2,
      ahead: 4,
      worktreeOf: 'forja',
      last: { msg: 'Split planning and review phases', ago: '40 minutes ago' },
    }),
    repo('repowatch', {
      untracked: 18,
      unstaged: 1,
      noUpstream: true,
      upstream: null,
      last: { msg: 'Initial commit', ago: 'today' },
    }),
    repo('casa-automation', {
      detached: true,
      branch: null,
      upstream: null,
      lost: 3,
      last: { msg: 'Try zigbee2mqtt 2.0 bridge', ago: '5 days ago' },
    }),
    repo('scraper-imoveis', {
      conflicts: 2,
      unstaged: 1,
      branch: 'main',
      behind: 1,
      ahead: 1,
      last: { msg: 'Parse new listing layout', ago: 'yesterday' },
    }),
    repo('budget-app', {
      branch: 'feature/recurring',
      upstream: 'origin/feature/recurring',
      ahead: 6,
      unmerged: [{ name: 'feature/recurring', ahead: 6 }],
      last: { msg: 'Recurring expenses: monthly rule', ago: 'yesterday' },
    }),
    repo('playbook', { path: 'C:\\Users\\Nuno\\Desktop\\PLAYBOOK', staged: 4, last: { msg: 'Add handover scenario', ago: '6 hours ago' } }),
    repo('nuno-portfolio', { behind: 7, last: { msg: 'Case study: tram app', ago: '3 weeks ago' } }),
    repo('android-shopping-list', {
      branch: 'compose-migration',
      upstream: null,
      noUpstream: true,
      ahead: 0,
      unmerged: [{ name: 'compose-migration', ahead: 11 }],
      stashes: 2,
      last: { msg: 'Migrate list screen to Compose', ago: '2 weeks ago' },
    }),
    repo('thesis-latex', { path: D + 'thesis-latex', noRemote: true, upstream: null, unstaged: 2, last: { msg: 'Chapter 4 corrections', ago: '1 month ago' } }),
    repo('dotfiles', { unstaged: 1, ahead: 1, last: { msg: 'PowerShell profile: git aliases', ago: '4 days ago' } }),
    repo('invoice-parser', { stashes: 3, last: { msg: 'Handle PT-PT date formats', ago: '2 months ago' } }),
    repo('tauri-sandbox', { noRemote: true, upstream: null, untracked: 4, last: { msg: 'Tray icon experiment', ago: '3 weeks ago' } }),
    repo('pt-holidays-api', {
      unmerged: [
        { name: 'feat/municipal-holidays', ahead: 5 },
        { name: 'chore/node-24', ahead: 1 },
      ],
      last: { msg: 'Add 2027 holidays', ago: '1 week ago' },
    }),
    repo('ml-experiments', { error: 'Repository is locked: index.lock exists', last: { msg: 'Notebook cleanup', ago: '2 months ago' } }),
    repo('home-dashboard', { ahead: 3, last: { msg: 'Energy tile: daily totals', ago: '2 days ago' } }),
    repo('photo-sorter', { behind: 2, ahead: 0, lost: 1, last: { msg: 'EXIF date fallback', ago: '5 weeks ago' } }),
    repo('flutter-habit', { branch: 'master', defaultBranch: 'master', upstream: 'origin/master', last: { msg: 'Streak widget', ago: '4 months ago' } }),
    repo('advent-of-code-2025', { last: { msg: 'Day 25', ago: '10 months ago' } }),
    repo('blog', { last: { msg: 'Post: moving to Tauri', ago: '2 weeks ago' } }),
    repo('cv-site', { last: { msg: 'Update contacts', ago: '3 months ago' } }),
    repo('rust-cli-kit', { last: { msg: 'clap 5 migration', ago: '1 month ago' } }),
    repo('kotlin-playground', { path: D + 'kotlin-playground', branch: 'master', defaultBranch: 'master', upstream: 'origin/master', last: { msg: 'Coroutines notes', ago: '6 months ago' } }),
    repo('dotnet-worker', { last: { msg: 'Health check endpoint', ago: '1 month ago' } }),
    repo('infra-terraform', { last: { msg: 'Rotate storage keys', ago: '2 weeks ago' } }),
    repo('notes-sync', { last: { msg: 'Conflict-free merge of notes', ago: '1 week ago' } }),
    repo('landing-studio', { last: { msg: 'Pricing section', ago: '5 days ago' } }),
    repo('api-gateway-poc', { path: D + 'api-gateway-poc', last: { msg: 'Rate limit middleware', ago: '7 months ago' } }),
  ];

  // Attention model: the most severe category decides a repo's colour and sort order.
  const CATEGORIES = {
    risk: { rank: 0, label: 'At risk' },
    change: { rank: 1, label: 'Uncommitted' },
    sync: { rank: 2, label: 'Out of sync' },
    branch: { rank: 3, label: 'Loose ends' },
    clean: { rank: 4, label: 'Clean' },
  };

  function issues(r) {
    const list = [];
    if (r.error) list.push({ cat: 'risk', key: 'error', text: r.error });
    if (r.conflicts) list.push({ cat: 'risk', key: 'conflicts', n: r.conflicts, text: `${r.conflicts} conflicted` });
    if (r.detached) list.push({ cat: 'risk', key: 'detached', text: 'Detached HEAD' });
    if (r.lost) list.push({ cat: 'risk', key: 'lost', n: r.lost, text: `${r.lost} lost ${r.lost === 1 ? 'commit' : 'commits'}` });
    if (r.staged) list.push({ cat: 'change', key: 'staged', n: r.staged, text: `${r.staged} staged` });
    if (r.unstaged) list.push({ cat: 'change', key: 'unstaged', n: r.unstaged, text: `${r.unstaged} modified` });
    if (r.untracked) list.push({ cat: 'change', key: 'untracked', n: r.untracked, text: `${r.untracked} untracked` });
    if (r.ahead) list.push({ cat: 'sync', key: 'ahead', n: r.ahead, text: `${r.ahead} to push` });
    if (r.behind) list.push({ cat: 'sync', key: 'behind', n: r.behind, text: `${r.behind} to pull` });
    if (r.noRemote) list.push({ cat: 'sync', key: 'noRemote', text: 'No remote' });
    else if (r.noUpstream) list.push({ cat: 'sync', key: 'noUpstream', text: 'No upstream' });
    if (r.unmerged.length) list.push({ cat: 'branch', key: 'unmerged', n: r.unmerged.length, text: `${r.unmerged.length} unmerged ${r.unmerged.length === 1 ? 'branch' : 'branches'}` });
    if (r.stashes) list.push({ cat: 'branch', key: 'stashes', n: r.stashes, text: `${r.stashes} ${r.stashes === 1 ? 'stash' : 'stashes'}` });
    return list;
  }

  function category(r) {
    const list = issues(r);
    if (!list.length) return 'clean';
    return list.reduce((best, i) => (CATEGORIES[i.cat].rank < CATEGORIES[best].rank ? i.cat : best), 'clean');
  }

  function sorted() {
    return repos
      .map((r, i) => ({ r, i, c: category(r) }))
      .sort((a, b) => CATEGORIES[a.c].rank - CATEGORIES[b.c].rank || a.i - b.i)
      .map((x) => x.r);
  }

  // Detail data for the selected repository (forja, main).
  const detail = {
    files: [
      { path: 'src/controller/phases.mjs', status: 'M', staged: true, add: 24, del: 9 },
      { path: 'docs/CORE.md', status: 'M', staged: true, add: 6, del: 2 },
      { path: 'src/controller/review.mjs', status: 'M', staged: false, add: 41, del: 17 },
      { path: 'src/scheduler/queue.mjs', status: 'M', staged: false, add: 3, del: 3 },
      { path: 'bin/forja.mjs', status: 'M', staged: false, add: 1, del: 1 },
      { path: 'docs/CORE-SPECIALISTS.md', status: '?', staged: false, add: 88, del: 0 },
    ],
    diff: {
      file: 'src/controller/review.mjs',
      hunks: [
        {
          header: '@@ -42,12 +42,16 @@ export async function review(task, snapshot) {',
          lines: [
            [' ', 42, 42, '  const packet = await buildPacket(task, snapshot);'],
            [' ', 43, 43, '  const reviewer = pickReviewer(task.risks);'],
            ['-', 44, null, '  const result = await reviewer.run(packet);'],
            ['-', 45, null, '  return result.status === "approve";'],
            ['+', null, 44, '  const result = await reviewer.run(packet, {'],
            ['+', null, 45, '    timeoutMs: config.reviewTimeoutMs,'],
            ['+', null, 46, '    snapshot: snapshot.hash,'],
            ['+', null, 47, '  });'],
            ['+', null, 48, '  if (result.status === "reject") {'],
            ['+', null, 49, '    await recordFindings(task, result.findings);'],
            ['+', null, 50, '  }'],
            ['+', null, 51, '  return result.status === "approve";'],
            [' ', 46, 52, '}'],
          ],
        },
        {
          header: '@@ -88,7 +94,7 @@ function pickReviewer(risks) {',
          lines: [
            [' ', 88, 94, '  if (risks.includes("security")) {'],
            ['-', 89, null, '    return reviewers.security;'],
            ['+', null, 95, '    return reviewers.get("security");'],
            [' ', 90, 96, '  }'],
            [' ', 91, 97, '  return reviewers.default;'],
          ],
        },
      ],
    },
    branches: [
      { name: 'main', current: true, upstream: 'origin/main', ahead: 2, behind: 0, merged: true, ago: '2 hours ago' },
      { name: 'feat/core-controller', upstream: 'origin/feat/core-controller', ahead: 14, merged: false, worktree: true, ago: '40 minutes ago' },
      { name: 'fix/runner-timeout', upstream: null, ahead: 3, merged: false, ago: '3 days ago' },
      { name: 'docs/runbook', upstream: 'origin/docs/runbook', ahead: 0, merged: true, ago: '2 weeks ago' },
    ],
    stashes: [{ ref: 'stash@{0}', msg: 'WIP on main: scheduler retry backoff', ago: '4 days ago' }],
    lost: [
      { hash: '9f3c2ab', msg: 'Experimental parallel reviewers', ago: '6 days ago', source: 'deleted branch exp/parallel' },
      { hash: '41d7e09', msg: 'Revert queue priorities', ago: '12 days ago', source: 'reset on main' },
    ],
  };

  const ICONS = {
    search: '<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>',
    refresh: '<path d="M13 8a5 5 0 1 1-1.5-3.6"/><path d="M13 2.5v3h-3"/>',
    settings: '<circle cx="8" cy="8" r="2"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4"/>',
    branch: '<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 3-7 2-7 4"/>',
    stash: '<path d="M2.5 9.5h3l1 1.5h3l1-1.5h3"/><path d="M2.5 9.5 4 4h8l1.5 5.5V13h-11z"/>',
    worktree: '<path d="M2.5 4.5h4l1 1.5h6v6.5h-11z"/><path d="M8 8.5v2.5M6.5 9.75h3"/>',
    lost: '<path d="M3 8a5 5 0 1 0 1.5-3.6"/><path d="M3 2.5v3h3"/><path d="M8 5.5V8l1.8 1.2"/>',
    detached: '<path d="M6.5 9.5 9.5 6.5"/><path d="M7 4.5 8.5 3a2.5 2.5 0 0 1 3.5 3.5L10.5 8M9 11.5 7.5 13A2.5 2.5 0 0 1 4 9.5L5.5 8"/>',
    cloudOff: '<path d="M4.5 12.5h7a2.5 2.5 0 0 0 .4-5A4 4 0 0 0 4.6 6 3.3 3.3 0 0 0 4.5 12.5z"/><path d="m2 2 12 12"/>',
    alert: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
    check: '<path d="m3.5 8.5 3 3 6-7"/>',
    up: '<path d="M8 13V3M4 7l4-4 4 4"/>',
    down: '<path d="M8 3v10M4 9l4 4 4-4"/>',
    fetch: '<path d="M8 2.5v8M4.5 7 8 10.5 11.5 7"/><path d="M3 13.5h10"/>',
    folder: '<path d="M2 4.5h4l1.2 1.5H14v7H2z"/>',
    terminal: '<rect x="2" y="3" width="12" height="10" rx="1.5"/><path d="m4.5 6.5 2 1.5-2 1.5M8 10h3"/>',
    code: '<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5 14 8l-3.5 3.5"/>',
    chevron: '<path d="m6 4 4 4-4 4"/>',
    back: '<path d="M10 4 6 8l4 4"/>',
    plus: '<path d="M8 3v10M3 8h10"/>',
    minus: '<path d="M3 8h10"/>',
    command: '<path d="M5.5 5.5h5v5h-5z"/><path d="M5.5 5.5V4a1.5 1.5 0 1 0-1.5 1.5h1.5zM10.5 5.5V4A1.5 1.5 0 1 1 12 5.5h-1.5zM5.5 10.5V12A1.5 1.5 0 1 1 4 10.5h1.5zM10.5 10.5V12a1.5 1.5 0 1 0 1.5-1.5h-1.5z"/>',
    filter: '<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>',
    eye: '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/>',
    density: '<path d="M2.5 3.5h11M2.5 6.5h11M2.5 9.5h11M2.5 12.5h11"/>',
    commit: '<circle cx="8" cy="8" r="2.5"/><path d="M1.5 8h4M10.5 8h4"/>',
  };

  function icon(name, cls) {
    return `<svg class="icon${cls ? ' ' + cls : ''}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  const ISSUE_ICON = {
    error: 'alert',
    conflicts: 'alert',
    detached: 'detached',
    lost: 'lost',
    staged: 'plus',
    unstaged: 'commit',
    untracked: 'plus',
    ahead: 'up',
    behind: 'down',
    noRemote: 'cloudOff',
    noUpstream: 'cloudOff',
    unmerged: 'branch',
    stashes: 'stash',
  };

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function view() {
    return new URLSearchParams(location.search).get('view') === 'detail' ? 'detail' : 'dashboard';
  }

  function summary() {
    const counts = { risk: 0, change: 0, sync: 0, branch: 0, clean: 0 };
    repos.forEach((r) => counts[category(r)]++);
    return { total: repos.length, attention: repos.length - counts.clean, counts };
  }

  window.RW = { repos, detail, CATEGORIES, ISSUE_ICON, issues, category, sorted, icon, esc, view, summary };
})();
