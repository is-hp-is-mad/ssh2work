import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  buildClipboardEnvAndTrap,
  ClipboardImageSync,
  normalizePrivateKey,
  readClipboardText,
  resizeRemotePty,
  savePrivateKeyFile,
  scanPrivateKeys,
  writeClipboardText,
} from './clipboard.js';
import { ConfigStore, createProfile, DEFAULT_PLUGIN_REGISTRY_URL, readLocalSshConfig } from './config.js';
import {
  buildDockerExecCommand,
  buildDockerLogsFollowCommand,
  fetchDockerInspect,
  fetchDockerLogs,
  fetchDockerOverview,
  runDockerAction,
} from './docker.js';
import {
  buildClaudeLaunchCommand,
  buildQuickLaunchCommand,
  createRemoteDir,
  deleteAgentMcp,
  deleteAgentSkill,
  deleteClaudeMemory,
  fetchAgentMcp,
  fetchAgentPrompt,
  fetchAgentSessionPreview,
  fetchAgentSessions,
  fetchAgentSkills,
  fetchClaudeMemory,
  fetchClaudeTokenStats,
  fetchRemoteSessions,
  fetchSessionPreview,
  installAgentSkill,
  listRemoteDir,
  renameRemoteDir,
  saveAgentPrompt,
  saveClaudeMemory,
  upsertAgentMcp,
} from './remote.js';
import {
  checkSshEnvironment,
  createSudoPromptFilter,
  launchInteractiveSsh,
  quoteSh,
  spawnEmbeddedSsh,
  wrapSudoInteractiveCommand,
} from './ssh.js';
import {
  aggregateTokenStats,
  fetchRemotePluginRegistry,
  formatCostUsd,
  formatLocalDateTimeNow,
  formatTokenCount,
  PluginManager,
} from './plugins.js';
import { ANSI, ScreenBuffer } from './tui/renderer.js';
import { TerminalController } from './tui/terminal.js';
import { VirtualTerminal } from './tui/vterm.js';
import { checkForAppUpdate, getCurrentVersion, performAppUpgrade } from './updater.js';
import { displayWidth, formatShortTime, padEndWidth, truncateToWidth } from './utils/text.js';

function wrapTextToWidth(text, maxWidth) {
  const wLimit = Math.max(8, maxWidth);
  const out = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    if (!rawLine) {
      out.push('');
      continue;
    }
    let line = '';
    let w = 0;
    for (const ch of rawLine) {
      const cw = displayWidth(ch);
      if (w + cw > wLimit && line) {
        out.push(line);
        line = ch;
        w = cw;
      } else {
        line += ch;
        w += cw;
      }
    }
    if (line) out.push(line);
  }
  return out.length ? out : [''];
}

