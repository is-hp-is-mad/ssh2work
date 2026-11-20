import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSemver } from './plugins.js';

export const APP_REPO = 'is-hp-is-mad/ssh4work';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT_DIR = path.resolve(__dirname, '..');

export function getCurrentVersion(rootDir = APP_ROOT_DIR) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
    return String(pkg.version || '0.0.0').trim();
  } catch {
    return '0.0.0';
  }
}

/**
 * Check GitHub Releases (with raw package.json fallback) for a newer version of ssh4work.
 */
export async function checkForAppUpdate({
  repo = APP_REPO,
  currentVersion = getCurrentVersion(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 10000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    return {
      ok: false,
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
      releaseUrl: `https://github.com/${repo}/releases`,
      releaseNotes: '',
      error: '当前 Node 环境不支持 fetch',
    };
  }

  const fetchJson = async (url) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const resp = await fetchImpl(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'ssh4work', Accept: 'application/vnd.github+json' },
      });
      if (!resp.ok) return { ok: false, status: resp.status, data: null };
      return { ok: true, status: resp.status, data: await resp.json() };
    } catch (err) {
      return { ok: false, status: 0, error: err?.name === 'AbortError' ? '请求超时' : err?.message || '网络错误' };
    } finally {
      clearTimeout(timer);
    }
  };

  const relRes = await fetchJson(`https://api.github.com/repos/${repo}/releases/latest`);
  if (relRes.ok && relRes.data) {
    const tag = String(relRes.data.tag_name || relRes.data.name || '').trim();
    const latestVersion = tag.replace(/^v/i, '');
    if (latestVersion) {
      return {
        ok: true,
        currentVersion,
        latestVersion,
        tagName: tag,
        hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
        releaseUrl: relRes.data.html_url || `https://github.com/${repo}/releases`,
        releaseNotes: String(relRes.data.body || '').trim(),
        publishedAt: relRes.data.published_at || '',
        error: '',
      };
    }
  }

  // Fallback to main branch package.json when no Release exists or API is rate-limited
  const pkgRes = await fetchJson(`https://raw.githubusercontent.com/${repo}/main/package.json`);
  if (pkgRes.ok && pkgRes.data?.version) {
    const latestVersion = String(pkgRes.data.version).trim().replace(/^v/i, '');
    return {
      ok: true,
      currentVersion,
      latestVersion,
      tagName: `v${latestVersion}`,
      hasUpdate: compareSemver(latestVersion, currentVersion) > 0,
      releaseUrl: `https://github.com/${repo}/releases`,
      releaseNotes: '',
      publishedAt: '',
      error: '',
    };
  }

  return {
    ok: false,
    currentVersion,
    latestVersion: currentVersion,
    hasUpdate: false,
    releaseUrl: `https://github.com/${repo}/releases`,
    releaseNotes: '',
    error: relRes.error || pkgRes.error || `检查更新失败 (HTTP ${relRes.status || pkgRes.status || 0})`,
  };
}

/**
 * Upgrade the local ssh4work installation (git pull + npm link for cloned repos, or npm install -g).
 */
export function performAppUpgrade({ repo = APP_REPO, installDir = APP_ROOT_DIR, inheritStdio = false } = {}) {
  const previousVersion = getCurrentVersion(installDir);
  const isGitRepo = fs.existsSync(path.join(installDir, '.git'));
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const stdioOpt = inheritStdio ? 'inherit' : 'pipe';

  if (isGitRepo) {
    const dirty = spawnSync('git', ['-C', installDir, 'status', '--porcelain'], { encoding: 'utf8' });
    if (dirty.status === 0 && dirty.stdout.trim()) {
      return {
        ok: false,
        method: 'git',
        previousVersion,
        newVersion: previousVersion,
        error: `本地仓库存在未提交的修改，请先处理后再升级 (${installDir})`,
      };
    }

    if (inheritStdio) console.log('⬇ 正在从 GitHub 下载最新代码 (git pull --ff-only)...');
    const pull = spawnSync('git', ['-C', installDir, 'pull', '--ff-only', 'origin', 'main'], {
      encoding: 'utf8',
      stdio: stdioOpt,
    });
    if (pull.status !== 0) {
      return {
        ok: false,
        method: 'git',
        previousVersion,
        newVersion: previousVersion,
        error: (pull.stderr || pull.stdout || 'git pull 失败').trim(),
      };
    }

    if (inheritStdio) console.log('🔗 正在刷新全局命令链接 (npm link)...');
    spawnSync(npmCmd, ['link'], {
      cwd: installDir,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      stdio: stdioOpt,
    });

    const newVersion = getCurrentVersion(installDir);
    return {
      ok: true,
      method: 'git',
      previousVersion,
      newVersion,
      output: (pull.stdout || '').trim(),
      error: '',
    };
  }

  if (inheritStdio) console.log(`⬇ 正在从 GitHub 下载并安装最新版本 (npm install -g git+https://github.com/${repo}.git)...`);
  const install = spawnSync(npmCmd, ['install', '-g', `git+https://github.com/${repo}.git`], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
    stdio: stdioOpt,
  });
  if (install.status !== 0) {
    return {
      ok: false,
      method: 'npm',
      previousVersion,
      newVersion: previousVersion,
      error: (install.stderr || install.stdout || 'npm 全局升级失败').trim(),
    };
  }
  const newVersion = getCurrentVersion(installDir);
  return {
    ok: true,
    method: 'npm',
    previousVersion,
    newVersion,
    output: (install.stdout || '').trim(),
    error: '',
  };
}

