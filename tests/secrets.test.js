import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from '../src/config.js';
import {
  createDpapiBackend,
  createMacKeychainBackend,
  createMemoryBackend,
  createSecretToolBackend,
} from '../src/secrets.js';
import { createSudoPromptFilter, runRemoteElevated } from '../src/ssh.js';

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-secrets-'));
  try {
    return fn(path.join(dir, 'profiles.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const readDisk = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

test('ConfigStore keeps passwords out of profiles.json and restores them from the backend', () => {
  withTmp((cfg) => {
    const backend = createMemoryBackend();
    const store = new ConfigStore(cfg, { secretBackend: backend, secretMode: 'auto' });
    store.load();
    const p = store.upsert({ host: '1.2.3.4', password: 'ssh-pw!', sudoPassword: 'sudo-pw' });

    const raw = fs.readFileSync(cfg, 'utf8');
    assert.ok(!raw.includes('ssh-pw!'));
    assert.ok(!raw.includes('sudo-pw'));
    assert.deepEqual(readDisk(cfg).profiles[0].secretRefs, { password: 'memory', sudoPassword: 'memory' });
    assert.equal(store.getById(p.id).password, 'ssh-pw!');

    const reloaded = new ConfigStore(cfg, { secretBackend: backend, secretMode: 'auto' });
    reloaded.load();
    assert.equal(reloaded.getById(p.id).password, 'ssh-pw!');
    assert.equal(reloaded.getById(p.id).sudoPassword, 'sudo-pw');

    // Unchanged secrets are not re-written on every save (e.g. lastDir updates).
    let stores = 0;
    const orig = backend.store;
    backend.store = (...a) => {
      stores += 1;
      return orig(...a);
    };
    reloaded.updateLastDir(p.id, '/srv');
    assert.equal(stores, 0);

    // Clearing a password removes it from the backend; deleting a profile removes the rest.
    reloaded.upsert({ ...reloaded.getById(p.id), password: '' });
    assert.equal(backend._map.has(`${p.id}:password`), false);
    assert.equal(readDisk(cfg).profiles[0].secretRefs.password, undefined);
    reloaded.remove(p.id);
    assert.equal(backend._map.size, 0);
  });
});

test('ConfigStore migrates legacy plaintext passwords into the backend', () => {
  withTmp((cfg) => {
    fs.writeFileSync(
      cfg,
      JSON.stringify({ profiles: [{ id: 'a', host: 'h', password: 'old-ssh', sudoPassword: 'old-sudo' }] })
    );
    const backend = createMemoryBackend();
    const store = new ConfigStore(cfg, { secretBackend: backend, secretMode: 'auto' });
    store.load();
    assert.equal(store.getById('a').password, 'old-ssh');
    const raw = fs.readFileSync(cfg, 'utf8');
    assert.ok(!raw.includes('old-ssh') && !raw.includes('old-sudo'));
    assert.equal(backend._map.get('a:sudoPassword'), 'old-sudo');
  });
});

test('ConfigStore without a usable keyring: new passwords stay in memory, legacy ones are not deleted', () => {
  withTmp((cfg) => {
    fs.writeFileSync(cfg, JSON.stringify({ profiles: [{ id: 'a', host: 'h', password: 'legacy' }] }));
    const store = new ConfigStore(cfg, { secretBackend: createMemoryBackend({ available: false }), secretMode: 'auto' });
    store.load();
    store.updateLastDir('a', '/x');
    assert.equal(readDisk(cfg).profiles[0].password, 'legacy');
    assert.ok(store.secretWarning);

    const b = store.upsert({ id: 'b', host: 'h2', sudoPassword: 'fresh' });
    assert.ok(!fs.readFileSync(cfg, 'utf8').includes('fresh'));
    assert.equal(store.getById(b.id).sudoPassword, 'fresh');
    assert.ok(store.secretWarning);
  });
});

test('ConfigStore keeps refs it could not resolve (locked keyring) instead of dropping them', () => {
  withTmp((cfg) => {
    fs.writeFileSync(cfg, JSON.stringify({ profiles: [{ id: 'a', host: 'h', secretRefs: { password: 'secret-service' } }] }));
    const store = new ConfigStore(cfg, { secretBackend: createMemoryBackend(), secretMode: 'auto' });
    store.load();
    assert.equal(store.getById('a').password, '');
    assert.ok(store.secretWarning);
    store.updateLastDir('a', '/y');
    assert.deepEqual(readDisk(cfg).profiles[0].secretRefs, { password: 'secret-service' });
  });
});

test('ConfigStore memory and plaintext modes', () => {
  withTmp((cfg) => {
    const mem = new ConfigStore(cfg, { secretBackend: createMemoryBackend(), secretMode: 'memory' });
    mem.load();
    mem.upsert({ id: 'a', host: 'h', password: 'pw1' });
    assert.ok(!fs.readFileSync(cfg, 'utf8').includes('pw1'));

    const plain = new ConfigStore(cfg, { secretBackend: createMemoryBackend(), secretMode: 'plaintext' });
    plain.load();
    plain.upsert({ id: 'a', host: 'h', password: 'pw2' });
    assert.equal(readDisk(cfg).profiles[0].password, 'pw2');
  });
});

function recordingRunner(responses = {}) {
  const calls = [];
  const run = (cmd, args, input = null) => {
    calls.push({ cmd, args, input });
    const key = `${cmd} ${args[0]}`;
    const r = typeof responses[key] === 'function' ? responses[key](args, input) : responses[key];
    return r || { status: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

test('secret-tool backend passes the secret via stdin only', () => {
  const { run, calls } = recordingRunner({
    'secret-tool lookup': (args) =>
      args.includes('__ssh4work_probe__') ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: 'p@ss w0rd', stderr: '' },
  });
  const b = createSecretToolBackend(run);
  assert.equal(b.isAvailable(), true);
  assert.equal(b.store('id:password', 'p@ss w0rd'), 'secret-service');
  const storeCall = calls.find((c) => c.args[0] === 'store');
  assert.equal(storeCall.input, 'p@ss w0rd');
  assert.ok(!storeCall.args.join(' ').includes('p@ss'));
  assert.deepEqual(b.loadMany([{ account: 'id:password' }]), ['p@ss w0rd']);

  const noDbus = createSecretToolBackend(() => ({ status: 1, stdout: '', stderr: 'Cannot autolaunch D-Bus' }));
  assert.equal(noDbus.isAvailable(), false);
  const missing = createSecretToolBackend(() => ({ status: -1, stdout: '', stderr: 'ENOENT' }));
  assert.equal(missing.isAvailable(), false);
});

test('macOS keychain backend stores base64 via `security -i` stdin and round-trips UTF-8', () => {
  const items = new Map();
  const { run, calls } = recordingRunner({
    'security -i': (_args, input) => {
      const m = input.match(/-a (\S+) .*-X ([0-9a-f]+)/);
      items.set(m[1], Buffer.from(m[2], 'hex').toString('utf8'));
      return { status: 0, stdout: '', stderr: '' };
    },
    'security find-generic-password': (args) => {
      const acct = args[args.indexOf('-a') + 1];
      return items.has(acct) ? { status: 0, stdout: `${items.get(acct)}\n`, stderr: '' } : { status: 44, stdout: '', stderr: '' };
    },
  });
  const b = createMacKeychainBackend(run);
  assert.equal(b.isAvailable(), true);
  b.store('id:sudoPassword', '密码 pass');
  for (const c of calls) assert.ok(!c.args.join(' ').includes('密码'));
  assert.deepEqual(b.loadMany([{ account: 'id:sudoPassword' }]), ['密码 pass']);
});

test('DPAPI backend batches decryption and keeps ciphertext as the ref', () => {
  const enc = (s) => Buffer.from(`ENC(${s})`).toString('base64');
  const dec = (s) => Buffer.from(s, 'base64').toString().replace(/^ENC\((.*)\)$/, '$1');
  const { run, calls } = recordingRunner({
    'powershell.exe -NoProfile': (args, input) => {
      const lines = input.split('\n').filter(Boolean);
      const op = args[3].includes('::Protect(') ? enc : dec;
      return { status: 0, stdout: lines.map(op).join('\n'), stderr: '' };
    },
  });
  const b = createDpapiBackend(run);
  assert.equal(b.isAvailable(), true);
  const r1 = b.store('a', 'one');
  const r2 = b.store('b', 'twø');
  assert.ok(r1.startsWith('dpapi:'));
  for (const c of calls) assert.ok(!c.args.join(' ').includes('one'));
  const before = calls.length;
  assert.deepEqual(b.loadMany([{ ref: r1 }, { ref: 'secret-service' }, { ref: r2 }]), ['one', null, 'twø']);
  assert.equal(calls.length, before + 1);
});

test('createSudoPromptFilter answers our marker once, even when split across chunks', () => {
  const marker = '<<ssh4work-sudo-test>>';
  const sent = [];
  const filter = createSudoPromptFilter(() => 'pw', (d) => sent.push(d), { marker });
  const out1 = filter(Buffer.from('motd\r\n<<ssh4work-'));
  const out2 = filter(Buffer.from('sudo-test>>'));
  assert.equal(Buffer.concat([out1, out2]).toString(), 'motd\r\n[sudo] password: (ssh4work 已自动填充)');
  assert.deepEqual(sent, ['pw\n']);

  // A second prompt (wrong password) is left for the user to type.
  const out3 = filter(Buffer.from(`Sorry, try again.\r\n${marker}`));
  assert.equal(out3.toString(), 'Sorry, try again.\r\n[sudo] password: ');
  assert.equal(sent.length, 1);

  // Ordinary output passes through untouched.
  assert.equal(filter(Buffer.from('plain <<text>>\r\n')).toString(), 'plain <<text>>\r\n');
});

test('runRemoteElevated sends the sudo password over stdin, never in ssh argv', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-fakessh-'));
  const oldPath = process.env.PATH;
  try {
    const log = path.join(dir, 'log');
    fs.writeFileSync(
      path.join(dir, 'ssh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}.argv'\ncat > '${log}.stdin'\n`,
      { mode: 0o755 }
    );
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    const profile = { host: 'h', user: 'u', privilegeMode: 'sudo', sudoPassword: 'Sup3r$ecret' };
    const res = await runRemoteElevated(profile, 'ls /root', { timeoutMs: 5000 });
    assert.equal(res.ok, true);
    const argv = fs.readFileSync(`${log}.argv`, 'utf8');
    assert.ok(argv.includes('sudo -S'));
    assert.ok(!argv.includes('Sup3r$ecret'));
    assert.equal(fs.readFileSync(`${log}.stdin`, 'utf8'), 'Sup3r$ecret\n');
  } finally {
    process.env.PATH = oldPath;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
