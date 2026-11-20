import { buildClipboardEnvAndTrap } from './clipboard.js';
import { quoteSh, runRemote, runRemoteElevated } from './ssh.js';

/**
 * Validate a single directory name (no slashes, not . or ..).
 */
export function validateDirName(name) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) return '名称不能为空';
  if (trimmed.includes('/')) return '名称不能包含 /';
  if (trimmed === '.' || trimmed === '..') return '名称不能是 . 或 ..';
  return null;
}

/**
 * Build the remote interactive login shell command to start Claude Code in a target directory.
 */
export function buildClaudeLaunchCommand(
  dirPath,
  {
    claudeCommand = 'claude',
    mode = 'new',
    sessionId = '',
    fork = false,
    shell = 'auto',
    preCommand = '',
    clipboardToken = '',
  } = {}
) {
  let cmd = String(claudeCommand || 'claude').trim() || 'claude';
  if (mode === 'continue') {
    cmd += ' --continue';
  } else if (mode === 'resume' && sessionId) {
    cmd += ` --resume ${quoteSh(sessionId)}`;
    if (fork) cmd += ' --fork-session';
  }
  const fullInner = preCommand ? `${preCommand}; ${cmd}` : cmd;
  const cdTarget = dirPath === '~' ? '~' : quoteSh(dirPath);
  const shellExpr = shell && shell !== 'auto' ? quoteSh(shell) : '"${SHELL:-bash}"';
  if (clipboardToken) {
    const clipPreamble = buildClipboardEnvAndTrap(clipboardToken);
    const innerWithClip = `export PATH="$CLIP_BIN:$PATH"; ${fullInner}`;
    return `${clipPreamble}; export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; cd ${cdTarget} && ${shellExpr} -lic ${quoteSh(innerWithClip)}`;
  }
  return `export PATH="$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"; cd ${cdTarget} && exec ${shellExpr} -lic ${quoteSh(fullInner)}`;
}

/**
 * Build a general-purpose remote interactive login shell command for quick commands.
 */
export function buildQuickLaunchCommand(
  command,
  { dirPath = '~', shell = 'auto', preCommand = '', clipboardToken = '' } = {}
) {
  const cmd = String(command || '').trim();
  if (!cmd) return '';
  const fullInner = preCommand ? `${preCommand}; ${cmd}` : cmd;
  const cdPrefix = dirPath && dirPath !== '~' ? `cd ${quoteSh(dirPath)} && ` : '';
  const shellExpr = shell && shell !== 'auto' ? quoteSh(shell) : '"${SHELL:-bash}"';
  if (clipboardToken) {
    const clipPreamble = buildClipboardEnvAndTrap(clipboardToken);
    const innerWithClip = `export PATH="$CLIP_BIN:$PATH"; ${fullInner}`;
    return `${clipPreamble}; ${cdPrefix}${shellExpr} -lic ${quoteSh(innerWithClip)}`;
  }
  return `${cdPrefix}exec ${shellExpr} -lic ${quoteSh(fullInner)}`;
}

/**
 * List subdirectories of a remote path over SSH.
 */
export async function listRemoteDir(
  profile,
  dirPath = '~',
  showHidden = false,
  settings = {},
  { elevate = false } = {}
) {
  const target = dirPath === '~' ? '~' : quoteSh(dirPath);
  const flags = showHidden ? '-1ApL' : '-1pL';
  const fallbackFlags = showHidden ? '-1Ap' : '-1p';
  const rawCmd = `LC_ALL=C cd ${target} || exit 1; pwd; ls ${flags} 2>/dev/null || ls ${fallbackFlags} 2>/dev/null || true`;
  const timeoutMs = (Number(settings.sshTimeoutSec) || 20) * 1000;
  const res = await runRemoteElevated(profile, rawCmd, { elevate, timeoutMs, settings });
  if (!res.ok) {
    const errText = res.stderr || '';
    if (/sudo:.*password|incorrect password|not in the sudoers/i.test(errText)) {
      return {
        ok: false,
        error: '提权失败: 需要免密 sudo 或在服务器配置中填写提权密码',
        path: '',
        dirs: [],
      };
    }
    return { ok: false, error: errText || '无法列出远程目录', path: '', dirs: [] };
  }
  const lines = res.stdout
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  if (lines.length === 0) {
    return { ok: false, error: '远程目录无响应', path: '', dirs: [] };
  }
  const absPath = lines[0];
  const dirs = lines
    .slice(1)
    .filter((l) => l.endsWith('/'))
    .map((l) => l.slice(0, -1));
  return { ok: true, path: absPath, dirs, error: '' };
}

/**
 * Create a subdirectory on the remote host.
 */
export async function createRemoteDir(profile, parentPath, name, { elevate = false } = {}) {
  const err = validateDirName(name);
  if (err) return { ok: false, error: err };
  const full = `${parentPath.replace(/\/+$/, '')}/${name.trim()}`;
  const res = await runRemoteElevated(profile, `mkdir -- ${quoteSh(full)}`, { elevate });
  return { ok: res.ok, fullPath: full, error: res.stderr || '' };
}

/**
 * Rename a subdirectory on the remote host safely (POSIX-portable across Linux/Alpine/macOS).
 */
export async function renameRemoteDir(
  profile,
  parentPath,
  oldName,
  newName,
  settings = {},
  { elevate = false } = {}
) {
  const err = validateDirName(newName);
  if (err) return { ok: false, error: err };
  const base = parentPath.replace(/\/+$/, '');
  const oldSh = quoteSh(`${base}/${oldName}`);
  const dstSh = quoteSh(`${base}/${newName.trim()}`);
  const rawCmd = `if [ -e ${dstSh} ]; then echo exists >&2; exit 1; fi; mv -- ${oldSh} ${dstSh}`;
  const timeoutMs = (Number(settings.sshTimeoutSec) || 20) * 1000;
  const res = await runRemoteElevated(profile, rawCmd, { elevate, timeoutMs, settings });
  if (!res.ok && res.stderr.includes('exists')) {
    return { ok: false, error: `已存在同名项目: ${newName.trim()}` };
  }
  return { ok: res.ok, error: res.stderr || '' };
}

