'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { StringDecoder } = require('string_decoder');
const pty = require('node-pty');
const { Client, utils: sshUtils } = require('ssh2');

const HOME = os.homedir();
const CACHE_DIR = path.join(os.tmpdir(), 'claude-deck');
const AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent';

let win = null;
let forceQuit = false;
let SEED_CONFIG = null; // set for a secondary instance on its first run

// ───────────────────────── config ─────────────────────────
const DEFAULT_CONFIG = {
  hosts: [],
  favorites: [],
  recentPaths: {},
  tabs: [],
  activeTab: null,
  knownHosts: {},
  settings: { fontSize: 14, localShell: 'auto', notify: true, programs: ['claude'], copyOnSelect: true },
};
let config = structuredClone(DEFAULT_CONFIG);
const configPath = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  try {
    let raw;
    try {
      raw = fs.readFileSync(configPath(), 'utf8');
    } catch (err) {
      if (!SEED_CONFIG) throw err;
      // first run of a secondary instance: take servers, favorites, programs and trusted keys, not tabs
      const seed = JSON.parse(fs.readFileSync(SEED_CONFIG, 'utf8'));
      delete seed.tabs;
      delete seed.activeTab;
      raw = JSON.stringify(seed);
    }
    const loaded = JSON.parse(raw);
    config = {
      ...structuredClone(DEFAULT_CONFIG),
      ...loaded,
      settings: { ...DEFAULT_CONFIG.settings, ...(loaded.settings || {}) },
    };
  } catch {}
}

let saveTimer = null;
function writeConfigNow() {
  clearTimeout(saveTimer);
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}
function saveConfig() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeConfigNow, 300);
}

function rememberPath(hostId, p) {
  if (!p) return;
  const list = (config.recentPaths[hostId] || []).filter((x) => x !== p);
  list.unshift(p);
  config.recentPaths[hostId] = list.slice(0, 15);
  saveConfig();
}

// ───────────────────────── hosts ─────────────────────────
const expandHome = (p) => (p && (p === '~' || p.startsWith('~/') || p.startsWith('~\\')) ? path.join(HOME, p.slice(1)) : p);

function parseSshConfig() {
  let text;
  try {
    text = fs.readFileSync(path.join(HOME, '.ssh', 'config'), 'utf8').replace(/^﻿/, '').replace(/^﻿/, '');
  } catch {
    return [];
  }
  const hosts = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(\S+?)\s*[=\s]\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      const names = val.split(/\s+/).filter((n) => n && !/[*?!]/.test(n));
      cur = names.length
        ? { id: 'ssh:' + names[0], name: names[0], host: names[0], port: 22, user: null, identityFile: null, source: 'ssh-config' }
        : null;
      if (cur) hosts.push(cur);
    } else if (key === 'match') {
      cur = null;
    } else if (cur) {
      if (key === 'hostname') cur.host = val;
      else if (key === 'port') cur.port = parseInt(val, 10) || 22;
      else if (key === 'user') cur.user = val;
      else if (key === 'identityfile' && !cur.identityFile) cur.identityFile = val;
    }
  }
  return hosts;
}

function hostDetail(h) {
  return `${h.user ? h.user + '@' : ''}${h.host}${h.port && h.port !== 22 ? ':' + h.port : ''}`;
}

function listHosts() {
  return [
    { id: 'local', name: '로컬', kind: 'local', detail: os.hostname() },
    ...parseSshConfig().map((h) => ({ ...h, kind: 'ssh', detail: hostDetail(h) })),
    ...config.hosts.map((h) => ({ ...h, kind: 'ssh', custom: true, detail: hostDetail(h) })),
  ];
}
const findHost = (id) => listHosts().find((h) => h.id === id);

// ───────────────────────── prompts (auth, host keys) ─────────────────────────
const pendingPrompts = new Map();
function ask(req) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(null);
    const rid = crypto.randomUUID();
    pendingPrompts.set(rid, resolve);
    win.webContents.send('prompt:ask', { rid, ...req });
    if (win.isMinimized()) win.restore();
    win.focus();
  });
}
ipcMain.on('prompt:answer', (_e, { rid, value }) => {
  const r = pendingPrompts.get(rid);
  if (r) {
    pendingPrompts.delete(rid);
    r(value);
  }
});

