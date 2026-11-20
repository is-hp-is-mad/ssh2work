import { quoteSh, runRemoteElevated, wrapSudoInteractiveCommand } from './ssh.js';

function parseJsonLines(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      out.push(JSON.parse(trimmed));
    } catch {
      // Ignore malformed lines
    }
  }
  return out;
}

function splitSection(stdout, startMarker, endMarker) {
  const sIdx = stdout.indexOf(startMarker);
  if (sIdx < 0) return '';
  const from = sIdx + startMarker.length;
  const eIdx = endMarker ? stdout.indexOf(endMarker, from) : -1;
  return (eIdx >= 0 ? stdout.slice(from, eIdx) : stdout.slice(from)).trim();
}

/**
 * Fetch Docker containers, images, and Compose stacks over pure SSH (no remote scripts).
 */
export async function fetchDockerOverview(profile, settings = {}, { elevate = false } = {}) {
  const rawCmd = [
    'if ! command -v docker >/dev/null 2>&1; then echo "__NO_DOCKER__"; exit 0; fi',
    'echo "===CONTAINERS==="',
    'docker ps -a --no-trunc --format "{{json .}}" 2>&1 || true',
    'echo "===IMAGES==="',
    'docker images --format "{{json .}}" 2>/dev/null || true',
    'echo "===COMPOSE==="',
    'docker compose ls --all --format json 2>/dev/null || echo "[]"',
    'echo "===NETWORKS==="',
    'docker network ls --format "{{json .}}" 2>/dev/null || true',
    'echo "===VOLUMES==="',
    'docker volume ls --format "{{json .}}" 2>/dev/null || true',
    'echo "===END==="',
  ].join('; ');

  const timeoutMs = Math.max(15000, (Number(settings.sshTimeoutSec) || 20) * 1000);
  const res = await runRemoteElevated(profile, rawCmd, { elevate, timeoutMs, settings });
  if (!res.ok) {
    return {
      ok: false,
      containers: [],
      images: [],
      compose: [],
      networks: [],
      volumes: [],
      error: res.stderr || '获取 Docker 状态失败',
    };
  }

  if (res.stdout.includes('__NO_DOCKER__')) {
    return {
      ok: false,
      containers: [],
      images: [],
      compose: [],
      networks: [],
      volumes: [],
      error: '当前服务器未安装 Docker CLI',
    };
  }

  const cRaw = splitSection(res.stdout, '===CONTAINERS===', '===IMAGES===');
  if (/permission denied|cannot connect to the docker daemon/i.test(cRaw)) {
    return {
      ok: false,
      containers: [],
      images: [],
      compose: [],
      networks: [],
      volumes: [],
      error: cRaw.split(/\r?\n/)[0] || 'Docker 权限不足（可尝试开启 [🛡 提权]）',
    };
  }

  const containers = parseJsonLines(cRaw).map((c) => ({
    id: String(c.ID || '').slice(0, 12),
    fullId: String(c.ID || ''),
    name: String(c.Names || '').replace(/^\//, ''),
    image: String(c.Image || ''),
    state: String(c.State || '').toLowerCase(),
    status: String(c.Status || ''),
    ports: String(c.Ports || ''),
    runningFor: String(c.RunningFor || ''),
  }));

  const iRaw = splitSection(res.stdout, '===IMAGES===', '===COMPOSE===');
  const images = parseJsonLines(iRaw).map((img) => ({
    id: String(img.ID || '').replace(/^sha256:/, '').slice(0, 12),
    repository: String(img.Repository || '<none>'),
    tag: String(img.Tag || '<none>'),
    size: String(img.Size || ''),
    createdSince: String(img.CreatedSince || ''),
  }));

  const compRaw = splitSection(res.stdout, '===COMPOSE===', '===NETWORKS===');
  let compose = [];
  try {
    const parsed = JSON.parse(compRaw || '[]');
    if (Array.isArray(parsed)) {
      compose = parsed.map((p) => ({
        name: String(p.Name || ''),
        status: String(p.Status || ''),
        configFiles: String(p.ConfigFiles || ''),
      }));
    }
  } catch {
    compose = [];
  }

  const netRaw = splitSection(res.stdout, '===NETWORKS===', '===VOLUMES===');
  const networks = parseJsonLines(netRaw).map((n) => ({
    id: String(n.ID || '').slice(0, 12),
    name: String(n.Name || ''),
    driver: String(n.Driver || ''),
    scope: String(n.Scope || ''),
  }));

  const volRaw = splitSection(res.stdout, '===VOLUMES===', '===END===');
  const volumes = parseJsonLines(volRaw).map((v) => ({
    name: String(v.Name || ''),
    driver: String(v.Driver || ''),
    mountpoint: String(v.Mountpoint || ''),
  }));

  return { ok: true, containers, images, compose, networks, volumes, error: '' };
}

/**
 * Run a non-interactive Docker lifecycle or cleanup command over SSH.
 */
export async function runDockerAction(
  profile,
  action,
  target = '',
  settings = {},
  { elevate = false } = {}
) {
  let rawCmd = '';
  const qTarget = quoteSh(target);
  switch (action) {
    case 'start':
      rawCmd = `docker start ${qTarget}`;
      break;
    case 'stop':
      rawCmd = `docker stop ${qTarget}`;
      break;
    case 'restart':
      rawCmd = `docker restart ${qTarget}`;
      break;
    case 'rm':
      rawCmd = `docker rm ${qTarget}`;
      break;
    case 'rmForce':
      rawCmd = `docker rm -f ${qTarget}`;
      break;
    case 'rmi':
      rawCmd = `docker rmi ${qTarget}`;
      break;
    case 'pull':
      rawCmd = `docker pull ${qTarget}`;
      break;
    case 'pruneSystem':
      rawCmd = 'docker system prune -f';
      break;
    case 'composeUp':
      rawCmd = `docker compose -p ${qTarget} up -d`;
      break;
    case 'composeDown':
      rawCmd = `docker compose -p ${qTarget} down`;
      break;
    case 'composeRestart':
      rawCmd = `docker compose -p ${qTarget} restart`;
      break;
    case 'rmNetwork':
      rawCmd = `docker network rm ${qTarget}`;
      break;
    case 'rmVolume':
      rawCmd = `docker volume rm ${qTarget}`;
      break;
    default:
      return { ok: false, error: `未知 Docker 操作: ${action}` };
  }

  const timeoutMs =
    action === 'pull' || action === 'composeUp'
      ? Math.max(60000, (Number(settings.sshTimeoutSec) || 20) * 3000)
      : Math.max(20000, (Number(settings.sshTimeoutSec) || 20) * 1000);
  const res = await runRemoteElevated(profile, rawCmd, { elevate, timeoutMs, settings });
  return {
    ok: res.ok,
    stdout: res.stdout.trim(),
    error: res.stderr || res.stdout || 'Docker 命令执行失败',
  };
}

/**
 * Fetch recent container logs for inline preview.
 */
export async function fetchDockerLogs(
  profile,
  containerId,
  { tail = 200, settings = {}, elevate = false } = {}
) {
  const n = Math.max(20, Math.min(2000, Number(tail) || 200));
  const rawCmd = `docker logs --tail ${n} ${quoteSh(containerId)} 2>&1`;
  const timeoutMs = Math.max(15000, (Number(settings.sshTimeoutSec) || 20) * 1000);
  const res = await runRemoteElevated(profile, rawCmd, { elevate, timeoutMs, settings });
  return { ok: res.ok, text: res.stdout || '', error: res.stderr || '' };
}

/**
 * Fetch key inspect details for a container.
 */
export async function fetchDockerInspect(
  profile,
  containerId,
  { settings = {}, elevate = false } = {}
) {
  const rawCmd = `docker inspect ${quoteSh(containerId)}`;
  const timeoutMs = Math.max(15000, (Number(settings.sshTimeoutSec) || 20) * 1000);
  const res = await runRemoteElevated(profile, rawCmd, { elevate, timeoutMs, settings });
  if (!res.ok) return { ok: false, text: '', error: res.stderr || '获取详情失败' };
  try {
    const arr = JSON.parse(res.stdout);
    const info = Array.isArray(arr) ? arr[0] : arr;
    if (!info) return { ok: false, text: '', error: '容器不存在' };
    const mounts = (info.Mounts || []).map((m) => `  - ${m.Type}: ${m.Source} -> ${m.Destination} (${m.RW ? 'rw' : 'ro'})`);
    const ports = Object.entries(info.NetworkSettings?.Ports || {}).map(
      ([k, v]) => `  - ${k} -> ${Array.isArray(v) ? v.map((b) => `${b.HostIp || '0.0.0.0'}:${b.HostPort}`).join(', ') : '未映射'}`
    );
    const nets = Object.entries(info.NetworkSettings?.Networks || {}).map(
      ([name, n]) => `  - ${name}: ${n.IPAddress || '-'}`
    );
    const lines = [
      `# 容器详情: ${String(info.Name || '').replace(/^\//, '')}`,
      '',
      `- **ID**: ${info.Id || ''}`,
      `- **镜像**: ${info.Config?.Image || ''}`,
      `- **状态**: ${info.State?.Status || ''} (Pid: ${info.State?.Pid || 0}, RestartCount: ${info.RestartCount || 0})`,
      `- **启动时间**: ${info.State?.StartedAt || '-'}`,
      `- **重启策略**: ${info.HostConfig?.RestartPolicy?.Name || 'no'}`,
      `- **命令**: ${(info.Config?.Cmd || []).join(' ') || '-'}`,
      '',
      '## 网络',
      ...(nets.length ? nets : ['  - (无)']),
      '',
      '## 端口映射',
      ...(ports.length ? ports : ['  - (无)']),
      '',
      '## 挂载卷',
      ...(mounts.length ? mounts : ['  - (无)']),
    ];
    return { ok: true, text: lines.join('\n'), error: '' };
  } catch (err) {
    return { ok: false, text: res.stdout, error: err.message };
  }
}

/**
 * Build interactive container shell command for embedded terminal tab.
 */
export function buildDockerExecCommand(containerId, profile, { elevate = false } = {}) {
  const q = quoteSh(containerId);
  const inner = `docker exec -it ${q} /bin/bash 2>/dev/null || docker exec -it ${q} /bin/sh`;
  return wrapSudoInteractiveCommand(inner, profile, { elevate });
}

/**
 * Build interactive live log tail command for embedded terminal tab.
 */
export function buildDockerLogsFollowCommand(containerId, profile, { elevate = false, tail = 100 } = {}) {
  const inner = `docker logs -f --tail ${Number(tail) || 100} ${quoteSh(containerId)}`;
  return wrapSudoInteractiveCommand(inner, profile, { elevate });
}