/**
 * Python 3 script executed on the VPS via `ssh ... python3 - <mode> <arg1> <arg2>`.
 * Reads ~/.claude/projects to list, search, or preview Claude Code sessions.
 */
const SESSION_PY = String.raw`
import os, sys, json, glob, re

mode = sys.argv[1] if len(sys.argv) > 1 else 'list'
arg1 = sys.argv[2] if len(sys.argv) > 2 else ''
arg2 = sys.argv[3] if len(sys.argv) > 3 else ''

projects_root = os.path.expanduser('~/.claude/projects')

def extract_text(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, dict) and item.get('type') == 'text':
                parts.append(str(item.get('text', '')))
        return '\n'.join(parts)
    return ''

def clean_snippet(text, limit=120):
    t = re.sub(r'\s+', ' ', str(text or '')).strip()
    if len(t) > limit:
        return t[:limit - 1] + '…'
    return t

def decode_project_dir(dirname):
    if dirname.startswith('-'):
        return '/' + dirname[1:].replace('-', '/')
    return dirname

def load_index(proj_dir):
    idx_path = os.path.join(proj_dir, 'sessions-index.json')
    by_id = {}
    if os.path.isfile(idx_path):
        try:
            with open(idx_path, 'r', encoding='utf-8', errors='replace') as f:
                data = json.load(f)
            entries = data.get('entries', []) if isinstance(data, dict) else (data if isinstance(data, list) else [])
            for e in entries:
                sid = e.get('sessionId')
                if sid:
                    by_id[sid] = e
        except Exception:
            pass
    return by_id

def parse_jsonl_meta(fpath, idx_entry=None, keyword=None):
    st = os.stat(fpath)
    sid = os.path.splitext(os.path.basename(fpath))[0]
    cwd = (idx_entry or {}).get('projectPath', '')
    branch = (idx_entry or {}).get('gitBranch', '')
    summary = (idx_entry or {}).get('customTitle', '') or (idx_entry or {}).get('summary', '')
    first_prompt = (idx_entry or {}).get('firstPrompt', '')
    last_prompt = ''
    msg_count = (idx_entry or {}).get('messageCount', 0)
    match_snippet = ''
    kw = keyword.lower() if keyword else None
    matched = False

    if kw:
        hay = f"{sid} {cwd} {summary} {first_prompt} {branch}".lower()
        if kw in hay:
            matched = True
            match_snippet = clean_snippet(summary or first_prompt or cwd, 100)

    try:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            lines = f.readlines()
    except Exception:
        return None

    if not msg_count:
        msg_count = 0

    for i, line in enumerate(lines):
        if not line.strip():
            continue
        if not kw and i > 40 and i < len(lines) - 25:
            continue
        try:
            obj = json.loads(line)
        except Exception:
            continue
        if not cwd and obj.get('cwd'):
            cwd = obj['cwd']
        if not branch and obj.get('gitBranch'):
            branch = obj['gitBranch']
        t = obj.get('type')
        if t == 'summary' and obj.get('summary'):
            summary = obj['summary']
        if obj.get('customTitle'):
            summary = obj['customTitle']
        elif obj.get('aiTitle') and not summary:
            summary = obj['aiTitle']
        if t in ('user', 'assistant'):
            if i <= 40 or i >= len(lines) - 25:
                pass
            msg = obj.get('message') or {}
            txt = extract_text(msg.get('content'))
            if t == 'user' and txt and not obj.get('isMeta'):
                if not txt.startswith('<command-') and not txt.startswith('<local-command'):
                    if not first_prompt:
                        first_prompt = txt
                    last_prompt = txt
            if kw and not matched and txt and kw in txt.lower():
                matched = True
                pos = txt.lower().find(kw)
                start = max(0, pos - 30)
                match_snippet = clean_snippet(txt[start:start + 120], 110)

    if kw and not matched:
        return None

    if not cwd:
        cwd = decode_project_dir(os.path.basename(os.path.dirname(fpath)))

    title = clean_snippet(summary or first_prompt or last_prompt or '(无标题会话)', 80)
    return {
        'sessionId': sid,
        'cwd': cwd,
        'gitBranch': branch or '',
        'title': title,
        'lastPrompt': clean_snippet(last_prompt, 80),
        'updatedAt': int(st.st_mtime * 1000),
        'size': st.st_size,
        'filePath': fpath,
        'matchSnippet': match_snippet,
    }

if mode == 'preview':
    fpath = arg1
    if not os.path.isfile(fpath):
        print(json.dumps({'ok': False, 'error': '会话文件不存在'}))
        sys.exit(0)
    msgs = []
    cwd = ''
    summary = ''
    try:
        with open(fpath, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                if not line.strip():
                    continue
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                if not cwd and obj.get('cwd'):
                    cwd = obj['cwd']
                if obj.get('customTitle'):
                    summary = obj['customTitle']
                elif obj.get('aiTitle') and not summary:
                    summary = obj['aiTitle']
                elif obj.get('type') == 'summary' and obj.get('summary'):
                    summary = obj['summary']
                t = obj.get('type')
                if t in ('user', 'assistant') and not obj.get('isMeta'):
                    txt = extract_text((obj.get('message') or {}).get('content'))
                    if txt and not txt.startswith('<local-command'):
                        msgs.append({
                            'role': t,
                            'text': txt[:8000],
                            'ts': obj.get('timestamp', '')
                        })
        print(json.dumps({
            'ok': True,
            'cwd': cwd,
            'summary': summary,
            'messages': msgs[:300],
            'totalMessages': len(msgs),
        }, ensure_ascii=False, separators=(',', ':')))
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
    sys.exit(0)

if not os.path.isdir(projects_root):
    print(json.dumps({'ok': True, 'sessions': []}))
    sys.exit(0)

keyword = arg1 if mode == 'search' else ''
project_filter = arg2 if mode == 'list' else (arg2 if mode == 'search' else '')

limit = int(sys.argv[4]) if len(sys.argv) > 4 and sys.argv[4].isdigit() else 120
candidates = []
for proj_dir in glob.glob(os.path.join(projects_root, '*')):
    if not os.path.isdir(proj_dir):
        continue
    for fpath in glob.glob(os.path.join(proj_dir, '*.jsonl')):
        bname = os.path.basename(fpath)
        if bname.startswith('agent-'):
            continue
        try:
            mtime = os.path.getmtime(fpath)
        except Exception:
            continue
        candidates.append((mtime, proj_dir, fpath, os.path.splitext(bname)[0]))

candidates.sort(key=lambda x: x[0], reverse=True)
scan_cap = limit * 3 if keyword else limit
idx_cache = {}
sessions = []
for mtime, proj_dir, fpath, sid in candidates[:scan_cap]:
    if proj_dir not in idx_cache:
        idx_cache[proj_dir] = load_index(proj_dir)
    item = parse_jsonl_meta(fpath, idx_cache[proj_dir].get(sid), keyword=keyword)
    if item:
        if project_filter and item['cwd'] != project_filter:
            continue
        sessions.append(item)
        if len(sessions) >= limit:
            break

sessions.sort(key=lambda x: x['updatedAt'], reverse=True)
print(json.dumps({'ok': True, 'sessions': sessions[:limit]}, ensure_ascii=False, separators=(',', ':')))
`;