function renderMarkdownLines(text, maxWidth, baseStyle = '') {
  const out = [];
  let inCode = false;
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (trimmed.startsWith('```')) {
      inCode = !inCode;
      for (const wl of wrapTextToWidth(rawLine, maxWidth)) {
        out.push({ text: wl, style: ANSI.fg.gray });
      }
      continue;
    }
    if (inCode) {
      for (const wl of wrapTextToWidth(`  ${rawLine}`, maxWidth)) {
        out.push({ text: wl, style: ANSI.fg.brightGreen });
      }
      continue;
    }
    let lineStyle = baseStyle;
    let displayLine = rawLine;
    if (/^#{1,3}\s+/.test(trimmed)) {
      lineStyle = `${ANSI.fg.brightYellow}${ANSI.bold}`;
      displayLine = trimmed.replace(/^#+\s+/, '▌ ');
    } else if (/^>\s?/.test(trimmed)) {
      lineStyle = ANSI.fg.brightCyan;
      displayLine = `│ ${trimmed.replace(/^>\s?/, '')}`;
    } else if (/^[-*]\s+/.test(trimmed)) {
      displayLine = rawLine.replace(/^(\s*)[-*]\s+/, '$1• ');
    }
    // Strip inline **bold** and `code` markers cleanly for readable terminal rendering
    displayLine = displayLine.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/`([^`]+)`/g, '[$1]');
    for (const wl of wrapTextToWidth(displayLine, maxWidth)) {
      out.push({ text: wl, style: lineStyle });
    }
  }
  return out.length ? out : [{ text: '', style: baseStyle }];
}

function findCursorIndexForX(text, relX, sliceStart = 0) {
  const s = String(text || '');
  if (relX <= 0) return sliceStart;
  let w = 0;
  let i = sliceStart;
  for (const ch of s.slice(sliceStart)) {
    const cw = displayWidth(ch);
    if (w + cw / 2 >= relX) return i;
    w += cw;
    i += ch.length;
  }
  return s.length;
}

function sliceInputWindow(text, cursor, maxWidth) {
  const s = String(text || '');
  const cur = Math.max(0, Math.min(s.length, cursor));
  if (displayWidth(s) <= maxWidth) {
    return {
      visible: s,
      sliceStart: 0,
      cursorOffsetCols: displayWidth(s.slice(0, cur)),
    };
  }
  const before = s.slice(0, cur);
  const chars = [...before];
  let w = 0;
  let startIdx = before.length;
  const keepCols = Math.max(2, maxWidth - 2);
  for (let k = chars.length - 1; k >= 0; k--) {
    const cw = displayWidth(chars[k]);
    if (w + cw > keepCols) break;
    w += cw;
    startIdx -= chars[k].length;
  }
  const visible = startIdx > 0 ? `…${s.slice(startIdx)}` : s.slice(startIdx);
  const prefixCols = startIdx > 0 ? 1 : 0;
  return {
    visible: truncateToWidth(visible, maxWidth),
    sliceStart: startIdx,
    cursorOffsetCols: prefixCols + displayWidth(s.slice(startIdx, cur)),
  };
}

function applyTextEditKey(target, ev) {
  const val = String(target.value || '');
  const cur = typeof target.cursor === 'number' ? Math.max(0, Math.min(val.length, target.cursor)) : val.length;
  if (ev.name === 'left') {
    target.cursor = Math.max(0, cur - 1);
    return true;
  }
  if (ev.name === 'right') {
    target.cursor = Math.min(val.length, cur + 1);
    return true;
  }
  if (ev.name === 'home' || (ev.ctrl && ev.name === 'a')) {
    target.cursor = 0;
    return true;
  }
  if (ev.name === 'end' || (ev.ctrl && ev.name === 'e')) {
    target.cursor = val.length;
    return true;
  }
  if (ev.ctrl && ev.name === 'u') {
    target.value = '';
    target.cursor = 0;
    return true;
  }
  if (ev.ctrl && ev.name === 'w') {
    const before = val.slice(0, cur).replace(/\s+$/, '');
    const cut = before.lastIndexOf(' ') + 1;
    target.value = val.slice(0, cut) + val.slice(cur);
    target.cursor = cut;
    return true;
  }
  if (ev.name === 'backspace') {
    if (cur > 0) {
      target.value = val.slice(0, cur - 1) + val.slice(cur);
      target.cursor = cur - 1;
    }
    return true;
  }
  if (ev.name === 'delete') {
    if (cur < val.length) {
      target.value = val.slice(0, cur) + val.slice(cur + 1);
      target.cursor = cur;
    }
    return true;
  }
  if (ev.char) {
    target.value = val.slice(0, cur) + ev.char + val.slice(cur);
    target.cursor = cur + ev.char.length;
    return true;
  }
  return false;
}

export class ClaudeVpsApp {
  constructor({ configPath } = {}) {
    this.store = new ConfigStore(configPath);
    this.term = new TerminalController();
    this.sshEnv = checkSshEnvironment();
    this.remotePluginCache = [];
    this.remotePluginSource = '';
    this.appUpdateInfo = null;
    this.dockerSubTab = 'containers'; // 'containers' | 'images' | 'compose' | 'networks' | 'volumes'
    this.dockerData = { containers: [], images: [], compose: [], networks: [], volumes: [], loadedForProfileId: null };
    this.dockerKeyword = '';
    this.dockerOnlyRunning = false;
    this.dockerIdx = 0;
    this.dockerScroll = 0;
    this.uiFocusZone = 'content'; // 'content' | 'top' | 'bottom'
    this.uiFocusBtnIdx = 0;
    this.tabCloseCharge = { tabId: null, count: 0, lastTime: 0, timer: null }; // long-press w to close

    this.tab = 'profiles'; // 'profiles' | 'files' | 'sessions'
    this.statusMsg = this.sshEnv.hasSsh ? this.sshEnv.agentMessage : this.sshEnv.agentMessage;
    this.statusIsError = !this.sshEnv.hasSsh;
    this.loadingText = '';
    this.lastTap = { key: '', time: 0 };

    // Profiles & Quick Commands view state
    this.profileIdx = 0;
    this.profileScroll = 0;
    this.profilePane = 'servers'; // 'servers' | 'commands'
    this.portraitView = 'servers'; // 'servers' | 'commands'
    this.quickCmdIdx = 0;
    this.quickCmdScroll = 0;

    // Active VPS & Multi-server tabs state
    this.serverTabs = [];
    this.activeServerTabId = null;
    this.activeProfile = null;
    this.dirCache = new Map();
    this.showHidden = false;
    this.dirElevate = false;
    this.currentDir = { path: '~', dirs: [] };
    this.fileIdx = 0;
    this.fileScroll = 0;

    // Sessions & Agent Sub-Tab view state
    this.sessions = [];
    this.sessionIdx = 0;
    this.sessionScroll = 0;
    this.sessionKeyword = '';
    this.sessionFilterCurrentDir = false;
    this.sessionsLoadedForProfileId = null;
    this.agentSubTab = 'sessions'; // 'sessions' | 'memory' | 'prompt' | 'skills' | 'mcp'
    this.agentSubIdx = 0;
    this.agentSubScroll = 0;
    this.agentPromptData = null;
    this.agentSkillsData = null;
    this.agentMcpData = null;
    this.claudeMemoryData = null;

    // Modal & Plugin state
    this.plugins = new PluginManager(this.store);
    this.modal = null;
    this.terminalMouseMode = true;
    this.lastSavedKeyPath = '';
    this._lastScreen = null;
    this._running = false;
  }

  start() {
    this.store.load();
    if (this.store.secretWarning) this.setStatus(this.store.secretWarning, true);
    this.showHidden = this.store.getSettings().showHiddenByDefault;
    const profiles = this.store.list();
    if (this.store.data.activeProfileId) {
      const idx = profiles.findIndex((p) => p.id === this.store.data.activeProfileId);
      if (idx >= 0) this.profileIdx = idx;
    }

    this._running = true;
    this.term.enter();

    this.term.on('quit', () => this.stop());
    this.term.on('resize', () => {
      const { cols, rows } = this.term.getSize();
      const termStartRow = this.serverTabs.length > 0 ? 4 : 3;
      const termRows = Math.max(4, rows - termStartRow);
      for (const t of this.serverTabs) {
        if (t.termSession?.vterm) {
          t.termSession.vterm.resize(cols, termRows);
        }
      }
      this._needsClear = true;
      clearTimeout(this._resizeRenderTimer);
      this._resizeRenderTimer = setTimeout(() => {
        this._resizeRenderTimer = null;
        this.render();
      }, 32);
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        const curTab = this.getActiveTab();
        if (curTab?.termSession && !curTab.termSession.exited && curTab.termSession.clipSync) {
          resizeRemotePty(
            curTab.profile,
            curTab.termSession.clipSync.token,
            cols,
            termRows,
            this.store.getSettings()
          ).catch(() => {});
        }
      }, 250);
    });
    this.term.on('key', (ev) => {
      Promise.resolve(this.handleKey(ev)).catch((err) => {
        this.setStatus(`操作异常: ${err?.message || err}`, true);
        this.render();
      });
    });
    this.term.on('mouseRaw', (ev) => this.handleTermMouseRaw(ev));
    this.term.on('wheel', (dir) => this.handleScroll(dir * 3));
    this.term.on('swipe', (dir) => this.handleScroll(dir));
    this.term.on('tap', (pos) => {
      Promise.resolve(this.handleTap(pos)).catch((err) => {
        this.setStatus(`操作异常: ${err?.message || err}`, true);
        this.render();
      });
    });

    this.render();
    this.checkAppUpdateInBackground().catch(() => {});
  }

  async checkAppUpdateInBackground({ fetchImpl } = {}) {
    const info = await checkForAppUpdate({ fetchImpl });
    if (!info.ok) return info;
    this.appUpdateInfo = info;
    if (info.hasUpdate && this._running) {
      this.setStatus(`发现 ssh4work 新版本 v${info.latestVersion} (当前 v${info.currentVersion})，可点击顶部 [⬆更新] 升级`);
      this.render();
    }
    return info;
  }

  async openAppUpdateModal({ force = false, fetchImpl } = {}) {
    // Show loading state immediately so user gets feedback
    this.modal = {
      type: 'appUpdate',
      title: '🔄 检查更新 (ssh4work)',
      info: this.appUpdateInfo || { ok: false, currentVersion: getCurrentVersion(), latestVersion: '', hasUpdate: false },
      scroll: 0,
      upgrading: false,
      upgradeDoneMsg: '',
      loading: true,
    };
    this.setStatus('正在检查 ssh4work 最新版本...');
    this.render();
    const info =
      !force && this.appUpdateInfo?.ok
        ? this.appUpdateInfo
        : await checkForAppUpdate({ fetchImpl });
    if (info.ok) this.appUpdateInfo = info;
    // Update modal with result (only if modal is still the appUpdate one)
    if (this.modal?.type === 'appUpdate') {
      this.modal.info = info;
      this.modal.loading = false;
    }
    if (info.ok) {
      this.setStatus(
        info.hasUpdate
          ? `发现新版本 v${info.latestVersion} (当前 v${info.currentVersion})`
          : `当前已是最新版本 v${info.currentVersion}`
      );
    } else {
      this.setStatus(`检查更新失败: ${info.error}`, true);
    }
    this.render();
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearTimeout(this._resizeTimer);
    clearTimeout(this._resizeRenderTimer);
    for (const t of this.serverTabs) {
      try {
        if (t.termSession?._renderTimer) clearTimeout(t.termSession._renderTimer);
        t.termSession?.clipSync?.stop();
        if (t.termSession?.proc && !t.termSession.exited) {
          t.termSession.proc.kill();
        }
      } catch {
        // Ignore cleanup errors
      }
    }
    this.term.leave();
    process.exit(0);
  }

  setStatus(msg, isError = false) {
    this.statusMsg = msg;
    this.statusIsError = isError;
  }

  // ==================== Navigation & Actions ====================

  findServerTab(idOrProfileId) {
    if (!idOrProfileId) return null;
    return (
      this.serverTabs.find((t) => t.id === idOrProfileId) ||
      this.serverTabs.find((t) => t.profileId === idOrProfileId) ||
      null
    );
  }

  getActiveTab() {
    return this.findServerTab(this.activeServerTabId);
  }

  ensureServerTab(profile, { dirLoaded = false, forceNew = false, title = '' } = {}) {
    if (!profile) return null;
    let tab = forceNew ? null : this.serverTabs.find((t) => t.id === this.activeServerTabId && t.profileId === profile.id);
    if (!tab && !forceNew) {
      tab = this.serverTabs.find((t) => t.profileId === profile.id);
    }
    if (!tab) {
      tab = {
        id: crypto.randomUUID(),
        profileId: profile.id,
        profile,
        title: title || '',
        dirCache: new Map(),
        currentDir: { path: profile.lastDir || profile.homeDir || '~', dirs: [] },
        dirLoaded,
        fileIdx: 0,
        fileScroll: 0,
        sessions: [],
        sessionIdx: 0,
        sessionScroll: 0,
        sessionKeyword: '',
        sessionFilterCurrentDir: false,
        sessionsLoadedForProfileId: null,
        termSession: null,
        lastViewTab: 'files',
      };
      this.serverTabs.push(tab);
    } else {
      tab.profile = profile;
      if (title) tab.title = title;
      if (dirLoaded) tab.dirLoaded = true;
    }
    return tab;
  }

  saveCurrentServerTabState() {
    if (!this.activeProfile) return;
    const tab = this.getActiveTab() || this.ensureServerTab(this.activeProfile);
    if (!tab) return;
    tab.dirCache = this.dirCache;
    tab.currentDir = this.currentDir;
    tab.fileIdx = this.fileIdx;
    tab.fileScroll = this.fileScroll;
    tab.sessions = this.sessions;
    tab.sessionIdx = this.sessionIdx;
    tab.sessionScroll = this.sessionScroll;
    tab.sessionKeyword = this.sessionKeyword;
    tab.sessionFilterCurrentDir = this.sessionFilterCurrentDir;
    tab.sessionsLoadedForProfileId = this.sessionsLoadedForProfileId;
    if (this.tab === 'files' || this.tab === 'sessions' || this.tab === 'terminal') {
      tab.lastViewTab = this.tab;
    }
  }

  async activateServerTab(tabIdOrProfileId, { switchView = true } = {}) {
    const tab = this.findServerTab(tabIdOrProfileId);
    if (!tab) return false;

    if (this.activeServerTabId && this.activeServerTabId !== tab.id) {
      this.saveCurrentServerTabState();
    }

    tab.profile = this.store.getById(tab.profileId) || tab.profile;
    this.activeServerTabId = tab.id;
    this.activeProfile = tab.profile;
    this.dirCache = tab.dirCache;
    this.currentDir = tab.currentDir;
    this.fileIdx = tab.fileIdx;
    this.fileScroll = tab.fileScroll;
    this.sessions = tab.sessions;
    this.sessionIdx = tab.sessionIdx;
    this.sessionScroll = tab.sessionScroll;
    this.sessionKeyword = tab.sessionKeyword;
    this.sessionFilterCurrentDir = tab.sessionFilterCurrentDir;
    this.sessionsLoadedForProfileId = tab.sessionsLoadedForProfileId;

    const profIdx = this.store.list().findIndex((p) => p.id === tab.profileId);
    if (profIdx >= 0 && this.profileIdx !== profIdx) {
      this.profileIdx = profIdx;
      this.quickCmdIdx = 0;
      this.quickCmdScroll = 0;
    }
    this.store.setActive(tab.profileId);

    if (switchView) {
      this.tab = tab.lastViewTab || 'files';
      if (this.tab === 'files' && !tab.dirLoaded) {
        await this.loadDirectory(tab.currentDir.path, { force: true });
        tab.dirLoaded = true;
        return true;
      }
      if (this.tab === 'sessions') {
        await this.loadSessions();
        return true;
      }
    }
    this.render();
    return true;
  }

  async closeServerTab(tabIdOrProfileId) {
    const target = this.findServerTab(tabIdOrProfileId);
    if (!target) return;
    const idx = this.serverTabs.indexOf(target);
    this.serverTabs.splice(idx, 1);
    try {
      target?.termSession?.clipSync?.stop();
      if (target?.termSession?.proc && !target.termSession.exited) {
        target.termSession.proc.kill();
      }
    } catch {
      // Ignore cleanup errors
    }

    if (this.activeServerTabId === target.id) {
      this.activeServerTabId = null;
      this.activeProfile = null;
      if (this.serverTabs.length > 0) {
        const nextTab = this.serverTabs[Math.max(0, idx - 1)];
        await this.activateServerTab(nextTab.id, { switchView: this.tab !== 'profiles' });
        return;
      }
      this.dirCache = new Map();
      this.currentDir = { path: '~', dirs: [] };
      this.sessions = [];
      this.tab = 'profiles';
    }
    this.render();
  }

  async connectProfile(profile) {
    if (!profile) return;
    if (!this.sshEnv.hasSsh) {
      this.setStatus('未找到 ssh 命令，无法连接', true);
      this.render();
      return;
    }

    const existingTab = this.serverTabs.find((t) => t.profileId === profile.id && t.dirLoaded);
    if (existingTab) {
      await this.activateServerTab(existingTab.id, { switchView: true });
      this.setStatus(`已切换到 ${profile.name}`);
      this.render();
      return;
    }

    this.saveCurrentServerTabState();
    const newTab = this.ensureServerTab(profile, { forceNew: true });
    this.activeProfile = profile;
    this.activeServerTabId = newTab.id;
    this.store.setActive(profile.id);
    this.dirCache = new Map();
    this.sessionsLoadedForProfileId = null;
    this.sessions = [];

    const startDir = profile.lastDir || profile.homeDir || '~';
    this.loadingText = `正在连接 ${profile.user ? `${profile.user}@` : ''}${profile.host} ...`;
    this.render();

    const settings = this.store.getSettings();
    const elevate = this.isDirElevate(profile);
    let res = await listRemoteDir(profile, startDir, this.showHidden, settings, { elevate });
    if (!res.ok && startDir !== (profile.homeDir || '~')) {
      res = await listRemoteDir(profile, profile.homeDir || '~', this.showHidden, settings, { elevate });
    }
    this.loadingText = '';

    if (!res.ok) {
      this.setStatus(`连接失败: ${res.error}`, true);
      this.render();
      return;
    }

    this.dirCache.set(`${this.showHidden}|${elevate ? 1 : 0}|${res.path}`, res);
    this.currentDir = res;
    this.fileIdx = 0;
    this.fileScroll = 0;
    this.tab = 'files';
    const tab = this.ensureServerTab(profile, { dirLoaded: true });
    if (tab) {
      tab.dirCache = this.dirCache;
      tab.currentDir = this.currentDir;
      tab.dirLoaded = true;
    }
    this.setStatus(`已连接到 ${profile.name}`);
    this.render();
  }

  isDirElevate(profile = this.activeProfile) {
    return Boolean(this.dirElevate || profile?.privilegeMode === 'sudo' || profile?.privilegeMode === 'root');
  }

  async loadDirectory(targetPath, { selectName = '', force = false } = {}) {
    if (!this.activeProfile) return false;
    const elevate = this.isDirElevate(this.activeProfile);
    const key = `${this.showHidden}|${elevate ? 1 : 0}|${targetPath}`;
    if (!force && this.dirCache.has(key)) {
      this.currentDir = this.dirCache.get(key);
    } else {
      this.loadingText = `正在读取 ${targetPath} ...`;
      this.render();
      const res = await listRemoteDir(
        this.activeProfile,
        targetPath,
        this.showHidden,
        this.store.getSettings(),
        { elevate }
      );
      this.loadingText = '';
      if (!res.ok) {
        this.setStatus(res.error || '无法进入目录', true);
        this.render();
        return false;
      }
      this.dirCache.set(`${this.showHidden}|${elevate ? 1 : 0}|${res.path}`, res);
      this.currentDir = res;
    }

    this.fileIdx = 0;
    this.fileScroll = 0;
    if (selectName) {
      const items = this.getFileListItems();
      const found = items.findIndex((it) => it.kind === 'dir' && it.name === selectName);
      if (found >= 0) this.fileIdx = found;
    }
    this.render();
    return true;
  }

  getFileListItems() {
    const items = [
      { kind: 'shell', label: '🔗 在此目录打开 SSH 终端', name: '' },
    ];

    for (const q of this.activeProfile?.quickCommands || []) {
      items.push({
        kind: 'quickCmd',
        label: `▶ 在此目录运行: ${q.name}`,
        name: q.name,
        quickCmd: q,
      });
    }

    if (this.activeProfile?.pinnedDirs?.length) {
      for (const p of this.activeProfile.pinnedDirs) {
        if (p !== this.currentDir.path) {
          items.push({ kind: 'pin', label: `★ 收藏: ${p}`, name: p });
        }
      }
    }

    if (this.currentDir.path !== '/') {
      items.push({ kind: 'up', label: '..  (返回上一级)', name: '' });
    }

    for (const d of this.currentDir.dirs) {
      items.push({ kind: 'dir', label: `📁 ${d}/`, name: d });
    }
    return items;
  }

  async launchClaudeInDir(dirPath, { mode = 'new', sessionId = '', fork = false } = {}) {
    if (!this.activeProfile) return;
    if (this._interactiveRunning) return;
    const profile = this.activeProfile;
    const settings = this.store.getSettings();
    this.store.updateLastDir(profile.id, dirPath);
    const clipSync = settings.enableImageClipboard
      ? new ClipboardImageSync(profile, settings)
      : null;

    const cmd = buildClaudeLaunchCommand(dirPath, {
      claudeCommand: profile.claudeCommand,
      mode,
      sessionId,
      fork,
      shell: settings.defaultShell,
      preCommand: profile.preCommand,
      clipboardToken: clipSync ? clipSync.token : '',
    });

    this._interactiveRunning = true;
    let result;
    try {
      result = await this.term.suspendForChildAsync(async () => {
        process.stdout.write(`\x1b[2J\x1b[H`);
        const label =
          mode === 'resume'
            ? `恢复会话 ${sessionId}`
            : mode === 'continue'
              ? '继续最近会话'
              : '启动 Claude';
        console.log(`[${profile.name}] ${label} @ ${dirPath}`);
        if (clipSync) {
          console.log('[图片剪贴板同步已开启: 本机复制图片后自动写入 VPS 内存 /dev/shm]');
        }
        console.log('');
        if (clipSync) clipSync.start();
        try {
          const r = await launchInteractiveSsh(profile, cmd, { settings });
          if (r.code !== 0) {
            console.log(`\nSSH 退出码: ${r.code}${r.error ? ` (${r.error})` : ''}`);
          }
          return r;
        } finally {
          if (clipSync) clipSync.stop();
        }
      });
    } finally {
      this._interactiveRunning = false;
    }

    this._needsClear = true;
    this.setStatus(
      result.code === 0 ? `Claude 已退出 (${dirPath})` : `SSH 退出码 ${result.code}`,
      result.code !== 0
    );
    this.render();
  }

  isAgentTab(tab = this.tab) {
    return ['sessions', 'codex', 'agy', 'pi', 'opencode'].includes(tab);
  }

  getDockerListItems() {
    let list = [];
    if (this.dockerSubTab === 'images') list = this.dockerData.images || [];
    else if (this.dockerSubTab === 'compose') list = this.dockerData.compose || [];
    else if (this.dockerSubTab === 'networks') list = this.dockerData.networks || [];
    else if (this.dockerSubTab === 'volumes') list = this.dockerData.volumes || [];
    else {
      list = this.dockerData.containers || [];
      if (this.dockerOnlyRunning) list = list.filter((c) => c.state === 'running');
    }
    const kw = this.dockerKeyword.trim().toLowerCase();
    if (!kw) return list;
    return list.filter((item) => JSON.stringify(item).toLowerCase().includes(kw));
  }

  async loadDocker({ force = false } = {}) {
    if (!this.activeProfile) {
      this.setStatus('请先连接一个服务器', true);
      this.render();
      return;
    }
    if (!force && this.dockerData.loadedForProfileId === this.activeProfile.id) {
      this.render();
      return;
    }
    this.loadingText = `正在读取 ${this.activeProfile.name} 的 Docker 状态...`;
    this.render();
    const res = await fetchDockerOverview(this.activeProfile, this.store.getSettings(), {
      elevate: this.isDirElevate(),
    });
    this.loadingText = '';
    if (!res.ok) {
      this.dockerData = { containers: [], images: [], compose: [], networks: [], volumes: [], loadedForProfileId: null };
      this.setStatus(res.error || '获取 Docker 状态失败', true);
      this.render();
      return;
    }
    this.dockerData = {
      containers: res.containers,
      images: res.images,
      compose: res.compose,
      networks: res.networks || [],
      volumes: res.volumes || [],
      loadedForProfileId: this.activeProfile.id,
    };
    const len = this.getDockerListItems().length;
    this.dockerIdx = Math.max(0, Math.min(len - 1, this.dockerIdx));
    this.setStatus(
      `Docker (${this.activeProfile.name}): ${res.containers.length} 容器 / ${res.images.length} 镜像 / ${res.compose.length} Compose`
    );
    this.render();
  }

  getAgentTypeForTab(tab = this.tab) {
    if (tab === 'codex') return 'codex';
    if (tab === 'agy') return 'agy';
    if (tab === 'pi') return 'pi';
    if (tab === 'opencode') return 'opencode';
    return 'claude';
  }

  async loadSessions({ keyword = this.sessionKeyword, force = false, agentType = this.getAgentTypeForTab() } = {}) {
    if (!this.activeProfile) {
      this.setStatus('请先连接一个服务器', true);
      this.render();
      return;
    }
    const projectFilter = agentType === 'claude' && this.sessionFilterCurrentDir ? this.currentDir.path : '';
    const cacheKey = `${agentType}:${this.activeProfile.id}`;
    if (!force && !keyword && this.sessionsLoadedForProfileId === cacheKey && !projectFilter) {
      this.render();
      return;
    }

    const agentLabel = agentType === 'codex' ? 'Codex' : agentType === 'agy' ? 'Antigravity' : 'Claude Code';
    this.loadingText = keyword
      ? `正在搜索 ${agentLabel} 会话 "${keyword}" ...`
      : `正在读取远程 ${agentLabel} 会话 ...`;
    this.render();

    const res = await fetchAgentSessions(agentType, this.activeProfile, {
      keyword,
      projectPath: projectFilter,
      settings: this.store.getSettings(),
    });
    this.loadingText = '';

    if (!res.ok) {
      this.setStatus(res.error || '读取会话失败', true);
      this.render();
      return;
    }

    this.sessions = res.sessions;
    this.sessionIdx = 0;
    this.sessionScroll = 0;
    if (!keyword && !projectFilter) {
      this.sessionsLoadedForProfileId = cacheKey;
    }
    this.setStatus(`找到 ${this.sessions.length} 个 ${agentLabel} 会话`);
    this.render();
  }

  async loadActiveAgentSubTab({ force = false } = {}) {
    const agentType = this.getAgentTypeForTab();
    if (this.agentSubTab === 'memory' && agentType === 'claude') {
      await this.loadClaudeMemoryInline({ force });
    } else if (this.agentSubTab === 'prompt') {
      await this.loadAgentPromptInline(agentType, { force });
    } else if (this.agentSubTab === 'skills') {
      await this.loadAgentSkillsInline(agentType, { force });
    } else if (this.agentSubTab === 'mcp') {
      await this.loadAgentMcpInline(agentType, { force });
    } else {
      await this.loadSessions({ agentType, force });
    }
  }

  async loadAgentPromptInline(agentType = this.getAgentTypeForTab(), { force = false } = {}) {
    if (!this.activeProfile) return;
    if (
      !force &&
      this.agentPromptData &&
      this.agentPromptData.profileId === this.activeProfile.id &&
      this.agentPromptData.agentType === agentType
    ) {
      this.render();
      return;
    }
    this.loadingText = `正在读取 ${agentType.toUpperCase()} 全局提示词...`;
    this.render();
    const res = await fetchAgentPrompt(agentType, this.activeProfile, this.store.getSettings());
    this.loadingText = '';
    if (!res.ok) {
      this.setStatus(res.error || '读取提示词失败', true);
      this.render();
      return;
    }
    const cols = Math.max(40, this.term.getSize().cols - 6);
    const lines = res.content
      ? renderMarkdownLines(res.content, cols, ANSI.fg.white)
      : [{ text: `(文件尚未创建: ${res.path})`, style: ANSI.fg.gray }];
    this.agentPromptData = {
      agentType,
      profileId: this.activeProfile.id,
      path: res.path,
      content: res.content || '',
      lines,
    };
    this.agentSubIdx = 0;
    this.agentSubScroll = 0;
    this.render();
  }

  async loadAgentSkillsInline(agentType = this.getAgentTypeForTab(), { force = false } = {}) {
    if (!this.activeProfile) return;
    if (
      !force &&
      this.agentSkillsData &&
      this.agentSkillsData.profileId === this.activeProfile.id &&
      this.agentSkillsData.agentType === agentType
    ) {
      this.render();
      return;
    }
    this.loadingText = `正在扫描 ${agentType.toUpperCase()} Skills...`;
    this.render();
    const res = await fetchAgentSkills(agentType, this.activeProfile, this.store.getSettings());
    this.loadingText = '';
    if (!res.ok) {
      this.setStatus(res.error || '读取 Skills 失败', true);
      this.render();
      return;
    }
    this.agentSkillsData = {
      agentType,
      profileId: this.activeProfile.id,
      root: res.root || '',
      skills: res.skills,
    };
    this.agentSubIdx = 0;
    this.agentSubScroll = 0;
    this.render();
  }

  async loadAgentMcpInline(agentType = this.getAgentTypeForTab(), { force = false } = {}) {
    if (!this.activeProfile) return;
    if (
      !force &&
      this.agentMcpData &&
      this.agentMcpData.profileId === this.activeProfile.id &&
      this.agentMcpData.agentType === agentType
    ) {
      this.render();
      return;
    }
    this.loadingText = `正在读取 ${agentType.toUpperCase()} MCP 配置...`;
    this.render();
    const res = await fetchAgentMcp(agentType, this.activeProfile, this.store.getSettings());
    this.loadingText = '';
    if (!res.ok) {
      this.setStatus(res.error || '读取 MCP 失败', true);
      this.render();
      return;
    }
    this.agentMcpData = {
      agentType,
      profileId: this.activeProfile.id,
      path: res.path || '',
      items: res.items,
    };
    this.agentSubIdx = 0;
    this.agentSubScroll = 0;
    this.render();
  }

  async loadClaudeMemoryInline({ force = false } = {}) {
    if (!this.activeProfile) return;
    if (!force && this.claudeMemoryData && this.claudeMemoryData.profileId === this.activeProfile.id) {
      this.render();
      return;
    }
    this.loadingText = '正在扫描 Claude 分项目 Memory...';
    this.render();
    const res = await fetchClaudeMemory(this.activeProfile, this.store.getSettings());
    this.loadingText = '';
    if (!res.ok) {
      this.setStatus(res.error || '读取 Memory 失败', true);
      this.render();
      return;
    }
    this.claudeMemoryData = {
      profileId: this.activeProfile.id,
      items: res.items,
    };
    this.agentSubIdx = 0;
    this.agentSubScroll = 0;
    this.render();
  }

  async openSessionPreview(session, agentType = this.getAgentTypeForTab()) {
    if (!session || !this.activeProfile) return;
    this.loadingText = '正在加载会话内容预览 ...';
    this.render();
    const res = await fetchAgentSessionPreview(agentType, this.activeProfile, session.filePath, this.store.getSettings());
    this.loadingText = '';
    if (!res.ok) {
      this.setStatus(res.error || '无法加载预览', true);
      this.render();
      return;
    }

    const botLabel = agentType === 'codex' ? '🤖 Codex' : agentType === 'agy' ? '🚀 AGY' : '🤖 Claude';
    const { cols } = this.term.getSize();
    const previewInnerW = Math.max(40, Math.min(cols - 4, Math.max(66, cols - 6)) - 4);
    const lines = [];
    const pushPlain = (txt, style = '') => {
      for (const wl of wrapTextToWidth(txt, previewInnerW)) lines.push({ text: wl, style });
    };
    pushPlain(`会话 ID: ${session.sessionId}`, ANSI.fg.brightCyan);
    pushPlain(`工作目录: ${res.cwd || session.cwd}`, ANSI.fg.brightCyan);
    if (res.summary || session.title) {
      pushPlain(`标题: ${res.summary || session.title}`, `${ANSI.fg.brightYellow}${ANSI.bold}`);
    }
    pushPlain('─'.repeat(Math.min(40, previewInnerW)), ANSI.fg.gray);
    for (const m of res.messages || []) {
      const isUser = m.role === 'user';
      const roleHeader = isUser ? '👤 用户:' : `${botLabel}:`;
      pushPlain(roleHeader, isUser ? `${ANSI.fg.brightGreen}${ANSI.bold}` : `${ANSI.fg.brightCyan}${ANSI.bold}`);
      lines.push(...renderMarkdownLines(m.text, previewInnerW));
      lines.push({ text: '', style: '' });
    }
    if ((res.messages || []).length === 0) {
      pushPlain('(暂无可预览的文本消息)', ANSI.fg.gray);
    }

    this.modal = {
      type: 'preview',
      title: '会话内容预览',
      agentType,
      session,
      lines,
      scroll: 0,
    };
    this.render();
  }

  async openTokenStatsModal({ sessionFilePath = '', startTime = '', endTime = '' } = {}) {
    if (!this.activeProfile) {
      this.setStatus('请先连接一个服务器', true);
      this.render();
      return;
    }
    this.loadingText = '正在统计 Claude Code Token 用量...';
    this.render();
    const res = await fetchClaudeTokenStats(this.activeProfile, {
      sessionFilePath,
      limit: 40,
      settings: this.store.getSettings(),
    });
    this.loadingText = '';
    if (!res.ok) {
      this.setStatus(res.error || 'Token 统计失败', true);
      this.render();
      return;
    }
    const stats = aggregateTokenStats(res.records, { startTime, endTime });
    this.modal = {
      type: 'tokenStats',
      title: sessionFilePath ? '📊 会话 Token 统计' : '📊 Claude Code Token 统计',
      sessionFilePath,
      configuredModel: res.configuredModel,
      rawRecords: res.records,
      startTime,
      endTime,
      preset: startTime || endTime ? 'custom' : 'all',
      stats,
      view: 'model', // 'model' | 'route' | 'hour' | 'day' | 'items'
      idx: 0,
      scroll: 0,
    };
    this.setStatus(
      `统计 ${stats.summary.calls} 次调用 · 缓存率 ${stats.summary.cacheRate.toFixed(1)}% (${stats.summary.tzLabel})`
    );
    this.render();
  }

  async resumeAgentSession(session, { fork = false, agentType = this.getAgentTypeForTab() } = {}) {
    if (!session || !this.activeProfile) return;
    if (agentType === 'codex') {
      await this.runQuickCommandItem(
        this.activeProfile,
        {
          kind: 'custom',
          name: `Codex:${session.sessionId.slice(0, 8)}`,
          command: `codex resume ${quoteSh(session.sessionId)}`,
        },
        { overrideDir: session.cwd && session.cwd !== '~' ? session.cwd : '' }
      );
      return;
    }
    if (agentType === 'agy') {
      await this.runQuickCommandItem(
        this.activeProfile,
        {
          kind: 'custom',
          name: `AGY:${session.sessionId.slice(0, 8)}`,
          command: `agy --conversation ${quoteSh(session.sessionId)}`,
        },
        { overrideDir: session.cwd && session.cwd !== '~' ? session.cwd : '' }
      );
      return;
    }
    if (agentType === 'pi') {
      await this.runQuickCommandItem(
        this.activeProfile,
        {
          kind: 'custom',
          name: `Pi:${session.sessionId.slice(0, 8)}`,
          command: `pi --session ${quoteSh(session.filePath || session.sessionId)}`,
        },
        { overrideDir: session.cwd && session.cwd !== '~' ? session.cwd : '' }
      );
      return;
    }
    if (agentType === 'opencode') {
      await this.runQuickCommandItem(
        this.activeProfile,
        {
          kind: 'custom',
          name: `OC:${session.sessionId.slice(0, 8)}`,
          command: `opencode --session ${quoteSh(session.sessionId)}`,
        },
        { overrideDir: session.cwd && session.cwd !== '~' ? session.cwd : '' }
      );
      return;
    }
    const claudeCmd = `${this.activeProfile.claudeCommand || 'claude'} --resume ${quoteSh(session.sessionId)}${fork ? ' --fork-session' : ''}`;
    await this.runQuickCommandItem(
      this.activeProfile,
      {
        kind: 'custom',
        name: `Claude:${session.sessionId.slice(0, 8)}`,
        command: claudeCmd,
      },
      { overrideDir: session.cwd && session.cwd !== '~' ? session.cwd : '' }
    );
  }

  // ==================== Modals ====================

  openInputModal({ title, prompt, initialValue = '', onSubmit }) {
    const val = String(initialValue ?? '');
    this.modal = {
      type: 'input',
      title,
      prompt,
      value: val,
      cursor: val.length,
      onSubmit,
    };
    this.render();
  }

  openConfirmModal({ title, message, onConfirm }) {
    this.modal = {
      type: 'confirm',
      title,
      message,
      onConfirm,
    };
    this.render();
  }

  isLandscape(cols = this.term.getSize().cols) {
    return cols >= 84;
  }

  getQuickCommandItems(profile) {
    if (!profile) return [];
    const items = [
      { kind: 'shell', id: '__shell__', label: '🔗 打开 SSH 终端 (Shell)', command: '', dir: '' },
      { kind: 'shell', root: true, id: '__root_shell__', label: '🛡 打开特权 Root Shell (提权)', command: '', dir: '' },
      { kind: 'browse', id: '__browse__', label: '📂 浏览远程目录', command: '', dir: '' },
    ];
    for (const q of profile.quickCommands || []) {
      items.push({
        kind: 'custom',
        id: q.id,
        label: `▶ ${q.name}`,
        name: q.name,
        command: q.command,
        dir: q.dir || '',
      });
    }
    for (const pq of this.plugins.getPluginQuickCommands(profile)) {
      items.push({
        kind: 'custom',
        id: pq.id,
        isPlugin: true,
        label: `🧩 ${pq.name}`,
        name: pq.name,
        command: pq.command,
        dir: pq.dir || '',
      });
    }
    items.push({ kind: 'add', id: '__add__', label: '+ 添加快捷指令...', command: '', dir: '' });
    return items;
  }

  async runQuickCommandItem(profile, item, { overrideDir = '' } = {}) {
    if (!profile || !item) return;
    if (item.kind === 'add') {
      this.openQuickCmdForm(profile, null);
      return;
    }
    if (item.kind === 'browse') {
      await this.connectProfile(profile);
      return;
    }
    if (!this.sshEnv.hasSsh) {
      this.setStatus('未找到 ssh 命令，无法连接', true);
      this.render();
      return;
    }

    const settings = this.store.getSettings();
    const targetDir = overrideDir || item.dir || profile.homeDir || '~';
    const clipSync = new ClipboardImageSync(profile, settings);
    const clipboardToken = clipSync.token;
    let remoteCmd = '';
    if (item.kind === 'custom') {
      remoteCmd = buildQuickLaunchCommand(item.command, {
        dirPath: targetDir,
        shell: settings.defaultShell,
        preCommand: profile.preCommand,
        clipboardToken,
      });
    } else if (item.kind === 'shell') {
      const shellExpr =
        settings.defaultShell && settings.defaultShell !== 'auto'
          ? quoteSh(settings.defaultShell)
          : '"${SHELL:-bash}"';
      const cdPrefix = targetDir && targetDir !== '~' ? `cd ${quoteSh(targetDir)} && ` : '';
      const motdPrefix =
        settings.showMotd !== false
          ? '([ -s /run/motd.dynamic ] && cat /run/motd.dynamic 2>/dev/null; [ -s /etc/motd ] && cat /etc/motd 2>/dev/null; true); '
          : '';
      const wantElevate = Boolean(item.root || profile.privilegeMode === 'sudo') && profile.privilegeMode !== 'root';
      if (wantElevate) {
        const innerShell = `${cdPrefix}exec ${shellExpr} -l`;
        const sudoCmd = wrapSudoInteractiveCommand(innerShell, profile, { elevate: true });
        remoteCmd = `${buildClipboardEnvAndTrap(clipboardToken)}; ${motdPrefix}${sudoCmd}`;
      } else {
        remoteCmd = `${buildClipboardEnvAndTrap(clipboardToken)}; ${motdPrefix}${cdPrefix}${shellExpr} -l`;
      }
    }

    const title = item.kind === 'shell' ? (item.root || profile.privilegeMode === 'root' || profile.privilegeMode === 'sudo' ? 'Root' : 'Shell') : item.name;
    this.saveCurrentServerTabState();
    const curActive = this.getActiveTab();
    const canReuseEmpty =
      curActive &&
      curActive.profileId === profile.id &&
      (!curActive.termSession || curActive.termSession.exited);
    const tab = canReuseEmpty
      ? this.ensureServerTab(profile, { title })
      : this.ensureServerTab(profile, { forceNew: true, title });
    this.activeServerTabId = tab.id;
    this.activeProfile = profile;
    this.store.setActive(profile.id);

    if (tab?.termSession?.proc && !tab.termSession.exited) {
      try {
        tab.termSession.clipSync?.stop();
        tab.termSession.proc.kill();
      } catch {
        // Ignore previous session kill error
      }
    }

    const { cols, rows } = this.term.getSize();
    const termRows = Math.max(4, rows - 4);
    let proc = null;
    const vterm = new VirtualTerminal(cols, termRows, {
      onResponse: (resp) => {
        if (proc?.stdin?.writable) proc.stdin.write(resp);
      },
      onOsc: (oscSeq) => {
        if (this._running) process.stdout.write(oscSeq);
      },
    });
    if (settings.enableImageClipboard) clipSync.start();
    proc = spawnEmbeddedSsh(profile, remoteCmd, { cols, rows: termRows, settings });
    proc.stdin?.on('error', () => {});

    const termSession = {
      proc,
      vterm,
      clipSync,
      title,
      exited: false,
      exitCode: null,
      _renderScheduled: false,
      _renderTimer: null,
    };
    if (tab) {
      tab.termSession = termSession;
      tab.lastViewTab = 'terminal';
    }

    const scheduleRender = () => {
      if (!this._running || this.tab !== 'terminal' || this.activeServerTabId !== tab.id) return;
      if (termSession._renderScheduled) return;
      termSession._renderScheduled = true;
      const delay = process.stdout.writableNeedDrain ? 50 : 16;
      termSession._renderTimer = setTimeout(() => {
        termSession._renderScheduled = false;
        termSession._renderTimer = null;
        if (!this._running || this.tab !== 'terminal' || this.activeServerTabId !== tab.id) return;
        if (process.stdout.writableNeedDrain) {
          scheduleRender();
          return;
        }
        this.render();
      }, delay);
    };

    // Answer our own sudo prompt with the stored password via the PTY (never via argv).
    const sudoFilter = createSudoPromptFilter(
      () => this.store.getById(profile.id)?.sudoPassword || profile.sudoPassword,
      (data) => {
        if (proc?.stdin?.writable) proc.stdin.write(data);
      }
    );
    proc.stdout?.on('data', (chunk) => {
      vterm.write(sudoFilter(chunk));
      scheduleRender();
    });
    proc.stderr?.on('data', (chunk) => {
      vterm.write(chunk);
      scheduleRender();
    });
    proc.on('error', (err) => {
      clipSync?.stop();
      termSession.exited = true;
      termSession.exitCode = 1;
      vterm.write(`\r\n[SSH 启动失败: ${err.message}]\r\n`);
      if (this.activeServerTabId === tab.id) {
        this.setStatus(`SSH 启动失败: ${err.message}`, true);
        this.render();
      }
    });
    proc.on('close', (code) => {
      clipSync?.stop();
      termSession.exited = true;
      termSession.exitCode = code ?? 0;
      vterm.write(`\r\n[SSH 会话已结束 (退出码 ${termSession.exitCode}) - 按 Enter 返回]\r\n`);
      if (this.activeServerTabId === tab.id) {
        this.setStatus(
          termSession.exitCode === 0 ? `已结束: ${title}` : `SSH 退出码 ${termSession.exitCode}`,
          termSession.exitCode !== 0
        );
        this.render();
      }
    });

    this.tab = 'terminal';
    this.setStatus(`已开启 ${profile.name} (${title}) - 点击上方标签可切换`);
    this.render();
  }

  openQuickCmdForm(profile, existingCmd = null) {
    if (!profile) return;
    this.modal = {
      type: 'profileForm',
      isQuickCmd: true,
      profileId: profile.id,
      cmdId: existingCmd?.id || null,
      title: existingCmd ? `编辑快捷指令 - ${profile.name}` : `添加快捷指令 - ${profile.name}`,
      focusIdx: 0,
      fields: [
        { key: 'name', label: '指令名称 (Name)', value: existingCmd?.name || '' },
        { key: 'command', label: '执行命令 (Command)', value: existingCmd?.command || '' },
        { key: 'dir', label: '工作目录 (可选)', value: existingCmd?.dir || '' },
      ],
    };
    this.render();
  }

  openProfileForm(existing = null) {
    const p = existing ? { ...existing } : createProfile({ name: '', host: '', user: 'ubuntu' });
    const keyCandidates = scanPrivateKeys(process.cwd());
    this.modal = {
      type: 'profileForm',
      title: existing ? '编辑服务器' : '新建服务器',
      isEdit: Boolean(existing),
      id: existing ? existing.id : null,
      focusIdx: 0,
      keyCandidates,
      keyDropdownOpen: false,
      keyDropdownIdx: 0,
      keyDropdownScroll: 0,
      fields: [
        { key: 'name', label: '名称 (Name)', value: existing ? p.name : '' },
        { key: 'host', label: '主机/IP (Host)', value: p.host },
        { key: 'port', label: '端口 (Port)', value: String(p.port || 22) },
        { key: 'user', label: '用户名 (User)', value: p.user },
        {
          key: 'identityFile',
          label: '私钥路径 (可选)',
          value: p.identityFile || (!existing ? this.lastSavedKeyPath : ''),
        },
        { key: 'password', label: 'SSH 登录密码 (可选)', value: p.password || '', masked: true },
        { key: 'homeDir', label: '默认目录 (可选)', value: p.homeDir || '~' },
        { key: 'proxyJump', label: '跳板机 -J (可选)', value: p.proxyJump || '' },
        { key: 'extraSshArgs', label: '额外 SSH 参数', value: p.extraSshArgs || '' },
        { key: 'preCommand', label: '前置命令 (可选)', value: p.preCommand || '' },
        { key: 'privilegeMode', label: '特权模式 (none/sudo/root)', value: p.privilegeMode || 'none' },
        { key: 'sudoPassword', label: '提权密码 (可选, sudo用)', value: p.sudoPassword || '', masked: true },
        { key: 'disabledPlugins', label: '禁用插件 (逗号分隔ID)', value: (p.disabledPlugins || []).join(', ') },
      ],
    };
    this.render();
  }

  openSettingsForm() {
    const s = this.store.getSettings();
    this.modal = {
      type: 'profileForm',
      isSettings: true,
      title: '全局设置 (Settings)',
      focusIdx: 0,
      fields: [
        { key: 'sshTimeoutSec', label: '命令超时 (秒)', value: String(s.sshTimeoutSec) },
        { key: 'connectTimeoutSec', label: '连接超时 (秒)', value: String(s.connectTimeoutSec) },
        { key: 'serverAliveIntervalSec', label: '心跳间隔 (秒)', value: String(s.serverAliveIntervalSec) },
        { key: 'defaultShell', label: '远程 Shell (auto/bash/zsh)', value: s.defaultShell },
        { key: 'sessionScanLimit', label: '会话扫描上限', value: String(s.sessionScanLimit) },
        { key: 'showHiddenByDefault', label: '默认显示隐藏目录 (true/false)', value: String(s.showHiddenByDefault) },
        { key: 'enableImageClipboard', label: '图片剪贴板同步 (true/false)', value: String(s.enableImageClipboard) },
        { key: 'enableAutoCopy', label: '界面选中自动复制 (true/false)', value: String(s.enableAutoCopy !== false) },
        { key: 'showMotd', label: '显示登录欢迎信息 MOTD (true/false)', value: String(s.showMotd !== false) },
        { key: 'theme', label: '配色主题 (cyber/emerald/amber/rose)', value: s.theme || 'cyber' },
        { key: 'pluginRegistryUrl', label: '插件仓库源 (GitHub/URL)', value: s.pluginRegistryUrl || DEFAULT_PLUGIN_REGISTRY_URL },
      ],
    };
    this.render();
  }

  openPluginsModal() {
    const catalog = this.plugins.mergeRemoteCatalog(this.remotePluginCache);
    this.modal = {
      type: 'plugins',
      title: '🧩 插件管理 (Plugins)',
      catalog,
      idx: 0,
      scroll: 0,
    };
    this.render();
    if (this._running) {
      this.refreshRemotePlugins({ silent: true }).catch(() => {});
    }
  }

  async refreshRemotePlugins({ silent = false, fetchImpl } = {}) {
    const sourceUrl = this.store.getSettings().pluginRegistryUrl || DEFAULT_PLUGIN_REGISTRY_URL;
    if (!silent) {
      this.setStatus(`正在从插件源同步: ${sourceUrl} ...`);
      this.render();
    }
    const res = await fetchRemotePluginRegistry(sourceUrl, { fetchImpl });
    if (!res.ok) {
      if (!silent) {
        this.setStatus(`同步插件源失败: ${res.error}`, true);
        this.render();
      }
      return res;
    }
    this.remotePluginCache = res.plugins;
    this.remotePluginSource = res.source;
    if (this.modal?.type === 'plugins') {
      const prevId = this.modal.catalog[this.modal.idx]?.id;
      this.modal.catalog = this.plugins.mergeRemoteCatalog(this.remotePluginCache);
      if (prevId) {
        const nextIdx = this.modal.catalog.findIndex((p) => p.id === prevId);
        if (nextIdx >= 0) this.modal.idx = nextIdx;
      }
    }
    const updatable = this.plugins.mergeRemoteCatalog(this.remotePluginCache).filter((p) => p.hasUpdate).length;
    if (!silent || updatable > 0 || res.plugins.length > 0) {
      const updateTip = updatable > 0 ? `，发现 ${updatable} 个可更新` : '';
      this.setStatus(`已同步插件源 (${res.plugins.length} 个插件${updateTip})`);
      this.render();
    }
    return res;
  }

  async loadPulse() {
    // Removed server-pulse
  }

  openSshImportModal() {
    const candidates = readLocalSshConfig();
    if (candidates.length === 0) {
      this.setStatus('未在 ~/.ssh/config 中找到可导入的 Host', true);
      this.render();
      return;
    }
    this.modal = {
      type: 'sshImport',
      title: '从 ~/.ssh/config 导入',
      candidates,
      idx: 0,
      scroll: 0,
    };
    this.render();
  }

  // ==================== Input Handling ====================

  applyScrollbarDrag(mouseY) {
    const sb = this._sbDrag;
    if (!sb) return;
    const maxScroll = Math.max(0, sb.total - sb.visible);
    const ratio = Math.max(0, Math.min(1, (mouseY - sb.y) / Math.max(1, sb.h - 1)));
    const newScroll = Math.round(ratio * maxScroll);
    if (sb.target === 'files') {
      this.fileScroll = newScroll;
      this.fileIdx = Math.max(newScroll, Math.min(sb.total - 1, newScroll));
    } else if (sb.target === 'docker') {
      this.dockerScroll = newScroll;
      this.dockerIdx = Math.max(newScroll, Math.min(sb.total - 1, newScroll));
    } else if (sb.target === 'profiles') {
      this.profileScroll = newScroll;
      this.profileIdx = Math.max(newScroll, Math.min(sb.total - 1, newScroll));
    } else if (sb.target === 'sessions') {
      this.sessionScroll = newScroll;
      this.sessionIdx = Math.max(newScroll, Math.min(sb.total - 1, newScroll));
    } else if (sb.target === 'agentSub') {
      this.agentSubScroll = newScroll;
      if (this.agentSubTab !== 'prompt') {
        this.agentSubIdx = Math.max(newScroll, Math.min(sb.total - 1, newScroll));
      }
    } else if (sb.target === 'terminal') {
      const vt = this.getActiveTab()?.termSession?.vterm;
      if (vt) vt.scrollOffset = Math.max(0, maxScroll - newScroll);
    } else if (sb.target === 'modal' && this.modal) {
      this.modal.scroll = newScroll;
      if (typeof this.modal.idx === 'number' && this.modal.type !== 'preview') {
        this.modal.idx = Math.max(newScroll, Math.min(sb.total - 1, newScroll));
      }
    }
    this.render();
  }

  handleTermMouseRaw(ev) {
    // Scrollbar dragging & hover thickening work anywhere (except when remote app explicitly tracks 1003h)
    if (ev.action === 'move') {
      const { rows } = this.term.getSize();
      const termStartRow = this.serverTabs.length > 0 ? 4 : 3;
      const inSshPane = !this.modal && this.tab === 'terminal' && ev.y >= termStartRow && ev.y < rows;
      const ts = this.getActiveTab()?.termSession;
      if (inSshPane && ts && !ts.exited && ts.vterm?.mouseModes?.has(1003)) {
        const termY = ev.y - termStartRow + 1;
        ts.proc?.stdin?.writable && ts.proc.stdin.write(`\x1b[<${ev.code};${ev.x};${termY}${ev.suffix}`);
        return;
      }
      const hit = this._lastScreen?.hitTest(ev.x, ev.y);
      const nextHover = hit?.action === 'scrollbarDrag' ? hit.payload?.target || 'modal' : null;
      if (nextHover !== this._sbHover) {
        this._sbHover = nextHover;
        this.render();
      }
      return;
    }

    if (ev.action === 'down' && ev.button === 0) {
      const hit = this._lastScreen?.hitTest(ev.x, ev.y);
      if (hit?.action === 'scrollbarDrag') {
        this._sbDrag = hit.payload;
        this._sbHover = hit.payload?.target || 'modal';
        this.applyScrollbarDrag(ev.y);
        return;
      }
      if (!this.modal && this.tab === 'profiles' && hit?.action === 'selectProfile') {
        this._profileDrag = { idx: hit.payload, lastY: ev.y, moved: false };
      }
    } else if (ev.action === 'drag' && this._sbDrag) {
      this.applyScrollbarDrag(ev.y);
      return;
    } else if (ev.action === 'drag' && this._profileDrag) {
      const dy = ev.y - this._profileDrag.lastY;
      if (dy !== 0) {
        const step = dy > 0 ? 1 : -1;
        const nextIdx = this.store.moveProfile(this._profileDrag.idx, step);
        if (nextIdx >= 0 && nextIdx !== this._profileDrag.idx) {
          this._profileDrag.idx = nextIdx;
          this._profileDrag.moved = true;
          this.profileIdx = nextIdx;
          this.setStatus(`已调整服务器顺序: ${this.store.list()[nextIdx]?.name || ''}`);
        }
        this._profileDrag.lastY = ev.y;
        this.render();
      }
      return;
    } else if (ev.action === 'up' && (this._sbDrag || this._profileDrag)) {
      if (this._sbDrag) {
        this._sbDrag = null;
        this.render();
        return;
      }
      const wasMoved = this._profileDrag.moved;
      this._profileDrag = null;
      if (wasMoved) return;
    }

    const { rows } = this.term.getSize();
    const termStartRow = this.serverTabs.length > 0 ? 4 : 3;
    const inSshPane = !this.modal && this.tab === 'terminal' && ev.y >= termStartRow && ev.y < rows;
    const curTab = this.getActiveTab();
    const ts = curTab?.termSession;

    if (inSshPane && ts && !ts.exited && ts.proc?.stdin?.writable) {
      // Right-click in terminal pastes text from local clipboard
      if (ev.button === 2) {
        if (ev.action === 'down') {
          const text = readClipboardText();
          if (text) {
            const payload = ts.vterm?.bracketedPaste
              ? `\x1b[200~${text}\x1b[201~`
              : text.replace(/\r\n/g, '\r');
            ts.proc.stdin.write(payload);
          }
        }
        return;
      }

      // Remote app with mouse tracking (e.g. Claude Code, vim) handles its own selection/copy
      if (ts.vterm?.hasMouseTracking()) {
        const termY = ev.y - termStartRow + 1;
        ts.proc.stdin.write(`\x1b[<${ev.code};${ev.x};${termY}${ev.suffix}`);
        return;
      }
    }

    // App-UI & plain-shell drag-to-select & auto-copy (never intercepts Claude Code / mouse-tracked apps)
    if (this.store.getSettings().enableAutoCopy === false) {
      if (this._uiSel) {
        this._uiSel = null;
        this.render();
      }
      return;
    }
    if (ev.action === 'down' && ev.button === 0) {
      const hadActive = Boolean(this._uiSel?.active);
      this._uiSel = {
        startX: ev.x,
        startY: ev.y,
        endX: ev.x,
        endY: ev.y,
        active: false,
        dragging: true,
        hadActive,
      };
    } else if (ev.action === 'drag' && this._uiSel?.dragging) {
      this._uiSel.endX = ev.x;
      this._uiSel.endY = ev.y;
      if (Math.abs(ev.x - this._uiSel.startX) >= 2) {
        this._uiSel.active = true;
        this.render();
      }
    } else if (ev.action === 'up' && this._uiSel) {
      const sel = this._uiSel;
      sel.dragging = false;
      if (sel.active && this._lastScreen) {
        const text = this._lastScreen.extractText(sel.startX, sel.startY, sel.endX, sel.endY);
        if (text) {
          const ok = writeClipboardText(text);
          this.setStatus(
            ok ? `已复制 ${text.length} 字到剪贴板` : '复制失败（未检测到可用剪贴板工具）',
            !ok
          );
        }
        this.render();
      } else {
        this._uiSel = null;
        if (sel.hadActive) this.render();
      }
    }
  }

  handleScroll(delta) {
    if (this.modal) {
      if (this.modal.type === 'preview') {
        this.modal.scroll = Math.max(
          0,
          Math.min(Math.max(0, this.modal.lines.length - 6), this.modal.scroll + delta)
        );
        this.render();
      } else if (this.modal.type === 'sshImport') {
        this.modal.idx = Math.max(
          0,
          Math.min(this.modal.candidates.length - 1, this.modal.idx + (delta > 0 ? 1 : -1))
        );
        this.render();
      } else if (this.modal.type === 'plugins') {
        this.modal.idx = Math.max(
          0,
          Math.min(Math.max(0, this.modal.catalog.length - 1), this.modal.idx + (delta > 0 ? 1 : -1))
        );
        this.render();
      } else if (this.modal.type === 'actionPalette') {
        this.modal.idx = Math.max(
          0,
          Math.min(Math.max(0, this.modal.items.length - 1), this.modal.idx + (delta > 0 ? 1 : -1))
        );
        this.render();
      } else if (this.modal.type === 'pluginServerConfig') {
        const len = this.store.list().length;
        this.modal.idx = Math.max(0, Math.min(Math.max(0, len - 1), this.modal.idx + (delta > 0 ? 1 : -1)));
        this.render();
      } else if (this.modal.type === 'agentSkills') {
        this.modal.idx = Math.max(
          0,
          Math.min(Math.max(0, this.modal.skills.length - 1), this.modal.idx + (delta > 0 ? 1 : -1))
        );
        this.render();
      } else if (this.modal.type === 'agentMcp') {
        this.modal.idx = Math.max(
          0,
          Math.min(Math.max(0, this.modal.items.length - 1), this.modal.idx + (delta > 0 ? 1 : -1))
        );
        this.render();
      } else if (this.modal.type === 'claudeMemory') {
        this.modal.idx = Math.max(
          0,
          Math.min(Math.max(0, this.modal.items.length - 1), this.modal.idx + (delta > 0 ? 1 : -1))
        );
        this.render();
      } else if (this.modal.type === 'tokenStats') {
        const list = this.getTokenStatsRows(this.modal);
        this.modal.idx = Math.max(0, Math.min(Math.max(0, list.length - 1), this.modal.idx + (delta > 0 ? 1 : -1)));
        this.render();
      } else if (this.modal.type === 'appUpdate') {
        this.modal.scroll = Math.max(0, (this.modal.scroll || 0) + delta);
        this.render();
      } else if (
        this.modal.type === 'profileForm' &&
        this.modal.keyDropdownOpen &&
        this.modal.keyCandidates?.length > 0
      ) {
        this.modal.keyDropdownIdx = Math.max(
          0,
          Math.min(this.modal.keyCandidates.length - 1, this.modal.keyDropdownIdx + (delta > 0 ? 1 : -1))
        );
        this.render();
      }
      return;
    }

    const step = delta > 0 ? 1 : -1;
    if (this.tab === 'profiles') {
      const landscape = this.isLandscape();
      const inCommands = landscape ? this.profilePane === 'commands' : this.portraitView === 'commands';
      if (inCommands) {
        const p = this.store.list()[this.profileIdx];
        const len = this.getQuickCommandItems(p).length;
        if (len > 0) this.quickCmdIdx = Math.max(0, Math.min(len - 1, this.quickCmdIdx + step));
      } else {
        const len = this.store.list().length;
        if (len > 0) {
          const next = Math.max(0, Math.min(len - 1, this.profileIdx + step));
          if (next !== this.profileIdx) {
            this.profileIdx = next;
            this.quickCmdIdx = 0;
            this.quickCmdScroll = 0;
          }
        }
      }
    } else if (this.tab === 'files') {
      const len = this.getFileListItems().length;
      if (len > 0) this.fileIdx = Math.max(0, Math.min(len - 1, this.fileIdx + step));
    } else if (this.isAgentTab()) {
      if (this.agentSubTab === 'sessions') {
        const len = this.sessions.length;
        if (len > 0) this.sessionIdx = Math.max(0, Math.min(len - 1, this.sessionIdx + step));
      } else if (this.agentSubTab === 'prompt') {
        const total = this.agentPromptData?.lines?.length || 0;
        const viewH = Math.max(2, this.term.getSize().rows - 9);
        this.agentSubScroll = Math.max(0, Math.min(Math.max(0, total - viewH), this.agentSubScroll + delta));
      } else {
        const len =
          this.agentSubTab === 'memory'
            ? this.claudeMemoryData?.items?.length || 0
            : this.agentSubTab === 'skills'
              ? this.agentSkillsData?.skills?.length || 0
              : this.agentMcpData?.items?.length || 0;
        if (len > 0) this.agentSubIdx = Math.max(0, Math.min(len - 1, this.agentSubIdx + step));
      }
    } else if (this.tab === 'docker') {
      const len = this.getDockerListItems().length;
      if (len > 0) this.dockerIdx = Math.max(0, Math.min(len - 1, this.dockerIdx + step));
    } else if (this.tab === 'terminal') {
      const curTab = this.getActiveTab();
      const vt = curTab?.termSession?.vterm;
      if (vt && !vt.hasMouseTracking()) {
        vt.scrollBy(delta);
      }
    }
    this.render();
  }

  async handleTap({ x, y }) {
    if (!this._lastScreen) return;
    const hit = this._lastScreen.hitTest(x, y);
    if (!hit) return;

    const now = Date.now();
    const tapKey = `${hit.action}:${JSON.stringify(hit.payload)}`;
    const isDoubleTap = this.lastTap.key === tapKey && now - this.lastTap.time < 450;
    this.lastTap = { key: tapKey, time: now };

    await this.dispatchAction(hit.action, hit.payload, { isDoubleTap, fromTap: true, x, y });
  }

  async dispatchAction(action, payload, { isDoubleTap = false, fromTap = false, x = 0, y = 0 } = {}) {
    switch (action) {
      case 'quit':
        this.stop();
        return;
      case 'switchTab':
        if (payload === 'files' && !this.activeProfile) {
          const sel = this.store.list()[this.profileIdx] || this.store.list()[0];
          if (sel) {
            await this.connectProfile(sel);
            return;
          }
          this.setStatus('请先新建一个服务器配置', true);
          this.render();
          return;
        }
        if (this.isAgentTab(payload) || payload === 'docker') {
          const pluginId = this.plugins.getPluginIdForTab(payload);
          const eligible = this.store
            .list()
            .filter((p) => !pluginId || !this.plugins.isDisabledForProfile(pluginId, p));
          if (eligible.length === 0) {
            this.tab = payload;
            this.sessions = [];
            this.dockerData = { containers: [], images: [], compose: [], networks: [], volumes: [], loadedForProfileId: null };
            this.setStatus('所有服务器均已禁用该插件，可在插件管理或服务器配置中启用', true);
            this.render();
            return;
          }
          if (!this.activeProfile || (pluginId && this.plugins.isDisabledForProfile(pluginId, this.activeProfile))) {
            const preferred = this.store.list()[this.profileIdx];
            const picked =
              preferred && (!pluginId || !this.plugins.isDisabledForProfile(pluginId, preferred))
                ? preferred
                : eligible[0];
            this.activeProfile = picked;
            this.store.setActive(picked.id);
            const switchedTab = this.ensureServerTab(picked);
            if (switchedTab) this.activeServerTabId = switchedTab.id;
          }
        }
        if (payload === 'terminal') {
          if (!this.activeProfile) {
            const sel = this.store.list()[this.profileIdx] || this.store.list()[0];
            if (sel) {
              this.activeProfile = sel;
              this.store.setActive(sel.id);
              await this.runQuickCommandItem(sel, { kind: 'shell' });
              return;
            }
            this.setStatus('请先新建一个服务器配置', true);
            this.render();
            return;
          }
          const curTab = this.getActiveTab();
          if (!curTab?.termSession) {
            await this.runQuickCommandItem(this.activeProfile, { kind: 'shell' });
            return;
          }
        }
        this.tab = payload;
        if (payload === 'files' && this.activeServerTabId) {
          const curTab = this.getActiveTab();
          if (curTab && !curTab.dirLoaded) {
            await this.loadDirectory(curTab.currentDir.path, { force: true });
            curTab.dirLoaded = true;
            return;
          }
        }
        if (this.isAgentTab(payload)) {
          if (payload !== 'sessions' && this.agentSubTab === 'memory') {
            this.agentSubTab = 'sessions';
          }
          await this.loadActiveAgentSubTab();
        } else if (payload === 'docker') {
          await this.loadDocker();
        } else {
          this.render();
        }
        return;
      case 'switchAgentSubTab': {
        this.agentSubTab = payload || 'sessions';
        this.agentSubIdx = 0;
        this.agentSubScroll = 0;
        await this.loadActiveAgentSubTab();
        return;
      }
      case 'refreshAgentSubTab':
        await this.loadActiveAgentSubTab({ force: true });
        return;
      case 'agentSubSelect': {
        const wasSelected = this.agentSubIdx === payload;
        this.agentSubIdx = payload;
        if ((fromTap && wasSelected) || isDoubleTap) {
          if (this.agentSubTab === 'memory') return this.dispatchAction('memoryPreview');
          if (this.agentSubTab === 'skills') return this.dispatchAction('skillPreview');
          if (this.agentSubTab === 'mcp') return this.dispatchAction('mcpAdd');
        }
        this.render();
        return;
      }
      case 'switchSessionServer': {
        const target = this.store.getById(payload);
        if (!target) return;
        this.activeProfile = target;
        this.store.setActive(target.id);
        this.ensureServerTab(target);
        this.sessionIdx = 0;
        this.sessionScroll = 0;
        this.agentSubIdx = 0;
        this.agentSubScroll = 0;
        await this.loadActiveAgentSubTab({ force: true });
        return;
      }
      case 'openPluginServers': {
        if (this.modal?.type !== 'plugins') return;
        const p = this.modal.catalog[this.modal.idx];
        if (!p) return;
        this.modal = {
          type: 'pluginServerConfig',
          title: `⚙ 服务器权限: ${p.name}`,
          plugin: p,
          idx: 0,
          scroll: 0,
        };
        this.render();
        return;
      }
      case 'pluginServerSelect':
        if (this.modal?.type === 'pluginServerConfig') {
          this.modal.idx = payload;
          if (fromTap) return this.dispatchAction('pluginServerToggle');
          this.render();
        }
        return;
      case 'pluginServerToggle': {
        if (this.modal?.type !== 'pluginServerConfig') return;
        const servers = this.store.list();
        const target = servers[this.modal.idx];
        const plugin = this.modal.plugin;
        if (!target || !plugin) return;
        const curDisabled = Array.isArray(target.disabledPlugins) ? [...target.disabledPlugins] : [];
        const has = curDisabled.includes(plugin.id);
        const nextDisabled = has ? curDisabled.filter((id) => id !== plugin.id) : [...curDisabled, plugin.id];
        const saved = this.store.upsert({ ...target, disabledPlugins: nextDisabled });
        if (this.activeProfile?.id === saved.id) this.activeProfile = saved;
        this.setStatus(
          has ? `已在 [${saved.name}] 启用 ${plugin.name}` : `已在 [${saved.name}] 禁用 ${plugin.name}`
        );
        this.render();
        return;
      }
      case 'pluginServersEnableAll':
      case 'pluginServersDisableAll': {
        if (this.modal?.type !== 'pluginServerConfig') return;
        const plugin = this.modal.plugin;
        const disable = action === 'pluginServersDisableAll';
        for (const srv of this.store.list()) {
          const curDisabled = Array.isArray(srv.disabledPlugins) ? [...srv.disabledPlugins] : [];
          const nextDisabled = disable
            ? [...new Set([...curDisabled, plugin.id])]
            : curDisabled.filter((id) => id !== plugin.id);
          const saved = this.store.upsert({ ...srv, disabledPlugins: nextDisabled });
          if (this.activeProfile?.id === saved.id) this.activeProfile = saved;
        }
        this.setStatus(disable ? `已对全部服务器禁用 ${plugin.name}` : `已对全部服务器启用 ${plugin.name}`);
        this.render();
        return;
      }
      case 'pluginToggleProfile':
        if (this.modal?.type === 'plugins') {
          const p = this.modal.catalog[this.modal.idx];
          const target = this.activeProfile || this.store.list()[this.profileIdx];
          if (!p || !target) {
            this.setStatus('请先选择一个服务器', true);
            this.render();
            return;
          }
          const curDisabled = Array.isArray(target.disabledPlugins) ? [...target.disabledPlugins] : [];
          const has = curDisabled.includes(p.id);
          const nextDisabled = has ? curDisabled.filter((id) => id !== p.id) : [...curDisabled, p.id];
          const saved = this.store.upsert({ ...target, disabledPlugins: nextDisabled });
          if (this.activeProfile?.id === saved.id) this.activeProfile = saved;
          this.setStatus(
            has
              ? `已在 [${saved.name}] 启用插件 ${p.name}`
              : `已在 [${saved.name}] 禁用插件 ${p.name}`
          );
          this.render();
        }
        return;
      case 'dockerSubTab':
        this.dockerSubTab = payload;
        this.dockerIdx = 0;
        this.dockerScroll = 0;
        this.render();
        return;
      case 'switchDockerServer': {
        const srv = this.store.getById(payload);
        if (!srv) return;
        this.saveCurrentServerTabState();
        this.activeProfile = srv;
        this.store.setActive(srv.id);
        this.ensureServerTab(srv);
        this.dockerIdx = 0;
        this.dockerScroll = 0;
        await this.loadDocker({ force: true });
        return;
      }
      case 'dockerSearch':
        this.openInputModal({
          title: '搜索 / 过滤 Docker 资源',
          prompt: '输入名称、镜像或状态关键词 (留空显示全部):',
          initialValue: this.dockerKeyword,
          onSubmit: (kw) => {
            this.dockerKeyword = String(kw || '').trim();
            this.dockerIdx = 0;
            this.dockerScroll = 0;
            this.render();
          },
        });
        return;
      case 'dockerToggleRunning':
        this.dockerOnlyRunning = !this.dockerOnlyRunning;
        this.dockerIdx = 0;
        this.dockerScroll = 0;
        this.render();
        return;
      case 'dockerRefresh':
        await this.loadDocker({ force: true });
        return;
      case 'dockerSelect': {
        this.dockerIdx = payload;
        if (isDoubleTap && this.dockerSubTab === 'containers') {
          await this.dispatchAction('dockerExec');
        } else {
          this.render();
        }
        return;
      }
      case 'dockerExec': {
        const c = this.getDockerListItems()[this.dockerIdx];
        if (!this.activeProfile || !c || this.dockerSubTab !== 'containers') return;
        const cmd = buildDockerExecCommand(c.id, this.activeProfile, { elevate: this.isDirElevate() });
        await this.runQuickCommandItem(this.activeProfile, { kind: 'custom', name: `🐚 ${c.name}`, command: cmd });
        return;
      }
      case 'dockerLogs': {
        const c = this.getDockerListItems()[this.dockerIdx];
        if (!this.activeProfile || !c || this.dockerSubTab !== 'containers') return;
        this.loadingText = `正在读取 ${c.name} 最近日志...`;
        this.render();
        const res = await fetchDockerLogs(this.activeProfile, c.id, {
          tail: 200,
          settings: this.store.getSettings(),
          elevate: this.isDirElevate(),
        });
        this.loadingText = '';
        if (!res.ok) {
          this.setStatus(res.error || '读取日志失败', true);
          this.render();
          return;
        }
        const lines = [];
        for (const rawLine of (res.text || '(暂无日志输出)').split(/\r?\n/)) {
          for (const wl of wrapTextToWidth(rawLine, Math.max(40, this.term.getSize().cols - 10))) {
            lines.push({ text: wl, style: /error|exception|fatal|fail/i.test(wl) ? ANSI.fg.red : ANSI.fg.white });
          }
        }
        this.modal = { type: 'preview', title: `📜 容器日志: ${c.name} (最近 200 行)`, lines, scroll: Math.max(0, lines.length - 12) };
        this.render();
        return;
      }
      case 'dockerLogsFollow': {
        const c = this.getDockerListItems()[this.dockerIdx];
        if (!this.activeProfile || !c || this.dockerSubTab !== 'containers') return;
        const cmd = buildDockerLogsFollowCommand(c.id, this.activeProfile, { elevate: this.isDirElevate(), tail: 100 });
        await this.runQuickCommandItem(this.activeProfile, { kind: 'custom', name: `📡 ${c.name}`, command: cmd });
        return;
      }
      case 'dockerInspect': {
        const c = this.getDockerListItems()[this.dockerIdx];
        if (!this.activeProfile || !c || this.dockerSubTab !== 'containers') return;
        this.loadingText = `正在读取 ${c.name} 详情...`;
        this.render();
        const res = await fetchDockerInspect(this.activeProfile, c.id, {
          settings: this.store.getSettings(),
          elevate: this.isDirElevate(),
        });
        this.loadingText = '';
        if (!res.ok) {
          this.setStatus(res.error || '读取容器详情失败', true);
          this.render();
          return;
        }
        const lines = renderMarkdownLines(res.text, Math.max(40, this.term.getSize().cols - 10), ANSI.fg.white);
        this.modal = { type: 'preview', title: `🔍 容器详情: ${c.name}`, lines, scroll: 0 };
        this.render();
        return;
      }
      case 'dockerStart':
      case 'dockerStop':
      case 'dockerRestart': {
        const item = this.getDockerListItems()[this.dockerIdx];
        if (!this.activeProfile || !item) return;
        const opMap = {
          dockerStart: this.dockerSubTab === 'compose' ? 'composeUp' : 'start',
          dockerStop: this.dockerSubTab === 'compose' ? 'composeDown' : 'stop',
          dockerRestart: this.dockerSubTab === 'compose' ? 'composeRestart' : 'restart',
        };
        const target = this.dockerSubTab === 'compose' ? item.name : item.id;
        this.loadingText = `正在执行 Docker ${opMap[action]} (${item.name || target})...`;
        this.render();
        const res = await runDockerAction(this.activeProfile, opMap[action], target, this.store.getSettings(), {
          elevate: this.isDirElevate(),
        });
        this.loadingText = '';
        if (!res.ok) {
          this.setStatus(res.error || '操作失败', true);
          this.render();
          return;
        }
        this.setStatus(`已完成: ${opMap[action]} ${item.name || target}`);
        await this.loadDocker({ force: true });
        return;
      }
      case 'dockerRemove': {
        const item = this.getDockerListItems()[this.dockerIdx];
        if (!this.activeProfile || !item) return;
        if (this.dockerSubTab === 'containers') {
          const isRunning = item.state === 'running';
          this.openConfirmModal({
            title: isRunning ? '强制删除运行中容器' : '删除容器',
            message: `确定删除容器 "${item.name}" (${item.id})？`,
            onConfirm: async () => {
              const res = await runDockerAction(
                this.activeProfile,
                isRunning ? 'rmForce' : 'rm',
                item.id,
                this.store.getSettings(),
                { elevate: this.isDirElevate() }
              );
              this.setStatus(res.ok ? `已删除容器 ${item.name}` : res.error, !res.ok);
              await this.loadDocker({ force: true });
            },
          });
        } else if (this.dockerSubTab === 'images') {
          const ref = item.repository !== '<none>' ? `${item.repository}:${item.tag}` : item.id;
          this.openConfirmModal({
            title: '删除镜像',
            message: `确定删除镜像 "${ref}" (${item.id})？`,
            onConfirm: async () => {
              const res = await runDockerAction(this.activeProfile, 'rmi', item.id, this.store.getSettings(), {
                elevate: this.isDirElevate(),
              });
              this.setStatus(res.ok ? `已删除镜像 ${ref}` : res.error, !res.ok);
              await this.loadDocker({ force: true });
            },
          });
        } else if (this.dockerSubTab === 'networks') {
          this.openConfirmModal({
            title: '删除 Docker 网络',
            message: `确定删除网络 "${item.name}" (${item.id})？`,
            onConfirm: async () => {
              const res = await runDockerAction(this.activeProfile, 'rmNetwork', item.name, this.store.getSettings(), {
                elevate: this.isDirElevate(),
              });
              this.setStatus(res.ok ? `已删除网络 ${item.name}` : res.error, !res.ok);
              await this.loadDocker({ force: true });
            },
          });
        } else if (this.dockerSubTab === 'volumes') {
          this.openConfirmModal({
            title: '删除 Docker 卷',
            message: `确定删除数据卷 "${item.name}"？`,
            onConfirm: async () => {
              const res = await runDockerAction(this.activeProfile, 'rmVolume', item.name, this.store.getSettings(), {
                elevate: this.isDirElevate(),
              });
              this.setStatus(res.ok ? `已删除数据卷 ${item.name}` : res.error, !res.ok);
              await this.loadDocker({ force: true });
            },
          });
        }
        return;
      }
      case 'dockerPull':
        if (!this.activeProfile) return;
        this.openInputModal({
          title: '拉取 Docker 镜像',
          prompt: '镜像名称 (如 nginx:alpine):',
          initialValue: '',
          onSubmit: async (img) => {
            const name = String(img || '').trim();
            if (!name) return;
            this.loadingText = `正在拉取镜像 ${name} ...`;
            this.render();
            const res = await runDockerAction(this.activeProfile, 'pull', name, this.store.getSettings(), {
              elevate: this.isDirElevate(),
            });
            this.loadingText = '';
            this.setStatus(res.ok ? `已拉取镜像: ${name}` : res.error, !res.ok);
            await this.loadDocker({ force: true });
          },
        });
        return;
      case 'dockerPrune':
        if (!this.activeProfile) return;
        this.openConfirmModal({
          title: '清理悬空 Docker 资源',
          message: '将执行 docker system prune -f（清理已停止容器、无用网络与悬空镜像）',
          onConfirm: async () => {
            const res = await runDockerAction(this.activeProfile, 'pruneSystem', '', this.store.getSettings(), {
              elevate: this.isDirElevate(),
            });
            this.setStatus(res.ok ? '已完成 Docker 资源清理' : res.error, !res.ok);
            await this.loadDocker({ force: true });
          },
        });
        return;
      case 'dockerStats':
        if (!this.activeProfile) return;
        await this.runQuickCommandItem(this.activeProfile, {
          kind: 'custom',
          name: '📊 Docker Stats',
          command: this.isDirElevate() ? 'sudo docker stats' : 'docker stats',
        });
        return;
      case 'openPlugins':
        this.openPluginsModal();
        return;
      case 'actionPaletteSelect':
        if (this.modal?.type === 'actionPalette') {
          this.modal.idx = payload;
          if (fromTap) return this.dispatchAction('actionPaletteRun');
          this.render();
        }
        return;
      case 'actionPaletteRun':
        if (this.modal?.type === 'actionPalette') {
          const item = this.modal.items[this.modal.idx];
          this.modal = null;
          if (item) {
            await this.dispatchAction(item.action, item.payload);
          } else {
            this.render();
          }
        }
        return;
      case 'openAppUpdate':
        await this.openAppUpdateModal({ force: false });
        return;
      case 'refreshAppUpdate':
        await this.openAppUpdateModal({ force: true });
        return;
      case 'runAppUpgrade': {
        this.setStatus('正在升级 ssh4work，请稍候...');
        this.render();
        const up = performAppUpgrade();
        if (this.modal?.type === 'appUpdate') {
          if (up.ok) {
            this.modal.upgradeDoneMsg = `升级成功: v${up.previousVersion} -> v${up.newVersion} (${up.method})，请重启 ssh4work 以应用新版本。`;
            this.modal.info = {
              ...(this.modal.info || {}),
              currentVersion: up.newVersion,
              hasUpdate: false,
            };
            this.appUpdateInfo = this.modal.info;
            this.setStatus(`升级成功: v${up.previousVersion} -> v${up.newVersion}，请重启 ssh4work`);
          } else {
            this.setStatus(`升级失败: ${up.error}`, true);
          }
        } else {
          this.setStatus(up.ok ? `升级成功: v${up.newVersion}` : `升级失败: ${up.error}`, !up.ok);
        }
        this.render();
        return;
      }
      case 'pluginSelect':
        if (this.modal?.type === 'plugins') {
          this.modal.idx = payload;
          if (fromTap) {
            await this.dispatchAction('pluginToggleOrInstall');
          } else {
            this.render();
          }
        }
        return;
      case 'pluginToggleOrInstall':
        if (this.modal?.type === 'plugins') {
          const p = this.modal.catalog[this.modal.idx];
          if (!p) return;
          if (p.hasUpdate && p.remotePlugin) {
            const res = this.plugins.installRemote(p.remotePlugin, { sourceUrl: this.remotePluginSource });
            if (res.ok) this.setStatus(`已更新插件: ${p.name} (v${p.remotePlugin.version})`);
            else this.setStatus(res.error || '更新失败', true);
          } else if (!p.installed) {
            const res =
              p.remotePlugin && !p.builtin
                ? this.plugins.installRemote(p.remotePlugin, { sourceUrl: this.remotePluginSource })
                : this.plugins.install(p.id);
            if (res.ok) this.setStatus(`已安装并启用插件: ${p.name}`);
            else this.setStatus(res.error || '安装失败', true);
          } else {
            const enabled = this.plugins.toggle(p.id);
            this.setStatus(enabled ? `已启用插件: ${p.name}` : `已禁用插件: ${p.name}`);
            if (!enabled && p.tab?.id === this.tab) this.tab = 'profiles';
          }
          this.modal.catalog = this.plugins.mergeRemoteCatalog(this.remotePluginCache);
          this.render();
        }
        return;
      case 'pluginSyncRemote':
        await this.refreshRemotePlugins({ silent: false });
        return;
      case 'pluginEditSource':
        this.openInputModal({
          title: '设置插件仓库源',
          prompt: '输入 GitHub 仓库 (如 owner/repo 或 URL) 或 registry.json 地址 (留空恢复默认):',
          initialValue: this.store.getSettings().pluginRegistryUrl || DEFAULT_PLUGIN_REGISTRY_URL,
          onSubmit: async (val) => {
            const nextUrl = String(val || '').trim() || DEFAULT_PLUGIN_REGISTRY_URL;
            this.store.updateSettings({ pluginRegistryUrl: nextUrl });
            this.remotePluginCache = [];
            this.remotePluginSource = '';
            this.openPluginsModal();
            await this.refreshRemotePlugins({ silent: false });
          },
        });
        return;
      case 'pluginUninstall':
        if (this.modal?.type === 'plugins') {
          const p = this.modal.catalog[this.modal.idx];
          if (!p || !p.installed) return;
          this.plugins.uninstall(p.id);
          if (p.tab?.id === this.tab) this.tab = 'profiles';
          this.modal.catalog = this.plugins.mergeRemoteCatalog(this.remotePluginCache);
          this.modal.idx = Math.max(0, Math.min(this.modal.idx, this.modal.catalog.length - 1));
          this.setStatus(`已卸载插件: ${p.name}`);
          this.render();
        }
        return;
      case 'pluginInstallLocal':
        this.openInputModal({
          title: '安装本地插件',
          prompt: '输入 plugin.json 路径或插件目录路径:',
          initialValue: '',
          onSubmit: (p) => {
            const res = this.plugins.install(p);
            if (!res.ok) {
              this.setStatus(res.error || '安装失败', true);
            } else {
              this.setStatus(`已安装插件: ${res.plugin.name}`);
            }
            this.openPluginsModal();
          },
        });
        return;
      case 'cycleTheme': {
        const themes = ['cyber', 'emerald', 'amber', 'rose'];
        const cur = this.store.getSettings().theme || 'cyber';
        const next = themes[(themes.indexOf(cur) + 1) % themes.length];
        this.store.updateSettings({ theme: next });
        this.setStatus(`已切换主题: ${next}`);
        this.render();
        return;
      }
      case 'openTokenStats':
        await this.openTokenStatsModal();
        return;
      case 'openSessionTokenStats': {
        const s = this.sessions[this.sessionIdx];
        await this.openTokenStatsModal({ sessionFilePath: s?.filePath || '' });
        return;
      }
      case 'tokenStatsView':
        if (this.modal?.type === 'tokenStats') {
          this.modal.view = payload;
          this.modal.idx = 0;
          this.modal.scroll = 0;
          this.render();
        }
        return;
      case 'tokenStatsSelect':
        if (this.modal?.type === 'tokenStats') {
          this.modal.idx = payload;
          this.render();
        }
        return;
      case 'refreshTokenStats':
        if (this.modal?.type === 'tokenStats') {
          await this.openTokenStatsModal({
            sessionFilePath: this.modal.sessionFilePath,
            startTime: this.modal.startTime,
            endTime: this.modal.endTime,
          });
        }
        return;
      case 'tokenStatsEditTime':
        if (this.modal?.type === 'tokenStats') {
          const prevModal = this.modal;
          const todayStart = `${formatLocalDateTimeNow().slice(0, 10)} 00:00:00`;
          this.modal = {
            type: 'profileForm',
            isTimeRange: true,
            parentTokenStats: prevModal,
            title: `设置统计时间范围 (${prevModal.stats.summary.tzLabel})`,
            focusIdx: 0,
            fields: [
              { key: 'startTime', label: '开始时间 (留空不限)', value: prevModal.startTime || todayStart },
              { key: 'endTime', label: '结束时间 (留空不限)', value: prevModal.endTime || formatLocalDateTimeNow() },
            ],
          };
          this.render();
        }
        return;
      case 'tokenStatsPreset': {
        const targetStats =
          this.modal?.type === 'tokenStats'
            ? this.modal
            : this.modal?.isTimeRange
              ? this.modal.parentTokenStats
              : null;
        if (!targetStats) return;
        const now = new Date();
        const endStr = formatLocalDateTimeNow(now);
        let startStr = '';
        if (payload === 'today') {
          const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
          startStr = formatLocalDateTimeNow(dayStart);
        } else if (payload === '1d') {
          startStr = formatLocalDateTimeNow(new Date(now.getTime() - 24 * 3600 * 1000));
        } else if (payload === '7d') {
          startStr = formatLocalDateTimeNow(new Date(now.getTime() - 7 * 24 * 3600 * 1000));
        } else if (payload === '30d') {
          startStr = formatLocalDateTimeNow(new Date(now.getTime() - 30 * 24 * 3600 * 1000));
        } else if (payload === '365d') {
          startStr = formatLocalDateTimeNow(new Date(now.getTime() - 365 * 24 * 3600 * 1000));
        } else if (payload === 'now') {
          startStr = targetStats.startTime || '';
        } else if (payload === 'all') {
          startStr = '';
        }
        const finalEnd = payload === 'all' ? '' : endStr;
        if (this.modal?.isTimeRange) {
          this.modal.fields[0].value = startStr;
          this.modal.fields[1].value = finalEnd;
          this.modal.fields[0].cursor = startStr.length;
          this.modal.fields[1].cursor = finalEnd.length;
          this.render();
          return;
        }
        targetStats.startTime = startStr;
        targetStats.endTime = finalEnd;
        targetStats.preset = payload || 'all';
        targetStats.stats = aggregateTokenStats(targetStats.rawRecords, {
          startTime: startStr,
          endTime: finalEnd,
        });
        targetStats.idx = 0;
        targetStats.scroll = 0;
        this.render();
        return;
      }
      case 'switchServerTab':
        await this.activateServerTab(payload, { switchView: this.tab !== 'profiles' });
        return;
      case 'closeServerTab':
        await this.closeServerTab(payload);
        return;
      case 'pasteImageToTerminal': {
        const curTab = this.getActiveTab();
        const ts = curTab?.termSession;
        if (!ts || ts.exited) {
          this.setStatus('当前没有活动中的 SSH 终端', true);
          this.render();
          return;
        }
        if (!ts.clipSync) {
          this.setStatus('请在设置中开启图片剪贴板同步 (enableImageClipboard)', true);
          this.render();
          return;
        }
        this.setStatus('正在推送剪贴板图片到远程...');
        this.render();
        const res = await ts.clipSync.pushNow();
        if (!res.ok) {
          this.setStatus(res.error || res.stderr || '推送图片失败', true);
          this.render();
          return;
        }
        if (ts.proc?.stdin?.writable) {
          ts.proc.stdin.write('\x16');
        }
        this.setStatus('已推送剪贴板图片并触发粘贴 (Ctrl+V)');
        this.render();
        return;
      }

      // Profile & Quick Command actions
      case 'selectProfile': {
        const wasSelected = this.profileIdx === payload;
        if (!wasSelected) {
          this.profileIdx = payload;
          this.quickCmdIdx = 0;
          this.quickCmdScroll = 0;
        }
        const landscape = this.isLandscape();
        if (!landscape) {
          this.portraitView = 'commands';
          this.profilePane = 'commands';
          this.render();
          return;
        }
        this.profilePane = 'servers';
        if (isDoubleTap) {
          const p = this.store.list()[this.profileIdx];
          await this.runQuickCommandItem(p, { kind: 'shell' });
        } else {
          this.render();
        }
        return;
      }
      case 'backToServers':
        this.portraitView = 'servers';
        this.profilePane = 'servers';
        this.render();
        return;
      case 'selectQuickCmd': {
        const p = this.store.list()[this.profileIdx];
        const items = this.getQuickCommandItems(p);
        const item = items[payload];
        const wasSelected = this.quickCmdIdx === payload;
        this.quickCmdIdx = payload;
        this.profilePane = 'commands';
        if (item?.kind === 'add' || (fromTap && wasSelected) || isDoubleTap) {
          await this.runQuickCommandItem(p, item);
        } else {
          this.render();
        }
        return;
      }
      case 'runQuickCmd': {
        const p = this.store.list()[this.profileIdx];
        const items = this.getQuickCommandItems(p);
        if (payload !== null && payload !== undefined) {
          this.quickCmdIdx = payload;
        }
        const item = items[this.quickCmdIdx];
        await this.runQuickCommandItem(p, item);
        return;
      }
      case 'addQuickCmd': {
        const p = this.store.list()[this.profileIdx];
        if (p) this.openQuickCmdForm(p, null);
        return;
      }
      case 'editQuickCmd': {
        const p = this.store.list()[this.profileIdx];
        const item = this.getQuickCommandItems(p)[this.quickCmdIdx];
        if (p && item?.kind === 'custom') {
          this.openQuickCmdForm(p, item);
        } else {
          this.setStatus('请选择一条自定义快捷指令进行编辑', true);
          this.render();
        }
        return;
      }
      case 'deleteQuickCmd': {
        const p = this.store.list()[this.profileIdx];
        const item = this.getQuickCommandItems(p)[this.quickCmdIdx];
        if (!p || item?.kind !== 'custom') {
          this.setStatus('请选择一条自定义快捷指令进行删除', true);
          this.render();
          return;
        }
        this.openConfirmModal({
          title: '确认删除快捷指令',
          message: `确定要删除 "${item.name}" 吗？`,
          onConfirm: () => {
            this.store.removeQuickCommand(p.id, item.id);
            this.quickCmdIdx = Math.max(0, this.quickCmdIdx - 1);
            this.setStatus(`已删除快捷指令: ${item.name}`);
          },
        });
        return;
      }
      case 'connectProfile': {
        const p = this.store.list()[this.profileIdx];
        await this.runQuickCommandItem(p, { kind: 'shell' });
        return;
      }
      case 'newProfile':
        this.openProfileForm(null);
        return;
      case 'editProfile': {
        const p = this.store.list()[this.profileIdx];
        if (p) this.openProfileForm(p);
        return;
      }
      case 'moveProfileUp':
      case 'moveProfileDown': {
        const delta = action === 'moveProfileUp' ? -1 : 1;
        const nextIdx = this.store.moveProfile(this.profileIdx, delta);
        if (nextIdx >= 0) {
          this.profileIdx = nextIdx;
          this.setStatus(`已移动服务器: ${this.store.list()[nextIdx]?.name || ''}`);
          this.render();
        }
        return;
      }
      case 'deleteProfile': {
        const p = this.store.list()[this.profileIdx];
        if (!p) return;
        this.openConfirmModal({
          title: '确认删除 VPS',
          message: `确定要删除 "${p.name}" (${p.host}) 吗？`,
          onConfirm: () => {
            this.store.remove(p.id);
            this.profileIdx = Math.max(0, Math.min(this.profileIdx, this.store.list().length - 1));
            this.setStatus(`已删除 ${p.name}`);
          },
        });
        return;
      }
      case 'importSsh':
        this.openSshImportModal();
        return;
      case 'openSettings':
        this.openSettingsForm();
        return;
      case 'toggleAutoCopy': {
        const cur = this.store.getSettings().enableAutoCopy !== false;
        const next = !cur;
        this.store.updateSettings({ enableAutoCopy: next });
        if (!next) this._uiSel = null;
        this.setStatus(next ? '已开启界面选中自动复制' : '已关闭界面选中自动复制');
        this.render();
        return;
      }
      case 'pastePrivateKey':
        this.promptPastePrivateKey();
        return;

      // File browser actions
      case 'selectFile': {
        const wasSelected = this.fileIdx === payload;
        this.fileIdx = payload;
        const item = this.getFileListItems()[payload];
        const instantKinds = ['shell', 'quickCmd', 'up', 'pin'];
        if ((fromTap && (wasSelected || instantKinds.includes(item?.kind))) || isDoubleTap) {
          await this.activateFileItem(item);
        } else {
          this.render();
        }
        return;
      }
      case 'launchShellInDir':
        if (this.activeProfile) {
          await this.runQuickCommandItem(
            this.activeProfile,
            { kind: 'shell' },
            { overrideDir: this.currentDir.path }
          );
        }
        return;
      case 'addQuickCmdInDir':
        if (this.activeProfile) {
          this.openQuickCmdForm(this.activeProfile, { dir: this.currentDir.path });
        }
        return;
      case 'launchClaude':
        await this.launchClaudeInDir(this.currentDir.path, { mode: 'new' });
        return;
      case 'continueClaude':
        await this.launchClaudeInDir(this.currentDir.path, { mode: 'continue' });
        return;
      case 'goUp':
        await this.goUpDir();
        return;
      case 'goHome':
        await this.loadDirectory(this.activeProfile?.homeDir || '~');
        return;
      case 'toggleHidden':
        this.showHidden = !this.showHidden;
        await this.loadDirectory(this.currentDir.path, { force: true });
        return;
      case 'toggleDirElevate':
        this.dirElevate = !this.dirElevate;
        this.setStatus(this.dirElevate ? '已开启目录提权 (sudo)' : '已关闭目录临时提权');
        await this.loadDirectory(this.currentDir.path, { force: true });
        return;
      case 'togglePin':
        if (this.activeProfile) {
          const pinned = this.store.togglePinDir(this.activeProfile.id, this.currentDir.path);
          this.activeProfile = this.store.getById(this.activeProfile.id);
          this.setStatus(pinned ? `已收藏 ${this.currentDir.path}` : `已取消收藏 ${this.currentDir.path}`);
          this.render();
        }
        return;
      case 'newDir':
        this.promptNewDir();
        return;
      case 'renameDir':
        this.promptRenameDir();
        return;
      case 'jumpDir':
        this.promptJumpDir();
        return;
      case 'refreshDir':
        this.dirCache.clear();
        await this.loadDirectory(this.currentDir.path, { force: true });
        return;
      case 'searchDirSessions':
        this.sessionFilterCurrentDir = true;
        this.sessionKeyword = '';
        this.tab = 'sessions';
        await this.loadSessions({ keyword: '', force: true });
        return;

      // Session actions
      case 'selectSession': {
        const wasSelected = this.sessionIdx === payload;
        this.sessionIdx = payload;
        if ((fromTap && wasSelected) || isDoubleTap) {
          const s = this.sessions[this.sessionIdx];
          if (s) await this.resumeAgentSession(s);
        } else {
          this.render();
        }
        return;
      }
      case 'resumeSession': {
        const s = this.sessions[this.sessionIdx];
        if (s) await this.resumeAgentSession(s);
        return;
      }
      case 'forkSession': {
        const s = this.sessions[this.sessionIdx];
        if (s) await this.resumeAgentSession(s, { fork: true });
        return;
      }
      case 'openAgentPrompt': {
        if (!this.activeProfile) return;
        const agentType = this.getAgentTypeForTab();
        this.loadingText = `正在读取 ${agentType.toUpperCase()} 全局提示词...`;
        this.render();
        const res = await fetchAgentPrompt(agentType, this.activeProfile, this.store.getSettings());
        this.loadingText = '';
        if (!res.ok) {
          this.setStatus(res.error || '读取提示词失败', true);
          this.render();
          return;
        }
        const mdLines = res.content
          ? renderMarkdownLines(res.content, Math.max(40, this.term.getSize().cols - 12), ANSI.fg.white)
          : [{ text: `(文件尚未创建: ${res.path})`, style: ANSI.fg.gray }];
        this.modal = {
          type: 'preview',
          title: `📜 ${agentType.toUpperCase()} 全局提示词 (${res.path})`,
          lines: mdLines,
          scroll: 0,
          promptMeta: { agentType, path: res.path, content: res.content || '' },
        };
        this.render();
        return;
      }
      case 'editAgentPromptModal': {
        const meta =
          this.modal?.promptMeta ||
          (this.agentSubTab === 'prompt' && this.agentPromptData
            ? {
                agentType: this.agentPromptData.agentType,
                path: this.agentPromptData.path,
                content: this.agentPromptData.content || '',
              }
            : null);
        if (!meta || !this.activeProfile) return;
        this.openInputModal({
          title: `写入 ${meta.path}`,
          prompt: '输入要写入的内容 (长文本建议点"终端编辑"):',
          initialValue: meta.content.replace(/\r?\n/g, '\\n'),
          onSubmit: async (val) => {
            const text = val.replace(/\\n/g, '\n');
            const saveRes = meta.isMemory
              ? await saveClaudeMemory(this.activeProfile, meta.path, text, this.store.getSettings())
              : await saveAgentPrompt(meta.agentType, this.activeProfile, text, this.store.getSettings());
            this.setStatus(saveRes.ok ? `已保存 ${meta.path}` : saveRes.error || '保存失败', !saveRes.ok);
            if (saveRes.ok && this.agentSubTab === 'prompt') {
              await this.loadAgentPromptInline(meta.agentType, { force: true });
            } else {
              this.render();
            }
          },
        });
        return;
      }
      case 'editAgentPromptInTerminal': {
        const meta =
          this.modal?.promptMeta ||
          (this.agentSubTab === 'prompt' && this.agentPromptData
            ? { agentType: this.agentPromptData.agentType, path: this.agentPromptData.path }
            : null);
        if (!meta || !this.activeProfile) return;
        this.modal = null;
        await this.runQuickCommandItem(this.activeProfile, {
          kind: 'custom',
          name: `编辑 ${meta.agentType}`,
          command: `\${EDITOR:-nano} ${quoteSh(meta.path)} || vi ${quoteSh(meta.path)}`,
        });
        return;
      }
      case 'openAgentSkills':
      case 'refreshAgentSkills': {
        if (!this.activeProfile) return;
        const agentType = this.getAgentTypeForTab();
        this.loadingText = `正在扫描 ${agentType.toUpperCase()} Skills...`;
        this.render();
        const res = await fetchAgentSkills(agentType, this.activeProfile, this.store.getSettings());
        this.loadingText = '';
        if (!res.ok) {
          this.setStatus(res.error || '读取 Skills 失败', true);
          this.render();
          return;
        }
        this.modal = {
          type: 'agentSkills',
          title: `🛠 ${agentType.toUpperCase()} Skills (${res.root || ''})`,
          agentType,
          skills: res.skills,
          idx: 0,
          scroll: 0,
        };
        this.render();
        return;
      }
      case 'skillSelect':
        if (this.modal?.type === 'agentSkills') {
          this.modal.idx = payload;
          if (fromTap) return this.dispatchAction('skillPreview');
          this.render();
        }
        return;
      case 'skillPreview': {
        const sk =
          this.modal?.type === 'agentSkills'
            ? this.modal.skills[this.modal.idx]
            : this.agentSubTab === 'skills'
              ? this.agentSkillsData?.skills?.[this.agentSubIdx]
              : null;
        if (!sk) return;
        const mdLines = renderMarkdownLines(sk.content || '(空)', Math.max(40, this.term.getSize().cols - 12), ANSI.fg.white);
        this.modal = {
          type: 'preview',
          title: `🛠 Skill: ${sk.name}`,
          lines: mdLines,
          scroll: 0,
        };
        this.render();
        return;
      }
      case 'skillInstall': {
        if (!this.activeProfile) return;
        const agentType = this.modal?.type === 'agentSkills' ? this.modal.agentType : this.getAgentTypeForTab();
        this.modal = {
          type: 'profileForm',
          isSkillInstall: true,
          agentType,
          title: `安装 ${agentType.toUpperCase()} Skill`,
          focusIdx: 0,
          fields: [
            { key: 'name', label: 'Skill 名称 (目录名)', value: '' },
            { key: 'source', label: 'Git/URL 或内容', value: '' },
          ],
        };
        this.render();
        return;
      }
      case 'skillDelete': {
        if (!this.activeProfile) return;
        const isModal = this.modal?.type === 'agentSkills';
        const sk = isModal
          ? this.modal.skills[this.modal.idx]
          : this.agentSubTab === 'skills'
            ? this.agentSkillsData?.skills?.[this.agentSubIdx]
            : null;
        const agentType = isModal ? this.modal.agentType : this.getAgentTypeForTab();
        if (!sk) return;
        const res = await deleteAgentSkill(agentType, this.activeProfile, sk.dir, this.store.getSettings());
        if (!res.ok) {
          this.setStatus(res.error || '删除 Skill 失败', true);
          this.render();
          return;
        }
        this.setStatus(`已删除 Skill: ${sk.name}`);
        if (isModal) return this.dispatchAction('refreshAgentSkills');
        return this.loadAgentSkillsInline(agentType, { force: true });
      }
      case 'openAgentMcp':
      case 'refreshAgentMcp': {
        if (!this.activeProfile) return;
        const agentType = this.getAgentTypeForTab();
        this.loadingText = `正在读取 ${agentType.toUpperCase()} MCP 配置...`;
        this.render();
        const res = await fetchAgentMcp(agentType, this.activeProfile, this.store.getSettings());
        this.loadingText = '';
        if (!res.ok) {
          this.setStatus(res.error || '读取 MCP 失败', true);
          this.render();
          return;
        }
        this.modal = {
          type: 'agentMcp',
          title: `🔌 ${agentType.toUpperCase()} MCP (${res.path || ''})`,
          agentType,
          items: res.items,
          idx: 0,
          scroll: 0,
        };
        this.render();
        return;
      }
      case 'mcpSelect':
        if (this.modal?.type === 'agentMcp') {
          this.modal.idx = payload;
          this.render();
        }
        return;
      case 'mcpAdd': {
        if (!this.activeProfile) return;
        const isModal = this.modal?.type === 'agentMcp';
        const agentType = isModal ? this.modal.agentType : this.getAgentTypeForTab();
        const cur = isModal
          ? this.modal.items[this.modal.idx]
          : this.agentSubTab === 'mcp'
            ? this.agentMcpData?.items?.[this.agentSubIdx]
            : null;
        this.modal = {
          type: 'profileForm',
          isMcpForm: true,
          agentType,
          title: `配置 ${agentType.toUpperCase()} MCP`,
          focusIdx: 0,
          fields: [
            { key: 'name', label: 'MCP 名称', value: cur?.name || '' },
            { key: 'command', label: '命令或 URL', value: cur?.command || '' },
            { key: 'args', label: '参数 (空格分隔)', value: (cur?.args || []).join(' ') },
            {
              key: 'env',
              label: '环境变量 (K=V,逗号分隔)',
              value: Object.entries(cur?.env || {})
                .map(([k, v]) => `${k}=${v}`)
                .join(', '),
            },
          ],
        };
        this.render();
        return;
      }
      case 'mcpDelete': {
        if (!this.activeProfile) return;
        const isModal = this.modal?.type === 'agentMcp';
        const item = isModal
          ? this.modal.items[this.modal.idx]
          : this.agentSubTab === 'mcp'
            ? this.agentMcpData?.items?.[this.agentSubIdx]
            : null;
        const agentType = isModal ? this.modal.agentType : this.getAgentTypeForTab();
        if (!item) return;
        const res = await deleteAgentMcp(agentType, this.activeProfile, item.name, this.store.getSettings());
        if (!res.ok) {
          this.setStatus(res.error || '删除 MCP 失败', true);
          this.render();
          return;
        }
        this.setStatus(`已删除 MCP: ${item.name}`);
        if (isModal) return this.dispatchAction('refreshAgentMcp');
        return this.loadAgentMcpInline(agentType, { force: true });
      }
      case 'openClaudeMemory':
      case 'refreshClaudeMemory': {
        if (!this.activeProfile) return;
        this.loadingText = '正在扫描 Claude 分项目 Memory...';
        this.render();
        const res = await fetchClaudeMemory(this.activeProfile, this.store.getSettings());
        this.loadingText = '';
        if (!res.ok) {
          this.setStatus(res.error || '读取 Memory 失败', true);
          this.render();
          return;
        }
        this.modal = {
          type: 'claudeMemory',
          title: '🧠 Claude Code 分项目 Memory',
          items: res.items,
          idx: 0,
          scroll: 0,
        };
        this.render();
        return;
      }
      case 'memorySelect':
        if (this.modal?.type === 'claudeMemory') {
          this.modal.idx = payload;
          if (fromTap) return this.dispatchAction('memoryPreview');
          this.render();
        }
        return;
      case 'memoryPreview': {
        const item =
          this.modal?.type === 'claudeMemory'
            ? this.modal.items[this.modal.idx]
            : this.agentSubTab === 'memory'
              ? this.claudeMemoryData?.items?.[this.agentSubIdx]
              : null;
        if (!item) return;
        const mdLines = renderMarkdownLines(
          item.content || '(空)',
          Math.max(40, this.term.getSize().cols - 12),
          ANSI.fg.white
        );
        this.modal = {
          type: 'preview',
          title: `🧠 ${path.posix.basename(item.project || '') || item.project} / ${item.name}`,
          lines: mdLines,
          scroll: 0,
          promptMeta: { agentType: 'claude', isMemory: true, path: item.path, content: item.content || '' },
        };
        this.render();
        return;
      }
      case 'memoryDelete': {
        if (!this.activeProfile) return;
        const isModal = this.modal?.type === 'claudeMemory';
        const item = isModal
          ? this.modal.items[this.modal.idx]
          : this.agentSubTab === 'memory'
            ? this.claudeMemoryData?.items?.[this.agentSubIdx]
            : null;
        if (!item) return;
        const res = await deleteClaudeMemory(this.activeProfile, item.path, this.store.getSettings());
        if (!res.ok) {
          this.setStatus(res.error || '删除 Memory 失败', true);
          this.render();
          return;
        }
        this.setStatus(`已删除 Memory: ${item.name}`);
        if (isModal) return this.dispatchAction('refreshClaudeMemory');
        return this.loadClaudeMemoryInline({ force: true });
      }
      case 'previewSession': {
        const s = this.sessions[this.sessionIdx];
        if (s) await this.openSessionPreview(s);
        return;
      }
      case 'searchSessions':
        this.openInputModal({
          title: '查找 Claude Code 会话',
          prompt: '输入关键词 (留空显示全部):',
          initialValue: this.sessionKeyword,
          onSubmit: async (val) => {
            this.sessionKeyword = val.trim();
            await this.loadSessions({ keyword: this.sessionKeyword, force: true });
          },
        });
        return;
      case 'toggleSessionScope':
        this.sessionFilterCurrentDir = !this.sessionFilterCurrentDir;
        await this.loadSessions({ force: true });
        return;
      case 'refreshSessions':
        await this.loadSessions({ force: true });
        return;

      // Modal actions
      case 'modalCancel':
        this.modal = null;
        this.render();
        return;
      case 'modalSubmit':
        await this.submitModal();
        return;
      case 'modalClearInput':
        if (this.modal?.type === 'input') {
          this.modal.value = '';
          this.modal.cursor = 0;
          this.render();
        }
        return;
      case 'modalBackdrop':
        if (this.modal?.type === 'profileForm' && this.modal.keyDropdownOpen) {
          this.modal.keyDropdownOpen = false;
          this.render();
        }
        return;
      case 'modalNoop':
        if (this.modal?.type === 'profileForm' && this.modal.keyDropdownOpen) {
          this.modal.keyDropdownOpen = false;
          this.render();
        }
        return;
      case 'modalInputClick':
        if (this.modal?.type === 'input') {
          const startX = payload?.textStartX ?? 0;
          const sliceStart = this.modal._sliceStart || 0;
          const prefixCols = sliceStart > 0 ? 1 : 0;
          this.modal.cursor = findCursorIndexForX(this.modal.value, x - startX - prefixCols, sliceStart);
          this.render();
        }
        return;
      case 'modalFocusField':
        if (this.modal?.type === 'profileForm') {
          const f = this.modal.fields[payload];
          const wasFocused = this.modal.focusIdx === payload;
          this.modal.focusIdx = payload;
          if (f) {
            const startX = this.modal._inputStartX;
            if (fromTap && typeof startX === 'number' && x >= startX) {
              const sliceStart = f._sliceStart || 0;
              const prefixCols = sliceStart > 0 ? 1 : 0;
              f.cursor = findCursorIndexForX(f.value, x - startX - prefixCols, sliceStart);
            } else if (typeof f.cursor !== 'number') {
              f.cursor = String(f.value || '').length;
            }
          }
          if (!this.modal.isSettings && !this.modal.isQuickCmd && f?.key === 'identityFile' && this.modal.keyCandidates?.length > 0) {
            this.modal.keyDropdownOpen = wasFocused ? !this.modal.keyDropdownOpen : true;
            if (this.modal.keyDropdownOpen) {
              const curIdx = this.modal.keyCandidates.indexOf(f.value);
              this.modal.keyDropdownIdx = curIdx >= 0 ? curIdx : 0;
            }
          } else {
            this.modal.keyDropdownOpen = false;
          }
          this.render();
        }
        return;
      case 'selectKeyCandidate':
        if (this.modal?.type === 'profileForm') {
          const f = this.modal.fields.find((item) => item.key === 'identityFile');
          const picked = this.modal.keyCandidates?.[payload];
          if (f && picked !== undefined) {
            f.value = picked;
          }
          this.modal.keyDropdownOpen = false;
          this.render();
        }
        return;
      case 'previewScrollUp':
        if (this.modal?.type === 'preview') {
          this.modal.scroll = Math.max(0, this.modal.scroll - 5);
          this.render();
        }
        return;
      case 'previewScrollDown':
        if (this.modal?.type === 'preview') {
          this.modal.scroll = Math.min(
            Math.max(0, this.modal.lines.length - 6),
            this.modal.scroll + 5
          );
          this.render();
        }
        return;
      case 'previewResume':
        if (this.modal?.type === 'preview') {
          const s = this.modal.session;
          const agentType = this.modal.agentType || 'claude';
          this.modal = null;
          await this.resumeAgentSession(s, { agentType });
        }
        return;
      case 'sshImportSelect':
        if (this.modal?.type === 'sshImport') {
          this.modal.idx = payload;
          if (fromTap) {
            await this.submitModal();
          } else {
            this.render();
          }
        }
        return;
    }
  }

  async activateFileItem(item) {
    if (!item) return;
    if (item.kind === 'shell') {
      await this.runQuickCommandItem(
        this.activeProfile,
        { kind: 'shell' },
        { overrideDir: this.currentDir.path }
      );
    } else if (item.kind === 'quickCmd' && item.quickCmd) {
      await this.runQuickCommandItem(
        this.activeProfile,
        { kind: 'custom', ...item.quickCmd },
        { overrideDir: this.currentDir.path }
      );
    } else if (item.kind === 'launch') {
      await this.launchClaudeInDir(this.currentDir.path, { mode: 'new' });
    } else if (item.kind === 'continue') {
      await this.launchClaudeInDir(this.currentDir.path, { mode: 'continue' });
    } else if (item.kind === 'sessions') {
      await this.dispatchAction('searchDirSessions');
    } else if (item.kind === 'up') {
      await this.goUpDir();
    } else if (item.kind === 'pin') {
      await this.loadDirectory(item.name);
    } else if (item.kind === 'dir') {
      const next = `${this.currentDir.path.replace(/\/+$/, '')}/${item.name}`;
      await this.loadDirectory(next);
    }
  }

  async goUpDir() {
    if (this.currentDir.path === '/') return;
    const trimmed = this.currentDir.path.replace(/\/+$/, '');
    const leaf = trimmed.replace(/^.*\//, '');
    const parent = trimmed.replace(/\/[^/]*$/, '') || '/';
    await this.loadDirectory(parent, { selectName: leaf });
  }

  promptNewDir() {
    this.openInputModal({
      title: '新建远程文件夹',
      prompt: `在 ${this.currentDir.path} 下创建:`,
      initialValue: '',
      onSubmit: async (name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const res = await createRemoteDir(this.activeProfile, this.currentDir.path, trimmed, {
          elevate: this.isDirElevate(this.activeProfile),
        });
        if (!res.ok) {
          this.setStatus(`创建失败: ${res.error}`, true);
          this.render();
          return;
        }
        this.dirCache.clear();
        await this.loadDirectory(this.currentDir.path, { selectName: trimmed, force: true });
        this.setStatus(`已创建 ${trimmed}`);
        this.render();
      },
    });
  }

  promptRenameDir() {
    const cur = this.getFileListItems()[this.fileIdx];
    if (!cur || cur.kind !== 'dir') {
      this.setStatus('请先选中要重命名的目录', true);
      this.render();
      return;
    }
    this.openInputModal({
      title: '重命名文件夹',
      prompt: `将 "${cur.name}" 重命名为:`,
      initialValue: cur.name,
      onSubmit: async (newName) => {
        const trimmed = newName.trim();
        if (!trimmed || trimmed === cur.name) return;
        const res = await renameRemoteDir(
          this.activeProfile,
          this.currentDir.path,
          cur.name,
          trimmed,
          this.store.getSettings(),
          { elevate: this.isDirElevate(this.activeProfile) }
        );
        if (!res.ok) {
          this.setStatus(`重命名失败: ${res.error}`, true);
          this.render();
          return;
        }
        this.dirCache.clear();
        await this.loadDirectory(this.currentDir.path, { selectName: trimmed, force: true });
        this.setStatus(`已重命名为 ${trimmed}`);
        this.render();
      },
    });
  }

  promptJumpDir() {
    this.openInputModal({
      title: '跳转到远程路径',
      prompt: '输入远程路径 (如 ~/projects 或 /var/www):',
      initialValue: this.currentDir.path,
      onSubmit: async (p) => {
        const trimmed = p.trim();
        if (trimmed) await this.loadDirectory(trimmed);
      },
    });
  }

  promptPastePrivateKey() {
    const raw = readClipboardText();
    const check = normalizePrivateKey(raw);
    if (!check.ok) {
      this.setStatus(check.error, true);
      this.render();
      return;
    }
    this.openInputModal({
      title: '保存剪贴板私钥到当前目录',
      prompt: `保存到 ${process.cwd()} (文件名):`,
      initialValue: 'vps_key.pem',
      onSubmit: (filename) => {
        const res = savePrivateKeyFile(process.cwd(), filename, raw);
        if (!res.ok) {
          this.setStatus(`保存私钥失败: ${res.error}`, true);
        } else {
          const relPath = path.relative(process.cwd(), res.path).replace(/\\/g, '/');
          this.lastSavedKeyPath = relPath;
          this.setStatus(`已保存私钥: ${relPath} (${res.permNote})`);
        }
        this.render();
      },
    });
  }

  async submitModal() {
    const m = this.modal;
    if (!m) return;
    if (m.type === 'input') {
      this.modal = null;
      await m.onSubmit(m.value);
      return;
    }
    if (m.type === 'confirm') {
      this.modal = null;
      await m.onConfirm();
      this.render();
      return;
    }
    if (m.type === 'profileForm') {
      if (m.isTimeRange && m.parentTokenStats) {
        const startVal = (m.fields.find((f) => f.key === 'startTime')?.value || '').trim();
        const endRaw = (m.fields.find((f) => f.key === 'endTime')?.value || '').trim();
        const endVal =
          endRaw.toLowerCase() === 'now' || endRaw === '现在' || endRaw === '到现在'
            ? formatLocalDateTimeNow()
            : endRaw;
        const parent = m.parentTokenStats;
        parent.startTime = startVal;
        parent.endTime = endVal;
        parent.preset = startVal || endVal ? 'custom' : 'all';
        parent.stats = aggregateTokenStats(parent.rawRecords, { startTime: startVal, endTime: endVal });
        parent.idx = 0;
        parent.scroll = 0;
        this.modal = parent;
        this.render();
        return;
      }
      if (m.isSkillInstall) {
        const name = (m.fields.find((f) => f.key === 'name')?.value || '').trim();
        const source = (m.fields.find((f) => f.key === 'source')?.value || '').trim();
        if (!name) {
          this.setStatus('Skill 名称不能为空', true);
          this.render();
          return;
        }
        const res = await installAgentSkill(
          m.agentType,
          this.activeProfile,
          { name, source },
          this.store.getSettings()
        );
        if (!res.ok) {
          this.setStatus(res.error || '安装 Skill 失败', true);
          this.render();
          return;
        }
        if (this.isAgentTab() && this.agentSubTab === 'skills') {
          this.modal = null;
          this.setStatus(`已安装 Skill: ${res.name}`);
          await this.loadAgentSkillsInline(m.agentType, { force: true });
          return;
        }
        this.modal = { type: 'agentSkills', agentType: m.agentType };
        this.setStatus(`已安装 Skill: ${res.name}`);
        await this.dispatchAction('refreshAgentSkills');
        return;
      }
      if (m.isMcpForm) {
        const name = (m.fields.find((f) => f.key === 'name')?.value || '').trim();
        const command = (m.fields.find((f) => f.key === 'command')?.value || '').trim();
        const argsRaw = (m.fields.find((f) => f.key === 'args')?.value || '').trim();
        const envRaw = (m.fields.find((f) => f.key === 'env')?.value || '').trim();
        if (!name || !command) {
          this.setStatus('MCP 名称和命令/URL 不能为空', true);
          this.render();
          return;
        }
        const args = argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [];
        const env = {};
        if (envRaw) {
          for (const pair of envRaw.split(/[,，]/)) {
            const idx = pair.indexOf('=');
            if (idx > 0) {
              env[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
            }
          }
        }
        const res = await upsertAgentMcp(
          m.agentType,
          this.activeProfile,
          { name, command, args, env },
          this.store.getSettings()
        );
        if (!res.ok) {
          this.setStatus(res.error || '保存 MCP 失败', true);
          this.render();
          return;
        }
        if (this.isAgentTab() && this.agentSubTab === 'mcp') {
          this.modal = null;
          this.setStatus(`已保存 MCP: ${name}`);
          await this.loadAgentMcpInline(m.agentType, { force: true });
          return;
        }
        this.modal = { type: 'agentMcp', agentType: m.agentType };
        this.setStatus(`已保存 MCP: ${name}`);
        await this.dispatchAction('refreshAgentMcp');
        return;
      }
      if (m.isQuickCmd) {
        const nameField = m.fields.find((f) => f.key === 'name')?.value || '';
        const cmdField = m.fields.find((f) => f.key === 'command')?.value || '';
        const dirField = m.fields.find((f) => f.key === 'dir')?.value || '';
        if (!cmdField.trim()) {
          this.setStatus('执行命令不能为空', true);
          this.render();
          return;
        }
        const savedCmd = this.store.upsertQuickCommand(m.profileId, {
          id: m.cmdId,
          name: nameField.trim() || cmdField.trim(),
          command: cmdField.trim(),
          dir: dirField.trim(),
        });
        this.modal = null;
        if (savedCmd) {
          const p = this.store.getById(m.profileId);
          if (this.activeProfile?.id === p?.id) this.activeProfile = p;
          const items = this.getQuickCommandItems(p);
          const found = items.findIndex((it) => it.id === savedCmd.id);
          if (found >= 0) this.quickCmdIdx = found;
          this.setStatus(`已保存快捷指令: ${savedCmd.name}`);
        }
        this.render();
        return;
      }
      if (m.isSettings) {
        const patch = {};
        for (const f of m.fields) {
          if (
            f.key === 'showHiddenByDefault' ||
            f.key === 'enableImageClipboard' ||
            f.key === 'enableAutoCopy' ||
            f.key === 'showMotd'
          ) {
            patch[f.key] = f.value.trim().toLowerCase() === 'true';
          } else {
            patch[f.key] = f.value;
          }
        }
        const updated = this.store.updateSettings(patch);
        this.showHidden = updated.showHiddenByDefault;
        this.modal = null;
        this.setStatus('全局设置已保存');
        this.render();
        return;
      }
      const obj = { id: m.id };
      for (const f of m.fields) obj[f.key] = f.value;
      if (!obj.host.trim()) {
        this.setStatus('主机/IP (Host) 不能为空', true);
        this.render();
        return;
      }
      if (!obj.name.trim()) obj.name = obj.host.trim();
      obj.disabledPlugins = String(obj.disabledPlugins || '')
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter(Boolean);
      const existing = m.id ? this.store.getById(m.id) : null;
      if (existing) {
        obj.lastDir = existing.lastDir;
        obj.pinnedDirs = existing.pinnedDirs;
        obj.quickCommands = existing.quickCommands;
        obj.claudeCommand = existing.claudeCommand;
      }
      const saved = this.store.upsert(obj);
      if (this.activeProfile?.id === saved.id) this.activeProfile = saved;
      const idx = this.store.list().findIndex((p) => p.id === saved.id);
      if (idx >= 0) this.profileIdx = idx;
      this.modal = null;
      if (this.store.secretWarning) this.setStatus(`已保存服务器: ${saved.name} - ${this.store.secretWarning}`, true);
      else this.setStatus(`已保存服务器: ${saved.name}`);
      this.render();
      return;
    }
    if (m.type === 'sshImport') {
      const cand = m.candidates[m.idx];
      if (cand) {
        const saved = this.store.upsert(cand);
        const idx = this.store.list().findIndex((p) => p.id === saved.id);
        if (idx >= 0) this.profileIdx = idx;
        this.setStatus(`已导入 SSH 配置: ${saved.name}`);
      }
      this.modal = null;
      this.render();
    }
  }

  async handleKey(ev) {
    if (this.modal) {
      await this.handleModalKey(ev);
      return;
    }

    if (this.tab === 'terminal') {
      if (ev.ctrl && ev.name === 'q') return this.stop();
      // Alt+number to switch tabs (including dynamic plugin tabs)
      if (ev.alt && ev.name >= '1' && ev.name <= '9') {
        const pluginTabs = this.plugins.getEnabledTabs();
        const navTabs = ['profiles', 'files', 'terminal', ...pluginTabs.map((t) => t.id)];
        const idx = Number(ev.name) - 1;
        if (idx < navTabs.length) return this.dispatchAction('switchTab', navTabs[idx]);
        return;
      }
      if (ev.alt && (ev.name === '[' || ev.name === ']') && this.serverTabs.length > 1) {
        const curIdx = this.serverTabs.findIndex((t) => t.id === this.activeServerTabId);
        const baseIdx = curIdx >= 0 ? curIdx : 0;
        const step = ev.name === ']' ? 1 : -1;
        const nextIdx = (baseIdx + step + this.serverTabs.length) % this.serverTabs.length;
        return this.dispatchAction('switchServerTab', this.serverTabs[nextIdx].id);
      }
      if (ev.alt && ev.name === 'v') return this.dispatchAction('pasteImageToTerminal');
      if (ev.alt && ev.name === 'm') {
        this.terminalMouseMode = !this.terminalMouseMode;
        this.setStatus(
          this.terminalMouseMode
            ? '已开启终端鼠标/触控点击模式 (可点击顶部标签，Alt+M 切回原生选字)'
            : '已切回原生选字模式 (可直接拖拽选中文字，Alt+数字 切换面板)'
        );
        this.render();
        return;
      }
      const curTab = this.getActiveTab();
      const ts = curTab?.termSession;
      if (ts) {
        if (ts.exited) {
          if (ev.name === 'enter' || ev.name === 'escape') {
            curTab.termSession = null;
            this.tab = 'profiles';
            this.render();
          }
          return;
        }
        ts.vterm?.resetScroll();
        const bytes = ev.raw || ev.char || '';
        if (bytes && ts.proc?.stdin?.writable) {
          ts.proc.stdin.write(bytes);
        }
      }
      return;
    }

    if (ev.ctrl && ev.name === 'c') return this.stop();

    // Pure-keyboard TUI navigation for top & bottom button bars (Shift+Tab / F6 / F10) and Action Palette (? / F1 / Ctrl+P)
    if (ev.name === '?' || ev.char === '?' || ev.name === 'f1' || (ev.ctrl && ev.name === 'p')) {
      this.openActionPalette();
      return;
    }
    if (ev.name === 'shift-tab' || ev.name === 'f6' || ev.name === 'f10') {
      this._resetTabCloseCharge();
      const candidateZones = ['content', 'top', 'sub', 'bottom'];
      const zones = candidateZones.filter(
        (z) => z === 'content' || this.getZoneButtons(this._lastScreen, z).length > 0
      );
      const curIdx = zones.indexOf(this.uiFocusZone);
      const nextZone = zones[(curIdx >= 0 ? curIdx + 1 : 0) % zones.length];
      this.uiFocusZone = nextZone;
      this.uiFocusBtnIdx = 0;
      if (nextZone === 'content') {
        this.setStatus('焦点已切换到内容列表 (↑/↓ 选择 | ←/→ 切子标签 | Enter 确认 | Shift+Tab 切区域 | Esc 顶部栏)');
      }
      this.render();
      return;
    }

    // Esc in content zone → switch focus to top bar (pure-keyboard navigation)
    if (ev.name === 'escape' && this.uiFocusZone === 'content') {
      this.uiFocusZone = 'top';
      this.uiFocusBtnIdx = 0;
      this.render();
      return;
    }

    if (this.uiFocusZone !== 'content') {
      const btns = this.getZoneButtons(this._lastScreen, this.uiFocusZone);
      if (ev.name === 'escape') {
        this._resetTabCloseCharge();
        this.uiFocusZone = 'content';
        this.render();
        return;
      }
      // Long-press 'w' to close server tab (charge bar mechanic)
      if (ev.char === 'w' && this.uiFocusZone === 'top') {
        const focusedBtn = btns[Math.max(0, Math.min(btns.length - 1, this.uiFocusBtnIdx))];
        const isServerTabBtn = focusedBtn && focusedBtn.action === 'switchServerTab';
        if (isServerTabBtn) {
          const tabId = focusedBtn.payload;
          const now = Date.now();
          const CHARGE_STEPS = 6;
          const MAX_GAP_MS = 300; // reset if gap between presses exceeds this
          if (this.tabCloseCharge.tabId === tabId && now - this.tabCloseCharge.lastTime < MAX_GAP_MS) {
            this.tabCloseCharge.count++;
          } else {
            this.tabCloseCharge = { tabId, count: 1, lastTime: now, timer: null };
          }
          this.tabCloseCharge.lastTime = now;
          // Reset charge after inactivity
          clearTimeout(this.tabCloseCharge.timer);
          this.tabCloseCharge.timer = setTimeout(() => {
            if (this.tabCloseCharge.tabId === tabId) {
              this.tabCloseCharge = { tabId: null, count: 0, lastTime: 0, timer: null };
              this.render();
            }
          }, MAX_GAP_MS + 50);
          if (this.tabCloseCharge.count >= CHARGE_STEPS) {
            this._resetTabCloseCharge();
            await this.closeServerTab(tabId);
            return;
          }
          this.render();
          return;
        }
      }
      // Any other key resets the charge
      if (ev.char !== 'w') this._resetTabCloseCharge();
      if (btns.length > 0) {
        if (ev.name === 'left' || ev.name === 'up') {
          this.uiFocusBtnIdx = (this.uiFocusBtnIdx - 1 + btns.length) % btns.length;
          this.render();
          return;
        }
        if (ev.name === 'right' || ev.name === 'down') {
          this.uiFocusBtnIdx = (this.uiFocusBtnIdx + 1) % btns.length;
          this.render();
          return;
        }
        if (ev.name === 'enter' || ev.name === 'space') {
          const picked = btns[Math.max(0, Math.min(btns.length - 1, this.uiFocusBtnIdx))];
          this.uiFocusZone = 'content';
          if (picked) return this.dispatchAction(picked.action, picked.payload);
          this.render();
          return;
        }
      }
      this.uiFocusZone = 'content';
    }

    // Global tab switching (core SSH tabs + enabled plugin tabs)
    const pluginTabs = this.plugins.getEnabledTabs();
    const navTabs = ['profiles', 'files', 'terminal', ...pluginTabs.map((t) => t.id)];
    const numKey = Number(ev.name);
    if (numKey >= 1 && numKey <= navTabs.length) {
      return this.dispatchAction('switchTab', navTabs[numKey - 1]);
    }
    if ((ev.char === '[' || ev.char === ']') && !this.isAgentTab() && this.tab !== 'docker' && this.serverTabs.length > 1) {
      const curIdx = this.serverTabs.findIndex((t) => t.id === this.activeServerTabId);
      const baseIdx = curIdx >= 0 ? curIdx : 0;
      const step = ev.char === ']' ? 1 : -1;
      const nextIdx = (baseIdx + step + this.serverTabs.length) % this.serverTabs.length;
      return this.dispatchAction('switchServerTab', this.serverTabs[nextIdx].id);
    }
    if (ev.name === 'tab') {
      const order = this.activeProfile
        ? ['profiles', 'files', ...pluginTabs.map((t) => t.id)]
        : ['profiles', ...pluginTabs.map((t) => t.id)];
      const curIdx = order.indexOf(this.tab);
      const next = order[(curIdx >= 0 ? curIdx + 1 : 0) % order.length];
      return this.dispatchAction('switchTab', next);
    }

    if (this.tab !== 'terminal') {
      if (ev.char === '1') return this.dispatchAction('switchTab', 'profiles');
      if (ev.char === '2') return this.dispatchAction('switchTab', 'files');
      if (ev.char === '3') return this.dispatchAction('switchTab', 'terminal');
      if (ev.char >= '4' && ev.char <= '9') {
        const pluginTabs = this.plugins.getEnabledTabs();
        const pt = pluginTabs[Number(ev.char) - 4];
        if (pt) return this.dispatchAction('switchTab', pt.id);
      }
      if (ev.char === 'P' || (ev.alt && ev.name === 'p')) return this.dispatchAction('openPlugins');
      if (ev.char === ',' || (ev.alt && ev.name === 's')) return this.dispatchAction('openSettings');
    }

    if (this.tab === 'profiles') {
      const list = this.store.list();
      const landscape = this.isLandscape();
      const inCommands = landscape ? this.profilePane === 'commands' : this.portraitView === 'commands';

      if (inCommands) {
        const p = list[this.profileIdx];
        const items = this.getQuickCommandItems(p);
        if (ev.name === 'up' && items.length > 0) this.quickCmdIdx = Math.max(0, this.quickCmdIdx - 1);
        else if (ev.name === 'down' && items.length > 0) {
          this.quickCmdIdx = Math.min(items.length - 1, this.quickCmdIdx + 1);
        } else if (ev.name === 'left' && landscape) {
          this.profilePane = 'servers';
        } else if (ev.name === 'escape' || ev.name === 'backspace') {
          if (!landscape) return this.dispatchAction('backToServers');
          this.profilePane = 'servers';
        } else if (ev.name === 'enter') {
          return this.dispatchAction('runQuickCmd');
        } else if (ev.char === 'c' || ev.char === '+') {
          return this.dispatchAction('addQuickCmd');
        } else if (ev.char === 'e' || ev.name === 'f2') {
          return this.dispatchAction('editQuickCmd');
        } else if (ev.char === 'd' || ev.name === 'delete') {
          return this.dispatchAction('deleteQuickCmd');
        } else if (ev.char === 'q') {
          return this.stop();
        }
      } else {
        if ((ev.shift && ev.name === 'up') || ev.char === 'K') return this.dispatchAction('moveProfileUp');
        if ((ev.shift && ev.name === 'down') || ev.char === 'J') return this.dispatchAction('moveProfileDown');
        if (ev.name === 'up' && list.length > 0) {
          const next = Math.max(0, this.profileIdx - 1);
          if (next !== this.profileIdx) {
            this.profileIdx = next;
            this.quickCmdIdx = 0;
            this.quickCmdScroll = 0;
          }
        } else if (ev.name === 'down' && list.length > 0) {
          const next = Math.min(list.length - 1, this.profileIdx + 1);
          if (next !== this.profileIdx) {
            this.profileIdx = next;
            this.quickCmdIdx = 0;
            this.quickCmdScroll = 0;
          }
        } else if (ev.name === 'right' && list.length > 0) {
          if (landscape) this.profilePane = 'commands';
          else {
            this.portraitView = 'commands';
            this.profilePane = 'commands';
          }
        } else if (ev.name === 'enter' && list.length > 0) {
          if (!landscape) {
            this.portraitView = 'commands';
            this.profilePane = 'commands';
          } else {
            return this.dispatchAction('connectProfile');
          }
        } else if (ev.char === 'n' || ev.char === 'a') return this.dispatchAction('newProfile');
        else if (ev.char === 'e' || ev.name === 'f2') return this.dispatchAction('editProfile');
        else if (ev.char === 'd' || ev.name === 'delete') return this.dispatchAction('deleteProfile');
        else if (ev.char === 'i') return this.dispatchAction('importSsh');
        else if (ev.char === 'k') return this.dispatchAction('pastePrivateKey');
        else if (ev.char === 'c') return this.dispatchAction('addQuickCmd');
        else if (ev.char === 'q' || ev.name === 'escape') return this.stop();
      }
      this.render();
      return;
    }

    if (this.tab === 'files') {
      const items = this.getFileListItems();
      if (ev.name === 'up') this.fileIdx = (this.fileIdx - 1 + items.length) % items.length;
      else if (ev.name === 'down') this.fileIdx = (this.fileIdx + 1) % items.length;
      else if (ev.name === 'home') this.fileIdx = 0;
      else if (ev.name === 'end') this.fileIdx = items.length - 1;
      else if (ev.name === 'pageup') this.fileIdx = Math.max(0, this.fileIdx - 10);
      else if (ev.name === 'pagedown') this.fileIdx = Math.min(items.length - 1, this.fileIdx + 10);
      else if (ev.name === 'left' || ev.name === 'backspace') return this.dispatchAction('goUp');
      else if (ev.name === 'right') {
        const cur = items[this.fileIdx];
        if (cur && (cur.kind === 'dir' || cur.kind === 'up' || cur.kind === 'pin')) {
          return this.activateFileItem(cur);
        }
      } else if (ev.name === 'enter') return this.activateFileItem(items[this.fileIdx]);
      else if (ev.name === 'space') return this.dispatchAction('launchClaude');
      else if (ev.char === 'c') return this.dispatchAction('continueClaude');
      else if (ev.char === 'n') return this.dispatchAction('newDir');
      else if (ev.char === 'r' || ev.name === 'f2') return this.dispatchAction('renameDir');
      else if (ev.char === '.') return this.dispatchAction('toggleHidden');
      else if (ev.char === 'h' || ev.char === '~') return this.dispatchAction('goHome');
      else if (ev.char === 'g') return this.dispatchAction('jumpDir');
      else if (ev.char === 'p') return this.dispatchAction('togglePin');
      else if (ev.char === 's' || ev.char === '/') return this.dispatchAction('searchDirSessions');
      else if (ev.char === 'R') return this.dispatchAction('refreshDir');
      else if (ev.name === 'escape' || ev.char === 'q') return this.dispatchAction('switchTab', 'profiles');
      this.render();
      return;
    }

    if (this.tab === 'docker') {
      const subTabs = ['containers', 'images', 'compose', 'networks', 'volumes'];
      if (ev.name === 'left' || ev.name === 'right') {
        const curIdx = Math.max(0, subTabs.indexOf(this.dockerSubTab));
        const nextIdx = (curIdx + (ev.name === 'right' ? 1 : -1) + subTabs.length) % subTabs.length;
        return this.dispatchAction('dockerSubTab', subTabs[nextIdx]);
      }
      if (ev.char === '[' || ev.char === ']') {
        const pluginId = this.plugins.getPluginIdForTab('docker');
        const eligible = this.store
          .list()
          .filter((p) => !pluginId || !this.plugins.isDisabledForProfile(pluginId, p));
        if (eligible.length > 1) {
          const curIdx = Math.max(0, eligible.findIndex((p) => p.id === this.activeProfile?.id));
          const nextIdx = (curIdx + (ev.char === ']' ? 1 : -1) + eligible.length) % eligible.length;
          return this.dispatchAction('switchDockerServer', eligible[nextIdx].id);
        }
      }
      const len = this.getDockerListItems().length;
      if (ev.name === 'up' && len > 0) this.dockerIdx = Math.max(0, this.dockerIdx - 1);
      else if (ev.name === 'down' && len > 0) this.dockerIdx = Math.min(len - 1, this.dockerIdx + 1);
      else if (ev.name === 'home' && len > 0) this.dockerIdx = 0;
      else if (ev.name === 'end' && len > 0) this.dockerIdx = len - 1;
      else if (ev.name === 'pageup' && len > 0) this.dockerIdx = Math.max(0, this.dockerIdx - 8);
      else if (ev.name === 'pagedown' && len > 0) this.dockerIdx = Math.min(len - 1, this.dockerIdx + 8);
      else if (ev.name === 'enter') {
        if (this.dockerSubTab === 'containers') return this.dispatchAction('dockerExec');
        if (this.dockerSubTab === 'compose') return this.dispatchAction('dockerRestart');
      } else if (ev.char === '/') return this.dispatchAction('dockerSearch');
      else if (ev.char === 'o' && this.dockerSubTab === 'containers') return this.dispatchAction('dockerToggleRunning');
      else if (ev.char === 'S' && this.dockerSubTab === 'containers') return this.dispatchAction('dockerStats');
      else if (ev.char === 'c' && this.dockerSubTab !== 'containers' && this.dockerSubTab !== 'compose') {
        return this.dispatchAction('dockerPrune');
      }
      else if (ev.char === 'l') return this.dispatchAction('dockerLogs');
      else if (ev.char === 'L') return this.dispatchAction('dockerLogsFollow');
      else if (ev.char === 'i') return this.dispatchAction('dockerInspect');
      else if (ev.char === 's') return this.dispatchAction('dockerStart');
      else if (ev.char === 'x') return this.dispatchAction('dockerStop');
      else if (ev.char === 'r') return this.dispatchAction('dockerRestart');
      else if (ev.char === 'd' || ev.name === 'delete') return this.dispatchAction('dockerRemove');
      else if (ev.char === 'p') return this.dispatchAction('dockerPull');
      else if (ev.char === 'u') return this.dispatchAction('toggleDirElevate');
      else if (ev.char === 'f' || ev.char === 'R') return this.dispatchAction('dockerRefresh');
      else if (ev.name === 'escape' || ev.char === 'q') return this.dispatchAction('switchTab', 'files');
      this.render();
      return;
    }

    if (this.isAgentTab()) {
      const agentType = this.getAgentTypeForTab();
      const subTabs = agentType === 'claude'
        ? ['sessions', 'memory', 'prompt', 'skills', 'mcp']
        : ['sessions', 'prompt', 'skills', 'mcp'];
      if (ev.name === 'left' || ev.name === 'right') {
        const curIdx = Math.max(0, subTabs.indexOf(this.agentSubTab));
        const nextIdx = (curIdx + (ev.name === 'right' ? 1 : -1) + subTabs.length) % subTabs.length;
        return this.dispatchAction('switchAgentSubTab', subTabs[nextIdx]);
      }
      if (ev.char === '[' || ev.char === ']') {
        const pluginId = this.plugins.getPluginIdForTab(this.tab);
        const eligible = this.store
          .list()
          .filter((p) => !pluginId || !this.plugins.isDisabledForProfile(pluginId, p));
        if (eligible.length > 1) {
          const curIdx = Math.max(0, eligible.findIndex((p) => p.id === this.activeProfile?.id));
          const nextIdx = (curIdx + (ev.char === ']' ? 1 : -1) + eligible.length) % eligible.length;
          return this.dispatchAction('switchSessionServer', eligible[nextIdx].id);
        }
      }
      if (this.agentSubTab === 'sessions') {
        const len = this.sessions.length;
        if (ev.name === 'up' && len > 0) this.sessionIdx = Math.max(0, this.sessionIdx - 1);
        else if (ev.name === 'down' && len > 0) this.sessionIdx = Math.min(len - 1, this.sessionIdx + 1);
        else if (ev.name === 'home' && len > 0) this.sessionIdx = 0;
        else if (ev.name === 'end' && len > 0) this.sessionIdx = len - 1;
        else if (ev.name === 'pageup' && len > 0) this.sessionIdx = Math.max(0, this.sessionIdx - 8);
        else if (ev.name === 'pagedown' && len > 0) this.sessionIdx = Math.min(len - 1, this.sessionIdx + 8);
        else if (ev.name === 'enter') return this.dispatchAction('resumeSession');
        else if (ev.char === 'f' && this.tab === 'sessions') return this.dispatchAction('forkSession');
        else if (ev.char === 'v' || ev.char === 'p') return this.dispatchAction('previewSession');
        else if (ev.char === 't' && this.tab === 'sessions') return this.dispatchAction('openTokenStats');
        else if (ev.char === 'T' && this.tab === 'sessions') return this.dispatchAction('openSessionTokenStats');
        else if (ev.char === '/' || ev.char === 's') return this.dispatchAction('searchSessions');
        else if (ev.char === 'd' && this.tab === 'sessions') return this.dispatchAction('toggleSessionScope');
        else if (ev.char === 'r' || ev.char === 'R') return this.dispatchAction('refreshSessions');
        else if (ev.name === 'escape' || ev.char === 'q') return this.dispatchAction('switchTab', 'files');
      } else if (this.agentSubTab === 'prompt') {
        const total = this.agentPromptData?.lines?.length || 0;
        const viewH = Math.max(2, this.term.getSize().rows - 9);
        const maxS = Math.max(0, total - viewH);
        if (ev.name === 'up') this.agentSubScroll = Math.max(0, this.agentSubScroll - 1);
        else if (ev.name === 'down') this.agentSubScroll = Math.min(maxS, this.agentSubScroll + 1);
        else if (ev.name === 'home') this.agentSubScroll = 0;
        else if (ev.name === 'end') this.agentSubScroll = maxS;
        else if (ev.name === 'pageup') this.agentSubScroll = Math.max(0, this.agentSubScroll - 8);
        else if (ev.name === 'pagedown') this.agentSubScroll = Math.min(maxS, this.agentSubScroll + 8);
        else if (ev.char === 'r' || ev.char === 'R') return this.dispatchAction('refreshAgentSubTab');
        else if (ev.char === 'e') return this.dispatchAction('editAgentPromptModal');
        else if (ev.char === 't') return this.dispatchAction('editAgentPromptInTerminal');
        else if (ev.name === 'escape' || ev.char === 'q') return this.dispatchAction('switchAgentSubTab', 'sessions');
      } else {
        const len =
          this.agentSubTab === 'memory'
            ? this.claudeMemoryData?.items?.length || 0
            : this.agentSubTab === 'skills'
              ? this.agentSkillsData?.skills?.length || 0
              : this.agentMcpData?.items?.length || 0;
        if (ev.name === 'up' && len > 0) this.agentSubIdx = Math.max(0, this.agentSubIdx - 1);
        else if (ev.name === 'down' && len > 0) this.agentSubIdx = Math.min(len - 1, this.agentSubIdx + 1);
        else if (ev.name === 'home' && len > 0) this.agentSubIdx = 0;
        else if (ev.name === 'end' && len > 0) this.agentSubIdx = len - 1;
        else if (ev.name === 'pageup' && len > 0) this.agentSubIdx = Math.max(0, this.agentSubIdx - 8);
        else if (ev.name === 'pagedown' && len > 0) this.agentSubIdx = Math.min(len - 1, this.agentSubIdx + 8);
        else if (ev.name === 'enter') {
          if (this.agentSubTab === 'memory') return this.dispatchAction('memoryPreview');
          if (this.agentSubTab === 'skills') return this.dispatchAction('skillPreview');
          if (this.agentSubTab === 'mcp') return this.dispatchAction('mcpAdd');
        } else if (ev.char === 'n' || ev.char === 'i' || ev.char === 'a') {
          if (this.agentSubTab === 'skills') return this.dispatchAction('skillInstall');
          if (this.agentSubTab === 'mcp') return this.dispatchAction('mcpAdd');
        } else if (ev.char === 'd' || ev.name === 'delete') {
          if (this.agentSubTab === 'memory') return this.dispatchAction('memoryDelete');
          if (this.agentSubTab === 'skills') return this.dispatchAction('skillDelete');
          if (this.agentSubTab === 'mcp') return this.dispatchAction('mcpDelete');
        } else if (ev.char === 'r' || ev.char === 'R') return this.dispatchAction('refreshAgentSubTab');
        else if (ev.name === 'escape' || ev.char === 'q') return this.dispatchAction('switchAgentSubTab', 'sessions');
      }
      this.render();
    }
  }

  async handleModalKey(ev) {
    const m = this.modal;
    if (ev.name === 'escape') {
      if (m.type === 'profileForm' && m.keyDropdownOpen) {
        m.keyDropdownOpen = false;
        this.render();
        return;
      }
      if (m.type === 'profileForm' && m.isTimeRange && m.parentTokenStats) {
        this.modal = m.parentTokenStats;
        this.render();
        return;
      }
      this.modal = null;
      this.render();
      return;
    }
    if (m.type === 'input') {
      if (ev.name === 'enter') return this.submitModal();
      applyTextEditKey(m, ev);
      this.render();
      return;
    }
    if (m.type === 'confirm') {
      if (ev.name === 'enter' || ev.char === 'y') return this.submitModal();
      if (ev.char === 'n') {
        this.modal = null;
        this.render();
      }
      return;
    }
    if (m.type === 'profileForm') {
      const f = m.fields[m.focusIdx];
      if (m.keyDropdownOpen && f?.key === 'identityFile' && m.keyCandidates?.length > 0) {
        if (ev.name === 'up') {
          m.keyDropdownIdx = Math.max(0, m.keyDropdownIdx - 1);
          this.render();
          return;
        }
        if (ev.name === 'down') {
          m.keyDropdownIdx = Math.min(m.keyCandidates.length - 1, m.keyDropdownIdx + 1);
          this.render();
          return;
        }
        if (ev.name === 'enter') {
          f.value = m.keyCandidates[m.keyDropdownIdx] ?? f.value;
          m.keyDropdownOpen = false;
          this.render();
          return;
        }
      }

      if (ev.ctrl && ev.name === 's') {
        m.keyDropdownOpen = false;
        return this.submitModal();
      }
      if (ev.name === 'tab' || ev.name === 'down') {
        m.keyDropdownOpen = false;
        m.focusIdx = (m.focusIdx + 1) % m.fields.length;
      } else if (ev.name === 'shift-tab' || ev.name === 'up') {
        m.keyDropdownOpen = false;
        m.focusIdx = (m.focusIdx - 1 + m.fields.length) % m.fields.length;
      } else if (ev.name === 'enter') {
        m.keyDropdownOpen = false;
        if (m.focusIdx < m.fields.length - 1) m.focusIdx += 1;
        else return this.submitModal();
      } else if (f && applyTextEditKey(f, ev)) {
        m.keyDropdownOpen = false;
      }
      this.render();
      return;
    }
    if (m.type === 'preview') {
      const maxS = Math.max(0, m.lines.length - 6);
      if (ev.name === 'up') m.scroll = Math.max(0, m.scroll - 1);
      else if (ev.name === 'down') m.scroll = Math.min(maxS, m.scroll + 1);
      else if (ev.name === 'home') m.scroll = 0;
      else if (ev.name === 'end') m.scroll = maxS;
      else if (ev.name === 'pageup') m.scroll = Math.max(0, m.scroll - 8);
      else if (ev.name === 'pagedown') m.scroll = Math.min(maxS, m.scroll + 8);
      else if (m.promptMeta && ev.char === 'e') return this.dispatchAction('editAgentPromptModal');
      else if (m.promptMeta && ev.char === 't') return this.dispatchAction('editAgentPromptInTerminal');
      else if (ev.name === 'enter' && !m.promptMeta && !m.title?.startsWith('🛠 Skill:')) {
        return this.dispatchAction('previewResume');
      }
      else if (ev.char === 'q') {
        this.modal = null;
      }
      this.render();
      return;
    }
    if (m.type === 'sshImport') {
      if (ev.name === 'up') m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down') m.idx = Math.min(m.candidates.length - 1, m.idx + 1);
      else if (ev.name === 'home' && m.candidates.length > 0) m.idx = 0;
      else if (ev.name === 'end' && m.candidates.length > 0) m.idx = m.candidates.length - 1;
      else if (ev.name === 'enter') return this.submitModal();
      this.render();
      return;
    }
    if (m.type === 'agentSkills') {
      const maxIdx = Math.max(0, m.skills.length - 1);
      if (ev.name === 'up') m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down') m.idx = Math.min(maxIdx, m.idx + 1);
      else if (ev.name === 'home') m.idx = 0;
      else if (ev.name === 'end') m.idx = maxIdx;
      else if (ev.name === 'pageup') m.idx = Math.max(0, m.idx - 8);
      else if (ev.name === 'pagedown') m.idx = Math.min(maxIdx, m.idx + 8);
      else if (ev.name === 'enter') return this.dispatchAction('skillPreview');
      else if (ev.char === 'd' || ev.name === 'delete') return this.dispatchAction('skillDelete');
      else if (ev.char === 'i' || ev.char === 'n') return this.dispatchAction('skillInstall');
      else if (ev.char === 'r' || ev.char === 'R') return this.dispatchAction('refreshAgentSkills');
      else if (ev.char === 'q') this.modal = null;
      this.render();
      return;
    }
    if (m.type === 'claudeMemory') {
      const maxIdx = Math.max(0, m.items.length - 1);
      if (ev.name === 'up') m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down') m.idx = Math.min(maxIdx, m.idx + 1);
      else if (ev.name === 'home') m.idx = 0;
      else if (ev.name === 'end') m.idx = maxIdx;
      else if (ev.name === 'pageup') m.idx = Math.max(0, m.idx - 8);
      else if (ev.name === 'pagedown') m.idx = Math.min(maxIdx, m.idx + 8);
      else if (ev.name === 'enter') return this.dispatchAction('memoryPreview');
      else if (ev.char === 'd' || ev.name === 'delete') return this.dispatchAction('memoryDelete');
      else if (ev.char === 'r' || ev.char === 'R') return this.dispatchAction('refreshClaudeMemory');
      else if (ev.char === 'q') this.modal = null;
      this.render();
      return;
    }
    if (m.type === 'agentMcp') {
      const maxIdx = Math.max(0, m.items.length - 1);
      if (ev.name === 'up') m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down') m.idx = Math.min(maxIdx, m.idx + 1);
      else if (ev.name === 'home') m.idx = 0;
      else if (ev.name === 'end') m.idx = maxIdx;
      else if (ev.name === 'pageup') m.idx = Math.max(0, m.idx - 8);
      else if (ev.name === 'pagedown') m.idx = Math.min(maxIdx, m.idx + 8);
      else if (ev.name === 'enter' || ev.char === 'n' || ev.char === 'a') return this.dispatchAction('mcpAdd');
      else if (ev.char === 'd' || ev.name === 'delete') return this.dispatchAction('mcpDelete');
      else if (ev.char === 'r' || ev.char === 'R') return this.dispatchAction('refreshAgentMcp');
      else if (ev.char === 'q') this.modal = null;
      this.render();
      return;
    }
    if (m.type === 'pluginServerConfig') {
      const len = this.store.list().length;
      if (ev.name === 'up' && len > 0) m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down' && len > 0) m.idx = Math.min(len - 1, m.idx + 1);
      else if (ev.name === 'home' && len > 0) m.idx = 0;
      else if (ev.name === 'end' && len > 0) m.idx = len - 1;
      else if (ev.name === 'pageup' && len > 0) m.idx = Math.max(0, m.idx - 8);
      else if (ev.name === 'pagedown' && len > 0) m.idx = Math.min(len - 1, m.idx + 8);
      else if (ev.name === 'enter' || ev.name === 'space') return this.dispatchAction('pluginServerToggle');
      else if (ev.char === 'a') return this.dispatchAction('pluginServersEnableAll');
      else if (ev.char === 'x' || ev.char === 'd') return this.dispatchAction('pluginServersDisableAll');
      else if (ev.name === 'backspace' || ev.char === 'b') return this.dispatchAction('openPlugins');
      this.render();
      return;
    }
    if (m.type === 'appUpdate') {
      if (ev.char === 'r' || ev.name === 'f5') return this.dispatchAction('refreshAppUpdate');
      if (m.info?.hasUpdate && (ev.char === 'u' || ev.name === 'enter')) return this.dispatchAction('runAppUpgrade');
      // Scroll release notes
      if (ev.name === 'up') m.scroll = Math.max(0, (m.scroll || 0) - 1);
      else if (ev.name === 'down') m.scroll = (m.scroll || 0) + 1;
      else if (ev.name === 'pageup') m.scroll = Math.max(0, (m.scroll || 0) - 5);
      else if (ev.name === 'pagedown') m.scroll = (m.scroll || 0) + 5;
      else if (ev.name === 'home') m.scroll = 0;
      else if (ev.name === 'end') m.scroll = 99999;
      this.render();
      return;
    }
    if (m.type === 'actionPalette') {
      if (ev.name === 'up' && m.items.length > 0) m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down' && m.items.length > 0) m.idx = Math.min(m.items.length - 1, m.idx + 1);
      else if (ev.name === 'pageup' && m.items.length > 0) m.idx = Math.max(0, m.idx - 8);
      else if (ev.name === 'pagedown' && m.items.length > 0) m.idx = Math.min(m.items.length - 1, m.idx + 8);
      else if (ev.name === 'enter' || ev.name === 'space') return this.dispatchAction('actionPaletteRun');
      this.render();
      return;
    }
    if (m.type === 'plugins') {
      const maxIdx = Math.max(0, m.catalog.length - 1);
      if (ev.name === 'up') m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down') m.idx = Math.min(maxIdx, m.idx + 1);
      else if (ev.name === 'home') m.idx = 0;
      else if (ev.name === 'end') m.idx = maxIdx;
      else if (ev.name === 'pageup') m.idx = Math.max(0, m.idx - 8);
      else if (ev.name === 'pagedown') m.idx = Math.min(maxIdx, m.idx + 8);
      else if (ev.name === 'enter' || ev.name === 'space') return this.dispatchAction('pluginToggleOrInstall');
      else if (ev.char === 's' || ev.char === 'c') return this.dispatchAction('openPluginServers');
      else if (ev.char === 'd' || ev.name === 'delete') return this.dispatchAction('pluginUninstall');
      else if (ev.char === 'i') return this.dispatchAction('pluginInstallLocal');
      else if (ev.char === 'f') return this.dispatchAction('pluginSyncRemote');
      else if (ev.char === 'r') return this.dispatchAction('pluginEditSource');
      else if (ev.char === 'q') this.modal = null;
      this.render();
      return;
    }
    if (m.type === 'tokenStats') {
      const views = ['model', 'route', 'hour', 'day', 'items'];
      const presets = ['all', 'today', '7d', '30d'];
      const rows = this.getTokenStatsRows(m);
      if (ev.name === '1' || ev.char === '1') return this.dispatchAction('tokenStatsView', 'model');
      if (ev.name === '2' || ev.char === '2') return this.dispatchAction('tokenStatsView', 'route');
      if (ev.name === '3' || ev.char === '3') return this.dispatchAction('tokenStatsView', 'hour');
      if (ev.name === '4' || ev.char === '4') return this.dispatchAction('tokenStatsView', 'day');
      if (ev.name === '5' || ev.char === '5') return this.dispatchAction('tokenStatsView', 'items');
      if (ev.name === 'left' || ev.name === 'right') {
        const cur = Math.max(0, views.indexOf(m.view));
        const next = views[(cur + (ev.name === 'right' ? 1 : -1) + views.length) % views.length];
        return this.dispatchAction('tokenStatsView', next);
      }
      if (ev.name === 'tab' || ev.name === 'shift-tab') {
        const cur = presets.indexOf(m.preset || 'all');
        const step = ev.name === 'shift-tab' ? -1 : 1;
        const next = presets[((cur >= 0 ? cur : 0) + step + presets.length) % presets.length];
        return this.dispatchAction('tokenStatsPreset', next);
      }
      if (ev.char === 't') return this.dispatchAction('tokenStatsEditTime');
      if (ev.char === 'd') return this.dispatchAction('tokenStatsPreset', 'today');
      if (ev.char === 'w') return this.dispatchAction('tokenStatsPreset', '7d');
      if (ev.char === 'm') return this.dispatchAction('tokenStatsPreset', '30d');
      if (ev.char === 'a') return this.dispatchAction('tokenStatsPreset', 'all');
      if (ev.char === 'r' || ev.char === 'R' || ev.name === 'f5') return this.dispatchAction('refreshTokenStats');
      if (ev.char === 'q') {
        this.modal = null;
        this.render();
        return;
      }
      if (ev.name === 'up' && rows.length > 0) m.idx = Math.max(0, m.idx - 1);
      else if (ev.name === 'down' && rows.length > 0) m.idx = Math.min(rows.length - 1, m.idx + 1);
      else if (ev.name === 'home' && rows.length > 0) m.idx = 0;
      else if (ev.name === 'end' && rows.length > 0) m.idx = rows.length - 1;
      else if (ev.name === 'pageup' && rows.length > 0) m.idx = Math.max(0, m.idx - 8);
      else if (ev.name === 'pagedown' && rows.length > 0) m.idx = Math.min(rows.length - 1, m.idx + 8);
      this.render();
      return;
    }
  }

  _resetTabCloseCharge() {
    clearTimeout(this.tabCloseCharge.timer);
    this.tabCloseCharge = { tabId: null, count: 0, lastTime: 0, timer: null };
  }

  // ==================== Rendering ====================

  getZoneButtons(scr, zone) {
    if (!scr || !Array.isArray(scr.buttons)) return [];
    const topMaxY = this.serverTabs.length > 0 ? 2 : 1;
    const bottomMinY = Math.max(topMaxY + 1, (scr.rows || 30) - 2);
    if (zone === 'top') return scr.buttons.filter((b) => b.y <= topMaxY);
    if (zone === 'sub') return scr.buttons.filter((b) => b.y > topMaxY && b.y < bottomMinY);
    if (zone === 'bottom') return scr.buttons.filter((b) => b.y >= bottomMinY);
    return [];
  }

  openActionPalette() {
    const scr = this._lastScreen;
    const topMaxY = this.serverTabs.length > 0 ? 2 : 1;
    const buttons = Array.isArray(scr?.buttons) ? scr.buttons : [];
    const items = buttons.map((b) => ({
      zone: b.y <= topMaxY ? '顶部栏' : b.y >= (scr?.rows || 30) - 2 ? '底部栏' : '子菜单',
      label: b.label,
      action: b.action,
      payload: b.payload,
    }));
    if (items.length === 0) {
      this.setStatus('当前界面暂无可用按钮', true);
      this.render();
      return;
    }
    this.modal = {
      type: 'actionPalette',
      title: '🔘 按钮与命令面板 (? / Shift+Tab 切换焦点)',
      items,
      idx: 0,
      scroll: 0,
    };
    this.render();
  }

  getThemeAccent() {
    const theme = this.store.getSettings().theme || 'cyber';
    switch (theme) {
      case 'emerald':
        return { title: ANSI.fg.brightGreen, highlight: ANSI.fg.green, sub: ANSI.fg.brightCyan };
      case 'amber':
        return { title: ANSI.fg.brightYellow, highlight: ANSI.fg.yellow, sub: ANSI.fg.brightWhite };
      case 'rose':
        return { title: ANSI.fg.magenta, highlight: ANSI.fg.brightYellow, sub: ANSI.fg.brightWhite };
      default:
        return { title: ANSI.fg.brightCyan, highlight: ANSI.fg.yellow, sub: ANSI.fg.brightCyan };
    }
  }

  render() {
    if (!this._running) return;
    this.term.setMouseTracking(this.tab !== 'terminal' || Boolean(this.modal) || this.terminalMouseMode);
    const { cols, rows } = this.term.getSize();
    const scr = new ScreenBuffer(cols, rows);
    const accent = this.getThemeAccent();
    const shouldClear = this.tab !== 'terminal' || Boolean(this.modal) || Boolean(this._needsClear);
    this._needsClear = false;
    scr.begin({ clear: shouldClear });

    // Row 1: Core SSH Tabs + Dynamic Plugin Tabs + Controls
    scr.drawLine(1, '');
    let x = 1;
    x = scr.drawButton(x, 1, '1.服务器', 'switchTab', 'profiles', { active: this.tab === 'profiles' });
    x = scr.drawButton(x, 1, '2.目录', 'switchTab', 'files', { active: this.tab === 'files' });
    x = scr.drawButton(x, 1, '3.终端', 'switchTab', 'terminal', { active: this.tab === 'terminal' });
    const pluginTabs = this.plugins.getEnabledTabs();
    for (let i = 0; i < pluginTabs.length; i++) {
      const pt = pluginTabs[i];
      x = scr.drawButton(x, 1, `${4 + i}.${pt.label}`, 'switchTab', pt.id, { active: this.tab === pt.id });
    }
    x = scr.drawButton(x, 1, '🧩 插件', 'openPlugins');
    const updateLabel = this.appUpdateInfo?.hasUpdate ? `⬆ v${this.appUpdateInfo.latestVersion}` : '🔄 更新';
    x = scr.drawButton(x, 1, updateLabel, 'openAppUpdate', null, {
      primary: Boolean(this.appUpdateInfo?.hasUpdate),
    });
    x = scr.drawButton(x, 1, '🎨', 'cycleTheme');
    x = scr.drawButton(x, 1, '⚙ 设置', 'openSettings');
    const autoCopyOn = this.store.getSettings().enableAutoCopy !== false;
    x = scr.drawButton(x, 1, autoCopyOn ? '📋 复制:开' : '📋 复制:关', 'toggleAutoCopy', null, {
      active: autoCopyOn,
    });
    if (this.tab === 'terminal') {
      x = scr.drawButton(x, 1, '📷 贴图', 'pasteImageToTerminal', null, { primary: true });
    }
    const titleRight = this.activeProfile
      ? `${this.activeProfile.user ? `${this.activeProfile.user}@` : ''}${this.activeProfile.host}`
      : '未连接';
    if (cols - titleRight.length - 10 > x) {
      scr.writeAt(cols - titleRight.length - 10, 1, titleRight, accent.title);
    }
    scr.drawButton(cols - 7, 1, '✕ 退出', 'quit', null, { danger: true });

    const hasServerTabs = this.serverTabs.length > 0;
    if (hasServerTabs) {
      this.renderServerTabs(scr, 2, cols);
      scr.drawRule(3);
    } else {
      scr.drawRule(2);
    }

    if (this.tab === 'terminal') {
      const curTab = this.getActiveTab();
      const termStartRow = hasServerTabs ? 4 : 3;
      const termRows = Math.max(4, rows - termStartRow);
      if (curTab?.termSession?.vterm) {
        const vt = curTab.termSession.vterm;
        const showSb = !vt.hasMouseTracking() && vt.scrollback.length > 0;
        vt.renderTo(scr, termStartRow, showSb ? cols - 1 : cols, termRows);
        if (showSb) {
          const total = vt.scrollback.length + vt.rows;
          const scrollPos = Math.max(0, vt.scrollback.length - vt.scrollOffset);
          scr.drawScrollbar(cols, termStartRow, termRows, scrollPos, total, vt.rows, 'scrollbarDrag', {
            target: 'terminal',
            hovered: this._sbHover === 'terminal' || this._sbDrag?.target === 'terminal',
          });
        }
      } else {
        scr.writeAt(3, termStartRow + 1, '当前服务器暂无活动 SSH 终端。', ANSI.fg.gray);
      }
      const scrollOff = curTab?.termSession?.vterm?.scrollOffset || 0;
      const termStatus = this.statusMsg
        ? this.statusMsg
        : scrollOff > 0
          ? `[${curTab?.profile?.name || 'SSH'}] 回看历史 (+${scrollOff} 行) - 滚轮向下或任意键返回底部`
          : curTab?.termSession?.exited
            ? `[${curTab.profile?.name}] SSH 已退出 (${curTab.termSession.exitCode}) - 按 Enter 返回 | Alt+数字 切换`
            : this.terminalMouseMode
              ? `[${curTab?.profile?.name || 'SSH'}] 触控点击模式 - 点击顶部切换 | Alt+M 切回直接选字 | Ctrl+Q 退出`
              : `[${curTab?.profile?.name || 'SSH'}] 原生选字(可直接拖拽) | Alt+数字切面板 | Alt+[/]切服务器 | Alt+V贴图 | Alt+M触控`;
      scr.drawLine(rows, termStatus, this.statusIsError ? ANSI.fg.red : ANSI.fg.gray);
      if (this.modal) {
        this.renderModal(scr, cols, rows);
      }
      if (this._uiSel?.active) {
        scr.highlightSelection(this._uiSel.startX, this._uiSel.startY, this._uiSel.endX, this._uiSel.endY);
      }
      scr.flush({ prevScreen: this._lastScreen });
      this._lastScreen = scr;
      return;
    }

    const bodyStart = hasServerTabs ? 5 : 4;
    const bodyEnd = Math.max(bodyStart + 2, rows - 3);
    const listHeight = bodyEnd - bodyStart + 1;

    if (this.tab === 'profiles') {
      this.renderProfiles(scr, bodyStart, listHeight, cols);
    } else if (this.tab === 'files') {
      this.renderFiles(scr, bodyStart, listHeight, cols);
    } else if (this.tab === 'docker') {
      this.renderDocker(scr, bodyStart, listHeight, cols);
    } else if (this.isAgentTab()) {
      this.renderSessions(scr, bodyStart, listHeight, cols);
    }

    // Bottom Touch Action Bar (row rows - 1) & Status Bar (row rows)
    scr.drawRule(rows - 2);
    this.renderActionBar(scr, rows - 1);

    let statusText = this.loadingText || this.statusMsg || '';
    let statusStyle = this.loadingText
      ? `${ANSI.fg.brightYellow}${ANSI.bold}`
      : this.statusIsError
        ? ANSI.fg.red
        : ANSI.fg.gray;

    if (!this.modal && this.uiFocusZone !== 'content') {
      const zoneBtns = this.getZoneButtons(scr, this.uiFocusZone);
      if (zoneBtns.length > 0) {
        this.uiFocusBtnIdx = Math.max(0, Math.min(zoneBtns.length - 1, this.uiFocusBtnIdx));
        const fb = zoneBtns[this.uiFocusBtnIdx];
        scr.writeAt(fb.x1, fb.y, fb.text, `\x1b[43m${ANSI.fg.black}${ANSI.bold}`);
        const zoneLabel =
          this.uiFocusZone === 'top'
            ? '顶部栏焦点'
            : this.uiFocusZone === 'sub'
              ? '子菜单焦点'
              : '操作栏焦点';
        const isClosableTab = this.uiFocusZone === 'top' && fb.action === 'switchServerTab';
        const isCharging = isClosableTab && this.tabCloseCharge.tabId === fb.payload && this.tabCloseCharge.count > 0;
        if (isCharging) {
          statusText = `[${zoneLabel}] 正在关闭 [${fb.label}] (${this.tabCloseCharge.count}/6) - 继续长按 w 确认关闭 | 松开取消`;
        } else if (isClosableTab) {
          statusText = `[${zoneLabel}] 当前: [${fb.label}] | 长按 w 关闭标签 | ←/→ 选按钮 | Enter 切换 | Shift+Tab 切换区域 | Esc 返回列表`;
        } else {
          statusText = `[${zoneLabel}] 当前: [${fb.label}] | ←/→ 选按钮 | Enter 触发 | Shift+Tab 切换区域 | Esc 返回列表`;
        }
        statusStyle = `${ANSI.fg.brightYellow}${ANSI.bold}`;
      }
    }
    scr.drawLine(rows, statusText, statusStyle);

    // Modal overlay if active
    if (this.modal) {
      this.renderModal(scr, cols, rows);
    }
    if (this._uiSel?.active) {
      scr.highlightSelection(this._uiSel.startX, this._uiSel.startY, this._uiSel.endX, this._uiSel.endY);
    }

    scr.flush({ prevScreen: this._lastScreen });
    this._lastScreen = scr;
  }

  renderServerTabs(scr, y, cols) {
    scr.drawLine(y, '');
    let x = 1;
    const CHARGE_STEPS = 6;
    const chargeChars = ['░', '▒', '▓', '█'];
    for (const t of this.serverTabs) {
      const isActive = t.id === this.activeServerTabId;
      const hasLiveTerm = Boolean(t.termSession && !t.termSession.exited);
      const serverName = truncateToWidth(t.profile?.name || t.profile?.host || 'Server', 10);
      const tabTitle = t.termSession?.title || t.title;
      const fullName = tabTitle ? `${serverName}·${truncateToWidth(tabTitle, 8)}` : serverName;
      const prefix = isActive ? '● ' : hasLiveTerm ? '▸ ' : '';
      // Check if this tab is being charged for close
      const isCharging = this.tabCloseCharge.tabId === t.id && this.tabCloseCharge.count > 0;
      const chargeRatio = isCharging ? this.tabCloseCharge.count / CHARGE_STEPS : 0;
      let label;
      if (isCharging) {
        // Build charge bar: replace tab text with progress visualization
        const barLen = displayWidth(fullName) + (prefix ? displayWidth(prefix) : 0);
        const filled = Math.round(chargeRatio * barLen);
        const barFull = '█'.repeat(Math.min(filled, barLen));
        const barEmpty = '░'.repeat(Math.max(0, barLen - filled));
        label = `${barFull}${barEmpty}`;
      } else {
        label = `${prefix}${fullName}`;
      }
      const btnOpts = { active: isActive };
      if (isCharging) btnOpts.danger = true;
      const nextX = scr.drawButton(x, y, label, 'switchServerTab', t.id, btnOpts);
      if (nextX === x) break;
      x = nextX - 1;
      if (x + 3 <= cols) {
        const closeStyle = isActive
          ? `${ANSI.bg.cyan}${ANSI.fg.black}`
          : `${ANSI.bg.darkGray}${ANSI.fg.gray}`;
        scr.writeAt(x, y, ' × ', closeStyle);
        scr.addHitBox(x, y, x + 2, y, 'closeServerTab', t.id);
        x += 4;
      }
    }
    scr.drawButton(x, y, '+ 服务器', 'switchTab', 'profiles');
  }

  renderProfiles(scr, startRow, height, cols) {
    const headerRow = startRow - 1;
    const profiles = this.store.list();
    const landscape = this.isLandscape(cols);

    if (landscape) {
      const leftW = Math.max(30, Math.min(46, Math.floor(cols * 0.4)));
      const divX = leftW + 1;
      const rightX = divX + 1;
      const rightW = Math.max(20, cols - rightX + 1);

      scr.writeAt(1, headerRow, truncateToWidth(' 服务器列表 (点击查看右侧快捷指令)', leftW), ANSI.fg.yellow);
      for (let r = headerRow; r < startRow + height; r++) {
        scr.writeAt(divX, r, '│', ANSI.fg.gray);
      }

      if (profiles.length === 0) {
        scr.writeAt(2, startRow + 1, truncateToWidth('暂无服务器，点击下方 [+ 新建]', leftW - 2), ANSI.fg.gray);
      } else {
        this.profileScroll = this.computeScroll(this.profileIdx, this.profileScroll, height, profiles.length);
        for (let i = 0; i < height; i++) {
          const idx = this.profileScroll + i;
          if (idx >= profiles.length) break;
          const p = profiles[idx];
          const selected = idx === this.profileIdx;
          const target = `${p.user ? `${p.user}@` : ''}${p.host}${p.port !== 22 ? `:${p.port}` : ''}`;
          const line = `${selected ? ' > ' : '   '}${p.name} (${target})`;
          const style = selected
            ? this.profilePane === 'servers'
              ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}`
              : `${ANSI.bg.darkGray}${ANSI.fg.brightCyan}${ANSI.bold}`
            : ANSI.fg.white;
          scr.writeAt(1, startRow + i, padEndWidth(truncateToWidth(line, leftW), leftW), style);
          scr.addHitBox(1, startRow + i, leftW, startRow + i, 'selectProfile', idx);
        }
      }

      const selectedProfile = profiles[this.profileIdx] || null;
      this.renderQuickCommandsPane(scr, selectedProfile, rightX, startRow, rightW, height, {
        activePane: this.profilePane === 'commands',
      });
      return;
    }

    // Portrait mode: server list OR selected server's quick commands
    if (this.portraitView === 'commands' && profiles[this.profileIdx]) {
      const p = profiles[this.profileIdx];
      let bx = 1;
      bx = scr.drawButton(bx, headerRow, '← 返回', 'backToServers');
      const target = `${p.user ? `${p.user}@` : ''}${p.host}`;
      scr.writeAt(bx, headerRow, truncateToWidth(`${p.name} (${target})`, Math.max(10, cols - bx)), `${ANSI.fg.brightCyan}${ANSI.bold}`);
      this.renderQuickCommandsPane(scr, p, 1, startRow, cols, height, {
        showHeader: false,
        activePane: true,
      });
      return;
    }

    this.portraitView = 'servers';
    scr.drawLine(headerRow, ' 服务器列表 (点击进入快捷指令)', ANSI.fg.yellow);
    if (profiles.length === 0) {
      scr.writeAt(3, startRow + 1, '暂无保存的服务器。点击下方 [+ 新建] 或 [⇩ 导入]。', ANSI.fg.gray);
      return;
    }

    this.profileScroll = this.computeScroll(this.profileIdx, this.profileScroll, height, profiles.length);
    for (let i = 0; i < height; i++) {
      const idx = this.profileScroll + i;
      if (idx >= profiles.length) break;
      const p = profiles[idx];
      const selected = idx === this.profileIdx;
      const target = `${p.user ? `${p.user}@` : ''}${p.host}${p.port !== 22 ? `:${p.port}` : ''}`;
      const cmdCount = p.quickCommands?.length ? ` [${p.quickCommands.length}条指令]` : '';
      const line = `${selected ? ' > ' : '   '}${p.name}  (${target})${cmdCount}`;
      const style = selected ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : ANSI.fg.white;
      scr.drawLine(startRow + i, line, style);
      scr.addHitBox(1, startRow + i, cols, startRow + i, 'selectProfile', idx);
    }
  }

  renderQuickCommandsPane(scr, profile, x, startRow, width, height, { showHeader = true, activePane = true } = {}) {
    const headerRow = startRow - 1;
    if (!profile) {
      if (showHeader) {
        scr.writeAt(x, headerRow, truncateToWidth(' 快捷指令', width), ANSI.fg.yellow);
      }
      scr.writeAt(x + 1, startRow + 1, truncateToWidth('请先添加或选择一个服务器', width - 2), ANSI.fg.gray);
      return;
    }

    if (showHeader) {
      const target = `${profile.user ? `${profile.user}@` : ''}${profile.host}`;
      scr.writeAt(
        x,
        headerRow,
        truncateToWidth(` 快捷指令: ${profile.name} (${target})`, width),
        `${ANSI.fg.brightYellow}${ANSI.bold}`
      );
    }

    const items = this.getQuickCommandItems(profile);
    this.quickCmdScroll = this.computeScroll(this.quickCmdIdx, this.quickCmdScroll, height, items.length);

    for (let i = 0; i < height; i++) {
      const idx = this.quickCmdScroll + i;
      if (idx >= items.length) break;
      const it = items[idx];
      const selected = idx === this.quickCmdIdx;
      const rowY = startRow + i;
      const canRun = it.kind !== 'add';
      const runBadgeW = canRun && width >= 24 ? 7 : 0; // ' ▶运行 '
      const textW = Math.max(8, width - runBadgeW);

      let text = `${selected ? ' > ' : '   '}${it.label}`;
      if (it.kind === 'custom' && textW > 26) {
        const dirTag = it.dir ? ` @${it.dir}` : '';
        text += `  (${it.command}${dirTag})`;
      }

      let style = ANSI.fg.white;
      if (selected) {
        style = activePane
          ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}`
          : `${ANSI.bg.darkGray}${ANSI.fg.brightWhite}${ANSI.bold}`;
      } else if (it.kind === 'shell') {
        style = `${ANSI.fg.brightGreen}${ANSI.bold}`;
      } else if (it.kind === 'browse') {
        style = ANSI.fg.brightCyan;
      } else if (it.kind === 'add') {
        style = ANSI.fg.yellow;
      }

      scr.writeAt(x, rowY, padEndWidth(truncateToWidth(text, textW), textW), style);
      scr.addHitBox(x, rowY, x + textW - 1, rowY, 'selectQuickCmd', idx);

      if (runBadgeW > 0) {
        const badgeStyle = selected
          ? `${ANSI.bg.teal}${ANSI.fg.brightWhite}${ANSI.bold}`
          : `${ANSI.bg.darkGray}${ANSI.fg.brightGreen}`;
        scr.writeAt(x + textW, rowY, ' ▶运行 ', badgeStyle);
        scr.addHitBox(x + textW, rowY, x + width - 1, rowY, 'runQuickCmd', idx);
      }
    }
  }

  renderFiles(scr, startRow, height, cols) {
    const headerRow = startRow - 1;
    const isPinned = this.activeProfile?.pinnedDirs?.includes(this.currentDir.path);
    const pathLabel = truncateToWidth(` ${this.currentDir.path}`, cols - 16);
    scr.writeAt(1, headerRow, pathLabel, `${ANSI.fg.brightYellow}${ANSI.bold}`);
    scr.drawButton(cols - 13, headerRow, isPinned ? '★ 已收藏' : '☆ 收藏目录', 'togglePin', null, {
      active: Boolean(isPinned),
    });

    if (this.loadingText) {
      scr.writeAt(2, startRow + 1, truncateToWidth(`⏳ ${this.loadingText}`, cols - 4), `${ANSI.fg.brightYellow}${ANSI.bold}`);
      return;
    }

    const items = this.getFileListItems();
    this.fileScroll = this.computeScroll(this.fileIdx, this.fileScroll, height, items.length);
    const hasSb = items.length > height;
    const itemW = hasSb ? cols - 1 : cols;

    for (let i = 0; i < height; i++) {
      const idx = this.fileScroll + i;
      if (idx >= items.length) break;
      const it = items[idx];
      const selected = idx === this.fileIdx;
      let style = ANSI.fg.white;
      if (selected) style = `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}`;
      else if (it.kind === 'launch') style = `${ANSI.fg.brightGreen}${ANSI.bold}`;
      else if (it.kind === 'continue' || it.kind === 'sessions') style = ANSI.fg.brightCyan;
      else if (it.kind === 'pin') style = ANSI.fg.yellow;
      else if (it.kind === 'up') style = ANSI.fg.gray;

      scr.writeAt(1, startRow + i, padEndWidth(truncateToWidth(`${selected ? ' > ' : '   '}${it.label}`, itemW), itemW), style);
      scr.addHitBox(1, startRow + i, itemW, startRow + i, 'selectFile', idx);
    }
    if (hasSb) {
      scr.drawScrollbar(cols, startRow, height, this.fileScroll, items.length, height, 'scrollbarDrag', {
        target: 'files',
        hovered: this._sbHover === 'files' || this._sbDrag?.target === 'files',
      });
    }
  }

  renderDocker(scr, startRow, height, cols) {
    const accent = this.getThemeAccent();
    const headerRow = startRow - 1;
    const pluginId = this.plugins.getPluginIdForTab('docker');
    const eligibleServers = this.store
      .list()
      .filter((p) => !pluginId || !this.plugins.isDisabledForProfile(pluginId, p));

    // Row headerRow: Eligible Server Selector Bar
    let sx = 1;
    scr.writeAt(sx, headerRow, '服务器:', ANSI.fg.yellow);
    sx += 8;
    if (eligibleServers.length === 0) {
      scr.writeAt(sx, headerRow, '无可用服务器 (均已禁用此插件)', ANSI.fg.red);
      return;
    }
    if (!this.activeProfile || (pluginId && this.plugins.isDisabledForProfile(pluginId, this.activeProfile))) {
      this.activeProfile = eligibleServers[0];
    }
    for (const srv of eligibleServers) {
      const isCur = this.activeProfile?.id === srv.id;
      const label = `${isCur ? '● ' : ''}${truncateToWidth(srv.name || srv.host, 12)}`;
      const nextSx = scr.drawButton(sx, headerRow, label, 'switchDockerServer', srv.id, { active: isCur });
      if (nextSx === sx) break;
      sx = nextSx;
    }

    // Row startRow: Primary Sub-Tabs Row
    let tx = 1;
    tx = scr.drawButton(tx, startRow, `🐳 容器 (${this.dockerData.containers.length})`, 'dockerSubTab', 'containers', {
      active: this.dockerSubTab === 'containers',
    });
    tx = scr.drawButton(tx, startRow, `📦 镜像 (${this.dockerData.images.length})`, 'dockerSubTab', 'images', {
      active: this.dockerSubTab === 'images',
    });
    tx = scr.drawButton(tx, startRow, `🧩 Compose (${this.dockerData.compose.length})`, 'dockerSubTab', 'compose', {
      active: this.dockerSubTab === 'compose',
    });
    tx = scr.drawButton(tx, startRow, `🌐 网络 (${(this.dockerData.networks || []).length})`, 'dockerSubTab', 'networks', {
      active: this.dockerSubTab === 'networks',
    });
    scr.drawButton(tx, startRow, `💾 卷 (${(this.dockerData.volumes || []).length})`, 'dockerSubTab', 'volumes', {
      active: this.dockerSubTab === 'volumes',
    });

    // Row startRow + 1: Contextual Sub-Menu Row
    const subMenuRow = startRow + 1;
    let mx = 1;
    const kwLabel = this.dockerKeyword ? `🔍 "${this.dockerKeyword}"` : '🔍 搜索';
    mx = scr.drawButton(mx, subMenuRow, kwLabel, 'dockerSearch', null, { active: Boolean(this.dockerKeyword) });
    if (this.dockerSubTab === 'containers') {
      mx = scr.drawButton(
        mx,
        subMenuRow,
        this.dockerOnlyRunning ? '● 仅运行中' : '○ 全部容器',
        'dockerToggleRunning',
        null,
        { active: this.dockerOnlyRunning }
      );
      mx = scr.drawButton(mx, subMenuRow, '📊 实时Stats', 'dockerStats');
    } else if (this.dockerSubTab === 'images') {
      mx = scr.drawButton(mx, subMenuRow, '⬇ 拉取镜像', 'dockerPull', null, { primary: true });
      mx = scr.drawButton(mx, subMenuRow, '🧹 清理无用资源', 'dockerPrune');
    }
    mx = scr.drawButton(mx, subMenuRow, this.isDirElevate() ? '🛡 提权:开' : '🛡 提权', 'toggleDirElevate', null, {
      active: this.isDirElevate(),
    });
    scr.drawButton(mx, subMenuRow, '↻ 刷新', 'dockerRefresh');

    const listStartY = startRow + 2;
    const listHeight = Math.max(2, height - 2);
    const items = this.getDockerListItems();

    if (this.loadingText) {
      scr.writeAt(2, listStartY + 1, truncateToWidth(`⏳ ${this.loadingText}`, cols - 4), `${ANSI.fg.brightYellow}${ANSI.bold}`);
      return;
    }

    if (items.length === 0) {
      const emptyMsg = this.dockerKeyword
        ? `未找到匹配 "${this.dockerKeyword}" 的资源 (按 / 修改搜索)`
        : this.dockerSubTab === 'containers'
          ? '当前服务器暂无 Docker 容器。'
          : this.dockerSubTab === 'images'
            ? '当前服务器暂无本地 Docker 镜像。'
            : this.dockerSubTab === 'compose'
              ? '当前服务器未发现 Docker Compose 项目。'
              : this.dockerSubTab === 'networks'
                ? '当前服务器暂无 Docker 网络。'
                : '当前服务器暂无 Docker 数据卷。';
      scr.writeAt(3, listStartY + 1, emptyMsg, ANSI.fg.gray);
      return;
    }

    const rowsPerItem = 2;
    const visibleItems = Math.max(1, Math.floor(listHeight / rowsPerItem));
    this.dockerIdx = Math.max(0, Math.min(items.length - 1, this.dockerIdx));
    this.dockerScroll = this.computeScroll(this.dockerIdx, this.dockerScroll, visibleItems, items.length);
    const hasSb = items.length > visibleItems;
    const itemW = hasSb ? cols - 1 : cols;

    for (let i = 0; i < visibleItems; i++) {
      const idx = this.dockerScroll + i;
      if (idx >= items.length) break;
      const item = items[idx];
      const selected = idx === this.dockerIdx;
      const rowY = listStartY + i * rowsPerItem;
      let line1 = '';
      let line2 = '';
      let style1 = selected ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : ANSI.fg.brightWhite;

      if (this.dockerSubTab === 'containers') {
        const running = item.state === 'running';
        const icon = running ? '●' : '○';
        line1 = `${selected ? ' > ' : '   '}${icon} ${item.name}  (${item.id})`;
        line2 = `     镜像: ${item.image} | 状态: ${item.status}${item.ports ? ` | 端口: ${item.ports}` : ''}`;
        if (!selected) style1 = running ? ANSI.fg.brightGreen : ANSI.fg.gray;
      } else if (this.dockerSubTab === 'images') {
        line1 = `${selected ? ' > ' : '   '}📦 ${item.repository}:${item.tag}  (${item.id})`;
        line2 = `     大小: ${item.size} | 创建: ${item.createdSince}`;
        if (!selected) style1 = accent.title;
      } else if (this.dockerSubTab === 'compose') {
        line1 = `${selected ? ' > ' : '   '}🧩 ${item.name}  [${item.status}]`;
        line2 = `     配置: ${item.configFiles || '-'}`;
        if (!selected) style1 = ANSI.fg.brightCyan;
      } else if (this.dockerSubTab === 'networks') {
        line1 = `${selected ? ' > ' : '   '}🌐 ${item.name}  (${item.id})`;
        line2 = `     驱动: ${item.driver} | 作用域: ${item.scope}`;
        if (!selected) style1 = accent.title;
      } else {
        line1 = `${selected ? ' > ' : '   '}💾 ${item.name}`;
        line2 = `     驱动: ${item.driver} | 挂载点: ${item.mountpoint || '-'}`;
        if (!selected) style1 = ANSI.fg.brightWhite;
      }

      const style2 = selected ? `${ANSI.bg.cyan}${ANSI.fg.black}` : ANSI.fg.gray;
      scr.writeAt(1, rowY, padEndWidth(truncateToWidth(line1, itemW), itemW), style1);
      scr.writeAt(1, rowY + 1, padEndWidth(truncateToWidth(line2, itemW), itemW), style2);
      scr.addHitBox(1, rowY, itemW, rowY + 1, 'dockerSelect', idx);
    }
    if (hasSb) {
      scr.drawScrollbar(cols, listStartY, listHeight, this.dockerScroll, items.length, visibleItems, 'scrollbarDrag', {
        target: 'docker',
        hovered: this._sbHover === 'docker' || this._sbDrag?.target === 'docker',
      });
    }
  }

  renderSessions(scr, startRow, height, cols) {
    const headerRow = startRow - 1;
    const agentType = this.getAgentTypeForTab();
    const pluginId = this.plugins.getPluginIdForTab(this.tab);
    const eligibleServers = this.store
      .list()
      .filter((p) => !pluginId || !this.plugins.isDisabledForProfile(pluginId, p));

    // Row headerRow: Eligible Server Selector Bar (skips servers that disabled this plugin)
    let sx = 1;
    scr.writeAt(sx, headerRow, '服务器:', ANSI.fg.yellow);
    sx += 8;
    if (eligibleServers.length === 0) {
      scr.writeAt(sx, headerRow, '无可用服务器 (均已禁用此插件)', ANSI.fg.red);
      return;
    }
    for (const srv of eligibleServers) {
      const isCur = this.activeProfile?.id === srv.id;
      const label = `${isCur ? '● ' : ''}${truncateToWidth(srv.name || srv.host, 12)}`;
      const nextSx = scr.drawButton(sx, headerRow, label, 'switchSessionServer', srv.id, { active: isCur });
      if (nextSx === sx) break;
      sx = nextSx;
    }

    // Row startRow: Primary Sub-Tabs Row (会话 / Memory / 提示词 / Skills / MCP)
    let tx = 1;
    tx = scr.drawButton(tx, startRow, '💬 会话', 'switchAgentSubTab', 'sessions', {
      active: this.agentSubTab === 'sessions',
    });
    if (agentType === 'claude') {
      tx = scr.drawButton(tx, startRow, '🧠 Memory', 'switchAgentSubTab', 'memory', {
        active: this.agentSubTab === 'memory',
      });
    }
    tx = scr.drawButton(tx, startRow, '📜 提示词', 'switchAgentSubTab', 'prompt', {
      active: this.agentSubTab === 'prompt',
    });
    tx = scr.drawButton(tx, startRow, '🛠 Skills', 'switchAgentSubTab', 'skills', {
      active: this.agentSubTab === 'skills',
    });
    scr.drawButton(tx, startRow, '🔌 MCP', 'switchAgentSubTab', 'mcp', {
      active: this.agentSubTab === 'mcp',
    });

    // Row startRow + 1: Contextual Sub-Menu Row
    const subMenuRow = startRow + 1;
    let mx = 1;
    if (this.agentSubTab === 'sessions') {
      const kwLabel = this.sessionKeyword ? `🔍 "${this.sessionKeyword}"` : '🔍 搜索';
      mx = scr.drawButton(mx, subMenuRow, kwLabel, 'searchSessions', null, { active: Boolean(this.sessionKeyword) });
      if (agentType === 'claude') {
        const scopeLabel = this.sessionFilterCurrentDir ? '📁 当前目录' : '📁 全部目录';
        mx = scr.drawButton(mx, subMenuRow, scopeLabel, 'toggleSessionScope', null, {
          active: this.sessionFilterCurrentDir,
        });
        mx = scr.drawButton(mx, subMenuRow, '📊 Token统计', 'openTokenStats');
        mx = scr.drawButton(mx, subMenuRow, '📊 单条统计', 'openSessionTokenStats');
      }
      scr.drawButton(mx, subMenuRow, '↻ 刷新', 'refreshSessions');
    } else if (this.agentSubTab === 'memory') {
      mx = scr.drawButton(mx, subMenuRow, '👁 预览/编辑', 'memoryPreview', null, { primary: true });
      mx = scr.drawButton(mx, subMenuRow, '✕ 删除', 'memoryDelete', null, { danger: true });
      scr.drawButton(mx, subMenuRow, '↻ 刷新', 'refreshAgentSubTab');
    } else if (this.agentSubTab === 'prompt') {
      mx = scr.drawButton(mx, subMenuRow, '✎ 写入/覆盖', 'editAgentPromptModal', null, { primary: true });
      mx = scr.drawButton(mx, subMenuRow, '💻 终端编辑', 'editAgentPromptInTerminal');
      scr.drawButton(mx, subMenuRow, '↻ 刷新', 'refreshAgentSubTab');
    } else if (this.agentSubTab === 'skills') {
      mx = scr.drawButton(mx, subMenuRow, '👁 预览', 'skillPreview', null, { primary: true });
      mx = scr.drawButton(mx, subMenuRow, '+ 安装 Skill', 'skillInstall');
      mx = scr.drawButton(mx, subMenuRow, '✕ 删除', 'skillDelete', null, { danger: true });
      scr.drawButton(mx, subMenuRow, '↻ 刷新', 'refreshAgentSubTab');
    } else if (this.agentSubTab === 'mcp') {
      mx = scr.drawButton(mx, subMenuRow, '+ 添加/编辑 MCP', 'mcpAdd', null, { primary: true });
      mx = scr.drawButton(mx, subMenuRow, '✕ 删除', 'mcpDelete', null, { danger: true });
      scr.drawButton(mx, subMenuRow, '↻ 刷新', 'refreshAgentSubTab');
    }

    const listStartY = startRow + 2;
    const listHeight = Math.max(2, height - 2);

    if (this.loadingText) {
      scr.writeAt(
        2,
        listStartY + 1,
        truncateToWidth(`⏳ ${this.loadingText}`, cols - 4),
        `${ANSI.fg.brightYellow}${ANSI.bold}`
      );
      return;
    }

    if (this.agentSubTab === 'memory') {
      const items = this.claudeMemoryData?.items || [];
      if (items.length === 0) {
        scr.writeAt(3, listStartY + 1, '未找到 ~/.claude/projects/*/memory/*.md 分项目记忆文件。', ANSI.fg.gray);
        return;
      }
      this.agentSubScroll = this.computeScroll(this.agentSubIdx, this.agentSubScroll, listHeight, items.length);
      const hasSb = items.length > listHeight;
      const itemW = hasSb ? cols - 1 : cols;
      for (let i = 0; i < listHeight; i++) {
        const idx = this.agentSubScroll + i;
        if (idx >= items.length) break;
        const it = items[idx];
        const sel = idx === this.agentSubIdx;
        const rowY = listStartY + i;
        const projShort = truncateToWidth(it.project || it.projectDir, 32);
        const text = `${sel ? ' > ' : '   '}${padEndWidth(projShort, 32)} │ ${it.name} (${it.size}B)`;
        scr.writeAt(
          1,
          rowY,
          padEndWidth(truncateToWidth(text, itemW), itemW),
          sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : ANSI.fg.white
        );
        scr.addHitBox(1, rowY, itemW, rowY, 'agentSubSelect', idx);
      }
      if (hasSb) {
        scr.drawScrollbar(cols, listStartY, listHeight, this.agentSubScroll, items.length, listHeight, 'scrollbarDrag', {
          target: 'agentSub',
          hovered: this._sbHover === 'agentSub' || this._sbDrag?.target === 'agentSub',
        });
      }
      return;
    }

    if (this.agentSubTab === 'prompt') {
      const lines = this.agentPromptData?.lines || [];
      if (lines.length === 0) {
        scr.writeAt(3, listStartY + 1, '暂无全局提示词内容，可点击上方 [✎ 写入/覆盖] 或 [💻 终端编辑]。', ANSI.fg.gray);
        return;
      }
      const hasSb = lines.length > listHeight;
      const itemW = hasSb ? cols - 1 : cols;
      this.agentSubScroll = Math.max(0, Math.min(Math.max(0, lines.length - listHeight), this.agentSubScroll));
      for (let i = 0; i < listHeight; i++) {
        const line = lines[this.agentSubScroll + i];
        if (!line) break;
        scr.writeAt(1, listStartY + i, padEndWidth(truncateToWidth(line.text || '', itemW), itemW), line.style || ANSI.fg.white);
      }
      if (hasSb) {
        scr.drawScrollbar(cols, listStartY, listHeight, this.agentSubScroll, lines.length, listHeight, 'scrollbarDrag', {
          target: 'agentSub',
        });
      }
      return;
    }

    if (this.agentSubTab === 'skills') {
      const skills = this.agentSkillsData?.skills || [];
      if (skills.length === 0) {
        scr.writeAt(3, listStartY + 1, '暂无已安装的 Skill，可点击上方 [+ 安装 Skill]。', ANSI.fg.gray);
        return;
      }
      this.agentSubScroll = this.computeScroll(this.agentSubIdx, this.agentSubScroll, listHeight, skills.length);
      const hasSb = skills.length > listHeight;
      const itemW = hasSb ? cols - 1 : cols;
      for (let i = 0; i < listHeight; i++) {
        const idx = this.agentSubScroll + i;
        if (idx >= skills.length) break;
        const sk = skills[idx];
        const sel = idx === this.agentSubIdx;
        const rowY = listStartY + i;
        const text = `${sel ? ' > ' : '   '}${sk.name}${sk.description ? ` - ${sk.description}` : ''}`;
        scr.writeAt(
          1,
          rowY,
          padEndWidth(truncateToWidth(text, itemW), itemW),
          sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : ANSI.fg.white
        );
        scr.addHitBox(1, rowY, itemW, rowY, 'agentSubSelect', idx);
      }
      if (hasSb) {
        scr.drawScrollbar(cols, listStartY, listHeight, this.agentSubScroll, skills.length, listHeight, 'scrollbarDrag', {
          target: 'agentSub',
        });
      }
      return;
    }

    if (this.agentSubTab === 'mcp') {
      const items = this.agentMcpData?.items || [];
      if (items.length === 0) {
        scr.writeAt(3, listStartY + 1, '暂无配置的 MCP 服务器，可点击上方 [+ 添加/编辑 MCP]。', ANSI.fg.gray);
        return;
      }
      this.agentSubScroll = this.computeScroll(this.agentSubIdx, this.agentSubScroll, listHeight, items.length);
      const hasSb = items.length > listHeight;
      const itemW = hasSb ? cols - 1 : cols;
      for (let i = 0; i < listHeight; i++) {
        const idx = this.agentSubScroll + i;
        if (idx >= items.length) break;
        const it = items[idx];
        const sel = idx === this.agentSubIdx;
        const rowY = listStartY + i;
        const argsStr = it.args?.length ? ` ${it.args.join(' ')}` : '';
        const text = `${sel ? ' > ' : '   '}${it.enabled === false ? '[禁用] ' : '[✓] '}${it.name} │ ${it.command}${argsStr}`;
        scr.writeAt(
          1,
          rowY,
          padEndWidth(truncateToWidth(text, itemW), itemW),
          sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : ANSI.fg.white
        );
        scr.addHitBox(1, rowY, itemW, rowY, 'agentSubSelect', idx);
      }
      if (hasSb) {
        scr.drawScrollbar(cols, listStartY, listHeight, this.agentSubScroll, items.length, listHeight, 'scrollbarDrag', {
          target: 'agentSub',
          hovered: this._sbHover === 'agentSub' || this._sbDrag?.target === 'agentSub',
        });
      }
      return;
    }

    if (this.sessions.length === 0) {
      scr.writeAt(3, listStartY + 1, `未找到匹配的 ${agentType.toUpperCase()} 会话。`, ANSI.fg.gray);
      return;
    }

    const rowsPerItem = 2;
    const visibleItems = Math.max(1, Math.floor(listHeight / rowsPerItem));
    this.sessionScroll = this.computeScroll(
      this.sessionIdx,
      this.sessionScroll,
      visibleItems,
      this.sessions.length
    );
    const hasSb = this.sessions.length > visibleItems;
    const itemW = hasSb ? cols - 1 : cols;

    for (let i = 0; i < visibleItems; i++) {
      const idx = this.sessionScroll + i;
      if (idx >= this.sessions.length) break;
      const s = this.sessions[idx];
      const selected = idx === this.sessionIdx;
      const rowY = listStartY + i * rowsPerItem;
      const timeStr = formatShortTime(s.updatedAt);
      const branch = s.gitBranch ? ` [${s.gitBranch}]` : '';
      const titleLine = `${selected ? ' > ' : '   '}${s.title}`;
      const subText = s.matchSnippet
        ? `     ${timeStr} | ${s.cwd}${branch} | 匹配: ${s.matchSnippet}`
        : `     ${timeStr} | ${s.cwd}${branch} | ID: ${s.sessionId.slice(0, 8)}`;

      const style1 = selected ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : ANSI.fg.brightWhite;
      const style2 = selected ? `${ANSI.bg.cyan}${ANSI.fg.black}` : ANSI.fg.gray;

      scr.writeAt(1, rowY, padEndWidth(truncateToWidth(titleLine, itemW), itemW), style1);
      scr.writeAt(1, rowY + 1, padEndWidth(truncateToWidth(subText, itemW), itemW), style2);
      scr.addHitBox(1, rowY, itemW, rowY + 1, 'selectSession', idx);
    }
    if (hasSb) {
      scr.drawScrollbar(cols, listStartY, listHeight, this.sessionScroll, this.sessions.length, visibleItems, 'scrollbarDrag', {
        target: 'sessions',
        hovered: this._sbHover === 'sessions' || this._sbDrag?.target === 'sessions',
      });
    }
  }

  renderActionBar(scr, y) {
    let x = 1;
    if (this.tab === 'profiles') {
      const landscape = this.isLandscape();
      if (!landscape && this.portraitView === 'commands') {
        x = scr.drawButton(x, y, '← 返回', 'backToServers');
        x = scr.drawButton(x, y, '▶ 运行', 'runQuickCmd', null, { primary: true });
        x = scr.drawButton(x, y, '+ 指令', 'addQuickCmd');
        x = scr.drawButton(x, y, '✎ 改指令', 'editQuickCmd');
        scr.drawButton(x, y, '✕ 删指令', 'deleteQuickCmd', null, { danger: true });
      } else {
        x = scr.drawButton(x, y, '+ 新建', 'newProfile', null, { primary: true });
        x = scr.drawButton(x, y, '✎ 编辑', 'editProfile');
        x = scr.drawButton(x, y, '▲', 'moveProfileUp');
        x = scr.drawButton(x, y, '▼', 'moveProfileDown');
        x = scr.drawButton(x, y, '✕ 删除', 'deleteProfile', null, { danger: true });
        x = scr.drawButton(x, y, '⇩ 导入', 'importSsh');
        x = scr.drawButton(x, y, '🔑 私钥', 'pastePrivateKey');
        if (landscape && this.store.list()[this.profileIdx]) {
          x = scr.drawButton(x, y, '+ 指令', 'addQuickCmd');
          x = scr.drawButton(x, y, '✎ 改指令', 'editQuickCmd');
          scr.drawButton(x, y, '✕ 删指令', 'deleteQuickCmd', null, { danger: true });
        }
      }
    } else if (this.tab === 'files') {
      x = scr.drawButton(x, y, '🔗 终端', 'launchShellInDir', null, { primary: true });
      x = scr.drawButton(x, y, '.. 上级', 'goUp');
      x = scr.drawButton(x, y, '+ 新建', 'newDir');
      x = scr.drawButton(x, y, '✎ 重命名', 'renameDir');
      x = scr.drawButton(x, y, '跳转', 'jumpDir');
      x = scr.drawButton(x, y, this.showHidden ? '• 隐藏' : '• 显隐', 'toggleHidden', null, {
        active: this.showHidden,
      });
      x = scr.drawButton(x, y, this.isDirElevate() ? '🛡 提权:开' : '🛡 提权', 'toggleDirElevate', null, {
        active: this.isDirElevate(),
      });
      scr.drawButton(x, y, '+ 指令', 'addQuickCmdInDir');
    } else if (this.tab === 'docker') {
      if (this.dockerSubTab === 'containers') {
        x = scr.drawButton(x, y, '🐚 进Shell', 'dockerExec', null, { primary: true });
        x = scr.drawButton(x, y, '📜 日志', 'dockerLogs');
        x = scr.drawButton(x, y, '📡 实时日志', 'dockerLogsFollow');
        x = scr.drawButton(x, y, '▶ 启动', 'dockerStart');
        x = scr.drawButton(x, y, '⏸ 停止', 'dockerStop');
        x = scr.drawButton(x, y, '🔄 重启', 'dockerRestart');
        x = scr.drawButton(x, y, '🔍 详情', 'dockerInspect');
        scr.drawButton(x, y, '✕ 删除', 'dockerRemove', null, { danger: true });
      } else if (this.dockerSubTab === 'images') {
        x = scr.drawButton(x, y, '⬇ 拉取镜像', 'dockerPull', null, { primary: true });
        x = scr.drawButton(x, y, '🧹 清理无用资源', 'dockerPrune');
        scr.drawButton(x, y, '✕ 删除镜像', 'dockerRemove', null, { danger: true });
      } else if (this.dockerSubTab === 'compose') {
        x = scr.drawButton(x, y, '▶ Up -d', 'dockerStart', null, { primary: true });
        x = scr.drawButton(x, y, '🔄 Restart', 'dockerRestart');
        scr.drawButton(x, y, '⏹ Down', 'dockerStop', null, { danger: true });
      } else {
        x = scr.drawButton(x, y, '🧹 清理无用资源', 'dockerPrune');
        scr.drawButton(x, y, '✕ 删除', 'dockerRemove', null, { danger: true });
      }
    } else if (this.isAgentTab()) {
      if (this.agentSubTab === 'memory') {
        x = scr.drawButton(x, y, '👁 预览/编辑', 'memoryPreview', null, { primary: true });
        x = scr.drawButton(x, y, '✕ 删除', 'memoryDelete', null, { danger: true });
        scr.drawButton(x, y, '↻ 刷新', 'refreshAgentSubTab');
      } else if (this.agentSubTab === 'prompt') {
        x = scr.drawButton(x, y, '✎ 写入/覆盖', 'editAgentPromptModal', null, { primary: true });
        x = scr.drawButton(x, y, '💻 终端编辑', 'editAgentPromptInTerminal');
        scr.drawButton(x, y, '↻ 刷新', 'refreshAgentSubTab');
      } else if (this.agentSubTab === 'skills') {
        x = scr.drawButton(x, y, '👁 预览', 'skillPreview', null, { primary: true });
        x = scr.drawButton(x, y, '+ 安装 Skill', 'skillInstall');
        x = scr.drawButton(x, y, '✕ 删除', 'skillDelete', null, { danger: true });
        scr.drawButton(x, y, '↻ 刷新', 'refreshAgentSubTab');
      } else if (this.agentSubTab === 'mcp') {
        x = scr.drawButton(x, y, '+ 添加/编辑 MCP', 'mcpAdd', null, { primary: true });
        x = scr.drawButton(x, y, '✕ 删除', 'mcpDelete', null, { danger: true });
        scr.drawButton(x, y, '↻ 刷新', 'refreshAgentSubTab');
      } else {
        x = scr.drawButton(x, y, '▶ 恢复会话', 'resumeSession', null, { primary: true });
        if (this.tab === 'sessions') {
          x = scr.drawButton(x, y, '⑂ 分叉', 'forkSession');
        }
        x = scr.drawButton(x, y, '👁 预览', 'previewSession');
        if (this.tab === 'sessions') {
          x = scr.drawButton(x, y, '📊 Token统计', 'openTokenStats');
          x = scr.drawButton(x, y, '📊 单条统计', 'openSessionTokenStats');
        }
        x = scr.drawButton(x, y, '🔍 搜索', 'searchSessions');
        scr.drawButton(x, y, '↻ 刷新', 'refreshSessions');
      }
    }
  }

  getTokenStatsRows(m) {
    if (!m?.stats) return [];
    if (m.view === 'route') return m.stats.byRoute || [];
    if (m.view === 'hour') return m.stats.byHour || [];
    if (m.view === 'day') return m.stats.byDay || [];
    if (m.view === 'items') return m.stats.items || [];
    return m.stats.byModel || [];
  }

  renderModal(scr, cols, rows) {
    const m = this.modal;
    const w = Math.min(
      cols - 4,
      m.type === 'preview' || m.type === 'tokenStats'
        ? Math.max(66, cols - 6)
        : m.type === 'profileForm' ||
            m.type === 'agentSkills' ||
            m.type === 'agentMcp' ||
            m.type === 'claudeMemory' ||
            m.type === 'plugins' ||
            m.type === 'pluginServerConfig' ||
            m.type === 'sshImport'
          ? 78
          : 64
    );
    const h =
      m.type === 'profileForm'
        ? Math.min(rows - 2, m.fields.length + 6)
        : m.type === 'preview' ||
            m.type === 'sshImport' ||
            m.type === 'plugins' ||
            m.type === 'pluginServerConfig' ||
            m.type === 'tokenStats' ||
            m.type === 'agentSkills' ||
            m.type === 'agentMcp' ||
            m.type === 'claudeMemory' ||
            m.type === 'actionPalette'
          ? Math.min(rows - 2, 20)
          : m.type === 'appUpdate'
            ? Math.min(rows - 2, 14)
            : 8;
    const x = Math.max(1, Math.floor((cols - w) / 2) + 1);
    const y = Math.max(1, Math.floor((rows - h) / 2) + 1);

    scr.addHitBox(1, 1, cols, rows, 'modalBackdrop', null);
    const inner = scr.drawBox(x, y, w, h, m.title);
    scr.setClipMaxX(inner.x + inner.w - 1);
    scr.addHitBox(x, y, x + w - 1, y + h - 1, 'modalNoop', null);
    const bg = `${ANSI.bg.navy}${ANSI.fg.brightWhite}`;

    if (m.type === 'input') {
      scr.writeAt(inner.x, inner.y, truncateToWidth(m.prompt, inner.w), bg);
      const cur = typeof m.cursor === 'number' ? Math.max(0, Math.min(m.value.length, m.cursor)) : m.value.length;
      const win = sliceInputWindow(m.value, cur, Math.max(4, inner.w - 2));
      m._sliceStart = win.sliceStart;
      const boxVal = padEndWidth(` ${win.visible}`, inner.w);
      scr.writeAt(inner.x, inner.y + 2, boxVal, `${ANSI.bg.black}${ANSI.fg.brightYellow}`);
      scr.addHitBox(inner.x, inner.y + 2, inner.x + inner.w - 1, inner.y + 2, 'modalInputClick', {
        textStartX: inner.x + 1,
      });
      const cursorX = Math.min(inner.x + inner.w - 1, inner.x + 1 + win.cursorOffsetCols);
      scr.setCursor(cursorX, inner.y + 2);
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✓ 确定 (Enter)', 'modalSubmit', null, { primary: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '⌫ 清空', 'modalClearInput');
      scr.drawButton(bx, inner.y + inner.h - 1, '✕ 取消 (Esc)', 'modalCancel');
    } else if (m.type === 'confirm') {
      scr.writeAt(inner.x, inner.y + 1, truncateToWidth(m.message, inner.w), bg);
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✓ 确认', 'modalSubmit', null, { danger: true });
      scr.drawButton(bx, inner.y + inner.h - 1, '✕ 取消', 'modalCancel');
    } else if (m.type === 'profileForm') {
      const labelW = Math.min(26, Math.max(16, Math.floor(inner.w * 0.42)));
      const inputW = Math.max(10, inner.w - labelW - 1);
      m._inputStartX = inner.x + labelW;
      let keyFieldRowY = -1;
      for (let i = 0; i < m.fields.length && i < inner.h - 2; i++) {
        const f = m.fields[i];
        const focused = i === m.focusIdx;
        const hasDropdown = !m.isSettings && !m.isQuickCmd && f.key === 'identityFile' && m.keyCandidates?.length > 0;
        const label = padEndWidth(f.label, labelW);
        const cur = typeof f.cursor === 'number' ? Math.max(0, Math.min(f.value.length, f.cursor)) : f.value.length;
        const textW = hasDropdown ? Math.max(6, inputW - 2) : inputW;
        const displayVal = f.masked ? '*'.repeat(f.value.length) : f.value;
        const win = sliceInputWindow(displayVal, focused ? cur : displayVal.length, textW);
        f._sliceStart = win.sliceStart;
        const val = hasDropdown
          ? padEndWidth(win.visible, textW) + (m.keyDropdownOpen ? ' ▲' : ' ▼')
          : padEndWidth(win.visible, inputW);
        const rowY = inner.y + i;
        if (f.key === 'identityFile') keyFieldRowY = rowY;
        scr.writeAt(inner.x, rowY, label, bg);
        scr.writeAt(
          inner.x + labelW,
          rowY,
          val,
          focused ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : `${ANSI.bg.black}${ANSI.fg.white}`
        );
        if (focused && !m.keyDropdownOpen) {
          const cursorX = Math.min(inner.x + labelW + textW - 1, inner.x + labelW + win.cursorOffsetCols);
          scr.setCursor(cursorX, rowY);
        }
        scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'modalFocusField', i);
      }
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, m.isTimeRange ? '✓ 应用' : '✓ 保存', 'modalSubmit', null, {
        primary: true,
      });
      if (m.isTimeRange) {
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '1天', 'tokenStatsPreset', '1d');
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '1周', 'tokenStatsPreset', '7d');
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '1月', 'tokenStatsPreset', '30d');
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '1年', 'tokenStatsPreset', '365d');
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '到现在', 'tokenStatsPreset', 'now');
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '全部', 'tokenStatsPreset', 'all');
      }
      scr.drawButton(bx, inner.y + inner.h - 1, '✕ 取消', 'modalCancel');

      if (m.keyDropdownOpen && keyFieldRowY >= 0 && m.keyCandidates?.length > 0) {
        const dropX = inner.x + labelW;
        const dropY = keyFieldRowY + 1;
        const availRows = inner.y + inner.h - 1 - dropY;
        const viewRows = Math.min(m.keyCandidates.length, Math.max(1, Math.min(6, availRows)));
        m.keyDropdownScroll = this.computeScroll(
          m.keyDropdownIdx || 0,
          m.keyDropdownScroll || 0,
          viewRows,
          m.keyCandidates.length
        );
        for (let i = 0; i < viewRows; i++) {
          const candIdx = m.keyDropdownScroll + i;
          const cand = m.keyCandidates[candIdx];
          const sel = candIdx === m.keyDropdownIdx;
          const itemText = padEndWidth(truncateToWidth(`${sel ? '▶ ' : '  '}${cand}`, inputW), inputW);
          const itemY = dropY + i;
          scr.writeAt(
            dropX,
            itemY,
            itemText,
            sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : `${ANSI.bg.darkGray}${ANSI.fg.brightWhite}`
          );
          scr.addHitBox(dropX, itemY, dropX + inputW - 1, itemY, 'selectKeyCandidate', candIdx);
        }
      }
    } else if (m.type === 'preview') {
      const viewH = inner.h - 2;
      const hasSb = m.lines.length > viewH;
      const lineW = hasSb ? inner.w - 1 : inner.w;
      for (let i = 0; i < viewH; i++) {
        const line = m.lines[m.scroll + i];
        if (line === undefined) break;
        const text = typeof line === 'string' ? line : line.text;
        const style = typeof line === 'string' ? bg : line.style ? `${ANSI.bg.navy}${line.style}` : bg;
        scr.writeAt(inner.x, inner.y + i, padEndWidth(truncateToWidth(text, lineW), lineW), style);
      }
      if (hasSb) {
        scr.drawScrollbar(
          inner.x + inner.w - 1,
          inner.y,
          viewH,
          m.scroll,
          m.lines.length,
          viewH,
          'scrollbarDrag',
          { target: 'modal', hovered: this._sbHover === 'modal' || this._sbDrag?.target === 'modal' }
        );
      }
      let bx = inner.x;
      if (m.promptMeta) {
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '✎ 写入/覆盖', 'editAgentPromptModal', null, { primary: true });
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '💻 终端编辑', 'editAgentPromptInTerminal');
      } else if (!m.title?.startsWith('🛠 Skill:')) {
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '▶ 恢复此会话', 'previewResume', null, { primary: true });
      }
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '▲ 上翻', 'previewScrollUp');
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '▼ 下翻', 'previewScrollDown');
      scr.drawButton(bx, inner.y + inner.h - 1, '关闭 (Esc)', 'modalCancel');
    } else if (m.type === 'agentSkills') {
      const viewH = inner.h - 2;
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, m.skills.length);
      if (m.skills.length === 0) {
        scr.writeAt(inner.x, inner.y + 1, '暂无已安装的 Skill，可点击下方 [+ 安装 Skill]。', ANSI.fg.gray);
      } else {
        for (let i = 0; i < viewH; i++) {
          const idx = m.scroll + i;
          if (idx >= m.skills.length) break;
          const sk = m.skills[idx];
          const sel = idx === m.idx;
          const rowY = inner.y + i;
          const text = `${sel ? '> ' : '  '}${sk.name}${sk.description ? ` - ${sk.description}` : ''}`;
          scr.writeAt(
            inner.x,
            rowY,
            padEndWidth(truncateToWidth(text, inner.w), inner.w),
            sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : bg
          );
          scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'skillSelect', idx);
        }
      }
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '👁 预览', 'skillPreview', null, { primary: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '+ 安装 Skill', 'skillInstall');
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✕ 删除', 'skillDelete', null, { danger: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '↻ 刷新', 'refreshAgentSkills');
      scr.drawButton(bx, inner.y + inner.h - 1, '关闭 (Esc)', 'modalCancel');
    } else if (m.type === 'agentMcp') {
      const viewH = inner.h - 2;
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, m.items.length);
      if (m.items.length === 0) {
        scr.writeAt(inner.x, inner.y + 1, '暂无配置的 MCP 服务器，可点击下方 [+ 添加/编辑 MCP]。', ANSI.fg.gray);
      } else {
        for (let i = 0; i < viewH; i++) {
          const idx = m.scroll + i;
          if (idx >= m.items.length) break;
          const it = m.items[idx];
          const sel = idx === m.idx;
          const rowY = inner.y + i;
          const argsStr = it.args?.length ? ` ${it.args.join(' ')}` : '';
          const text = `${sel ? '> ' : '  '}${it.enabled === false ? '[禁用] ' : '[✓] '}${it.name} │ ${it.command}${argsStr}`;
          scr.writeAt(
            inner.x,
            rowY,
            padEndWidth(truncateToWidth(text, inner.w), inner.w),
            sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : bg
          );
          scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'mcpSelect', idx);
        }
      }
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '+ 添加/编辑 MCP', 'mcpAdd', null, { primary: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✕ 删除', 'mcpDelete', null, { danger: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '↻ 刷新', 'refreshAgentMcp');
      scr.drawButton(bx, inner.y + inner.h - 1, '关闭 (Esc)', 'modalCancel');
    } else if (m.type === 'claudeMemory') {
      const viewH = inner.h - 2;
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, m.items.length);
      if (m.items.length === 0) {
        scr.writeAt(inner.x, inner.y + 1, '未找到 ~/.claude/projects/*/memory/*.md 分项目记忆文件。', ANSI.fg.gray);
      } else {
        for (let i = 0; i < viewH; i++) {
          const idx = m.scroll + i;
          if (idx >= m.items.length) break;
          const it = m.items[idx];
          const sel = idx === m.idx;
          const rowY = inner.y + i;
          const projShort = truncateToWidth(it.project || it.projectDir, 28);
          const text = `${sel ? '> ' : '  '}${padEndWidth(projShort, 28)} │ ${it.name} (${it.size}B)`;
          scr.writeAt(
            inner.x,
            rowY,
            padEndWidth(truncateToWidth(text, inner.w), inner.w),
            sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : bg
          );
          scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'memorySelect', idx);
        }
      }
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '👁 预览/编辑', 'memoryPreview', null, { primary: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✕ 删除', 'memoryDelete', null, { danger: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '↻ 刷新', 'refreshClaudeMemory');
      scr.drawButton(bx, inner.y + inner.h - 1, '关闭 (Esc)', 'modalCancel');
    } else if (m.type === 'sshImport') {
      const viewH = inner.h - 2;
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, m.candidates.length);
      for (let i = 0; i < viewH; i++) {
        const idx = m.scroll + i;
        if (idx >= m.candidates.length) break;
        const c = m.candidates[idx];
        const sel = idx === m.idx;
        const rowY = inner.y + i;
        const text = `${sel ? '> ' : '  '}${c.name} (${c.user ? `${c.user}@` : ''}${c.host}:${c.port})`;
        scr.writeAt(
          inner.x,
          rowY,
          padEndWidth(text, inner.w),
          sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : bg
        );
        scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'sshImportSelect', idx);
      }
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✓ 导入选中', 'modalSubmit', null, { primary: true });
      scr.drawButton(bx, inner.y + inner.h - 1, '✕ 取消', 'modalCancel');
    } else if (m.type === 'actionPalette') {
      const viewH = inner.h - 2;
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, m.items.length);
      for (let i = 0; i < viewH; i++) {
        const idx = m.scroll + i;
        if (idx >= m.items.length) break;
        const it = m.items[idx];
        const sel = idx === m.idx;
        const rowY = inner.y + i;
        const text = `${sel ? '> ' : '  '}[${it.zone}] ${it.label}`;
        scr.writeAt(
          inner.x,
          rowY,
          padEndWidth(truncateToWidth(text, inner.w), inner.w),
          sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : ANSI.fg.white
        );
        scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'actionPaletteSelect', idx);
      }
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✓ 执行选中 (Enter)', 'actionPaletteRun', null, { primary: true });
      scr.drawButton(bx, inner.y + inner.h - 1, '关闭 (Esc)', 'modalCancel');
    } else if (m.type === 'appUpdate') {
      const info = m.info || {};
      const curVer = info.currentVersion || getCurrentVersion();
      const latVer = info.latestVersion || curVer;
      // Fixed header rows
      let headerY = inner.y;
      scr.writeAt(inner.x, headerY++, `当前版本: v${curVer}`, ANSI.fg.brightWhite);
      scr.writeAt(
        inner.x,
        headerY++,
        info.ok
          ? info.hasUpdate
            ? `最新版本: v${latVer} (有可用更新！)`
            : `最新版本: v${latVer} (已是最新)`
          : `检查失败: ${info.error || '未知错误'}`,
        info.ok ? (info.hasUpdate ? ANSI.fg.brightYellow : ANSI.fg.brightGreen) : ANSI.fg.red
      );
      if (info.releaseUrl) {
        scr.writeAt(inner.x, headerY++, truncateToWidth(`Release: ${info.releaseUrl}`, inner.w), ANSI.fg.brightCyan);
      }
      // Scrollable content area (between header and button row)
      const contentStartY = headerY;
      const contentH = inner.y + inner.h - 1 - contentStartY; // -1 for button row
      if (m.loading) {
        scr.writeAt(inner.x, contentStartY + 1, '⏳ 正在检查中...', ANSI.fg.brightYellow);
      } else if (m.upgradeDoneMsg) {
        const wlines = wrapTextToWidth(m.upgradeDoneMsg, inner.w - 2);
        for (let i = 0; i < Math.min(wlines.length, contentH); i++) {
          scr.writeAt(inner.x, contentStartY + i, wlines[i], ANSI.fg.brightGreen);
        }
      } else if (info.releaseNotes && info.releaseNotes.trim()) {
        // Build all rendered lines with markdown
        const allLines = [
          { text: '── 更新说明 ──', style: `${ANSI.fg.gray}${ANSI.bold}` },
          ...renderMarkdownLines(info.releaseNotes, inner.w - 2, ANSI.fg.white),
        ];
        // Clamp scroll
        const maxScroll = Math.max(0, allLines.length - contentH);
        m.scroll = Math.max(0, Math.min(m.scroll || 0, maxScroll));
        // Render visible slice
        for (let i = 0; i < contentH; i++) {
          const lineIdx = (m.scroll || 0) + i;
          if (lineIdx >= allLines.length) break;
          const ln = allLines[lineIdx];
          scr.writeAt(inner.x, contentStartY + i, truncateToWidth(ln.text, inner.w - 1), ln.style);
        }
        // Draw scrollbar if content overflows
        if (allLines.length > contentH) {
          scr.drawScrollbar(
            inner.x + inner.w,
            contentStartY,
            contentH,
            m.scroll || 0,
            allLines.length,
            contentH,
            'appUpdateScroll'
          );
        }
      }
      // Bottom buttons
      let bx = inner.x;
      if (info.hasUpdate) {
        bx = scr.drawButton(bx, inner.y + inner.h - 1, '⬆ 立即升级', 'runAppUpgrade', null, { primary: true });
      }
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '🔄 重新检查', 'refreshAppUpdate');
      scr.drawButton(bx, inner.y + inner.h - 1, '关闭 (Esc)', 'modalCancel');
    } else if (m.type === 'plugins') {
      const viewH = inner.h - 2;
      const targetSrv = this.activeProfile || this.store.list()[this.profileIdx] || null;
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, m.catalog.length);
      for (let i = 0; i < viewH; i++) {
        const idx = m.scroll + i;
        if (idx >= m.catalog.length) break;
        const p = m.catalog[idx];
        const sel = idx === m.idx;
        const rowY = inner.y + i;
        const srvDisabled = targetSrv ? this.plugins.isDisabledForProfile(p.id, targetSrv) : false;
        const badge = p.hasUpdate
          ? `[⬆ 可更新 v${p.remoteVersion}]`
          : !p.installed
            ? p.remoteAvailable && !p.builtin
              ? '[☁ 远端可下载]'
              : '[未安装]'
            : !p.enabled
              ? '[○ 已禁用]'
              : srvDisabled
                ? '[⊘ 本服禁用]'
                : '[✓ 已启用]';
        const catTag = p.category ? `[${p.category}] ` : '';
        const text = `${sel ? '> ' : '  '}${badge} ${catTag}${p.name} v${p.version} - ${p.description}`;
        scr.writeAt(
          inner.x,
          rowY,
          padEndWidth(truncateToWidth(text, inner.w), inner.w),
          sel
            ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}`
            : p.hasUpdate
              ? ANSI.fg.brightYellow
              : p.enabled && !srvDisabled
                ? ANSI.fg.brightGreen
                : !p.installed && p.remoteAvailable && !p.builtin
                  ? ANSI.fg.brightCyan
                  : bg
        );
        scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'pluginSelect', idx);
      }
      const curPlugin = m.catalog[m.idx];
      const primaryLabel = curPlugin?.hasUpdate ? '⬆ 更新' : '✓ 安装/启停';
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, primaryLabel, 'pluginToggleOrInstall', null, { primary: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '🔄 同步', 'pluginSyncRemote');
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '🌐 源设置', 'pluginEditSource');
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '⚙ 权限', 'openPluginServers');
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '📦 本地', 'pluginInstallLocal');
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✕ 卸载', 'pluginUninstall', null, { danger: true });
      scr.drawButton(bx, inner.y + inner.h - 1, '关闭', 'modalCancel');
    } else if (m.type === 'pluginServerConfig') {
      const servers = this.store.list();
      const viewH = inner.h - 2;
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, servers.length);
      if (servers.length === 0) {
        scr.writeAt(inner.x, inner.y + 1, '暂无已配置服务器。', ANSI.fg.gray);
      } else {
        for (let i = 0; i < viewH; i++) {
          const idx = m.scroll + i;
          if (idx >= servers.length) break;
          const srv = servers[idx];
          const sel = idx === m.idx;
          const rowY = inner.y + i;
          const disabled = this.plugins.isDisabledForProfile(m.plugin.id, srv);
          const badge = disabled ? '[⊘ 已禁用]' : '[✓ 已启用]';
          const text = `${sel ? '> ' : '  '}${badge} ${srv.name} (${srv.user ? `${srv.user}@` : ''}${srv.host}:${srv.port})`;
          scr.writeAt(
            inner.x,
            rowY,
            padEndWidth(truncateToWidth(text, inner.w), inner.w),
            sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : disabled ? ANSI.fg.gray : ANSI.fg.brightGreen
          );
          scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'pluginServerSelect', idx);
        }
      }
      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✓ 切换状态', 'pluginServerToggle', null, { primary: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '✓ 全部启用', 'pluginServersEnableAll');
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '⊘ 全部禁用', 'pluginServersDisableAll');
      scr.drawButton(bx, inner.y + inner.h - 1, '← 返回', 'openPlugins');
    } else if (m.type === 'tokenStats') {
      const s = m.stats.summary;
      const fmtSpeed = (v) => (v !== null && v !== undefined ? `≈${Math.round(v)}tok/s` : '—');
      const fmtTtft = (v) => (v !== null && v !== undefined ? `≈${(v / 1000).toFixed(1)}s` : '—');
      const fmtSucc = (v) => `${(v ?? 100).toFixed(v === 100 || v === 0 ? 0 : 1)}%`;

      let vx = inner.x;
      vx = scr.drawButton(vx, inner.y, '1.按模型', 'tokenStatsView', 'model', { active: m.view === 'model' });
      vx = scr.drawButton(vx, inner.y, '2.按路由', 'tokenStatsView', 'route', { active: m.view === 'route' });
      vx = scr.drawButton(vx, inner.y, '3.按小时', 'tokenStatsView', 'hour', { active: m.view === 'hour' });
      vx = scr.drawButton(vx, inner.y, '4.按天', 'tokenStatsView', 'day', { active: m.view === 'day' });
      vx = scr.drawButton(vx, inner.y, '5.请求日志', 'tokenStatsView', 'items', { active: m.view === 'items' });
      vx = scr.drawButton(vx, inner.y, '⏱时间', 'tokenStatsEditTime', null, { active: m.preset === 'custom' });
      vx = scr.drawButton(vx, inner.y, '当天', 'tokenStatsPreset', 'today', { active: m.preset === 'today' });
      vx = scr.drawButton(vx, inner.y, '1周', 'tokenStatsPreset', '7d', { active: m.preset === '7d' });
      vx = scr.drawButton(vx, inner.y, '1月', 'tokenStatsPreset', '30d', { active: m.preset === '30d' });
      scr.drawButton(vx, inner.y, '全部', 'tokenStatsPreset', 'all', { active: !m.preset || m.preset === 'all' });

      // Prominent top KPI summary banner (CC Switch style)
      const kpiText = ` 💰 总成本: ${formatCostUsd(s.costUsd)}   │   📊 总请求: ${s.calls}   │   🔥 Tokens: ${formatTokenCount(s.totalTokens)}   │   ⚡ 缓存命中率: ${s.cacheRate.toFixed(1)}%`;
      scr.writeAt(
        inner.x,
        inner.y + 1,
        padEndWidth(truncateToWidth(kpiText, inner.w), inner.w),
        `${ANSI.bg.teal}${ANSI.fg.brightWhite}${ANSI.bold}`
      );

      const rangeText =
        m.startTime || m.endTime ? `${m.startTime || '最早'} ~ ${m.endTime || '最新'}` : '全部时间';
      const subText = ` [${s.tzLabel}·${rangeText}]  In:${formatTokenCount(s.input)} Out:${formatTokenCount(s.output)}  成功率:${fmtSucc(s.successRate)}  速度:${fmtSpeed(s.tokPerSec)}  首字:${fmtTtft(s.avgTtftMs)}`;
      scr.writeAt(
        inner.x,
        inner.y + 2,
        padEndWidth(truncateToWidth(subText, inner.w), inner.w),
        `${ANSI.bg.navy}${ANSI.fg.brightCyan}`
      );

      // Table column header
      const colW = Math.max(14, inner.w - 58);
      let hdr = '';
      if (m.view === 'model') {
        hdr = `  ${padEndWidth('模型', colW)} ${padEndWidth('请求数', 7)} ${padEndWidth('成本', 9)} ${padEndWidth('Tokens', 8)} ${padEndWidth('缓存率', 7)} ${padEndWidth('成功率', 7)} ${padEndWidth('速度', 10)} 首字`;
      } else if (m.view === 'route') {
        hdr = `  ${padEndWidth('模型路由 (请求 -> 返回)', colW)} ${padEndWidth('请求数', 7)} ${padEndWidth('成本', 9)} ${padEndWidth('Tokens', 8)} ${padEndWidth('缓存率', 7)} ${padEndWidth('成功率', 7)} ${padEndWidth('速度', 10)} 首字`;
      } else if (m.view === 'hour' || m.view === 'day') {
        hdr = `  ${padEndWidth('时段', colW)} ${padEndWidth('请求数', 7)} ${padEndWidth('成本', 9)} ${padEndWidth('Tokens', 8)} ${padEndWidth('缓存率', 7)} ${padEndWidth('成功率', 7)} 速度`;
      } else {
        hdr = `  ${padEndWidth('时间', 19)} ${padEndWidth('成本', 8)} ${padEndWidth('路由', 24)} ${padEndWidth('Tokens', 8)} ${padEndWidth('缓存', 6)} 会话`;
      }
      scr.writeAt(
        inner.x,
        inner.y + 3,
        padEndWidth(truncateToWidth(hdr, inner.w), inner.w),
        `${ANSI.bg.darkGray}${ANSI.fg.gray}${ANSI.bold}`
      );

      const rowsList = this.getTokenStatsRows(m);
      const listStartY = inner.y + 4;
      const viewH = Math.max(1, inner.h - 6);
      m.scroll = this.computeScroll(m.idx, m.scroll, viewH, rowsList.length);

      if (rowsList.length === 0) {
        scr.writeAt(inner.x, listStartY + 1, '该时间范围内暂无 Token 使用记录。', ANSI.fg.gray);
      } else {
        for (let i = 0; i < viewH; i++) {
          const idx = m.scroll + i;
          if (idx >= rowsList.length) break;
          const r = rowsList[idx];
          const sel = idx === m.idx;
          const rowY = listStartY + i;
          let line = '';
          if (m.view === 'model') {
            line = `${sel ? '>' : ' '} ${padEndWidth(truncateToWidth(r.model, colW), colW)} ${padEndWidth(String(r.calls), 7)} ${padEndWidth(formatCostUsd(r.costUsd), 9)} ${padEndWidth(formatTokenCount(r.totalTokens), 8)} ${padEndWidth(`${r.cacheRate.toFixed(1)}%`, 7)} ${padEndWidth(fmtSucc(r.successRate), 7)} ${padEndWidth(fmtSpeed(r.tokPerSec), 10)} ${fmtTtft(r.avgTtftMs)}`;
          } else if (m.view === 'route') {
            const routeName = r.reqModel !== r.respModel ? `${r.reqModel} -> ${r.respModel}` : r.respModel;
            line = `${sel ? '>' : ' '} ${padEndWidth(truncateToWidth(routeName, colW), colW)} ${padEndWidth(String(r.calls), 7)} ${padEndWidth(formatCostUsd(r.costUsd), 9)} ${padEndWidth(formatTokenCount(r.totalTokens), 8)} ${padEndWidth(`${r.cacheRate.toFixed(1)}%`, 7)} ${padEndWidth(fmtSucc(r.successRate), 7)} ${padEndWidth(fmtSpeed(r.tokPerSec), 10)} ${fmtTtft(r.avgTtftMs)}`;
          } else if (m.view === 'hour' || m.view === 'day') {
            line = `${sel ? '>' : ' '} ${padEndWidth(truncateToWidth(r.bucket, colW), colW)} ${padEndWidth(String(r.calls), 7)} ${padEndWidth(formatCostUsd(r.costUsd), 9)} ${padEndWidth(formatTokenCount(r.totalTokens), 8)} ${padEndWidth(`${r.cacheRate.toFixed(1)}%`, 7)} ${padEndWidth(fmtSucc(r.successRate), 7)} ${fmtSpeed(r.tokPerSec)}`;
          } else {
            const routeName = r.reqModel !== r.respModel ? `${r.reqModel}->${r.respModel}` : r.respModel;
            line = `${sel ? '>' : ' '} ${padEndWidth(r.localTime, 19)} ${padEndWidth(formatCostUsd(r.costUsd), 8)} ${padEndWidth(truncateToWidth(routeName, 24), 24)} ${padEndWidth(formatTokenCount(r.totalTokens), 8)} ${padEndWidth(`${r.cacheRate.toFixed(0)}%`, 6)} ${r.sessionTitle}`;
          }
          const style = sel ? `${ANSI.bg.cyan}${ANSI.fg.black}${ANSI.bold}` : bg;
          scr.writeAt(inner.x, rowY, padEndWidth(truncateToWidth(line, inner.w), inner.w), style);
          scr.addHitBox(inner.x, rowY, inner.x + inner.w - 1, rowY, 'tokenStatsSelect', idx);
        }
      }

      let bx = inner.x;
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '↻ 刷新(r)', 'refreshTokenStats', null, { primary: true });
      bx = scr.drawButton(bx, inner.y + inner.h - 1, '关闭(Esc)', 'modalCancel');
      const hint = ' ←/→切视图 | Tab切时间(d/w/m/a) | t自定义 | ↑/↓滚表';
      if (bx + 4 < inner.x + inner.w) {
        scr.writeAt(bx, inner.y + inner.h - 1, truncateToWidth(hint, inner.x + inner.w - bx), ANSI.fg.gray);
      }
    }
    scr.clearClipMaxX();
  }

  computeScroll(idx, prevScroll, viewHeight, total) {
    if (total <= viewHeight) return 0;
    let s = prevScroll;
    if (idx < s) s = idx;
    if (idx >= s + viewHeight) s = idx - viewHeight + 1;
    return Math.max(0, Math.min(total - viewHeight, s));
  }
}
