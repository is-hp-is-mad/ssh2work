import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Wrap a string in POSIX sh single quotes safely.
 */
export function quoteSh(text) {
  return "'" + String(text ?? '').replace(/'/g, "'\\''") + "'";
}

/**
 * Split extra SSH args string into argv tokens, respecting single/double quotes.
 */
export function splitArgs(str) {
  const args = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(str || ''))) !== null) {
    args.push(m[1] ?? m[2] ?? m[3]);
  }
  return args;
}

export function getEffectiveSshUser(profile) {
  if (profile?.privilegeMode === 'root') return 'root';
  return String(profile?.user || '').trim();
}

function needsElevation(profile, elevate) {
  const mode = profile?.privilegeMode || 'none';
  if (mode === 'root') return false;
  return Boolean(elevate) || mode === 'sudo';
}

/**
 * Wrap a non-interactive command with sudo.
 *
 * The sudo password is never embedded in the command line (which would be visible in `ps`
 * on both the local and the remote host). When one is configured, sudo reads it from the
 * SSH channel's stdin (`sudo -S`); use {@link runRemoteElevated}, or pass
 * {@link sudoStdinData} as `stdinData` to {@link runRemote}. The inner command gets
 * /dev/null as stdin so an unconsumed password line can never reach it.
 */
export function wrapSudoCommand(innerCmd, profile, { elevate = false } = {}) {
  if (!needsElevation(profile, elevate)) return innerCmd;
  if (profile?.sudoPassword) {
    return `sudo -S -p '' sh -c ${quoteSh(`exec </dev/null; ${innerCmd}`)}`;
  }
  return `sudo -n sh -c ${quoteSh(innerCmd)}`;
}

/**
 * stdin payload that accompanies {@link wrapSudoCommand}, or null when none is needed.
 */
export function sudoStdinData(profile, { elevate = false } = {}) {
  if (!needsElevation(profile, elevate) || !profile?.sudoPassword) return null;
  return `${profile.sudoPassword}\n`;
}

/**
 * Run a command over SSH, elevated with sudo when required by the profile / `elevate`.
 */
export function runRemoteElevated(profile, innerCmd, { elevate = false, ...opts } = {}) {
  const cmd = wrapSudoCommand(innerCmd, profile, { elevate });
  const stdinData = sudoStdinData(profile, { elevate });
  return runRemote(profile, cmd, stdinData === null ? opts : { ...opts, stdinData });
}

/**
 * Prompt string used for sudo inside embedded PTY sessions. It is unique per process so
 * the embedded terminal can recognise *our* prompt and answer it with the stored password
 * (see {@link createSudoPromptFilter}) without the password ever touching argv.
 */
export const SUDO_PROMPT_MARKER = `<<ssh4work-sudo-${crypto.randomBytes(6).toString('hex')}>>`;

/**
 * Wrap a command for an interactive (PTY) session with sudo. sudo prompts on the remote
 * TTY with echo disabled; the embedded terminal fills in the stored password if there is
 * one, otherwise the user can type it.
 */
export function wrapSudoInteractiveCommand(innerCmd, profile, { elevate = false } = {}) {
  if (!needsElevation(profile, elevate)) return innerCmd;
  return `sudo -p ${quoteSh(SUDO_PROMPT_MARKER)} sh -c ${quoteSh(innerCmd)}`;
}

/**
 * Create a stream filter for embedded-terminal output that replaces our sudo prompt marker
 * with a readable prompt and answers the first occurrence with the stored password.
 * Returns `(chunk: Buffer) => Buffer`.
 */
export function createSudoPromptFilter(getPassword, writeToRemote, { marker = SUDO_PROMPT_MARKER } = {}) {
  const needle = Buffer.from(marker, 'utf8');
  let carry = Buffer.alloc(0);
  let answered = false;
  return (chunk) => {
    let buf = carry.length ? Buffer.concat([carry, Buffer.from(chunk)]) : Buffer.from(chunk);
    carry = Buffer.alloc(0);
    const out = [];
    let idx;
    while ((idx = buf.indexOf(needle)) !== -1) {
      out.push(buf.subarray(0, idx));
      const pw = answered ? '' : String(getPassword() || '');
      if (pw) {
        answered = true;
        writeToRemote(`${pw}\n`);
        out.push(Buffer.from('[sudo] password: (ssh4work 已自动填充)'));
      } else {
        out.push(Buffer.from('[sudo] password: '));
      }
      buf = buf.subarray(idx + needle.length);
    }
    // Hold back a trailing partial match so a marker split across chunks is still caught.
    let keep = Math.min(needle.length - 1, buf.length);
    while (keep > 0 && !needle.subarray(0, keep).equals(buf.subarray(buf.length - keep))) keep -= 1;
    out.push(buf.subarray(0, buf.length - keep));
    carry = Buffer.from(buf.subarray(buf.length - keep));
    return Buffer.concat(out);
  };
}