/**
 * List or search Claude Code sessions on the remote VPS.
 */
export async function fetchRemoteSessions(
  profile,
  { keyword = '', projectPath = '', settings = {} } = {}
) {
  const mode = keyword ? 'search' : 'list';
  const limit = Number(settings.sessionScanLimit) || 120;
  const cmd = `PY=$(command -v python3 || command -v python || true); if [ -z "$PY" ]; then echo '{"ok":false,"error":"VPS 未安装 python3，无法解析会话"}' ; exit 0; fi; "$PY" - ${quoteSh(mode)} ${quoteSh(keyword)} ${quoteSh(projectPath)} ${limit}`;
  const timeoutMs = Math.max(25000, (Number(settings.sshTimeoutSec) || 20) * 1000);
  const res = await runRemote(profile, cmd, { stdinData: SESSION_PY, timeoutMs, settings });
  if (!res.ok) {
    return {
      ok: false,
      sessions: [],
      error: res.stderr || '读取远程 Claude 会话失败 (请确认 VPS 已安装 python3)',
    };
  }
  try {
    const parsed = JSON.parse(res.stdout);
    return {
      ok: Boolean(parsed.ok),
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      error: parsed.error || '',
    };
  } catch {
    return { ok: false, sessions: [], error: '解析远程会话数据失败' };
  }
}

/**
 * Fetch preview messages for a single remote Claude Code session file.
 */
export async function fetchSessionPreview(profile, filePath, settings = {}) {
  const cmd = `PY=$(command -v python3 || command -v python || true); if [ -z "$PY" ]; then echo '{"ok":false,"error":"VPS 未安装 python3"}' ; exit 0; fi; "$PY" - preview ${quoteSh(filePath)}`;
  const timeoutMs = (Number(settings.sshTimeoutSec) || 20) * 1000;
  const res = await runRemote(profile, cmd, { stdinData: SESSION_PY, timeoutMs, settings });
  if (!res.ok) {
    return { ok: false, error: res.stderr || '无法预览会话', messages: [] };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: '解析会话预览失败', messages: [] };
  }
}

async function runPythonRemote(profile, script, args = [], settings = {}, fallbackError = '执行失败') {
  const quotedArgs = args.map((a) => quoteSh(String(a ?? ''))).join(' ');
  const cmd = `PY=$(command -v python3 || command -v python || true); if [ -z "$PY" ]; then echo '{"ok":false,"error":"VPS 未安装 python3"}' ; exit 0; fi; "$PY" - ${quotedArgs}`;
  const timeoutMs = Math.max(25000, (Number(settings.sshTimeoutSec) || 20) * 1000);
  const res = await runRemote(profile, cmd, { stdinData: script, timeoutMs, settings });
  if (!res.ok) {
    return { ok: false, error: res.stderr || fallbackError };
  }
  try {
    return JSON.parse(res.stdout);
  } catch {
    return { ok: false, error: `${fallbackError}: JSON 解析失败` };
  }
}