function hashedHostMatch(field, name) {
  const [, , salt, hash] = field.split('|');
  if (!salt || !hash) return false;
  const h = crypto.createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest('base64');
  return h === hash;
}

// 'match' | 'mismatch' | 'unknown' — compared against ~/.ssh/known_hosts
function knownHostsLookup(host, port, type, keyBuf) {
  let text;
  try {
    text = fs.readFileSync(path.join(HOME, '.ssh', 'known_hosts'), 'utf8');
  } catch {
    return 'unknown';
  }
  const names = port === 22 ? [host] : [`[${host}]:${port}`];
  let mismatch = false;
  for (const line of text.split(/\r?\n/)) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 3 || parts[0].startsWith('#') || parts[0].startsWith('@')) continue;
    const [hostsField, ktype, b64] = parts;
    const hit = hostsField.startsWith('|1|')
      ? names.some((n) => hashedHostMatch(hostsField, n))
      : hostsField.split(',').some((x) => names.includes(x));
    if (!hit || ktype !== type) continue;
    if (Buffer.from(b64, 'base64').equals(keyBuf)) return 'match';
    mismatch = true;
  }
  return mismatch ? 'mismatch' : 'unknown';
}

async function checkHostKey(h, keyBuf) {
  const type = keyBuf.subarray(4, 4 + keyBuf.readUInt32BE(0)).toString();
  const fp = crypto.createHash('sha256').update(keyBuf).digest('base64').replace(/=+$/, '');
  const port = h.port || 22;
  const hostKey = port === 22 ? h.host : `[${h.host}]:${port}`;
  const known = knownHostsLookup(h.host, port, type, keyBuf);
  if (known === 'match') return true;
  const entry = `${type} ${fp}`;
  const stored = config.knownHosts[hostKey];
  if (stored === entry) return true;
  const changed = known === 'mismatch' || (stored && stored.split(' ')[0] === type);
  const ok = await ask({
    title: changed ? '⚠ 서버 키가 바뀌었습니다' : '처음 접속하는 서버',
    message:
      `${h.name}  (${hostKey})\n${type}\nSHA256:${fp}\n\n` +
      (changed
        ? '이전에 기록된 키와 다릅니다. 서버를 재설치한 게 아니라면 중간자 공격일 수 있습니다.'
        : '이 서버의 지문을 신뢰하고 연결할까요?'),
    okLabel: '신뢰하고 연결',
    danger: !!changed,
  });
  if (ok) {
    config.knownHosts[hostKey] = entry;
    saveConfig();
    return true;
  }
  return false;
}

// ───────────────────────── ssh connections ─────────────────────────
const conns = new Map(); // hostId -> { client, host, ready, sftp, home }
const passphraseCache = new Map();

function candidateKeys(h) {
  const files = h.identityFile
    ? [expandHome(h.identityFile)]
    : ['id_ed25519', 'id_ecdsa', 'id_rsa'].map((f) => path.join(HOME, '.ssh', f));
  return files.filter((f) => fs.existsSync(f));
}

