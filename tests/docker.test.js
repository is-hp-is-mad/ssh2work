import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeVpsApp } from '../src/app.js';
import { buildDockerExecCommand, buildDockerLogsFollowCommand } from '../src/docker.js';
import { ScreenBuffer } from '../src/tui/renderer.js';
import { SUDO_PROMPT_MARKER } from '../src/ssh.js';

test('buildDockerExecCommand and buildDockerLogsFollowCommand handle quoting and sudo', () => {
  const normal = buildDockerExecCommand('web-app', { privilegeMode: 'none' });
  assert.ok(normal.includes("docker exec -it 'web-app' /bin/bash"));
  assert.ok(normal.includes("docker exec -it 'web-app' /bin/sh"));

  const elevated = buildDockerLogsFollowCommand('api', { privilegeMode: 'sudo', sudoPassword: 'pw' }, { tail: 50 });
  assert.ok(elevated.includes(`sudo -p '${SUDO_PROMPT_MARKER}'`));
  assert.ok(!/'pw'|printf/.test(elevated));
  assert.ok(elevated.includes('docker logs -f --tail 50'));
  assert.ok(elevated.includes('api'));
});

test('ClaudeVpsApp renders Docker tab across containers, images, and compose sub-tabs', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-docker-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    app.activeProfile = app.store.upsert({ name: 'Prod-A', host: '203.0.113.10', user: 'ubuntu' });
    app.tab = 'docker';
    app.dockerData = {
      loadedForProfileId: app.activeProfile.id,
      containers: [
        { id: 'abc123456789', name: 'nginx-proxy', image: 'nginx:alpine', state: 'running', status: 'Up 2 hours', ports: '80->80/tcp' },
        { id: 'bbb222333444', name: 'old-worker', image: 'python:3.12', state: 'exited', status: 'Exited (0)', ports: '' },
      ],
      images: [
        { id: 'def987654321', repository: 'nginx', tag: 'alpine', size: '42MB', createdSince: '2 days ago' },
      ],
      compose: [
        { name: 'prod-stack', status: 'running(3)', configFiles: '/srv/prod/docker-compose.yml' },
      ],
      networks: [
        { id: 'net111222333', name: 'app-net', driver: 'bridge', scope: 'local' },
      ],
      volumes: [
        { name: 'pg-data', driver: 'local', mountpoint: '/var/lib/docker/volumes/pg-data/_data' },
      ],
    };

    const scr = new ScreenBuffer(100, 20);
    scr.begin({ clear: false });
    app.renderDocker(scr, 5, 10, 100);
    const out1 = scr.extractText(1, 4, 100, 14);
    assert.ok(out1.includes('Prod-A'));
    assert.ok(out1.includes('nginx-proxy'));
    assert.ok(out1.includes('old-worker'));

    await app.dispatchAction('dockerToggleRunning');
    assert.equal(app.getDockerListItems().length, 1);
    assert.equal(app.getDockerListItems()[0].name, 'nginx-proxy');
    await app.dispatchAction('dockerToggleRunning');

    app.dockerKeyword = 'worker';
    assert.equal(app.getDockerListItems().length, 1);
    assert.equal(app.getDockerListItems()[0].name, 'old-worker');
    app.dockerKeyword = '';

    await app.dispatchAction('dockerSubTab', 'images');
    const scr2 = new ScreenBuffer(100, 20);
    scr2.begin({ clear: false });
    app.renderDocker(scr2, 5, 10, 100);
    assert.ok(scr2.extractText(1, 5, 100, 14).includes('42MB'));

    await app.dispatchAction('dockerSubTab', 'compose');
    const scr3 = new ScreenBuffer(100, 20);
    scr3.begin({ clear: false });
    app.renderDocker(scr3, 5, 10, 100);
    assert.ok(scr3.extractText(1, 5, 100, 14).includes('prod-stack'));

    await app.dispatchAction('dockerSubTab', 'networks');
    const scr4 = new ScreenBuffer(100, 20);
    scr4.begin({ clear: false });
    app.renderDocker(scr4, 5, 10, 100);
    assert.ok(scr4.extractText(1, 5, 100, 14).includes('app-net'));

    await app.dispatchAction('dockerSubTab', 'volumes');
    const scr5 = new ScreenBuffer(100, 20);
    scr5.begin({ clear: false });
    app.renderDocker(scr5, 5, 10, 100);
    assert.ok(scr5.extractText(1, 5, 100, 14).includes('pg-data'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Docker tab skips disabled first server and pure-keyboard focus/palette triggers top & bottom buttons', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ssh4work-tui-nav-'));
  try {
    const app = new ClaudeVpsApp({ configPath: path.join(tmpDir, 'profiles.json') });
    const s1 = app.store.upsert({ name: 'NoDocker', host: '10.0.0.1', disabledPlugins: ['docker-devops'] });
    const s2 = app.store.upsert({ name: 'HasDocker', host: '10.0.0.2' });
    app.plugins.installRemote({
      id: 'docker-devops',
      name: 'Docker',
      version: '1.2.0',
      description: 'Docker tab',
      tab: { id: 'docker', label: 'Docker', agentType: 'docker', requiresServer: true },
    });

    app.activeProfile = s1;
    app.loadDocker = async () => {};
    await app.dispatchAction('switchTab', 'docker');
    assert.equal(app.tab, 'docker');
    assert.equal(app.activeProfile.id, s2.id);

    // Populate _lastScreen with buttons (top + bottom)
    const scr = new ScreenBuffer(100, 24);
    scr.begin({ clear: false });
    scr.drawButton(1, 1, '1.服务器', 'switchTab', 'profiles');
    scr.drawButton(12, 1, '🧩 插件', 'openPlugins');
    scr.drawButton(1, 23, '+ 新建', 'newProfile');
    app._lastScreen = scr;

    // Shift+Tab -> top bar focus -> move right to [🧩 插件] -> Enter opens plugins modal
    await app.handleKey({ type: 'key', name: 'shift-tab', char: '', ctrl: false });
    assert.equal(app.uiFocusZone, 'top');
    await app.handleKey({ type: 'key', name: 'right', char: '', ctrl: false });
    assert.equal(app.uiFocusBtnIdx, 1);
    await app.handleKey({ type: 'key', name: 'enter', char: '', ctrl: false });
    assert.equal(app.uiFocusZone, 'content');
    assert.equal(app.modal?.type, 'plugins');

    // Close modal, open Action Palette with '?' -> lists all top & bottom buttons
    app.modal = null;
    await app.handleKey({ type: 'key', name: '?', char: '?', ctrl: false });
    assert.equal(app.modal?.type, 'actionPalette');
    assert.equal(app.modal.items.length, 3);
    app.modal.idx = 2; // '+ 新建' on bottom bar
    await app.handleKey({ type: 'key', name: 'enter', char: '', ctrl: false });
    assert.equal(app.modal?.type, 'profileForm');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