const CLAUDE_TOKEN_PY = String.raw`
import glob, json, os, sys
from datetime import datetime

target_file = sys.argv[1] if len(sys.argv) > 1 else ''
limit = int(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2].isdigit() else 40

def parse_iso_ms(ts):
    if not ts or not isinstance(ts, str):
        return None
    try:
        s = ts.strip()
        if s.endswith('Z'):
            s = s[:-1] + '+00:00'
        return int(datetime.fromisoformat(s).timestamp() * 1000)
    except Exception:
        return None

configured_model = ''
settings_path = os.path.expanduser('~/.claude/settings.json')
try:
    if os.path.exists(settings_path):
        with open(settings_path, 'r', encoding='utf-8') as f:
            sdata = json.load(f)
        configured_model = sdata.get('model') or (sdata.get('env') or {}).get('ANTHROPIC_MODEL') or ''
except Exception:
    pass

if target_file and os.path.exists(target_file):
    files = [target_file]
else:
    base = os.path.expanduser('~/.claude/projects')
    files = glob.glob(os.path.join(base, '*', '*.jsonl')) if os.path.isdir(base) else []
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    files = files[:limit]

records_map = {}
anon_idx = 0
for fp in files:
    sid = os.path.splitext(os.path.basename(fp))[0]
    stitle = ''
    idx_path = os.path.join(os.path.dirname(fp), 'sessions-index.json')
    if os.path.isfile(idx_path):
        try:
            with open(idx_path, 'r', encoding='utf-8', errors='replace') as idxf:
                idata = json.load(idxf)
            entries = idata.get('entries', []) if isinstance(idata, dict) else (idata if isinstance(idata, list) else [])
            for e in entries:
                if e.get('sessionId') == sid:
                    stitle = e.get('customTitle') or e.get('summary') or e.get('firstPrompt') or ''
                    break
        except Exception:
            pass
    try:
        prev_user_ms = None
        with open(fp, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                t = d.get('type')
                if d.get('customTitle'):
                    stitle = str(d['customTitle'])[:60]
                elif t == 'summary' and d.get('summary') and not stitle:
                    stitle = str(d['summary'])[:60]
                if t == 'user':
                    u_ms = parse_iso_ms(d.get('timestamp'))
                    if u_ms is not None:
                        prev_user_ms = u_ms
                if not stitle and t == 'user':
                    msg = d.get('message')
                    if isinstance(msg, dict):
                        c = msg.get('content')
                        if isinstance(c, str) and not c.startswith('<'):
                            stitle = ' '.join(c.split())[:60]
                        elif isinstance(c, list):
                            for blk in c:
                                if isinstance(blk, dict) and blk.get('type') == 'text':
                                    txt = blk.get('text', '')
                                    if txt and not txt.startswith('<'):
                                        stitle = ' '.join(txt.split())[:60]
                                        break
                if t == 'assistant':
                    msg = d.get('message')
                    if not isinstance(msg, dict):
                        continue
                    usage = msg.get('usage')
                    if not isinstance(usage, dict):
                        continue
                    resp_model = msg.get('model') or d.get('responseModel') or ''
                    if not resp_model or resp_model == '<synthetic>':
                        continue
                    req_model = d.get('requestModel') or d.get('request_model') or msg.get('requestModel') or ''
                    if not req_model and d.get('model') and d.get('model') != resp_model:
                        req_model = d.get('model')
                    if not req_model:
                        req_model = configured_model or resp_model
                    cr = int(usage.get('cache_read_input_tokens') or usage.get('prompt_cache_hit_tokens') or 0)
                    out_tok = int(usage.get('output_tokens') or 0)
                    dur_ms = d.get('durationMs')
                    if dur_ms is None:
                        a_ms = parse_iso_ms(d.get('timestamp'))
                        if a_ms is not None and prev_user_ms is not None:
                            dt = a_ms - prev_user_ms
                            if 100 <= dt <= 600000:
                                dur_ms = dt
                    ttft_ms = d.get('ttftMs') or d.get('firstTokenMs')
                    is_ok = not bool(d.get('isApiErrorMessage') or d.get('error') or msg.get('stop_reason') == 'error')
                    dedup_id = d.get('requestId') or msg.get('id')
                    if not dedup_id:
                        anon_idx += 1
                        dedup_id = f"{sid}:{anon_idx}"
                    rec_obj = {
                        'ts': d.get('timestamp') or '',
                        'sessionId': d.get('sessionId') or sid,
                        'sessionTitle': stitle or sid[:8],
                        'reqModel': req_model,
                        'respModel': resp_model,
                        'in': int(usage.get('input_tokens') or 0),
                        'out': out_tok,
                        'cr': cr,
                        'cc': int(usage.get('cache_creation_input_tokens') or 0),
                        'ok': is_ok,
                    }
                    if dur_ms is not None:
                        rec_obj['durationMs'] = int(dur_ms)
                    if ttft_ms is not None:
                        rec_obj['ttftMs'] = int(ttft_ms)
                    records_map[dedup_id] = rec_obj
    except Exception:
        continue

records = list(records_map.values())
records.sort(key=lambda r: r['ts'], reverse=True)
print(json.dumps({'ok': True, 'configuredModel': configured_model, 'records': records[:1000]}, ensure_ascii=False, separators=(',', ':')))
`;

export async function fetchClaudeTokenStats(
  profile,
  { sessionFilePath = '', limit = 40, settings = {} } = {}
) {
  const res = await runPythonRemote(
    profile,
    CLAUDE_TOKEN_PY,
    [sessionFilePath, String(limit)],
    settings,
    '读取 Claude Token 统计失败'
  );
  return {
    ok: Boolean(res.ok),
    configuredModel: res.configuredModel || '',
    records: Array.isArray(res.records) ? res.records : [],
    error: res.error || '',
  };
}

