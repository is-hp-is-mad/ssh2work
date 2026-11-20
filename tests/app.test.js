import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeVpsApp } from '../src/app.js';
import { createProfile } from '../src/config.js';
import {
  aggregateTokenStats,
  computeTokenCostUsd,
  formatCostUsd,
  formatLocalDateTimeNow,
  formatTokenCount,
} from '../src/plugins.js';
import { buildSshArgs, buildSshSpawnEnv, sudoStdinData, wrapSudoCommand } from '../src/ssh.js';
import { ScreenBuffer } from '../src/tui/renderer.js';
import { parseInputEvents } from '../src/tui/terminal.js';
import { VirtualTerminal } from '../src/tui/vterm.js';

test('input modal supports cursor movement, delete, ctrl+u, and clear button', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-app-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    let submitted = '';
    app.openInputModal({
      title: '保存剪贴板私钥到当前目录',
      prompt: '文件名:',
      initialValue: 'vps_key.pem',
      onSubmit: (v) => {
        submitted = v;
      },
    });

    // Move left 4 chars (before '.pem'), delete 'key', insert 'prod'
    for (let i = 0; i < 4; i++) await app.handleModalKey({ name: 'left', char: '', ctrl: false });
    for (let i = 0; i < 3; i++) await app.handleModalKey({ name: 'backspace', char: '', ctrl: false });
    for (const ch of 'prod') await app.handleModalKey({ name: ch, char: ch, ctrl: false });
    assert.equal(app.modal.value, 'vps_prod.pem');

    // Delete forward with Delete key
    await app.handleModalKey({ name: 'home', char: '', ctrl: false });
    await app.handleModalKey({ name: 'delete', char: '', ctrl: false });
    assert.equal(app.modal.value, 'ps_prod.pem');

    // Clear via action button
    await app.dispatchAction('modalClearInput');
    assert.equal(app.modal.value, '');

    for (const ch of 'my.pem') await app.handleModalKey({ name: ch, char: ch, ctrl: false });
    await app.handleModalKey({ name: 'enter', char: '', ctrl: false });
    assert.equal(submitted, 'my.pem');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('profileForm scans project private keys and selects relative path from dropdown', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-drop-'));
  const origCwd = process.cwd();
  const sampleKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nabc123\n-----END OPENSSH PRIVATE KEY-----\n';
  try {
    fs.writeFileSync(path.join(tmpDir, 'vps_key.pem'), sampleKey, 'utf8');
    fs.mkdirSync(path.join(tmpDir, 'keys'));
    fs.writeFileSync(path.join(tmpDir, 'keys', 'staging.pem'), sampleKey, 'utf8');

    process.chdir(tmpDir);
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    app.openProfileForm(null);

    assert.deepEqual(app.modal.keyCandidates, ['vps_key.pem', 'keys/staging.pem']);
    assert.equal(app.modal.keyDropdownOpen, false);

    const idIdx = app.modal.fields.findIndex((f) => f.key === 'identityFile');
    await app.dispatchAction('modalFocusField', idIdx);
    assert.equal(app.modal.keyDropdownOpen, true);

    await app.dispatchAction('selectKeyCandidate', 1);
    assert.equal(app.modal.keyDropdownOpen, false);
    assert.equal(app.modal.fields[idIdx].value, 'keys/staging.pem');
  } finally {
    process.chdir(origCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('portrait tap opens quick commands and quickCmdForm saves custom command', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-quick-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    const srv = app.store.upsert({ name: 'Prod', host: '10.0.0.2', user: 'root' });

    // Simulate portrait terminal width (< 84 cols)
    app.term.getSize = () => ({ cols: 60, rows: 24 });
    assert.equal(app.isLandscape(), false);
    assert.equal(app.portraitView, 'servers');

    await app.dispatchAction('selectProfile', 0, { fromTap: true });
    assert.equal(app.portraitView, 'commands');

    app.openQuickCmdForm(srv, null);
    app.modal.fields[0].value = '系统监控';
    app.modal.fields[1].value = 'htop';
    app.modal.fields[2].value = '/var/log';
    await app.submitModal();

    const updated = app.store.getById(srv.id);
    assert.equal(updated.quickCommands.length, 1);
    assert.equal(updated.quickCommands[0].name, '系统监控');
    assert.equal(updated.quickCommands[0].command, 'htop');
    assert.equal(updated.quickCommands[0].dir, '/var/log');

    app.activeProfile = updated;
    app.currentDir = { path: '/home/ubuntu/demo-app', dirs: ['src'] };
    const fileItems = app.getFileListItems();
    assert.equal(fileItems[0].kind, 'shell');
    assert.equal(fileItems[1].kind, 'quickCmd');
    assert.equal(fileItems[1].quickCmd.command, 'htop');

    await app.dispatchAction('backToServers');
    assert.equal(app.portraitView, 'servers');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('click-to-position moves cursor in input modal and profileForm fields', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-cur-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    app.openInputModal({
      title: '文件名',
      prompt: '文件名:',
      initialValue: 'vps_key.pem',
      onSubmit: () => {},
    });

    await app.dispatchAction('modalInputClick', { textStartX: 10 }, { fromTap: true, x: 14 });
    assert.equal(app.modal.cursor, 4);

    app.openProfileForm(null);
    app.modal._inputStartX = 30;
    app.modal.fields[0].value = 'my-server';
    await app.dispatchAction('modalFocusField', 0, { fromTap: true, x: 32 });
    assert.equal(app.modal.fields[0].cursor, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('multi-server tabs preserve per-server state and support switching/closing', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-tabs-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    const s1 = app.store.upsert({ name: 'Alpha', host: '10.0.0.1', user: 'root' });
    const s2 = app.store.upsert({ name: 'Beta', host: '10.0.0.2', user: 'ubuntu' });

    const t1 = app.ensureServerTab(s1, { dirLoaded: true });
    t1.currentDir = { path: '/srv/alpha', dirs: ['a'] };
    t1.fileIdx = 1;
    const t2 = app.ensureServerTab(s2, { dirLoaded: true });
    t2.currentDir = { path: '/srv/beta', dirs: ['b'] };
    t2.fileIdx = 2;

    await app.activateServerTab(s1.id, { switchView: true });
    assert.equal(app.activeServerTabId, t1.id);
    assert.equal(app.activeProfile.id, s1.id);
    assert.equal(app.currentDir.path, '/srv/alpha');
    assert.equal(app.fileIdx, 1);

    await app.dispatchAction('switchServerTab', s2.id);
    assert.equal(app.activeServerTabId, t2.id);
    assert.equal(app.currentDir.path, '/srv/beta');
    assert.equal(app.fileIdx, 2);

    await app.dispatchAction('closeServerTab', s2.id);
    assert.equal(app.serverTabs.length, 1);
    assert.equal(app.activeServerTabId, t1.id);
    assert.equal(app.currentDir.path, '/srv/alpha');

    await app.dispatchAction('closeServerTab', s1.id);
    assert.equal(app.serverTabs.length, 0);
    assert.equal(app.activeProfile, null);
    assert.equal(app.tab, 'profiles');

    // Multiple tabs for the same server (e.g. one Claude, one Shell)
    const tabClaude = app.ensureServerTab(s1, { forceNew: true, title: 'claude' });
    const tabShell = app.ensureServerTab(s1, { forceNew: true, title: 'Shell' });
    assert.equal(app.serverTabs.length, 2);
    assert.notEqual(tabClaude.id, tabShell.id);
    await app.dispatchAction('switchServerTab', tabClaude.id);
    assert.equal(app.activeServerTabId, tabClaude.id);
    await app.dispatchAction('switchServerTab', tabShell.id);
    assert.equal(app.activeServerTabId, tabShell.id);
    await app.dispatchAction('closeServerTab', tabClaude.id);
    assert.equal(app.serverTabs.length, 1);
    assert.equal(app.activeServerTabId, tabShell.id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('VirtualTerminal handles ANSI cursor, CJK wide chars, scrolling, and alt screen', () => {
  const vt = new VirtualTerminal(20, 4);
  vt.write('hello\r\n中文');
  assert.equal(vt.grid[0][0].ch, 'h');
  assert.equal(vt.grid[1][0].ch, '中');
  assert.equal(vt.grid[1][1].cont, true);
  assert.equal(vt.grid[1][2].ch, '文');

  // Switch to alt screen and back
  vt.write('\x1b[?1049hALT');
  assert.equal(vt.grid[0][0].ch, 'A');
  vt.write('\x1b[?1049l');
  assert.equal(vt.grid[0][0].ch, 'h');
  assert.equal(vt.grid[1][0].ch, '中');

  // Scroll up when exceeding 4 rows
  vt.write('\r\nL3\r\nL4\r\nL5');
  assert.equal(vt.grid[0][0].ch, '中');
  assert.equal(vt.grid[3][0].ch, 'L');

  // DSR cursor position request & CSI > prefix should not leak text
  const replies = [];
  const oscOut = [];
  const vt2 = new VirtualTerminal(30, 5, {
    onResponse: (r) => replies.push(r),
    onOsc: (o) => oscOut.push(o),
  });
  vt2.write('\x1b[>4;2mhi\x1b[6n\x1b]52;c;aGVsbG8=\x07');
  assert.equal(vt2.grid[0][0].ch, 'h');
  assert.equal(vt2.grid[0][1].ch, 'i');
  assert.deepEqual(replies, ['\x1b[1;3R']);
  assert.deepEqual(oscOut, ['\x1b]52;c;aGVsbG8=\x07']);

  // Split escape sequence across chunks
  vt2.write('\r\n\x1b');
  vt2.write('[32mOK\x1b[0m');
  assert.equal(vt2.grid[1][0].ch, 'O');
  assert.equal(vt2.grid[1][0].style, '\x1b[32m');
  assert.equal(vt2.grid[1][1].ch, 'K');
});

test('PluginManager installs/toggles/uninstalls built-in & custom plugins and cycles themes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-plug-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    assert.equal(app.plugins.getEnabledTabs().length, 0);

    // Install claude-code, codex-cli, antigravity-cli, pi-cli, opencode-cli built-in plugins
    app.openPluginsModal();
    assert.equal(app.modal.catalog.length, 5);
    await app.dispatchAction('pluginToggleOrInstall'); // installs claude-code
    assert.equal(app.plugins.isEnabled('claude-code'), true);
    assert.deepEqual(
      app.plugins.getEnabledTabs().map((t) => t.id),
      ['sessions']
    );
    assert.equal(app.plugins.getPluginQuickCommands().length, 2);

    // Install codex-cli & antigravity-cli
    assert.equal(app.plugins.install('codex-cli').ok, true);
    assert.equal(app.plugins.install('antigravity-cli').ok, true);
    assert.deepEqual(
      app.plugins.getEnabledTabs().map((t) => t.id),
      ['sessions', 'codex', 'agy']
    );

    // Toggle off claude-code -> sessions tab disappears
    await app.dispatchAction('pluginToggleOrInstall');
    assert.equal(app.plugins.isEnabled('claude-code'), false);
    assert.deepEqual(
      app.plugins.getEnabledTabs().map((t) => t.id),
      ['codex', 'agy']
    );

    // Install custom plugin from local plugin.json
    const manifestPath = path.join(tmpDir, 'plugin.json');
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        id: 'docker-tools',
        name: 'Docker 助手',
        version: '0.1.0',
        quickCommands: [{ id: 'dc-ps', name: '容器列表', command: 'docker ps' }],
      }),
      'utf8'
    );
    const customRes = app.plugins.install(manifestPath);
    assert.equal(customRes.ok, true);
    assert.ok(app.plugins.getPluginQuickCommands().some((q) => q.command === 'docker ps'));

    // Theme cycling
    assert.equal(app.store.getSettings().theme, 'cyber');
    await app.dispatchAction('cycleTheme');
    assert.equal(app.store.getSettings().theme, 'emerald');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('aggregateTokenStats computes cache rate, time buckets, and local-timezone time range filtering', () => {
  const t1 = new Date(2026, 10, 20, 9, 10, 5);
  const t2 = new Date(2026, 10, 20, 10, 20, 30);
  const records = [
    {
      ts: t1.toISOString(),
      sessionId: 's1',
      sessionTitle: 'Fix bug',
      reqModel: 'opus',
      respModel: 'claude-opus-5-5',
      in: 100,
      out: 50,
      cr: 800,
      cc: 100,
    },
    {
      ts: t2.toISOString(),
      sessionId: 's1',
      sessionTitle: 'Fix bug',
      reqModel: 'claude-sonnet-4-5',
      respModel: 'claude-sonnet-4-5',
      in: 200,
      out: 100,
      cr: 800,
      cc: 0,
    },
  ];

  const stats = aggregateTokenStats(records);
  assert.equal(stats.summary.calls, 2);
  assert.equal(stats.summary.input, 300);
  assert.equal(stats.summary.output, 150);
  assert.equal(stats.summary.cacheRead, 1600);
  assert.equal(stats.summary.cacheCreate, 100);
  // cacheRate = 1600 / (300 + 1600 + 100) = 80%
  assert.equal(Math.round(stats.summary.cacheRate), 80);
  assert.equal(stats.items[0].reqModel, 'opus');
  assert.equal(stats.items[0].respModel, 'claude-opus-5-5');
  assert.equal(stats.byHour.length, 2);
  assert.equal(stats.byDay.length, 1);
  assert.equal(stats.byModel.length, 2);
  assert.equal(formatTokenCount(1500), '1.5k');

  // Filter down to the second in local timezone (should include only t2)
  const filtered = aggregateTokenStats(records, {
    startTime: '2026-11-20 10:00:00',
    endTime: '2026-11-20 10:20:30',
  });
  assert.equal(filtered.summary.calls, 1);
  assert.equal(filtered.items[0].respModel, 'claude-sonnet-4-5');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(formatLocalDateTimeNow()));
  assert.ok(stats.summary.costUsd > 0);
  assert.ok(filtered.summary.costUsd > 0);
});

test('computeTokenCostUsd and formatCostUsd calculate cc-switch compatible model pricing', () => {
  // claude-sonnet-4-5: input 3, output 15, cacheRead 0.3, cacheCreation 3.75 per 1M
  const sonnetCost = computeTokenCostUsd({
    input: 1_000_000,
    output: 100_000,
    cacheRead: 1_000_000,
    cacheCreate: 100_000,
    respModel: 'claude-sonnet-4-5',
  });
  assert.ok(Math.abs(sonnetCost - (3 + 1.5 + 0.3 + 0.375)) < 1e-9);
  assert.equal(formatCostUsd(0), '$0.00');
  assert.equal(formatCostUsd(0.0042), '$0.0042');
  assert.equal(formatCostUsd(5.176), '$5.18');
});

test('tokenStatsEditTime merged modal and tokenStatsPreset update time range filters', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-time-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    app.modal = {
      type: 'tokenStats',
      agentName: 'claude',
      rawRecords: [],
      stats: aggregateTokenStats([]),
      tab: 'summary',
      scroll: 0,
      startTime: '',
      endTime: '',
    };

    await app.dispatchAction('tokenStatsPreset', 'today');
    assert.ok(app.modal.startTime.endsWith(' 00:00:00'));

    await app.dispatchAction('tokenStatsPreset', '7d');
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(app.modal.startTime));
    assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(app.modal.endTime));

    await app.dispatchAction('tokenStatsPreset', 'all');
    assert.equal(app.modal.startTime, '');
    assert.equal(app.modal.endTime, '');

    await app.dispatchAction('tokenStatsEditTime');
    assert.equal(app.modal.type, 'profileForm');
    assert.equal(app.modal.isTimeRange, true);
    assert.equal(app.modal.fields.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('aggregateTokenStats filters <synthetic>, separates byModel and byRoute, and ScreenBuffer extracts UI text', () => {
  const stats = aggregateTokenStats([
    {
      ts: '2026-11-20T10:00:00Z',
      reqModel: 'opus',
      respModel: '<synthetic>',
      in: 0,
      out: 0,
      cr: 0,
      cc: 0,
    },
    {
      ts: '2026-11-20T10:01:00Z',
      reqModel: 'opus',
      respModel: 'claude-opus-5-5',
      in: 100,
      out: 200,
      cr: 500,
      cc: 0,
      ok: true,
      durationMs: 2000,
    },
    {
      ts: '2026-11-20T10:02:00Z',
      reqModel: 'claude-opus-5-5',
      respModel: 'claude-opus-5-5',
      in: 50,
      out: 0,
      cr: 0,
      cc: 0,
      ok: false,
    },
  ]);

  assert.equal(stats.summary.calls, 2);
  assert.equal(stats.byModel.length, 1);
  assert.equal(stats.byModel[0].model, 'claude-opus-5-5');
  assert.equal(stats.byModel[0].successRate, 50);
  assert.equal(Math.round(stats.byModel[0].tokPerSec), 100);
  assert.equal(stats.byRoute.length, 2);

  const scr = new ScreenBuffer(40, 5);
  scr.begin({ clear: false });
  scr.writeAt(2, 2, '💰 总成本: $18.78');
  scr.writeAt(2, 3, '模型: claude-opus-5-5');
  const extracted = scr.extractText(2, 2, 18, 3);
  assert.ok(extracted.includes('$18.78'));
  assert.ok(extracted.includes('模型:'));
});

test('privilegeMode supports root SSH target and sudo command elevation with or without password', () => {
  const rootProfile = createProfile({
    host: '1.2.3.4',
    user: 'ubuntu',
    privilegeMode: 'root',
  });
  const rootArgs = buildSshArgs(rootProfile);
  assert.equal(rootArgs[rootArgs.length - 1], 'root@1.2.3.4');
  assert.equal(wrapSudoCommand('ls /root', rootProfile, { elevate: true }), 'ls /root');

  const nopassProfile = createProfile({
    host: '1.2.3.4',
    user: 'ubuntu',
    privilegeMode: 'sudo',
  });
  const nopassCmd = wrapSudoCommand('ls /root', nopassProfile);
  assert.ok(nopassCmd.startsWith('sudo -n sh -c '));

  const pwProfile = createProfile({
    host: '1.2.3.4',
    user: 'ubuntu',
    privilegeMode: 'none',
    sudoPassword: 'secret!',
  });
  const pwCmd = wrapSudoCommand('ls /root', pwProfile, { elevate: true });
  assert.ok(pwCmd.includes('sudo -S -p'));
  // The password must never be part of the command line (visible via ps / /proc).
  assert.ok(!pwCmd.includes('secret!'));
  assert.ok(pwCmd.includes('exec </dev/null'));
  assert.equal(sudoStdinData(pwProfile, { elevate: true }), 'secret!\n');
  assert.equal(sudoStdinData(pwProfile), null);
  assert.equal(sudoStdinData(nopassProfile), null);
});

test('per-server disabledPlugins skips disabled servers in Claude Code tab and quick commands', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-vps-pdis-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    const s1 = app.store.upsert({ name: 'NoClaude', host: '1.1.1.1', disabledPlugins: ['claude-code'] });
    const s2 = app.store.upsert({ name: 'HasClaude', host: '2.2.2.2' });
    app.plugins.install('claude-code');

    const tabs = app.plugins.getEnabledTabs();
    assert.equal(tabs.find((t) => t.id === 'sessions')?.label, 'Claude Code');

    assert.equal(app.plugins.getPluginQuickCommands(s1).some((q) => q.pluginId === 'claude-code'), false);
    assert.equal(app.plugins.getPluginQuickCommands(s2).some((q) => q.pluginId === 'claude-code'), true);

    app.activeProfile = s1;
    app.loadSessions = async () => {};
    await app.dispatchAction('switchTab', 'sessions');
    assert.equal(app.activeProfile.id, s2.id);
    assert.equal(app.tab, 'sessions');

    // Pi & OpenCode plugins and agent tab mapping
    app.plugins.install('pi-cli');
    app.plugins.install('opencode-cli');
    const allTabs = app.plugins.getEnabledTabs();
    assert.ok(allTabs.some((t) => t.id === 'pi' && t.label === 'Pi'));
    assert.ok(allTabs.some((t) => t.id === 'opencode' && t.label === 'OpenCode'));
    assert.equal(app.isAgentTab('pi'), true);
    assert.equal(app.isAgentTab('opencode'), true);
    assert.equal(app.getAgentTypeForTab('pi'), 'pi');
    assert.equal(app.getAgentTypeForTab('opencode'), 'opencode');

    // Top-of-list loading banner in renderSessions
    app.tab = 'sessions';
    app.sessions = [];
    app.loadingText = '正在扫描 Claude 会话...';
    const scr = new ScreenBuffer(100, 20);
    scr.begin({ clear: false });
    app.renderSessions(scr, 5, 12, 100);
    const renderedTop = scr.extractText(1, 5, 100, 8);
    assert.ok(renderedTop.includes('正在扫描 Claude 会话'));
    assert.ok(!renderedTop.includes('未找到匹配'));

    // Verify 2-row sub-tab + sub-menu layout and draggable scrollbar
    app.loadingText = '';
    app.agentSubTab = 'sessions';
    app.sessions = Array.from({ length: 12 }, (_, idx) => ({
      sessionId: `sid-${idx}`,
      title: `Session ${idx}`,
      cwd: '/tmp',
      updatedAt: Date.now(),
    }));
    const scr2 = new ScreenBuffer(100, 20);
    scr2.begin({ clear: false });
    app.renderSessions(scr2, 5, 10, 100);
    const tabBarText = scr2.extractText(1, 5, 100, 6);
    assert.ok(tabBarText.includes('会话'));
    assert.ok(tabBarText.includes('Memory'));
    assert.ok(tabBarText.includes('Token统计'));
    const sbHit = scr2.hitTest(100, 8);
    assert.equal(sbHit?.action, 'scrollbarDrag');
    app._sbDrag = sbHit.payload;
    app.applyScrollbarDrag(14);
    assert.ok(app.sessionScroll > 0);
    app._sbDrag = null;

    // Dedicated pluginServerConfig modal & ScreenBuffer modal button clipping
    app.openPluginsModal();
    app.modal.idx = 0; // claude-code
    await app.dispatchAction('openPluginServers');
    assert.equal(app.modal.type, 'pluginServerConfig');
    app.modal.idx = 1; // s2 (HasClaude)
    await app.dispatchAction('pluginServerToggle');
    assert.equal(app.plugins.isDisabledForProfile('claude-code', app.store.getById(s2.id)), true);
    await app.dispatchAction('pluginServersEnableAll');
    assert.equal(app.plugins.isDisabledForProfile('claude-code', app.store.getById(s1.id)), false);
    assert.equal(app.plugins.isDisabledForProfile('claude-code', app.store.getById(s2.id)), false);

    // Verify drawButton respects clipMaxX so buttons never spill outside modal box
    const clipScr = new ScreenBuffer(80, 10);
    clipScr.begin({ clear: false });
    clipScr.setClipMaxX(20);
    const x1 = clipScr.drawButton(1, 2, '按钮A', 'a');
    const x2 = clipScr.drawButton(x1, 2, '一个超长溢出按钮名称', 'b');
    assert.ok(x1 > 1);
    assert.equal(x2, x1);

    // Verify memoryPreview and skillPreview render Markdown without throwing
    app.modal = {
      type: 'claudeMemory',
      items: [{ project: '/home/ubuntu/demo-app', name: 'MEMORY.md', path: '/tmp/MEMORY.md', content: '# Title\n- item' }],
      idx: 0,
      scroll: 0,
    };
    await app.dispatchAction('memoryPreview');
    assert.equal(app.modal.type, 'preview');
    assert.ok(app.modal.lines.length >= 2);

    // Verify SSH password login uses SSH_ASKPASS instead of BatchMode=yes
    const pwSrv = createProfile({ host: '9.9.9.9', user: 'root', password: 'p@ss&word!' });
    const pwArgs = buildSshArgs(pwSrv, { batch: true });
    assert.equal(pwArgs.includes('BatchMode=yes'), false);
    assert.ok(pwArgs.includes('NumberOfPasswordPrompts=1'));
    const spawnEnv = buildSshSpawnEnv(pwSrv);
    assert.equal(spawnEnv.SSH_ASKPASS_REQUIRE, 'force');
    assert.equal(spawnEnv.CLAUDE_VPS_SSH_PW, 'p@ss&word!');
    assert.ok(fs.existsSync(spawnEnv.SSH_ASKPASS));

    // Verify VirtualTerminal preserves scrollback on scroll and shrink resize
    const vt = new VirtualTerminal(30, 5);
    vt.write('line1\r\nline2\r\nline3\r\nline4\r\nline5\r\nline6\r\n');
    assert.ok(vt.scrollback.length >= 2);
    vt.resize(30, 4);
    vt.scrollBy(-2);
    assert.equal(vt.scrollOffset, 2);
    const vtScr = new ScreenBuffer(30, 8);
    vtScr.begin({ clear: false });
    vt.renderTo(vtScr, 1, 30, 4);
    const histText = vtScr.extractText(1, 1, 30, 4);
    assert.ok(histText.includes('line1') || histText.includes('line2'));
    vt.resetScroll();
    assert.equal(vt.scrollOffset, 0);

    // Verify scrollbar hover thickening, SGR move parsing, profile reordering, and auto-connect on tab switch
    const moveEvs = parseInputEvents('\x1b[<35;80;5M');
    assert.equal(moveEvs[0]?.action, 'move');
    const sbScr = new ScreenBuffer(20, 6);
    sbScr.begin({ clear: false });
    sbScr.drawScrollbar(20, 1, 5, 0, 20, 5, 'scrollbarDrag', { hovered: true });
    assert.equal(sbScr.extractText(20, 1, 20, 1), '█');

    const moved = app.store.moveProfile(0, 1);
    assert.equal(moved, 1);
    assert.equal(app.store.list()[1].id, s1.id);

    app.activeProfile = null;
    app.profileIdx = 0;
    let connectedId = '';
    app.connectProfile = async (p) => {
      connectedId = p.id;
    };
    await app.dispatchAction('switchTab', 'files');
    assert.equal(connectedId, app.store.list()[0].id);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('long-press w on server tab charges progress bar and closes tab at threshold', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-charge-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    const s1 = app.store.upsert({ name: 'ChargeTest', host: '10.0.0.99', user: 'root' });
    const tab = app.ensureServerTab(s1, { dirLoaded: true });
    app.activeProfile = s1;
    app.activeServerTabId = tab.id;
    app.tab = 'files';

    // Build a fake _lastScreen with the server tab button on row 2
    const scr = new ScreenBuffer(100, 24);
    scr.begin({ clear: false });
    scr.drawButton(1, 1, '1.服务器', 'switchTab', 'profiles');
    scr.drawButton(12, 1, '2.目录', 'switchTab', 'files');
    // Server tab on row 2
    scr.drawButton(1, 2, '● ChargeTest', 'switchServerTab', tab.id, { active: true });
    app._lastScreen = scr;

    // Switch to top focus zone
    app.uiFocusZone = 'top';
    // Find the switchServerTab button index
    const topBtns = app.getZoneButtons(scr, 'top');
    const tabBtnIdx = topBtns.findIndex((b) => b.action === 'switchServerTab');
    assert.ok(tabBtnIdx >= 0, 'should find server tab button in top zone');
    app.uiFocusBtnIdx = tabBtnIdx;

    // Press 'w' less than threshold (6) — should NOT close
    for (let i = 0; i < 4; i++) {
      await app.handleKey({ type: 'key', name: 'w', char: 'w', ctrl: false });
    }
    assert.equal(app.serverTabs.length, 1, 'tab should still be open after 4 presses');
    assert.equal(app.tabCloseCharge.count, 4, 'charge should be at 4');
    assert.equal(app.tabCloseCharge.tabId, tab.id, 'charge should target the correct tab');

    // Press 'w' 2 more times to reach threshold (6)
    await app.handleKey({ type: 'key', name: 'w', char: 'w', ctrl: false });
    await app.handleKey({ type: 'key', name: 'w', char: 'w', ctrl: false });
    assert.equal(app.serverTabs.length, 0, 'tab should be closed after 6 presses');
    assert.equal(app.tabCloseCharge.tabId, null, 'charge should be reset after close');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Shift+Tab cycles top -> sub -> bottom -> content in plugin tabs and shows close-tab hint on server tab', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-focus-zones-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    const s1 = app.store.upsert({ name: 'SrvA', host: '10.0.0.1', user: 'root' });
    const tab = app.ensureServerTab(s1, { dirLoaded: true });
    app.activeProfile = s1;
    app.activeServerTabId = tab.id;
    app.tab = 'sessions';
    app.agentSubTab = 'sessions';
    app.sessions = [
      { sessionId: 'aaaa1111', title: 'First session', cwd: '/app', updatedAt: Date.now() },
      { sessionId: 'bbbb2222', title: 'Second session', cwd: '/app', updatedAt: Date.now() - 1000 },
    ];
    app._running = true;
    app.term.getSize = () => ({ cols: 110, rows: 26 });
    const origWrite = process.stdout.write;
    process.stdout.write = () => true;
    try {
      app.render();

      // Verify 3 distinct button zones exist on Claude Code tab: top, sub, bottom
      assert.ok(app.getZoneButtons(app._lastScreen, 'top').length > 0);
      assert.ok(app.getZoneButtons(app._lastScreen, 'sub').length > 0);
      assert.ok(app.getZoneButtons(app._lastScreen, 'bottom').length > 0);

      // Cycle: content -> top -> sub -> bottom -> content
      assert.equal(app.uiFocusZone, 'content');
      await app.handleKey({ type: 'key', name: 'shift-tab', char: '', ctrl: false });
      assert.equal(app.uiFocusZone, 'top');

      // Move focus to the closeable server tab and verify status bar shows "长按 w 关闭标签"
      const topBtns = app.getZoneButtons(app._lastScreen, 'top');
      const tabBtnIdx = topBtns.findIndex((b) => b.action === 'switchServerTab');
      assert.ok(tabBtnIdx >= 0);
      app.uiFocusBtnIdx = tabBtnIdx;
      app.render();
      const statusRow = app._lastScreen.extractText(1, 26, 110, 26);
      assert.ok(statusRow.includes('长按 w 关闭标签'), `expected close-tab hint in status bar, got: ${statusRow}`);

      // Continue cycling: top -> sub -> bottom -> content
      await app.handleKey({ type: 'key', name: 'shift-tab', char: '', ctrl: false });
      assert.equal(app.uiFocusZone, 'sub');
      await app.handleKey({ type: 'key', name: 'shift-tab', char: '', ctrl: false });
      assert.equal(app.uiFocusZone, 'bottom');
      await app.handleKey({ type: 'key', name: 'shift-tab', char: '', ctrl: false });
      assert.equal(app.uiFocusZone, 'content');

      // In content zone, down arrow navigates the plugin's session list
      assert.equal(app.sessionIdx, 0);
      await app.handleKey({ type: 'key', name: 'down', char: '', ctrl: false });
      assert.equal(app.sessionIdx, 1);
    } finally {
      process.stdout.write = origWrite;
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('tokenStats modal supports full keyboard navigation (views, time presets, custom time, Esc return)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-token-kb-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    const rawRecords = [
      {
        ts: new Date().toISOString(),
        respModel: 'claude-sonnet-4-5',
        reqModel: 'claude-sonnet-4-5',
        in: 1000,
        out: 500,
        cr: 200,
        cc: 0,
        title: 's1',
      },
      {
        ts: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
        respModel: 'claude-opus-4-1',
        reqModel: 'claude-opus-4-1',
        in: 2000,
        out: 800,
        cr: 0,
        cc: 0,
        title: 's2',
      },
    ];
    app.modal = {
      type: 'tokenStats',
      title: '📊 Claude Code Token 统计',
      rawRecords,
      startTime: '',
      endTime: '',
      preset: 'all',
      stats: aggregateTokenStats(rawRecords),
      view: 'model',
      idx: 0,
      scroll: 0,
    };

    // Left/Right switches views
    await app.handleKey({ type: 'key', name: 'right', char: '', ctrl: false });
    assert.equal(app.modal.view, 'route');
    await app.handleKey({ type: 'key', name: 'left', char: '', ctrl: false });
    assert.equal(app.modal.view, 'model');

    // Down/Up/End/Home navigates table rows
    await app.handleKey({ type: 'key', name: 'down', char: '', ctrl: false });
    assert.equal(app.modal.idx, 1);
    await app.handleKey({ type: 'key', name: 'home', char: '', ctrl: false });
    assert.equal(app.modal.idx, 0);

    // Tab cycles time presets: all -> today -> 7d -> 30d -> all
    await app.handleKey({ type: 'key', name: 'tab', char: '', ctrl: false });
    assert.equal(app.modal.preset, 'today');
    assert.ok(app.modal.startTime.endsWith('00:00:00'));
    await app.handleKey({ type: 'key', name: 'tab', char: '', ctrl: false });
    assert.equal(app.modal.preset, '7d');

    // Direct shortcut 'a' resets to all
    await app.handleKey({ type: 'key', name: 'a', char: 'a', ctrl: false });
    assert.equal(app.modal.preset, 'all');
    assert.equal(app.modal.startTime, '');

    // 't' opens custom time range editor; Esc returns to tokenStats modal
    await app.handleKey({ type: 'key', name: 't', char: 't', ctrl: false });
    assert.equal(app.modal.type, 'profileForm');
    assert.equal(app.modal.isTimeRange, true);
    await app.handleKey({ type: 'key', name: 'escape', char: '', ctrl: false });
    assert.equal(app.modal.type, 'tokenStats');

    // 'q' closes tokenStats modal
    await app.handleKey({ type: 'key', name: 'q', char: 'q', ctrl: false });
    assert.equal(app.modal, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