async function loadKey(file) {
  const buf = fs.readFileSync(file);
  let parsed = sshUtils.parseKey(buf, passphraseCache.get(file));
  while (parsed instanceof Error && /passphrase|encrypt|decrypt/i.test(parsed.message)) {
    const pw = await ask({ title: '키 암호', message: `${path.basename(file)} 키의 암호를 입력하세요`, input: 'password' });
    if (pw == null) return null;
    parsed = sshUtils.parseKey(buf, pw);
    if (!(parsed instanceof Error)) passphraseCache.set(file, pw);
  }
  if (parsed instanceof Error) return null;
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

function getConn(hostId) {
  const existing = conns.get(hostId);
  if (existing) return existing.ready;
  const h = findHost(hostId);
  if (!h || h.kind !== 'ssh') return Promise.reject(new Error(`알 수 없는 서버: ${hostId}`));

  const client = new Client();
  const entry = { client, host: h, sftp: null, home: null };
  conns.set(hostId, entry);
  const username = h.user || os.userInfo().username;
  const methods = [
    ...candidateKeys(h).map((file) => ({ type: 'publickey', file })),
    ...(fs.existsSync(AGENT_PIPE) ? [{ type: 'agent' }] : []),
    { type: 'keyboard-interactive' },
    { type: 'password' },
  ];

  async function nextAuth(methodsLeft, next) {
    while (methods.length) {
      const m = methods.shift();
      if (methodsLeft && !methodsLeft.includes(m.type)) continue;
      if (m.type === 'publickey') {
        const key = await loadKey(m.file).catch(() => null);
        if (!key) continue;
        return next({ type: 'publickey', username, key });
      }
      if (m.type === 'agent') return next({ type: 'agent', username, agent: AGENT_PIPE });
      if (m.type === 'keyboard-interactive') {
        return next({
          type: 'keyboard-interactive',
          username,
          prompt: async (_name, _instr, _lang, prompts, finish) => {
            const answers = [];
            for (const p of prompts) {
              const v = await ask({ title: `${h.name} 인증`, message: p.prompt, input: p.echo ? 'text' : 'password' });
              if (v == null) return finish([]);
              answers.push(v);
            }
            finish(answers);
          },
        });
      }
      if (m.type === 'password') {
        const pw = await ask({ title: `${h.name} 비밀번호`, message: `${username}@${h.host}`, input: 'password' });
        if (pw == null) return next(false);
        return next({ type: 'password', username, password: pw });
      }
    }
    next(false);
  }

  entry.ready = new Promise((resolve, reject) => {
    const drop = () => {
      if (conns.get(hostId) === entry) conns.delete(hostId);
    };
    client.on('ready', () => resolve(entry));
    client.on('error', (err) => {
      drop();
      reject(err.level === 'client-authentication' ? new Error(`${h.name} 인증 실패 (키/비밀번호를 확인하세요)`) : err);
    });
    client.on('close', () => {
      drop();
      reject(new Error('연결이 닫혔습니다'));
    });
    client.connect({
      host: h.host,
      port: h.port || 22,
      username,
      readyTimeout: 30000,
      keepaliveInterval: 15000,
      keepaliveCountMax: 4,
      hostVerifier: (key, verify) => {
        checkHostKey(h, key).then(verify, () => verify(false));
      },
      authHandler: (methodsLeft, _partial, next) => {
        nextAuth(methodsLeft, next);
      },
    });
  });
  return entry.ready;
}

async function getSftp(hostId) {
  const entry = await getConn(hostId);
  if (!entry.sftp) {
    entry.sftp = new Promise((resolve, reject) =>
      entry.client.sftp((err, s) => {
        if (err) {
          entry.sftp = null;
          return reject(err);
        }
        s.on('close', () => {
          entry.sftp = null;
        });
        resolve(s);
      })
    );
  }
  return entry.sftp;
}

const sftpCall = (sftp, fn, ...args) =>
  new Promise((resolve, reject) => sftp[fn](...args, (err, res) => (err ? reject(err) : resolve(res))));
const isDirMode = (mode) => (mode & 0o170000) === 0o040000;
const isLinkMode = (mode) => (mode & 0o170000) === 0o120000;

async function remoteHome(hostId) {
  const entry = await getConn(hostId);
  if (!entry.home) entry.home = await sftpCall(await getSftp(hostId), 'realpath', '.');
  return entry.home;
}

async function resolveRemote(hostId, p, base) {
  const home = await remoteHome(hostId);
  const ex = (x) => (x === '~' ? home : x.startsWith('~/') ? home + x.slice(1) : x);
  p = ex(p || '~');
  if (!p.startsWith('/')) p = path.posix.join(ex(base || '~'), p);
  return path.posix.normalize(p);
}

function resolveLocal(p, base) {
  p = expandHome(p || '~');
  if (!path.isAbsolute(p)) p = path.resolve(expandHome(base || '~'), p);
  return path.normalize(p);
}

function remoteExec(entry, cmd) {
  return new Promise((resolve, reject) =>
    entry.client.exec(cmd, (err, stream) => {
      if (err) return reject(err);
      const chunks = [];
      stream.on('data', (d) => chunks.push(d));
      stream.stderr.on('data', () => {});
      stream.on('close', (code) => resolve({ code, out: Buffer.concat(chunks).toString('utf8') }));
    })
  );
}

function shq(p) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (p === '~') return '~';
  if (p.startsWith('~/')) return '~/' + q(p.slice(2));
  return q(p);
}