const MULTI_AGENT_PY = String.raw`
import glob, json, os, sys

agent = sys.argv[1] if len(sys.argv) > 1 else 'codex'
mode = sys.argv[2] if len(sys.argv) > 2 else 'list'
arg3 = sys.argv[3] if len(sys.argv) > 3 else ''
arg4 = sys.argv[4] if len(sys.argv) > 4 else ''
limit = int(sys.argv[5]) if len(sys.argv) > 5 and sys.argv[5].isdigit() else 120

if mode == 'preview':
    fp = os.path.expanduser(arg3)
    if not os.path.exists(fp):
        print(json.dumps({'ok': False, 'error': '文件不存在'}))
        sys.exit(0)
    msgs = []
    cwd = ''
    try:
        with open(fp, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    d = json.loads(line)
                except Exception:
                    continue
                if agent == 'codex':
                    t = d.get('type')
                    p = d.get('payload') if isinstance(d.get('payload'), dict) else {}
                    if t == 'session_meta' and p.get('cwd'):
                        cwd = p.get('cwd')
                    elif t == 'response_item':
                        role = p.get('role')
                        if role in ('user', 'assistant'):
                            content = p.get('content')
                            txt = ''
                            if isinstance(content, list):
                                txt = ' '.join(b.get('text', '') for b in content if isinstance(b, dict) and b.get('text'))
                            elif isinstance(content, str):
                                txt = content
                            txt = ' '.join(txt.split())
                            if txt:
                                msgs.append({'role': role, 'text': txt[:400]})
                    elif t == 'event_msg' and p.get('type') == 'user_message' and p.get('message'):
                        msgs.append({'role': 'user', 'text': ' '.join(str(p.get('message')).split())[:400]})
                elif agent == 'agy':
                    t = d.get('type')
                    txt = ' '.join(str(d.get('content') or '').split())
                    if t == 'USER_INPUT' and txt:
                        msgs.append({'role': 'user', 'text': txt[:400]})
                    elif t == 'PLANNER_RESPONSE' and txt:
                        msgs.append({'role': 'assistant', 'text': txt[:400]})
                elif agent in ('pi', 'opencode'):
                    role = d.get('role') or (d.get('message') or {}).get('role') or d.get('type')
                    txt = ''
                    c = d.get('content') or (d.get('message') or {}).get('content') or d.get('text') or ''
                    if isinstance(c, str):
                        txt = c
                    elif isinstance(c, list):
                        txt = ' '.join(b.get('text', '') for b in c if isinstance(b, dict) and b.get('text'))
                    txt = ' '.join(str(txt).split())
                    if role in ('user', 'assistant', 'USER_INPUT') and txt:
                        msgs.append({'role': 'user' if role in ('user', 'USER_INPUT') else 'assistant', 'text': txt[:400]})
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        sys.exit(0)
    print(json.dumps({'ok': True, 'cwd': cwd, 'messages': msgs[:200]}, ensure_ascii=False, separators=(',', ':')))
    sys.exit(0)

keyword = arg3.lower()
project_filter = os.path.normpath(arg4) if arg4 else ''
sessions = []

if agent == 'codex':
    base = os.path.expanduser('~/.codex/sessions')
    files = glob.glob(os.path.join(base, '*', '*', '*', 'rollout-*.jsonl')) if os.path.isdir(base) else []
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for fp in files[:limit * 2]:
        sid = os.path.splitext(os.path.basename(fp))[0]
        cwd = ''
        title = ''
        model = ''
        ts = int(os.path.getmtime(fp) * 1000)
        matched = ''
        try:
            with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    t = d.get('type')
                    p = d.get('payload') if isinstance(d.get('payload'), dict) else {}
                    if t == 'session_meta':
                        if p.get('id'):
                            sid = p.get('id')
                        if p.get('cwd'):
                            cwd = p.get('cwd')
                        if p.get('model'):
                            model = p.get('model')
                    elif t == 'turn_context' and p.get('model') and not model:
                        model = p.get('model')
                    if not title:
                        if t == 'event_msg' and p.get('type') == 'user_message' and p.get('message'):
                            title = ' '.join(str(p.get('message')).split())[:80]
                        elif t == 'response_item' and p.get('role') == 'user':
                            c = p.get('content')
                            if isinstance(c, list):
                                for b in c:
                                    if isinstance(b, dict) and b.get('text'):
                                        title = ' '.join(str(b.get('text')).split())[:80]
                                        break
                    if keyword and not matched and keyword in line.lower():
                        matched = title or sid
            if project_filter and cwd and os.path.normpath(cwd) != project_filter:
                continue
            if keyword and not matched and keyword not in title.lower() and keyword not in cwd.lower() and keyword not in sid.lower():
                continue
            sessions.append({
                'sessionId': sid,
                'cwd': cwd or '~',
                'title': title or sid,
                'gitBranch': model,
                'updatedAt': ts,
                'filePath': fp,
                'matchSnippet': matched[:60] if matched else '',
            })
        except Exception:
            continue
elif agent == 'agy':
    roots = [
        os.path.expanduser('~/.gemini/antigravity-cli/brain'),
        os.path.expanduser('~/.gemini/antigravity/brain'),
    ]
    files = []
    for r in roots:
        if os.path.isdir(r):
            files.extend(glob.glob(os.path.join(r, '*', '.system_generated', 'logs', 'transcript.jsonl')))
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for fp in files[:limit * 2]:
        parts = fp.replace('\\\\', '/').split('/')
        sid = parts[-4] if len(parts) >= 4 else os.path.basename(fp)
        title = ''
        ts = int(os.path.getmtime(fp) * 1000)
        matched = ''
        steps = 0
        try:
            with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    steps += 1
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if not title and d.get('type') == 'USER_INPUT' and d.get('content'):
                        title = ' '.join(str(d.get('content')).split())[:80]
                    if keyword and not matched and keyword in line.lower():
                        matched = ' '.join(str(d.get('content') or line).split())[:60]
            if keyword and not matched and keyword not in title.lower() and keyword not in sid.lower():
                continue
            sessions.append({
                'sessionId': sid,
                'cwd': '~',
                'title': title or sid,
                'gitBranch': f'{steps} steps',
                'updatedAt': ts,
                'filePath': fp,
                'matchSnippet': matched,
            })
        except Exception:
            continue
elif agent == 'pi':
    roots = [
        os.path.expanduser('~/.pi/agent/sessions'),
        os.path.expanduser('~/.pi/sessions'),
    ]
    files = []
    for r in roots:
        if os.path.isdir(r):
            files.extend(glob.glob(os.path.join(r, '**', '*.jsonl'), recursive=True))
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for fp in files[:limit * 2]:
        sid = os.path.splitext(os.path.basename(fp))[0]
        title = ''
        cwd = '~'
        ts = int(os.path.getmtime(fp) * 1000)
        matched = ''
        try:
            with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    if d.get('cwd') and cwd == '~':
                        cwd = d.get('cwd')
                    role = d.get('role') or (d.get('message') or {}).get('role') or d.get('type')
                    if not title and role == 'user':
                        c = d.get('content') or (d.get('message') or {}).get('content') or d.get('text') or ''
                        if isinstance(c, list):
                            c = ' '.join(b.get('text', '') for b in c if isinstance(b, dict))
                        title = ' '.join(str(c).split())[:80]
                    if keyword and not matched and keyword in line.lower():
                        matched = title or sid
            if project_filter and cwd != '~' and os.path.normpath(cwd) != project_filter:
                continue
            if keyword and not matched and keyword not in title.lower() and keyword not in sid.lower():
                continue
            sessions.append({
                'sessionId': sid,
                'cwd': cwd,
                'title': title or sid,
                'gitBranch': 'pi',
                'updatedAt': ts,
                'filePath': fp,
                'matchSnippet': matched[:60] if matched else '',
            })
        except Exception:
            continue
elif agent == 'opencode':
    roots = [
        os.path.expanduser('~/.local/share/opencode/storage/session'),
        os.path.expanduser('~/.opencode/sessions'),
    ]
    files = []
    for r in roots:
        if os.path.isdir(r):
            files.extend(glob.glob(os.path.join(r, '**', '*.json*'), recursive=True))
    files.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    for fp in files[:limit * 2]:
        sid = os.path.splitext(os.path.basename(fp))[0]
        title = ''
        cwd = '~'
        ts = int(os.path.getmtime(fp) * 1000)
        matched = ''
        try:
            with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                raw = f.read()
            if fp.endswith('.json'):
                d = json.loads(raw)
                sid = d.get('id') or sid
                title = ' '.join(str(d.get('title') or d.get('name') or '').split())[:80]
                cwd = d.get('directory') or d.get('cwd') or '~'
            else:
                for line in raw.splitlines():
                    if not line.strip():
                        continue
                    try:
                        d = json.loads(line)
                        if not title and (d.get('title') or d.get('content')):
                            title = ' '.join(str(d.get('title') or d.get('content')).split())[:80]
                    except Exception:
                        pass
            if keyword and keyword not in (title + raw).lower():
                continue
            if keyword:
                matched = title or sid
            sessions.append({
                'sessionId': sid,
                'cwd': cwd,
                'title': title or sid,
                'gitBranch': 'opencode',
                'updatedAt': ts,
                'filePath': fp,
                'matchSnippet': matched[:60] if matched else '',
            })
        except Exception:
            continue

sessions.sort(key=lambda x: x['updatedAt'], reverse=True)
print(json.dumps({'ok': True, 'sessions': sessions[:limit]}, ensure_ascii=False, separators=(',', ':')))
`;