function runCommandAsync(cmd, args, opts = {}, onLine) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const emitLines = (chunk) => {
      const text = chunk.toString('utf8');
      if (typeof onLine === 'function') {
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length > 0) onLine(lines[lines.length - 1]);
      }
      return text;
    };
    child.stdout?.on('data', (d) => { stdout += emitLines(d); });
    child.stderr?.on('data', (d) => { stderr += emitLines(d); });
    child.on('error', (err) => resolve({ status: 1, stdout, stderr: err?.message || String(err) }));
    child.on('close', (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

/**
 * Async version of performAppUpgrade that reports progress so TUI can animate downloading status.
 */
export async function performAppUpgradeAsync({ repo = APP_REPO, installDir = APP_ROOT_DIR, onProgress } = {}) {
  const notify = (msg) => {
    if (typeof onProgress === 'function') onProgress(msg);
  };
  const previousVersion = getCurrentVersion(installDir);
  const isGitRepo = fs.existsSync(path.join(installDir, '.git'));
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';

  if (isGitRepo) {
    notify('正在检查本地仓库状态...');
    const dirty = await runCommandAsync('git', ['-C', installDir, 'status', '--porcelain']);
    if (dirty.status === 0 && dirty.stdout.trim()) {
      return {
        ok: false,
        method: 'git',
        previousVersion,
        newVersion: previousVersion,
        error: `本地仓库存在未提交的修改，请先处理后再升级 (${installDir})`,
      };
    }

    notify('⬇ 正在从 GitHub 下载更新 (git pull)...');
    const pull = await runCommandAsync(
      'git',
      ['-C', installDir, 'pull', '--ff-only', '--progress', 'origin', 'main'],
      {},
      (line) => notify(`⬇ 下载中: ${line}`)
    );
    if (pull.status !== 0) {
      return {
        ok: false,
        method: 'git',
        previousVersion,
        newVersion: previousVersion,
        error: (pull.stderr || pull.stdout || 'git pull 失败').trim(),
      };
    }

    notify('🔗 正在刷新全局命令链接 (npm link)...');
    await runCommandAsync(
      npmCmd,
      ['link'],
      { cwd: installDir, shell: process.platform === 'win32' },
      (line) => notify(`🔗 链接中: ${line}`)
    );

    const newVersion = getCurrentVersion(installDir);
    return {
      ok: true,
      method: 'git',
      previousVersion,
      newVersion,
      output: (pull.stdout || '').trim(),
      error: '',
    };
  }

  notify('⬇ 正在从 GitHub 下载并安装最新版本 (npm install -g)...');
  const install = await runCommandAsync(
    npmCmd,
    ['install', '-g', `git+https://github.com/${repo}.git`],
    { shell: process.platform === 'win32' },
    (line) => notify(`⬇ 下载安装中: ${line}`)
  );
  if (install.status !== 0) {
    return {
      ok: false,
      method: 'npm',
      previousVersion,
      newVersion: previousVersion,
      error: (install.stderr || install.stdout || 'npm 全局升级失败').trim(),
    };
  }
  const newVersion = getCurrentVersion(installDir);
  return {
    ok: true,
    method: 'npm',
    previousVersion,
    newVersion,
    output: (install.stdout || '').trim(),
    error: '',
  };
}