async function sftpMkdirp(sftp, dir) {
  const parts = dir.split('/').filter(Boolean);
  let cur = '';
  for (const part of parts) {
    cur += '/' + part;
    try {
      await sftpCall(sftp, 'mkdir', cur);
    } catch {}
  }
}

async function uploadToRemote(hostId, localFile) {
  const sftp = await getSftp(hostId);
  const home = await remoteHome(hostId);
  const dir = `${home}/.claude-deck/uploads`;
  await sftpMkdirp(sftp, dir);
  const safe = path.basename(localFile).replace(/[^\w.\-가-힣]/g, '_');
  const remote = `${dir}/${Date.now().toString(36)}-${safe}`;
  await sftpCall(sftp, 'fastPut', localFile, remote);
  return remote;
}

// ───────────────────────── sessions ─────────────────────────
const sessions = new Map(); // id -> { kind, pty | stream, killed }
const send = (ch, ...args) => {
  try {
    if (win && !win.isDestroyed()) win.webContents.send(ch, ...args);
  } catch {}
};

function which(exe) {
  for (const d of (process.env.PATH || '').split(';')) {
    if (!d) continue;
    const p = path.join(d, exe);
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {}
  }
  return null;
}

function localShell() {
  const pref = config.settings.localShell;
  if (pref === 'cmd') return { file: 'cmd.exe', kind: 'cmd' };
  if (pref === 'pwsh' || pref === 'auto') {
    const p = which('pwsh.exe');
    if (p) return { file: p, kind: 'ps' };
  }
  return { file: 'powershell.exe', kind: 'ps' };
}

function startLocal({ id, cwd, command, cols, rows }) {
  const dir = resolveLocal(cwd || '~');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`폴더가 없습니다: ${dir}`);
  const sh = localShell();
  const args =
    sh.kind === 'cmd' ? (command ? ['/k', command] : []) : ['-NoLogo', ...(command ? ['-NoExit', '-Command', command] : [])];
  const opts = { name: 'xterm-256color', cols, rows, cwd: dir, env: { ...process.env, COLORTERM: 'truecolor' } };
  let p;
  try {
    p = pty.spawn(sh.file, args, { ...opts, useConptyDll: true });
  } catch {
    p = pty.spawn(sh.file, args, opts);
  }
  const s = { kind: 'local', pty: p, killed: false };
  sessions.set(id, s);
  p.onData((d) => send('session:data', id, d));
  p.onExit(({ exitCode }) => {
    if (s.killed) return;
    if (sessions.get(id) === s) sessions.delete(id);
    send('session:exit', id, exitCode);
  });
  rememberPath('local', cwd || '~');
  return { cwd: dir };
}

const TMUX_NAME_RE = /^[\w.-]{1,64}$/;

// Shell line typed into the remote login shell. With `tmux`, the program runs inside a named tmux
// session: reconnecting attaches to it if it still exists, so Claude survives SSH drops and app restarts.
function buildRemoteLine(dir, command, tmux) {
  if (!tmux) {
    const parts = [];
    if (dir) parts.push(`cd ${shq(dir)}`);
    parts.push('clear');
    if (command) parts.push(command);
    return parts.join(' && ');
  }
  if (!TMUX_NAME_RE.test(tmux)) throw new Error(`잘못된 세션 이름: ${tmux}`);
  const exact = shq('=' + tmux);
  const create = [
    `tmux new-session -s ${shq(tmux)}${dir ? ' -c ' + shq(dir) : ''}`,
    'set-option status off',
    'set-option mouse on',
    'set-option set-titles on',
    "set-option set-titles-string '#T'",
    ...(command ? [`send-keys ${shq(command)} Enter`] : []),
  ].join(' \\; ');
  return (
    "command -v tmux >/dev/null || { echo 'tmux가 설치되어 있지 않습니다 (sudo apt install tmux)'; exit 1; }; clear; " +
    `if tmux has-session -t ${exact} 2>/dev/null; then exec tmux attach-session -t ${exact}; else exec ${create}; fi`
  );
}