export async function fetchAgentSessions(
  agentType,
  profile,
  { keyword = '', projectPath = '', settings = {} } = {}
) {
  if (agentType === 'claude') {
    return fetchRemoteSessions(profile, { keyword, projectPath, settings });
  }
  const mode = keyword ? 'search' : 'list';
  const limit = Number(settings.sessionScanLimit) || 120;
  const res = await runPythonRemote(
    profile,
    MULTI_AGENT_PY,
    [agentType, mode, keyword, projectPath, String(limit)],
    settings,
    `读取 ${agentType} 会话失败`
  );
  return {
    ok: Boolean(res.ok),
    sessions: Array.isArray(res.sessions) ? res.sessions : [],
    error: res.error || '',
  };
}

export async function fetchAgentSessionPreview(agentType, profile, filePath, settings = {}) {
  if (agentType === 'claude') {
    return fetchSessionPreview(profile, filePath, settings);
  }
  const res = await runPythonRemote(
    profile,
    MULTI_AGENT_PY,
    [agentType, 'preview', filePath],
    settings,
    `预览 ${agentType} 会话失败`
  );
  return {
    ok: Boolean(res.ok),
    cwd: res.cwd || '',
    messages: Array.isArray(res.messages) ? res.messages : [],
    error: res.error || '',
  };
}

