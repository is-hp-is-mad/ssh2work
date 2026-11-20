import { spawnSync } from 'node:child_process';

/**
 * OS-native credential storage for SSH / sudo passwords (zero npm dependencies).
 *
 * Backends (selected by platform):
 *   - linux / *bsd : freedesktop Secret Service via `secret-tool` (libsecret, GNOME Keyring / KWallet)
 *   - darwin       : login Keychain via `security`
 *   - win32        : DPAPI (CurrentUser) via Windows PowerShell; ciphertext lives in profiles.json
 *
 * Secrets never appear in child-process argv: they are always passed through stdin.
 *
 * Override with SSH4WORK_SECRET_STORE:
 *   auto      (default) use the OS backend; if unavailable keep passwords in memory only
 *   memory    never persist passwords to disk
 *   plaintext legacy behaviour: write passwords into profiles.json (NOT recommended)
 */

export const SECRET_FIELDS = ['password', 'sudoPassword'];
export const SECRET_SERVICE = 'ssh4work';

function defaultRunner(cmd, args, input = null) {
  const r = spawnSync(cmd, args, {
    input: input === null ? undefined : input,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20000,
  });
  if (r.error) return { status: -1, stdout: '', stderr: r.error.message || String(r.error) };
  return { status: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' };
}

/**
 * Linux & BSD: libsecret `secret-tool`. Requires a running Secret Service (D-Bus session).
 */
export function createSecretToolBackend(run = defaultRunner) {
  let available = null;
  const attrs = (account) => ['service', SECRET_SERVICE, 'account', account];
  return {
    name: 'secret-service',
    isAvailable() {
      if (available === null) {
        // Exit 0 (found) or 1 with empty stderr (not found) means the service answered.
        const r = run('secret-tool', ['lookup', ...attrs('__ssh4work_probe__')]);
        available = r.status === 0 || (r.status === 1 && !r.stderr.trim());
      }
      return available;
    },
    store(account, value) {
      const r = run('secret-tool', ['store', `--label=ssh4work ${account}`, ...attrs(account)], value);
      if (r.status !== 0) throw new Error(r.stderr.trim() || `secret-tool store failed (${r.status})`);
      return 'secret-service';
    },
    loadMany(entries) {
      return entries.map(({ account }) => {
        const r = run('secret-tool', ['lookup', ...attrs(account)]);
        return r.status === 0 ? r.stdout : null;
      });
    },
    remove(account) {
      run('secret-tool', ['clear', ...attrs(account)]);
    },
  };
}

/**
 * macOS: login Keychain through `security`. The value is stored base64-encoded so that
 * `find-generic-password -w` always prints it verbatim (it hex-dumps non-ASCII data), and
 * the add command is sent through `security -i` on stdin so the secret is never in argv.
 */
export function createMacKeychainBackend(run = defaultRunner) {
  let available = null;
  return {
    name: 'keychain',
    isAvailable() {
      if (available === null) {
        const r = run('security', ['find-generic-password', '-s', SECRET_SERVICE, '-a', '__ssh4work_probe__']);
        // 0 = found, 44 = errSecItemNotFound; anything else (incl. ENOENT) = unusable.
        available = r.status === 0 || r.status === 44;
      }
      return available;
    },
    store(account, value) {
      const hex = Buffer.from(Buffer.from(value, 'utf8').toString('base64'), 'utf8').toString('hex');
      run('security', ['-i'], `add-generic-password -U -s ${SECRET_SERVICE} -a ${account} -l ${SECRET_SERVICE} -X ${hex}\n`);
      // `security -i` does not propagate the sub-command status, so read the item back.
      const [check] = this.loadMany([{ account }]);
      if (check !== value) throw new Error('security add-generic-password failed');
      return 'keychain';
    },
    loadMany(entries) {
      return entries.map(({ account }) => {
        const r = run('security', ['find-generic-password', '-s', SECRET_SERVICE, '-a', account, '-w']);
        if (r.status !== 0) return null;
        return Buffer.from(r.stdout.trim(), 'base64').toString('utf8');
      });
    },
    remove(account) {
      run('security', ['delete-generic-password', '-s', SECRET_SERVICE, '-a', account]);
    },
  };
}

const DPAPI_PS = (op) =>
  [
    "$ErrorActionPreference = 'Stop'",
    'Add-Type -AssemblyName System.Security',
    '$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser',
    '$lines = [Console]::In.ReadToEnd() -split "`n"',
    '$out = foreach ($l in $lines) { $l = $l.Trim(); if ($l -eq "") { continue }',
    `  try { [Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::${op}([Convert]::FromBase64String($l), $null, $scope)) } catch { "-" } }`,
    '[Console]::Out.Write(($out -join "`n"))',
  ].join('\n');

/**
 * Windows: DPAPI bound to the current user. The returned ref *is* the ciphertext, so it is
 * stored in profiles.json; it can only be decrypted by the same Windows account.
 */
export function createDpapiBackend(run = defaultRunner) {
  let available = null;
  const ps = (op, lines) => {
    const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', DPAPI_PS(op)], lines.join('\n') + '\n');
    if (r.status !== 0) throw new Error(r.stderr.trim() || `powershell DPAPI ${op} failed (${r.status})`);
    const out = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (out.length !== lines.length) throw new Error(`powershell DPAPI ${op} returned unexpected output`);
    return out.map((s) => (s === '-' ? null : s));
  };
  return {
    name: 'dpapi',
    isAvailable() {
      if (available === null) {
        try {
          const probe = Buffer.from('probe').toString('base64');
          const [enc] = ps('Protect', [probe]);
          available = Boolean(enc) && ps('Unprotect', [enc])[0] === probe;
        } catch {
          available = false;
        }
      }
      return available;
    },
    store(_account, value) {
      const [enc] = ps('Protect', [Buffer.from(value, 'utf8').toString('base64')]);
      if (!enc) throw new Error('DPAPI Protect failed');
      return `dpapi:${enc}`;
    },
    loadMany(entries) {
      const idx = [];
      const blobs = [];
      entries.forEach(({ ref }, i) => {
        if (typeof ref === 'string' && ref.startsWith('dpapi:')) {
          idx.push(i);
          blobs.push(ref.slice(6));
        }
      });
      const result = entries.map(() => null);
      if (!blobs.length) return result;
      const plain = ps('Unprotect', blobs);
      plain.forEach((b64, k) => {
        if (b64) result[idx[k]] = Buffer.from(b64, 'base64').toString('utf8');
      });
      return result;
    },
    remove() {
      // Ciphertext lives only in profiles.json; dropping the ref is enough.
    },
  };
}

/**
 * In-memory backend: nothing is persisted. Also handy for tests.
 */
export function createMemoryBackend({ available = true } = {}) {
  const map = new Map();
  return {
    name: 'memory',
    _map: map,
    isAvailable: () => available,
    store(account, value) {
      if (!available) throw new Error('unavailable');
      map.set(account, value);
      return 'memory';
    },
    loadMany: (entries) => entries.map(({ account }) => (map.has(account) ? map.get(account) : null)),
    remove: (account) => {
      map.delete(account);
    },
  };
}

export function getSecretStoreMode(env = process.env) {
  const v = String(env.SSH4WORK_SECRET_STORE || 'auto').trim().toLowerCase();
  return ['auto', 'memory', 'plaintext'].includes(v) ? v : 'auto';
}

export function createDefaultSecretBackend({ platform = process.platform, run = defaultRunner } = {}) {
  if (platform === 'win32') return createDpapiBackend(run);
  if (platform === 'darwin') return createMacKeychainBackend(run);
  return createSecretToolBackend(run);
}

export function secretAccount(profileId, field) {
  return `${profileId}:${field}`;
}