/**
 * Build OpenSSH CLI arguments for a VPS profile.
 */
export function buildSshArgs(profile, { batch = true, forceTty = false, settings = {} } = {}) {
  const args = [];
  if (forceTty) {
    args.push('-t');
  }
  if (profile.port && Number(profile.port) !== 22) {
    args.push('-p', String(profile.port));
  }
  if (profile.identityFile) {
    const resolvedKey = String(profile.identityFile).replace(/^~(?=$|[\\/])/, os.homedir());
    args.push('-i', resolvedKey);
  }
  if (profile.proxyJump) {
    args.push('-J', profile.proxyJump);
  }
  if (batch) {
    if (profile?.password) {
      args.push('-o', 'NumberOfPasswordPrompts=1');
    } else {
      args.push('-o', 'BatchMode=yes');
    }
  } else if (profile?.password) {
    args.push('-o', 'NumberOfPasswordPrompts=1');
  }

  const alive = Number(settings.serverAliveIntervalSec) || 30;
  const baseConnTimeout = Number(settings.connectTimeoutSec) || 10;
  const connTimeout = profile.proxyJump ? Math.max(baseConnTimeout, 15) : baseConnTimeout;

  args.push(
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'Compression=yes',
    '-o',
    `ServerAliveInterval=${alive}`,
    '-o',
    'ServerAliveCountMax=3',
    '-o',
    `ConnectTimeout=${connTimeout}`
  );

  // Reuse multiplexed SSH connections on POSIX to avoid repeated jump-host handshakes
  if (process.platform !== 'win32') {
    const ctrlDir = path.join(os.homedir(), '.claude-vps');
    try {
      fs.mkdirSync(ctrlDir, { recursive: true, mode: 0o700 });
    } catch {
      // Ignore mkdir errors
    }
    args.push(
      '-o',
      'ControlMaster=auto',
      '-o',
      'ControlPersist=60',
      '-o',
      `ControlPath=${path.join(ctrlDir, 'c-%C')}`
    );
  }

  if (profile.extraSshArgs) {
    args.push(...splitArgs(profile.extraSshArgs));
  }

  const effectiveUser = getEffectiveSshUser(profile);
  const target = effectiveUser ? `${effectiveUser}@${profile.host}` : profile.host;
  args.push(target);
  return args;
}

/**
 * Check local OpenSSH client and ssh-agent availability.
 */
export function checkSshEnvironment() {
  const sshCheck = spawnSync('ssh', ['-V'], { encoding: 'utf8' });
  if (sshCheck.error && sshCheck.error.code === 'ENOENT') {
    return {
      hasSsh: false,
      agentCode: -1,
      agentMessage: '未找到 ssh，请确认已安装 OpenSSH 客户端',
    };
  }

  const agentCheck = spawnSync('ssh-add', ['-l'], { encoding: 'utf8' });
  const code = agentCheck.status ?? -1;
  let agentMessage = '';
  if (code === 0) agentMessage = 'ssh-agent 已就绪';
  else if (code === 1) agentMessage = 'ssh-agent 中暂无密钥 (可用 ssh-add 加载或使用私钥文件)';
  else agentMessage = '未连接到 ssh-agent (若使用私钥文件 -i 可忽略)';

  return {
    hasSsh: true,
    agentCode: code,
    agentMessage,
  };
}

let _askpassPath = '';

export function ensureAskpassScript() {
  if (_askpassPath && fs.existsSync(_askpassPath)) return _askpassPath;
  const nodeExe = process.execPath;
  if (process.platform === 'win32') {
    const p = path.join(os.tmpdir(), 'claude-vps-askpass.cmd');
    const content = `@echo off\r\n"${nodeExe}" -e "process.stdout.write((process.env.CLAUDE_VPS_SSH_PW||'')+'\\n')"\r\n`;
    fs.writeFileSync(p, content, 'utf8');
    _askpassPath = p;
  } else {
    const content = `#!/bin/sh\nexec "${nodeExe}" -e "process.stdout.write((process.env.CLAUDE_VPS_SSH_PW||'')+'\\n')"\n`;
    let p = '';
    try {
      const cfgDir = path.join(os.homedir(), '.claude-vps');
      fs.mkdirSync(cfgDir, { recursive: true, mode: 0o700 });
      p = path.join(cfgDir, 'claude-vps-askpass.sh');
      fs.writeFileSync(p, content, { encoding: 'utf8', mode: 0o700 });
    } catch {
      const uid = typeof process.getuid === 'function' ? process.getuid() : process.pid;
      p = path.join(os.tmpdir(), `claude-vps-askpass-${uid}.sh`);
      fs.writeFileSync(p, content, { encoding: 'utf8', mode: 0o700 });
    }
    try {
      fs.chmodSync(p, 0o700);
    } catch {
      // Ignore chmod error
    }
    _askpassPath = p;
  }
  return _askpassPath;
}