async function startRemote({ id, hostId, cwd, command, cols, rows, tmux }) {
  const entry = await getConn(hostId);
  let dir = null;
  if (cwd) {
    dir = await resolveRemote(hostId, cwd);
    let st;
    try {
      st = await sftpCall(await getSftp(hostId), 'stat', dir);
    } catch {
      throw new Error(`원격 폴더가 없습니다: ${dir}`);
    }
    if (!isDirMode(st.mode)) throw new Error(`폴더가 아닙니다: ${dir}`);
  }
  const stream = await new Promise((resolve, reject) =>
    entry.client.shell({ term: 'xterm-256color', cols, rows }, (err, st) => (err ? reject(err) : resolve(st)))
  );
  const s = { kind: 'ssh', stream, hostId, killed: false };
  sessions.set(id, s);
  const dec = new StringDecoder('utf8');
  const onData = (d) => send('session:data', id, dec.write(d));
  stream.on('data', onData);
  stream.stderr.on('data', onData);
  stream.on('close', () => {
    if (s.killed) return;
    if (sessions.get(id) === s) sessions.delete(id);
    send('session:exit', id, null);
  });
  stream.write(buildRemoteLine(dir, command, tmux) + '\n');
  rememberPath(hostId, cwd || '~');
  return { cwd: dir };
}

ipcMain.handle('tmux:list', async (_e, hostId) => {
  const entry = await getConn(hostId);
  const { out } = await remoteExec(
    entry,
    "tmux list-sessions -F '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_path}' 2>/dev/null"
  );
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, created, attached, cwd] = l.split('\t');
      return { name, created: Number(created) * 1000, attached: Number(attached), cwd };
    });
});
ipcMain.handle('tmux:kill', async (_e, { hostId, name }) => {
  if (!TMUX_NAME_RE.test(name)) throw new Error(`잘못된 세션 이름: ${name}`);
  const entry = await getConn(hostId);
  await remoteExec(entry, `tmux kill-session -t ${shq('=' + name)} 2>/dev/null`);
});

function killSession(id) {
  const s = sessions.get(id);
  if (!s) return;
  s.killed = true;
  sessions.delete(id);
  try {
    if (s.kind === 'local') s.pty.kill();
    else {
      try {
        s.stream.signal('HUP');
      } catch {}
      s.stream.close();
    }
  } catch {}
}

ipcMain.handle('session:start', async (_e, opts) => {
  killSession(opts.id);
  return opts.hostId === 'local' ? startLocal(opts) : startRemote(opts);
});
ipcMain.on('session:input', (_e, id, data) => {
  const s = sessions.get(id);
  if (!s) return;
  if (s.kind === 'local') s.pty.write(data);
  else s.stream.write(data);
});
ipcMain.on('session:resize', (_e, id, cols, rows) => {
  const s = sessions.get(id);
  if (!s || !cols || !rows) return;
  try {
    if (s.kind === 'local') s.pty.resize(cols, rows);
    else s.stream.setWindow(rows, cols, 0, 0);
  } catch {}
});
ipcMain.handle('session:kill', (_e, id) => killSession(id));

// ───────────────────────── files ─────────────────────────
function sortEntries(list) {
  return list.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, 'ko')));
}