const AGENT_CFG_PY = String.raw`
import base64, glob, json, os, re, shutil, subprocess, sys, urllib.request

agent = sys.argv[1] if len(sys.argv) > 1 else 'claude'
op = sys.argv[2] if len(sys.argv) > 2 else 'prompt_get'
arg3 = sys.argv[3] if len(sys.argv) > 3 else ''
arg4 = sys.argv[4] if len(sys.argv) > 4 else ''

PROMPT_PATHS = {
    'claude': '~/.claude/CLAUDE.md',
    'codex': '~/.codex/AGENTS.md',
    'agy': '~/.gemini/GEMINI.md',
    'pi': '~/.pi/agent/AGENTS.md',
    'opencode': '~/.config/opencode/AGENTS.md',
}

SKILL_DIRS = {
    'claude': ['~/.claude/skills'],
    'codex': ['~/.codex/skills'],
    'agy': ['~/.gemini/skills', '~/.gemini/antigravity/skills'],
    'pi': ['~/.pi/agent/skills'],
    'opencode': ['~/.config/opencode/skills'],
}

MCP_PATHS = {
    'claude': ('~/.claude.json', 'mcpServers', 'json'),
    'codex': ('~/.codex/config.toml', 'mcp_servers', 'toml'),
    'agy': ('~/.gemini/antigravity/mcp_config.json', 'mcpServers', 'json'),
    'pi': ('~/.pi/agent/mcp.json', 'mcpServers', 'json'),
    'opencode': ('~/.config/opencode/opencode.json', 'mcp', 'json'),
}

def b64_dec(s):
    return base64.b64decode(s.encode('ascii')).decode('utf-8', errors='replace') if s else ''

if op == 'prompt_get':
    p = os.path.expanduser(PROMPT_PATHS.get(agent, '~/.claude/CLAUDE.md'))
    content = ''
    if os.path.isfile(p):
        with open(p, 'r', encoding='utf-8', errors='replace') as f:
            content = f.read()
    print(json.dumps({'ok': True, 'path': p, 'exists': os.path.isfile(p), 'content': content}, ensure_ascii=False))
elif op == 'prompt_set':
    p = os.path.expanduser(PROMPT_PATHS.get(agent, '~/.claude/CLAUDE.md'))
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w', encoding='utf-8') as f:
        f.write(b64_dec(arg3))
    print(json.dumps({'ok': True, 'path': p}, ensure_ascii=False))
elif op == 'skills_list':
    skills = []
    seen = set()
    for d in SKILL_DIRS.get(agent, ['~/.claude/skills']):
        root = os.path.expanduser(d)
        if not os.path.isdir(root):
            continue
        for fp in sorted(glob.glob(os.path.join(root, '*', 'SKILL.md'))):
            sdir = os.path.dirname(fp)
            sname = os.path.basename(sdir)
            if sname in seen:
                continue
            seen.add(sname)
            desc = ''
            content = ''
            try:
                with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                    content = f.read()
                m = re.search(r'^description:\s*(.+)$', content, re.M)
                if m:
                    desc = m.group(1).strip().strip('"\'')
                else:
                    for ln in content.splitlines():
                        ln = ln.strip()
                        if ln and not ln.startswith('#') and ln != '---':
                            desc = ln[:80]
                            break
            except Exception:
                pass
            skills.append({'name': sname, 'description': desc[:100], 'path': fp, 'dir': sdir, 'content': content[:12000]})
    print(json.dumps({'ok': True, 'skills': skills, 'root': os.path.expanduser(SKILL_DIRS.get(agent, ['~/.claude/skills'])[0])}, ensure_ascii=False))
elif op == 'skills_install':
    sname = re.sub(r'[^a-zA-Z0-9._-]', '-', arg3.strip()).strip('-') or 'custom-skill'
    src = b64_dec(arg4).strip()
    root = os.path.expanduser(SKILL_DIRS.get(agent, ['~/.claude/skills'])[0])
    target_dir = os.path.join(root, sname)
    os.makedirs(root, exist_ok=True)
    if src.startswith(('http://', 'https://')) and (src.endswith('.git') or 'github.com/' in src and '/raw/' not in src and 'raw.githubusercontent.com' not in src):
        if os.path.exists(target_dir):
            shutil.rmtree(target_dir, ignore_errors=True)
        r = subprocess.run(['git', 'clone', '--depth', '1', src, target_dir], capture_output=True, text=True)
        if r.returncode != 0:
            print(json.dumps({'ok': False, 'error': r.stderr.strip() or 'git clone 失败'}, ensure_ascii=False))
            sys.exit(0)
        print(json.dumps({'ok': True, 'name': sname, 'dir': target_dir}, ensure_ascii=False))
    elif src.startswith(('http://', 'https://')):
        os.makedirs(target_dir, exist_ok=True)
        req = urllib.request.Request(src, headers={'User-Agent': 'claude-vps'})
        with urllib.request.urlopen(req, timeout=15) as resp:
            txt = resp.read().decode('utf-8', errors='replace')
        with open(os.path.join(target_dir, 'SKILL.md'), 'w', encoding='utf-8') as f:
            f.write(txt)
        print(json.dumps({'ok': True, 'name': sname, 'dir': target_dir}, ensure_ascii=False))
    else:
        os.makedirs(target_dir, exist_ok=True)
        txt = src if src else f"---\nname: {sname}\ndescription: Custom skill\n---\n\n# {sname}\n"
        with open(os.path.join(target_dir, 'SKILL.md'), 'w', encoding='utf-8') as f:
            f.write(txt)
        print(json.dumps({'ok': True, 'name': sname, 'dir': target_dir}, ensure_ascii=False))
elif op == 'skills_delete':
    sdir = os.path.expanduser(arg3)
    if os.path.isdir(sdir) and ('skills' in sdir):
        shutil.rmtree(sdir, ignore_errors=True)
        print(json.dumps({'ok': True}, ensure_ascii=False))
    else:
        print(json.dumps({'ok': False, 'error': '无效的 Skill 目录'}, ensure_ascii=False))
elif op == 'mcp_list':
    cfg_path, key_name, fmt = MCP_PATHS.get(agent, ('~/.claude.json', 'mcpServers', 'json'))
    fp = os.path.expanduser(cfg_path)
    items = []
    if os.path.isfile(fp):
        with open(fp, 'r', encoding='utf-8', errors='replace') as f:
            raw = f.read()
        if fmt == 'json':
            data = json.loads(raw) if raw.strip() else {}
            servers = data.get(key_name) or {}
            if isinstance(servers, dict):
                for k, v in servers.items():
                    if not isinstance(v, dict):
                        continue
                    items.append({
                        'name': k,
                        'command': v.get('command') or v.get('url') or '',
                        'args': v.get('args') if isinstance(v.get('args'), list) else [],
                        'env': v.get('env') if isinstance(v.get('env'), dict) else {},
                        'enabled': v.get('enabled', True) is not False and not v.get('disabled', False),
                    })
        else:
            cur = None
            for ln in raw.splitlines():
                m = re.match(r'^\[mcp_servers\.([^\]]+)\]\s*$', ln.strip())
                if m:
                    cur = {'name': m.group(1).strip('"\''), 'command': '', 'args': [], 'env': {}, 'enabled': True}
                    items.append(cur)
                elif cur is not None:
                    if ln.strip().startswith('['):
                        cur = None
                    elif '=' in ln:
                        k, val = ln.split('=', 1)
                        k = k.strip()
                        val = val.strip()
                        if k == 'command':
                            cur['command'] = val.strip('"\'')
                        elif k == 'url':
                            cur['command'] = val.strip('"\'')
                        elif k == 'args':
                            try:
                                cur['args'] = json.loads(val)
                            except Exception:
                                pass
                        elif k == 'enabled':
                            cur['enabled'] = val.lower() != 'false'
    print(json.dumps({'ok': True, 'path': fp, 'items': items}, ensure_ascii=False))
elif op == 'mcp_upsert':
    cfg_path, key_name, fmt = MCP_PATHS.get(agent, ('~/.claude.json', 'mcpServers', 'json'))
    fp = os.path.expanduser(cfg_path)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    spec = json.loads(b64_dec(arg3))
    name = spec['name']
    cmd_or_url = spec.get('command', '')
    args = spec.get('args', [])
    env = spec.get('env', {})
    if fmt == 'json':
        data = {}
        if os.path.isfile(fp):
            try:
                with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                    data = json.load(f) or {}
            except Exception:
                data = {}
        if not isinstance(data.get(key_name), dict):
            data[key_name] = {}
        if cmd_or_url.startswith(('http://', 'https://')):
            entry = {'url': cmd_or_url}
        else:
            entry = {'command': cmd_or_url, 'args': args}
        if env:
            entry['env'] = env
        data[key_name][name] = entry
        with open(fp, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
    else:
        raw = ''
        if os.path.isfile(fp):
            with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                raw = f.read()
        block_lines = [f'[mcp_servers.{name}]']
        if cmd_or_url.startswith(('http://', 'https://')):
            block_lines.append(f'url = {json.dumps(cmd_or_url)}')
        else:
            block_lines.append(f'command = {json.dumps(cmd_or_url)}')
            if args:
                block_lines.append(f'args = {json.dumps(args)}')
        block = '\n'.join(block_lines) + '\n'
        pat = re.compile(rf'(?ms)^\[mcp_servers\.{re.escape(name)}\]\s*\n(?:(?!^\[).*\n?)*')
        if pat.search(raw):
            raw = pat.sub(block, raw, count=1)
        else:
            raw = raw.rstrip() + ('\n\n' if raw.strip() else '') + block
        with open(fp, 'w', encoding='utf-8') as f:
            f.write(raw)
    print(json.dumps({'ok': True, 'path': fp}, ensure_ascii=False))
elif op == 'mcp_delete':
    cfg_path, key_name, fmt = MCP_PATHS.get(agent, ('~/.claude.json', 'mcpServers', 'json'))
    fp = os.path.expanduser(cfg_path)
    name = arg3
    if os.path.isfile(fp):
        if fmt == 'json':
            with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                data = json.load(f) or {}
            if isinstance(data.get(key_name), dict) and name in data[key_name]:
                del data[key_name][name]
                with open(fp, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
        else:
            with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                raw = f.read()
            pat = re.compile(rf'(?ms)^\[mcp_servers\.{re.escape(name)}\]\s*\n(?:(?!^\[).*\n?)*')
            raw = pat.sub('', raw)
            with open(fp, 'w', encoding='utf-8') as f:
                f.write(raw)
    print(json.dumps({'ok': True, 'path': fp}, ensure_ascii=False))
elif op == 'memory_list':
    base = os.path.expanduser('~/.claude/projects')
    items = []
    if os.path.isdir(base):
        for pdir in sorted(os.listdir(base)):
            full_pdir = os.path.join(base, pdir)
            mem_dir = os.path.join(full_pdir, 'memory')
            if not os.path.isdir(mem_dir):
                continue
            proj_label = pdir
            idx_fp = os.path.join(full_pdir, 'sessions-index.json')
            if os.path.isfile(idx_fp):
                try:
                    with open(idx_fp, 'r', encoding='utf-8', errors='replace') as idxf:
                        idata = json.load(idxf)
                    entries = idata.get('entries', []) if isinstance(idata, dict) else (idata if isinstance(idata, list) else [])
                    for e in entries:
                        if e.get('projectPath'):
                            proj_label = e['projectPath']
                            break
                except Exception:
                    pass
            if proj_label == pdir and pdir.startswith('-'):
                proj_label = '/' + pdir[1:].replace('-', '/')
            for fp in sorted(glob.glob(os.path.join(mem_dir, '*.md'))):
                try:
                    st = os.stat(fp)
                    with open(fp, 'r', encoding='utf-8', errors='replace') as f:
                        content = f.read()
                    items.append({
                        'project': proj_label,
                        'projectDir': pdir,
                        'name': os.path.basename(fp),
                        'path': fp,
                        'size': st.st_size,
                        'updatedAt': int(st.st_mtime * 1000),
                        'content': content[:16000],
                    })
                except Exception:
                    continue
    items.sort(key=lambda x: x['updatedAt'], reverse=True)
    print(json.dumps({'ok': True, 'items': items}, ensure_ascii=False))
elif op == 'memory_set':
    fp = os.path.expanduser(arg3)
    if '/.claude/projects/' not in fp.replace('\\\\', '/') or '/memory/' not in fp.replace('\\\\', '/'):
        print(json.dumps({'ok': False, 'error': '非法 Memory 路径'}, ensure_ascii=False))
        sys.exit(0)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, 'w', encoding='utf-8') as f:
        f.write(b64_dec(arg4))
    print(json.dumps({'ok': True, 'path': fp}, ensure_ascii=False))
elif op == 'memory_delete':
    fp = os.path.expanduser(arg3)
    if '/.claude/projects/' in fp.replace('\\\\', '/') and '/memory/' in fp.replace('\\\\', '/') and os.path.isfile(fp):
        os.remove(fp)
        print(json.dumps({'ok': True}, ensure_ascii=False))
    else:
        print(json.dumps({'ok': False, 'error': 'Memory 文件不存在或路径无效'}, ensure_ascii=False))
`;