export function buildSshSpawnEnv(profile) {
  if (!profile?.password) return process.env;
  return {
    ...process.env,
    SSH_ASKPASS: ensureAskpassScript(),
    SSH_ASKPASS_REQUIRE: 'force',
    DISPLAY: process.env.DISPLAY || 'dummy:0',
    CLAUDE_VPS_SSH_PW: String(profile.password),
  };
}

/**
 * Execute a non-interactive remote command via SSH.
 */
export function runRemote(
  profile,
  remoteCommand,
  { stdinData = null, timeoutMs = 20000, settings = {} } = {}
) {
  const effectiveTimeout = profile?.proxyJump ? Math.max(timeoutMs, 30000) : timeoutMs;
  return new Promise((resolve) => {
    const args = buildSshArgs(profile, { batch: true, settings });
    args.push(remoteCommand);

    const useDetached = process.platform !== 'win32' && Boolean(profile?.password);
    const child = spawn('ssh', args, {
      stdio: [stdinData !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: buildSshSpawnEnv(profile),
      detached: useDetached,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        if (useDetached && child.pid) {
          try {
            process.kill(-child.pid);
          } catch {
            child.kill();
          }
        } else {
          child.kill();
        }
        resolve({ ok: false, code: -1, stdout, stderr: stderr || 'SSH 命令超时' });
      }
    }, effectiveTimeout);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: -1, stdout, stderr: err.message });
    });

    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr: stderr.trim() });
    };

    child.on('close', (code) => finish(code));
    // A backgrounded ControlPersist master may inherit and hold the stdio pipes open,
    // delaying 'close' until it expires. Once ssh itself exited, all output is already
    // in the pipe buffer, so settle shortly after 'exit' if 'close' hasn't arrived.
    child.on('exit', (code) => {
      setTimeout(() => finish(code), 300);
    });

    if (stdinData !== null && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.write(stdinData);
      child.stdin.end();
    }
  });
}

/**
 * Spawn an embedded `ssh -tt` session with piped stdio for switchable TUI terminal tabs.
 */
export function spawnEmbeddedSsh(
  profile,
  remoteCommand = '',
  { cols = 80, rows = 24, settings = {} } = {}
) {
  const args = buildSshArgs(profile, { batch: false, forceTty: true, settings });
  args.unshift('-t'); // Second -t forces remote PTY allocation when local stdio is piped
  const sttyPrefix = `stty rows ${Math.max(4, rows)} cols ${Math.max(10, cols)} 2>/dev/null; `;
  const hasCmd = Boolean(String(remoteCommand || '').trim());
  const finalCmd = hasCmd
    ? `${sttyPrefix}${remoteCommand}`
    : `${sttyPrefix}exec "\${SHELL:-bash}" -l`;
  args.push(finalCmd);
  return spawn('ssh', args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildSshSpawnEnv(profile),
    windowsHide: true,
  });
}
/**
 * Hand over the current terminal to an interactive `ssh` (or `ssh -t <cmd>`) session.
 * Async (non-blocking) so background tasks like clipboard image sync keep running.
 */
export function launchInteractiveSsh(profile, remoteCommand = '', { settings = {} } = {}) {
  const hasCmd = Boolean(String(remoteCommand || '').trim());
  const args = buildSshArgs(profile, { batch: false, forceTty: hasCmd, settings });
  if (hasCmd) {
    args.push(remoteCommand);
  }
  return new Promise((resolve) => {
    // While ssh owns the TTY, a stray SIGINT (e.g. Ctrl+C during handshake) must not kill the TUI.
    const ignoreSigint = () => {};
    process.on('SIGINT', ignoreSigint);
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      process.off('SIGINT', ignoreSigint);
      resolve(result);
    };
    let child;
    try {
      child = spawn('ssh', args, { stdio: 'inherit', env: buildSshSpawnEnv(profile) });
    } catch (err) {
      finish({ code: 1, error: err.message });
      return;
    }
    child.on('error', (err) => finish({ code: 1, error: err.message }));
    child.on('exit', (code, signal) => finish({ code: code ?? (signal ? 1 : 0), error: signal ? `signal ${signal}` : '' }));
  });
}