ipcMain.handle('fs:list', async (_e, { hostId, dir, base }) => {
  if (hostId === 'local') {
    const p = resolveLocal(dir, base);
    const ents = await fs.promises.readdir(p, { withFileTypes: true });
    const out = await Promise.all(
      ents.map(async (d) => {
        let st = null;
        try {
          st = await fs.promises.stat(path.join(p, d.name));
        } catch {}
        return { name: d.name, dir: st ? st.isDirectory() : d.isDirectory(), size: st?.size ?? 0, mtime: st?.mtimeMs ?? 0 };
      })
    );
    const parent = path.dirname(p);
    return { path: p, parent: parent !== p ? parent : null, sep: '\\', entries: sortEntries(out) };
  }
  const p = await resolveRemote(hostId, dir, base);
  const sftp = await getSftp(hostId);
  const list = await sftpCall(sftp, 'readdir', p);
  const out = await Promise.all(
    list.map(async (it) => {
      let isDir = isDirMode(it.attrs.mode);
      if (isLinkMode(it.attrs.mode)) {
        try {
          isDir = isDirMode((await sftpCall(sftp, 'stat', path.posix.join(p, it.filename))).mode);
        } catch {}
      }
      return { name: it.filename, dir: isDir, size: it.attrs.size, mtime: it.attrs.mtime * 1000 };
    })
  );
  return { path: p, parent: p !== '/' ? path.posix.dirname(p) : null, sep: '/', entries: sortEntries(out) };
});

const PRUNE = ['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.cache', 'dist', 'build', 'target', '.gradle', '.idea'];
const LOCAL_PRUNE = new Set([...PRUNE, 'AppData', '$Recycle.Bin']);

async function localRecent(root, sinceMs) {
  const out = [];
  let budget = 8000;
  const queue = [[root, 0]];
  while (queue.length && budget > 0) {
    const [dir, depth] = queue.shift();
    let ents;
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of ents) {
      if (--budget <= 0) break;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (depth < 4 && !LOCAL_PRUNE.has(d.name)) queue.push([full, depth + 1]);
      } else if (d.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          if (st.mtimeMs >= sinceMs) out.push({ path: full, rel: path.relative(root, full), size: st.size, mtime: st.mtimeMs });
        } catch {}
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, 200);
}

ipcMain.handle('fs:recent', async (_e, { hostId, dir, sinceMs }) => {
  if (hostId === 'local') return localRecent(resolveLocal(dir), sinceMs);
  const entry = await getConn(hostId);
  const p = await resolveRemote(hostId, dir);
  const minutes = Math.max(1, Math.ceil((Date.now() - sinceMs) / 60000) + 1);
  const prune = PRUNE.map((n) => `-name ${shq(n)}`).join(' -o ');
  const cmd =
    `cd ${shq(p)} 2>/dev/null && find . -maxdepth 5 \\( ${prune} \\) -prune -o -type f -mmin -${minutes} ` +
    `-printf '%T@\\t%s\\t%p\\n' 2>/dev/null | sort -rn | head -200`;
  const { out } = await remoteExec(entry, cmd);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [t, s, rel] = l.split('\t');
      return { path: path.posix.join(p, rel), rel: rel.replace(/^\.\//, ''), size: +s, mtime: parseFloat(t) * 1000 };
    })
    .filter((f) => f.mtime >= sinceMs);
});