export async function fetchAgentPrompt(agentType, profile, settings = {}) {
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'prompt_get'],
    settings,
    `读取 ${agentType} 全局提示词失败`
  );
  return { ok: Boolean(res.ok), path: res.path || '', exists: Boolean(res.exists), content: res.content || '', error: res.error || '' };
}

export async function saveAgentPrompt(agentType, profile, content, settings = {}) {
  const b64 = Buffer.from(String(content ?? ''), 'utf8').toString('base64');
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'prompt_set', b64],
    settings,
    `保存 ${agentType} 全局提示词失败`
  );
  return { ok: Boolean(res.ok), path: res.path || '', error: res.error || '' };
}

export async function fetchAgentSkills(agentType, profile, settings = {}) {
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'skills_list'],
    settings,
    `读取 ${agentType} Skills 失败`
  );
  return { ok: Boolean(res.ok), root: res.root || '', skills: Array.isArray(res.skills) ? res.skills : [], error: res.error || '' };
}

export async function installAgentSkill(agentType, profile, { name = '', source = '' } = {}, settings = {}) {
  const b64 = Buffer.from(String(source ?? ''), 'utf8').toString('base64');
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'skills_install', name, b64],
    settings,
    `安装 ${agentType} Skill 失败`
  );
  return { ok: Boolean(res.ok), name: res.name || name, dir: res.dir || '', error: res.error || '' };
}

export async function deleteAgentSkill(agentType, profile, skillDir, settings = {}) {
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'skills_delete', skillDir],
    settings,
    `删除 ${agentType} Skill 失败`
  );
  return { ok: Boolean(res.ok), error: res.error || '' };
}

export async function fetchAgentMcp(agentType, profile, settings = {}) {
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'mcp_list'],
    settings,
    `读取 ${agentType} MCP 失败`
  );
  return { ok: Boolean(res.ok), path: res.path || '', items: Array.isArray(res.items) ? res.items : [], error: res.error || '' };
}

export async function upsertAgentMcp(agentType, profile, spec, settings = {}) {
  const b64 = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'mcp_upsert', b64],
    settings,
    `保存 ${agentType} MCP 失败`
  );
  return { ok: Boolean(res.ok), path: res.path || '', error: res.error || '' };
}

export async function deleteAgentMcp(agentType, profile, name, settings = {}) {
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    [agentType, 'mcp_delete', name],
    settings,
    `删除 ${agentType} MCP 失败`
  );
  return { ok: Boolean(res.ok), path: res.path || '', error: res.error || '' };
}

export async function fetchClaudeMemory(profile, settings = {}) {
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    ['claude', 'memory_list'],
    settings,
    '读取 Claude 分项目 Memory 失败'
  );
  return { ok: Boolean(res.ok), items: Array.isArray(res.items) ? res.items : [], error: res.error || '' };
}

export async function saveClaudeMemory(profile, filePath, content, settings = {}) {
  const b64 = Buffer.from(String(content ?? ''), 'utf8').toString('base64');
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    ['claude', 'memory_set', filePath, b64],
    settings,
    '保存 Claude Memory 失败'
  );
  return { ok: Boolean(res.ok), path: res.path || filePath, error: res.error || '' };
}

export async function deleteClaudeMemory(profile, filePath, settings = {}) {
  const res = await runPythonRemote(
    profile,
    AGENT_CFG_PY,
    ['claude', 'memory_delete', filePath],
    settings,
    '删除 Claude Memory 失败'
  );
  return { ok: Boolean(res.ok), error: res.error || '' };
}