ipcMain.handle('fs:fetch', async (_e, { hostId, file, base }) => {
  const stamp = `?t=${Date.now()}`;
  if (hostId === 'local') {
    const p = resolveLocal(file, base);
    const st = await fs.promises.stat(p);
    if (st.isDirectory()) return { dir: true, path: p };
    return { localPath: p, remotePath: null, size: st.size, url: pathToFileURL(p).href + stamp, name: path.basename(p) };
  }
  const p = await resolveRemote(hostId, file, base);
  const sftp = await getSftp(hostId);
  const st = await sftpCall(sftp, 'stat', p);
  if (isDirMode(st.mode)) return { dir: true, path: p };
  const safe = p
    .replace(/^\/+/, '')
    .split('/')
    .map((seg) => seg.replace(/[<>:"|?*\\]/g, '_'))
    .join(path.sep);
  const local = path.join(CACHE_DIR, 'remote', hostId.replace(/[^\w.-]/g, '_'), safe);
  await fs.promises.mkdir(path.dirname(local), { recursive: true });
  await sftpCall(sftp, 'fastGet', p, local);
  return { localPath: local, remotePath: p, size: st.size, url: pathToFileURL(local).href + stamp, name: path.posix.basename(p) };
});

ipcMain.handle('fs:readText', async (_e, localPath) => {
  const fh = await fs.promises.open(localPath, 'r');
  try {
    const { size } = await fh.stat();
    const len = Math.min(size, 3 * 1024 * 1024);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 0);
    if (buf.subarray(0, 8000).includes(0)) return { binary: true };
    return { text: buf.toString('utf8'), truncated: size > len };
  } finally {
    await fh.close();
  }
});

ipcMain.handle('fs:openExternal', (_e, p) => shell.openPath(p));
ipcMain.handle('fs:showInFolder', (_e, p) => shell.showItemInFolder(p));
ipcMain.handle('fs:saveAs', async (_e, { localPath, name }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
  if (r.canceled || !r.filePath) return null;
  await fs.promises.copyFile(localPath, r.filePath);
  return r.filePath;
});
ipcMain.handle('fs:upload', async (_e, { hostId, files }) => {
  if (hostId === 'local') return files;
  const out = [];
  for (const f of files) out.push(await uploadToRemote(hostId, f));
  return out;
});

// ───────────────────────── clipboard ─────────────────────────
// In this Electron build the clipboard calls are asynchronous (readText() returns a Promise) and there is
// no readImage/readBuffer. Every call is awaited; returning an unresolved Promise over IPC hangs the caller.
async function clipboardFiles() {
  try {
    if (typeof clipboard.has !== 'function' || !(await clipboard.has('FileNameW'))) return [];
    const raw = String((await clipboard.read('FileNameW')) || '').split(String.fromCharCode(0)).join('').trim();
    return raw && fs.existsSync(raw) ? [raw] : [];
  } catch {
    return [];
  }
}
ipcMain.handle('clip:read', async () => {
  let text = '';
  try {
    const v = await clipboard.readText();
    text = typeof v === 'string' ? v : '';
  } catch {}
  return { text, files: await clipboardFiles() };
});
// bytes come from the renderer (paste event or drag payload); saved locally, uploaded when the tab is remote
ipcMain.handle('clip:saveImage', async (_e, { hostId, bytes, ext }) => {
  const safeExt = /^[a-z0-9]{1,5}$/i.test(ext || '') ? ext : 'png';
  const dir = path.join(CACHE_DIR, 'paste');
  await fs.promises.mkdir(dir, { recursive: true });
  const f = path.join(dir, `paste-${Date.now()}.${safeExt}`);
  await fs.promises.writeFile(f, Buffer.from(bytes));
  return hostId === 'local' ? f : uploadToRemote(hostId, f);
});
// The app runs without a menu bar, so Chromium's built-in Ctrl+V never fires. Running the paste
// command here dispatches a real paste event in the renderer, which is the only way to get image data.
ipcMain.handle('clip:pasteCommand', () => {
  win?.webContents.paste();
});
ipcMain.handle('clip:write', async (_e, text) => {
  await clipboard.writeText(String(text ?? ''));
  return true;
});

// ───────────────────────── hosts / config ipc ─────────────────────────
ipcMain.handle('hosts:list', () => listHosts());
ipcMain.handle('hosts:add', (_e, h) => {
  const host = {
    id: 'custom:' + crypto.randomUUID().slice(0, 8),
    name: h.name || h.host,
    host: h.host,
    port: parseInt(h.port, 10) || 22,
    user: h.user || null,
    identityFile: h.identityFile || null,
  };
  config.hosts.push(host);
  saveConfig();
  return host;
});
ipcMain.handle('hosts:remove', (_e, id) => {
  config.hosts = config.hosts.filter((h) => h.id !== id);
  saveConfig();
});
ipcMain.handle('hosts:test', async (_e, id) => {
  await getConn(id);
  return remoteHome(id);
});

ipcMain.handle('config:get', () => ({
  settings: config.settings,
  favorites: config.favorites,
  recentPaths: config.recentPaths,
  tabs: config.tabs,
  activeTab: config.activeTab,
}));
ipcMain.handle('config:set', (_e, patch) => {
  for (const k of ['settings', 'favorites', 'tabs', 'activeTab']) if (k in patch) config[k] = patch[k];
  saveConfig();
});

ipcMain.handle('dialog:pickFile', async (_e, { defaultPath } = {}) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: expandHome(defaultPath || '~/.ssh'), properties: ['openFile', 'showHiddenFiles'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pickDir', async (_e, { defaultPath } = {}) => {
  const r = await dialog.showOpenDialog(win, { defaultPath: expandHome(defaultPath || '~'), properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.on('notify', (_e, { title, body, tabId }) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, silent: false });
  n.on('click', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    send('focus-tab', tabId);
  });
  n.show();
});
ipcMain.on('open-url', (_e, url) => {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
});
ipcMain.on('devtools', () => win?.webContents.toggleDevTools());

// ───────────────────────── window ─────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 820,
    minHeight: 500,
    backgroundColor: '#131418',
    title: 'Claude Deck',
    show: !process.env.DECK_HIDDEN,
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      plugins: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (INSTANCE) {
    win.on('page-title-updated', (e, title) => {
      e.preventDefault();
      win.setTitle(title.replace('Claude Deck', `Claude Deck ${INSTANCE}`));
    });
  }
  // self-test hooks: DECK_EVAL runs JS in the renderer, DECK_SHOT saves a screenshot
  // DECK_KEYTEST=<ms>: after load, send a real Ctrl+V through Chromium's input pipeline
  if (process.env.DECK_KEYTEST) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        win.webContents.focus();
        for (const type of ['keyDown', 'keyUp']) win.webContents.sendInputEvent({ type, keyCode: 'V', modifiers: ['control'] });
        console.log('KEYTEST_SENT');
      }, Number(process.env.DECK_KEYTEST));
    });
  }
  if (process.env.DECK_EVAL || process.env.DECK_SHOT) {
    win.webContents.once('did-finish-load', async () => {
      if (process.env.DECK_EVAL) win.webContents.executeJavaScript(`${process.env.DECK_EVAL};void 0`).catch((e) => console.error(e));
      if (process.env.DECK_SHOT) {
        await new Promise((r) => setTimeout(r, Number(process.env.DECK_SHOT_DELAY || 3000)));
        fs.writeFileSync(process.env.DECK_SHOT, (await win.webContents.capturePage()).toPNG());
        console.log('SHOT_SAVED');
      }
    });
  }
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('close', async (e) => {
    if (forceQuit || sessions.size === 0) return;
    e.preventDefault();
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['모두 종료하고 닫기', '취소'],
      defaultId: 1,
      cancelId: 1,
      title: 'Claude Deck',
      message: `실행 중인 세션이 ${sessions.size}개 있습니다.`,
      detail: '창을 닫으면 모든 세션이 끝납니다. 탭 목록은 저장되어 다음 실행 때 이어서 열 수 있습니다.',
    });
    if (response === 0) {
      forceQuit = true;
      win.close();
    }
  });
}

// Secondary instance: `electron . --instance=2` gets its own profile folder, so it runs next to the
// main window (the single-instance lock is per profile) and seeds its config from the main one.
const instanceArg = process.argv.find((a) => a.startsWith('--instance='));
const INSTANCE = (instanceArg ? instanceArg.slice('--instance='.length) : '').replace(/[^\w-]/g, '');
if (process.env.DECK_USERDATA) {
  app.setPath('userData', process.env.DECK_USERDATA); // self-test: isolated instance
} else if (INSTANCE) {
  const primary = app.getPath('userData');
  app.setPath('userData', path.join(path.dirname(primary), `claude-deck-${INSTANCE}`));
  SEED_CONFIG = path.join(primary, 'config.json');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
  });
  app.whenReady().then(() => {
    app.setAppUserModelId('com.inspirio.claude-deck');
    Menu.setApplicationMenu(null);
    loadConfig();
    createWindow();
  });
  app.on('window-all-closed', () => {
    for (const id of [...sessions.keys()]) killSession(id);
    for (const e of conns.values()) {
      try {
        e.client.end();
      } catch {}
    }
    try {
      writeConfigNow();
    } catch {}
    app.quit();
  });
}
