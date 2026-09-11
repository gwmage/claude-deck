'use strict';
/* global Terminal, FitAddon, Unicode11Addon, WebLinksAddon, WebglAddon, marked, deck */

// ───────────────────────── helpers ─────────────────────────
const $ = (s, el = document) => el.querySelector(s);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k in el && typeof v !== 'string') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : String(kid));
  return el;
}
const cleanErr = (err) => String(err?.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const basename = (p) => p.split(/[\\/]/).filter(Boolean).pop() || p;
const joinPath = (dir, name, sep) => (dir.endsWith(sep) ? dir + name : dir + sep + name);
const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
function timeAgo(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return '방금';
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// ───────────────────────── state ─────────────────────────
const state = {
  hosts: [],
  tabs: [],
  activeId: null,
  settings: { fontSize: 14, localShell: 'auto', notify: true, programs: ['claude'] },
  favorites: [],
  recentPaths: {},
  filePanel: { open: false, mode: 'recent' },
};
const tabById = (id) => state.tabs.find((t) => t.id === id);
const activeTab = () => tabById(state.activeId);
const hostById = (id) => state.hosts.find((x) => x.id === id) || { id, name: id.replace(/^\w+:/, ''), kind: 'ssh' };
const isRemote = (tab) => tab.hostId !== 'local';

const MODES = [
  { flag: '', label: '새 대화' },
  { flag: '--continue', label: '마지막 대화 이어서 (--continue)' },
  { flag: '--resume', label: '대화 골라서 재개 (--resume)' },
];

const THEME = {
  background: '#16171c',
  foreground: '#e4e4e7',
  cursor: '#d97757',
  cursorAccent: '#16171c',
  selectionBackground: '#d9775750',
  black: '#1d1f24', red: '#ff6b6b', green: '#98c379', yellow: '#e5c07b',
  blue: '#61afef', magenta: '#c678dd', cyan: '#56b6c2', white: '#dcdfe4',
  brightBlack: '#5c6370', brightRed: '#ff8787', brightGreen: '#b5e08a', brightYellow: '#f0d08a',
  brightBlue: '#82c0ff', brightMagenta: '#d7a0ec', brightCyan: '#7fd0da', brightWhite: '#ffffff',
};
const FONT = '"Cascadia Mono", "D2Coding", Consolas, "Malgun Gothic", monospace';

// A tab runs either an agent program (claude, claude-glm, ...) followed by flags, or an arbitrary command.
const programs = () => (state.settings.programs?.length ? state.settings.programs : ['claude']);
const FLAG_RE = /\s(--continue|--resume|-c|-r)\b(\s+[0-9a-f-]{36})?/g;
function inferProgram(cmd) {
  if (!cmd) return null;
  const known = [...new Set([...programs(), 'claude'])].sort((a, b) => b.length - a.length);
  return known.find((p) => cmd === p || cmd.startsWith(p + ' ')) || null;
}
const tmuxNameFor = (cwd) =>
  'deck-' + ((basename(cwd || '') || '').replace(/[^\w-]/g, '').slice(0, 24) || 'session') + '-' + Math.random().toString(36).slice(2, 6);
const isAgent = (tab) => !!tab.program && (tab.command === tab.program || tab.command.startsWith(tab.program + ' '));
// same program and args, re-flagged with --continue; a pinned "--resume <id>" is kept so the exact conversation reopens
function continueCommand(tab) {
  if (!isAgent(tab)) return tab.command;
  const rest = tab.command.slice(tab.program.length);
  if (/--resume\s+[0-9a-f-]{36}/.test(rest)) return tab.command;
  return `${tab.program} --continue${rest.replace(FLAG_RE, '')}`;
}
function freshCommand(tab) {
  if (!isAgent(tab)) return tab.command;
  return tab.program + tab.command.slice(tab.program.length).replace(FLAG_RE, '');
}

// ───────────────────────── terminal tabs ─────────────────────────
function defaultName(hostId, cwd) {
  const base = cwd && cwd !== '~' ? basename(cwd) : hostId === 'local' ? '홈' : hostById(hostId).name;
  const taken = new Set(state.tabs.map((t) => t.name));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

function createTab(opts, { activate: doActivate = true } = {}) {
  const tab = {
    id: opts.id || crypto.randomUUID(),
    name: opts.name || defaultName(opts.hostId, opts.cwd),
    hostId: opts.hostId,
    cwd: opts.cwd || '~',
    command: opts.command ?? 'claude',
    program: opts.program !== undefined ? opts.program : inferProgram(opts.command ?? 'claude'),
    tmux: opts.tmux || null,
    status: 'new',
    title: '',
    attention: false,
    busy: false,
    lastData: 0,
    busySince: 0,
    startedAt: Date.now(),
    recentFiles: null,
    knownFiles: null,
  };
  const wrap = h('div', { class: 'term-wrap' });
  const host = h('div', { class: 'term-host' });
  wrap.append(host);
  $('#terms').append(wrap);
  tab.el = wrap;

  const term = new Terminal({
    allowProposedApi: true,
    fontFamily: FONT,
    fontSize: state.settings.fontSize,
    lineHeight: 1.12,
    cursorBlink: true,
    scrollback: 20000,
    theme: THEME,
    minimumContrastRatio: 1,
    windowsPty: isRemote(tab) ? undefined : { backend: 'conpty', buildNumber: 26200 },
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new Unicode11Addon.Unicode11Addon());
  term.unicode.activeVersion = '11';
  term.loadAddon(new WebLinksAddon.WebLinksAddon((_e, uri) => deck.openUrl(uri)));
  tab.term = term;
  tab.fit = fit;

  state.tabs.push(tab);
  if (doActivate) setActive(tab.id);
  term.open(host);
  try {
    const gl = new WebglAddon.WebglAddon();
    gl.onContextLoss(() => gl.dispose());
    term.loadAddon(gl);
  } catch {}
  registerFileLinks(tab);

  term.onData((d) => {
    if (tab.status === 'running') deck.input(tab.id, d);
  });
  term.onResize(({ cols, rows }) => deck.resize(tab.id, cols, rows));
  term.onTitleChange((t) => {
    // ignore shell titles like "C:\WINDOWS\System32\cmd.exe"; keep Claude's task titles
    tab.title = /[\\/]|\.exe\b/i.test(t) ? '' : t.replace(/^[^\p{L}\p{N}]+/u, '').trim();
    renderTabs();
    if (tab.id === state.activeId) updateTopbar();
  });
  term.onBell(() => flagAttention(tab, '벨'));
  const oscNotify = (data) => {
    if (/^4;/.test(data)) return true; // progress sequences
    const body = data.split(';').filter(Boolean).pop() || '알림';
    flagAttention(tab, body);
    return true;
  };
  term.parser.registerOscHandler(9, oscNotify);
  term.parser.registerOscHandler(777, oscNotify);
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (term.hasSelection()) {
      deck.clipWrite(term.getSelection());
      term.clearSelection();
      toast('복사했습니다');
    } else pasteInto(tab);
  });

  if (opts.paused) {
    tab.status = 'paused';
    term.write('\x1b[90m이전에 열려 있던 세션입니다.\x1b[0m\r\n');
    showOverlay(tab);
  } else {
    requestAnimationFrame(() => startTab(tab));
  }
  persistTabs();
  renderTabs();
  updateTopbar();
  return tab;
}

function fitTab(tab) {
  if (!tab || !tab.el.classList.contains('active')) return;
  try {
    tab.fit.fit();
  } catch {}
}

function setActive(id) {
  const tab = tabById(id);
  if (!tab) return;
  state.activeId = id;
  for (const t of state.tabs) t.el.classList.toggle('active', t.id === id);
  tab.attention = false;
  requestAnimationFrame(() => {
    fitTab(tab);
    if (!document.querySelector('.modal-back')) tab.term.focus();
  });
  deck.setConfig({ activeTab: id });
  renderTabs();
  updateTopbar();
  renderFilePanel();
}

async function startTab(tab, command = tab.command) {
  hideOverlay(tab);
  tab.status = 'connecting';
  tab.busy = false;
  renderTabs();
  fitTab(tab);
  if (isRemote(tab)) tab.term.write(`\x1b[90m● ${hostById(tab.hostId).name} 연결 중…\x1b[0m\r\n`);
  tab.startedAt = Date.now();
  tab.recentFiles = null;
  tab.knownFiles = null;
  try {
    const res = await deck.start({
      id: tab.id,
      hostId: tab.hostId,
      cwd: tab.cwd,
      command,
      tmux: tab.tmux,
      cols: tab.term.cols,
      rows: tab.term.rows,
    });
    tab.resolvedCwd = res?.cwd || null;
    tab.status = 'running';
  } catch (err) {
    tab.status = 'error';
    tab.term.write(`\r\n\x1b[31m✖ ${cleanErr(err)}\x1b[0m\r\n`);
    showOverlay(tab);
  }
  renderTabs();
  updateTopbar();
  if (tab.id === state.activeId) renderFilePanel();
}

async function restartTab(tab, command, { keepServerSession = false } = {}) {
  await deck.kill(tab.id);
  if (tab.tmux && !keepServerSession) await deck.tmuxKill({ hostId: tab.hostId, name: tab.tmux }).catch(() => {});
  tab.term.reset();
  startTab(tab, command);
}

// move a plain remote tab into tmux: same conversation (--resume id / --continue) relaunched inside a new tmux session
async function convertToKeep(t) {
  const ok = await confirmModal({
    title: '세션 보존으로 전환',
    message:
      '"' + t.name + '" 대화를 서버의 tmux 안에서 다시 띄웁니다.\n' +
      '대화 내용은 이어지지만, 지금 진행 중인 응답은 한 번 끊깁니다.\n' +
      '전환 후에는 창을 닫거나 컴퓨터를 꺼도 서버에서 계속 돌아갑니다.',
    okLabel: '전환',
  });
  if (!ok) return;
  t.tmux = tmuxNameFor(t.cwd);
  persistTabs();
  renderTabs();
  restartTab(t, continueCommand(t), { keepServerSession: true });
}

// attach to the tab's tmux session if it is still alive; otherwise start it again, continuing the conversation
function reconnectTab(tab) {
  restartTab(tab, continueCommand(tab), { keepServerSession: true });
}

async function closeTab(tab, { confirm = true } = {}) {
  const alive = tab.status === 'running' || tab.status === 'connecting';
  let killServer = false;
  if (tab.tmux) {
    const choice = await choiceModal({
      title: '보존 세션 닫기',
      message:
        '"' + tab.name + '"은 서버의 tmux 세션(' + tab.tmux + ')에서 돌고 있습니다.\n' +
        '연결만 끊으면 Claude는 서버에서 계속 실행되고, 새 세션 창에서 다시 붙을 수 있습니다.',
      choices: [
        { value: 'kill', label: '서버 세션까지 종료', danger: true },
        { value: 'detach', label: '연결만 끊기', primary: true },
      ],
    });
    if (!choice) return;
    killServer = choice === 'kill';
  } else if (alive && confirm) {
    const ok = await confirmModal({
      title: '세션을 닫을까요?',
      message: '"' + tab.name + '" 세션이 실행 중입니다.\n닫으면 이 세션의 Claude가 종료됩니다.',
      okLabel: '세션 닫기',
      danger: true,
    });
    if (!ok) return;
  }
  await deck.kill(tab.id);
  if (killServer) {
    await deck.tmuxKill({ hostId: tab.hostId, name: tab.tmux }).catch((err) => toast('서버 세션 종료 실패: ' + cleanErr(err), { error: true }));
  }
  const idx = state.tabs.indexOf(tab);
  state.tabs.splice(idx, 1);
  tab.term.dispose();
  tab.el.remove();
  if (state.activeId === tab.id) {
    const next = state.tabs[Math.min(idx, state.tabs.length - 1)];
    state.activeId = null;
    if (next) setActive(next.id);
  }
  persistTabs();
  renderTabs();
  updateTopbar();
  renderFilePanel();
}

function persistTabs() {
  deck.setConfig({
    tabs: state.tabs.map((t) => ({ id: t.id, name: t.name, hostId: t.hostId, cwd: t.cwd, command: t.command, program: t.program, tmux: t.tmux })),
  });
}

function flagAttention(tab, reason) {
  const unseen = tab.id !== state.activeId || !document.hasFocus();
  if (!unseen) return;
  tab.attention = true;
  renderTabs();
  if (state.settings.notify && !document.hasFocus()) {
    deck.notify({ title: `${tab.name}`, body: reason || '확인이 필요합니다', tabId: tab.id });
  }
}

// ── overlay for paused / exited / error tabs
function showOverlay(tab) {
  hideOverlay(tab);
  const agent = isAgent(tab);
  const msg = (tab.tmux
    ? { paused: '<b>보존된 세션</b> · 서버에서 계속 실행 중일 수 있습니다', exited: '<b>연결 끊김</b> · 서버의 세션은 살아 있을 수 있습니다', error: '<b>연결하지 못했습니다</b>' }
    : { paused: '<b>이전 세션</b> · 다시 열까요?', exited: '<b>세션 종료됨</b>', error: '<b>시작하지 못했습니다</b>' })[tab.status] || '';
  const btns = [];
  if (tab.tmux) {
    btns.push(h('button', { class: 'primary', onclick: () => reconnectTab(tab) }, '다시 연결'));
    if (agent) btns.push(h('button', { class: 'btn', title: '서버의 세션을 끝내고 새로 시작', onclick: () => restartTab(tab, freshCommand(tab)) }, '새 대화로 시작'));
  } else if (agent) {
    btns.push(h('button', { class: 'primary', onclick: () => restartTab(tab, continueCommand(tab)) }, '이어서 시작'));
    btns.push(h('button', { class: 'btn', onclick: () => restartTab(tab, freshCommand(tab)) }, '새 대화로 시작'));
  } else {
    btns.push(h('button', { class: 'primary', onclick: () => restartTab(tab) }, '다시 시작'));
  }
  btns.push(h('button', { class: 'btn', onclick: () => closeTab(tab, { confirm: false }) }, '탭 닫기'));
  tab.overlay = h('div', { class: 'overlay' }, h('div', { class: 'overlay-msg', html: msg }), h('div', { class: 'btns' }, btns));
  tab.el.append(tab.overlay);
}
function hideOverlay(tab) {
  tab.overlay?.remove();
  tab.overlay = null;
}

// ── session events from main
deck.onData((id, data) => {
  const tab = tabById(id);
  if (!tab) return;
  tab.term.write(data);
  const now = Date.now();
  if (!tab.busy) {
    tab.busy = true;
    tab.busySince = now;
    renderTabs();
  }
  tab.lastData = now;
});
deck.onExit((id, code) => {
  const tab = tabById(id);
  if (!tab) return;
  tab.status = 'exited';
  tab.busy = false;
  tab.term.write(`\r\n\x1b[90m── 세션 종료${code != null ? ` (코드 ${code})` : ''} ──\x1b[0m\r\n`);
  showOverlay(tab);
  renderTabs();
  updateTopbar();
});
deck.onFocusTab((id) => tabById(id) && setActive(id));

// busy → idle transitions: Claude streams output while it works and goes quiet when it waits for you
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const tab of state.tabs) {
    if (!tab.busy || now - tab.lastData < 2500) continue;
    tab.busy = false;
    changed = true;
    if (tab.status === 'running' && tab.lastData - tab.busySince > 8000) {
      flagAttention(tab, `응답 완료${tab.title ? ' · ' + tab.title : ''}`);
    }
  }
  if (changed) renderTabs();
}, 1000);

window.addEventListener('focus', () => {
  const tab = activeTab();
  if (tab?.attention) {
    tab.attention = false;
    renderTabs();
  }
});

// ───────────────────────── file links inside the terminal ─────────────────────────
const KNOWN_EXT = new Set(
  ('md markdown mdx html htm pdf png jpg jpeg gif webp svg bmp ico txt log csv tsv json jsonl yaml yml toml ini env xml ' +
    'js mjs cjs ts tsx jsx py rb go rs java kt swift c h cc cpp hpp cs php sh bash zsh ps1 bat cmd sql css scss less vue svelte ' +
    'prisma graphql proto dockerfile docx doc xlsx xls pptx ppt hwp hwpx zip tar gz mp4 webm mov mp3 wav m4a ipynb lock conf cfg').split(' ')
);
const PATH_RE = /(?:[A-Za-z]:[\\/]|~[\\/]|\.{1,2}[\\/]|[\\/])?(?:[\w.@+\-가-힣]+[\\/])*[\w@+\-가-힣][\w.@+\-가-힣]*\.[A-Za-z0-9]{1,8}(?![\w가-힣])/g;

function registerFileLinks(tab) {
  const term = tab.term;
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      let start = y - 1;
      let end = y - 1;
      while (start > 0 && buf.getLine(start)?.isWrapped) start--;
      while (buf.getLine(end + 1)?.isWrapped) end++;
      if (end - start > 30) return callback(undefined);
      let text = '';
      const pos = [];
      const nc = buf.getNullCell();
      for (let row = start; row <= end; row++) {
        const line = buf.getLine(row);
        if (!line) continue;
        for (let x = 0; x < line.length; x++) {
          const cell = line.getCell(x, nc);
          if (!cell) continue;
          const w = cell.getWidth();
          if (w === 0) continue;
          const ch = cell.getChars() || ' ';
          for (let k = 0; k < ch.length; k++) pos.push({ x: x + 1, y: row + 1, w });
          text += ch;
        }
      }
      const links = [];
      PATH_RE.lastIndex = 0;
      let m;
      while ((m = PATH_RE.exec(text))) {
        const s = m[0];
        const idx = m.index;
        const prev = text[idx - 1] || ' ';
        if (/[:/\\\w.]/.test(prev)) continue;
        const ext = s.split('.').pop().toLowerCase();
        const hasSep = /[\\/]/.test(s);
        if (!/[a-z]/i.test(ext)) continue;
        if (!KNOWN_EXT.has(ext) && (!hasSep || /^[\w-]+\.(com|net|org|io|ai|kr|dev|app|co)\b/i.test(s))) continue;
        const a = pos[idx];
        const b = pos[idx + s.length - 1];
        if (!a || !b) continue;
        links.push({
          range: { start: { x: a.x, y: a.y }, end: { x: b.x + b.w - 1, y: b.y } },
          text: s,
          decorations: { pointerCursor: true, underline: true },
          activate: (_ev, t) => openFile(tab, t),
        });
      }
      callback(links.length ? links : undefined);
    },
  });
}

// ───────────────────────── paste / drop ─────────────────────────
function quoteFor(tab, p) {
  if (!/[\s'"()&;]/.test(p)) return p;
  return isRemote(tab) ? `'${p.replace(/'/g, `'\\''`)}'` : `"${p}"`;
}

async function pastePaths(tab, localPaths) {
  let paths = localPaths;
  if (isRemote(tab)) {
    const t = toast(`서버로 업로드 중… (${localPaths.length}개)`, { sticky: true });
    try {
      paths = await deck.upload({ hostId: tab.hostId, files: localPaths });
    } catch (err) {
      toast(`업로드 실패: ${cleanErr(err)}`, { error: true });
      return;
    } finally {
      t.close();
    }
  }
  tab.term.paste(paths.map((p) => quoteFor(tab, p)).join(' ') + ' ');
  tab.term.focus();
}

async function pasteInto(tab) {
  if (!tab || tab.status !== 'running') return;
  const clip = await deck.clipRead();
  if (clip.text) return tab.term.paste(clip.text);
  if (clip.files?.length) return pastePaths(tab, clip.files);
  if (clip.hasImage) {
    const t = toast(isRemote(tab) ? '이미지를 서버로 올리는 중…' : '이미지 저장 중…', { sticky: true });
    try {
      const p = await deck.clipImage({ hostId: tab.hostId });
      if (p) tab.term.paste(quoteFor(tab, p) + ' ');
    } catch (err) {
      toast(`이미지 붙여넣기 실패: ${cleanErr(err)}`, { error: true });
    } finally {
      t.close();
    }
  }
}

const termsEl = $('#terms');
termsEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  termsEl.classList.add('drop');
});
termsEl.addEventListener('dragleave', (e) => {
  if (!termsEl.contains(e.relatedTarget)) termsEl.classList.remove('drop');
});
termsEl.addEventListener('drop', (e) => {
  e.preventDefault();
  termsEl.classList.remove('drop');
  const tab = activeTab();
  if (!tab || tab.status !== 'running') return;
  const files = [...e.dataTransfer.files].map((f) => deck.pathForFile(f)).filter(Boolean);
  if (files.length) pastePaths(tab, files);
});
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => e.preventDefault());

// ───────────────────────── keyboard ─────────────────────────
window.addEventListener(
  'keydown',
  (e) => {
    const modalOpen = !!document.querySelector('.modal-back');
    const ctrl = e.ctrlKey && !e.altKey && !e.metaKey;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    const tab = activeTab();
    const stop = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.key === 'F12') return stop(), deck.devtools();
    if (modalOpen) return;

    if (ctrl && e.shiftKey && key === 't') return stop(), newSessionModal();
    if (ctrl && e.shiftKey && key === 'w') return stop(), tab && closeTab(tab);
    if (ctrl && e.shiftKey && key === 'e') return stop(), toggleFilePanel();
    if (ctrl && e.key === 'Tab') {
      stop();
      if (!state.tabs.length) return;
      const i = state.tabs.indexOf(tab);
      const n = state.tabs.length;
      return setActive(state.tabs[(i + (e.shiftKey ? n - 1 : 1)) % n].id);
    }
    if (ctrl && !e.shiftKey && /^[1-9]$/.test(e.key)) {
      const t = state.tabs[Number(e.key) - 1];
      if (t) return stop(), setActive(t.id);
    }
    if (ctrl && (e.key === '=' || e.key === '+')) return stop(), setFontSize(state.settings.fontSize + 1);
    if (ctrl && e.key === '-') return stop(), setFontSize(state.settings.fontSize - 1);
    if (ctrl && e.key === '0') return stop(), setFontSize(14);

    if (!tab || !e.target.closest?.('.xterm')) return;
    if (ctrl && key === 'c' && (e.shiftKey || tab.term.hasSelection())) {
      stop();
      if (tab.term.hasSelection()) {
        deck.clipWrite(tab.term.getSelection());
        tab.term.clearSelection();
      }
      return;
    }
    if (ctrl && key === 'v') return stop(), pasteInto(tab);
    // Ctrl+Enter / Shift+Enter → newline in Claude's prompt. xterm sends a plain CR (submit) for both;
    // Windows Terminal sends LF (Ctrl+J), which Claude treats as "insert newline".
    if ((e.ctrlKey || e.shiftKey) && !e.altKey && !e.metaKey && e.key === 'Enter') {
      stop();
      if (tab.status === 'running') deck.input(tab.id, '\n');
    }
  },
  true
);

function setFontSize(n) {
  n = Math.max(9, Math.min(28, n));
  state.settings.fontSize = n;
  for (const t of state.tabs) t.term.options.fontSize = n;
  fitTab(activeTab());
  deck.setConfig({ settings: state.settings });
}

new ResizeObserver(() => {
  clearTimeout(window.__fitT);
  window.__fitT = setTimeout(() => fitTab(activeTab()), 30);
}).observe(termsEl);

// ───────────────────────── sidebar ─────────────────────────
function tabStateClass(t) {
  if (t.status === 'running') return t.attention ? 'attention' : t.busy ? 'busy' : 'idle';
  return t.status;
}
const STATUS_LABEL = {
  idle: '입력 대기', busy: '작업 중', attention: '확인 필요', connecting: '연결 중', new: '시작 중',
  exited: '종료됨', paused: '일시정지', error: '오류',
};
function shortPath(p) {
  if (!p) return '';
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? '…/' + parts.slice(-2).join('/') : p;
}

function renderTabs() {
  const nav = $('#tabs');
  nav.replaceChildren();
  const groups = new Map();
  for (const t of state.tabs) {
    if (!groups.has(t.hostId)) groups.set(t.hostId, []);
    groups.get(t.hostId).push(t);
  }
  for (const [hostId, tabs] of groups) {
    const host = hostById(hostId);
    nav.append(
      h('div', { class: 'group-title' },
        h('span', {}, hostId === 'local' ? '💻' : '🖥'),
        h('span', { class: 'gname' }, host.name),
        h('button', { class: 'group-add', title: `${host.name}에서 새 세션`, onclick: () => newSessionModal({ hostId }) }, '+'))
    );
    for (const t of tabs) {
      const idx = state.tabs.indexOf(t);
      const st = tabStateClass(t);
      nav.append(
        h('div', {
          class: `tab st-${st}${t.id === state.activeId ? ' active' : ''}`,
          title: `${STATUS_LABEL[st] || st}\n${host.name}: ${t.cwd}\n${t.command || '(셸)'}\n\n더블클릭: 이름 변경 · 우클릭: 메뉴`,
          onclick: () => setActive(t.id),
          ondblclick: () => renameTab(t),
          oncontextmenu: (e) => {
            e.preventDefault();
            tabMenu(t, e.clientX, e.clientY);
          },
        },
        h('span', { class: 'dot' }),
        h('div', { class: 'tab-text' },
          h('div', { class: 'tab-name' }, t.name),
          h('div', { class: 'tab-sub' }, t.tmux ? h('span', { class: 'keep-tag', title: 'tmux 세션 ' + t.tmux }, '보존 · ') : null, t.program && t.program !== 'claude' ? h('span', { class: 'prog-tag' }, t.program + ' · ') : null, t.title && t.status === 'running' ? t.title : shortPath(t.cwd))),
        idx < 9 ? h('span', { class: 'tab-key' }, `^${idx + 1}`) : null,
        h('button', {
          class: 'tab-more',
          title: '메뉴',
          onclick: (e) => {
            e.stopPropagation();
            const r = e.currentTarget.getBoundingClientRect();
            tabMenu(t, r.right, r.bottom);
          },
        }, '⋯'))
      );
    }
  }
  $('#empty').hidden = state.tabs.length > 0;
  const attention = state.tabs.filter((t) => t.attention).length;
  document.title = attention ? `(${attention}) Claude Deck` : 'Claude Deck';
}

function renameTab(t) {
  const item = [...document.querySelectorAll('.tab')].find((el) => el.querySelector('.tab-name')?.textContent === t.name);
  const nameEl = item?.querySelector('.tab-name');
  if (!nameEl) return;
  const input = h('input', { class: 'tab-rename', value: t.name });
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) t.name = input.value.trim();
    persistTabs();
    renderTabs();
    updateTopbar();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') done(true);
    if (e.key === 'Escape') done(false);
  });
  input.addEventListener('blur', () => done(true));
  input.addEventListener('click', (e) => e.stopPropagation());
}

function tabMenu(t, x, y) {
  const claude = isAgent(t);
  showMenu(x, y, [
    { label: '이름 변경', onClick: () => renameTab(t) },
    { label: '실행 프로그램 변경…', onClick: () => changeProgramModal(t) },
    t.tmux && { label: '다시 연결 (서버 세션에 붙기)', onClick: () => reconnectTab(t) },
    isRemote(t) && !t.tmux && { label: '세션 보존으로 전환', onClick: () => convertToKeep(t) },
    claude && { label: '다시 시작 (이어서)', onClick: () => restartTab(t, continueCommand(t)) },
    claude && { label: '새 대화로 다시 시작', onClick: () => restartTab(t, freshCommand(t)) },
    !claude && { label: '다시 시작', onClick: () => restartTab(t) },
    { label: '같은 위치에 새 세션', onClick: () => createTab({ hostId: t.hostId, cwd: t.cwd, command: freshCommand(t), program: t.program, tmux: t.tmux ? tmuxNameFor(t.cwd) : null }) },
    { label: '빠른 실행에 추가', onClick: () => addFavorite({ name: t.name, hostId: t.hostId, cwd: t.cwd, command: t.command, program: t.program, keep: !!t.tmux }) },
    { label: '파일 패널', sc: 'Ctrl+Shift+E', onClick: () => { setActive(t.id); state.filePanel.open = true; renderFilePanel(); } },
    '-',
    { label: '세션 닫기', sc: 'Ctrl+Shift+W', danger: true, onClick: () => closeTab(t) },
  ]);
}

function renderFavorites() {
  const el = $('#favorites');
  el.replaceChildren();
  if (!state.favorites.length) {
    el.append(h('div', { class: 'side-empty' }, '자주 여는 폴더를 등록해두면 한 번에 켤 수 있습니다. 새 세션 창에서 "빠른 실행에 저장"을 체크하세요.'));
    return;
  }
  state.favorites.forEach((f, i) => {
    el.append(
      h('div', {
        class: 'fav',
        title: `${hostById(f.hostId).name}: ${f.cwd}\n${f.command || '(셸)'}`,
        onclick: () => createTab({ ...f, name: undefined, tmux: f.keep ? tmuxNameFor(f.cwd) : null }),
      },
      h('span', { class: 'fav-icon' }, '▶'),
      h('div', { class: 'fav-text' },
        h('div', { class: 'fav-name' }, f.name),
        h('div', { class: 'fav-sub' }, `${hostById(f.hostId).name} · ${shortPath(f.cwd)}`)),
      h('button', {
        class: 'fav-del',
        title: '삭제',
        onclick: (e) => {
          e.stopPropagation();
          state.favorites.splice(i, 1);
          deck.setConfig({ favorites: state.favorites });
          renderFavorites();
        },
      }, '✕'))
    );
  });
}

function addFavorite(f) {
  state.favorites.push({ name: f.name || defaultName(f.hostId, f.cwd), hostId: f.hostId, cwd: f.cwd, command: f.command, program: f.program !== undefined ? f.program : inferProgram(f.command), keep: !!f.keep });
  deck.setConfig({ favorites: state.favorites });
  renderFavorites();
  toast(`빠른 실행에 추가: ${f.name}`);
}

function updateTopbar() {
  const tab = activeTab();
  $('#tb-name').textContent = tab ? tab.name : '';
  $('#tb-path').textContent = tab ? `${hostById(tab.hostId).name}:${tab.resolvedCwd || tab.cwd}` : '';
  $('#tb-path').title = '클릭하면 경로 복사';
  $('#btn-restart').hidden = !tab;
}
$('#tb-path').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  deck.clipWrite(tab.resolvedCwd || tab.cwd);
  toast('경로를 복사했습니다');
});
$('#btn-restart').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  const r = $('#btn-restart').getBoundingClientRect();
  if (isAgent(tab)) {
    showMenu(r.left, r.bottom + 4, [
      tab.tmux && { label: '다시 연결 (서버 세션에 붙기)', onClick: () => reconnectTab(tab) },
      { label: '이어서 다시 시작 (--continue)', onClick: () => restartTab(tab, continueCommand(tab)) },
      { label: '새 대화로 다시 시작', onClick: () => restartTab(tab, freshCommand(tab)) },
    ]);
  } else restartTab(tab);
});

// ───────────────────────── file panel ─────────────────────────
const VIEWABLE = /\.(md|markdown|html?|pdf|png|jpe?g|gif|webp|svg|csv|txt|json|docx|xlsx|pptx|hwpx?|mp4|webm)$/i;
const fileIcon = (name, dir) => {
  if (dir) return '📁';
  const ext = name.split('.').pop().toLowerCase();
  if (/^(png|jpe?g|gif|webp|svg|bmp|ico)$/.test(ext)) return '🖼';
  if (/^(md|markdown|txt|log)$/.test(ext)) return '📝';
  if (/^(html?)$/.test(ext)) return '🌐';
  if (ext === 'pdf') return '📕';
  if (/^(csv|tsv|xlsx?)$/.test(ext)) return '📊';
  if (/^(docx?|hwpx?|pptx?)$/.test(ext)) return '📄';
  if (/^(mp4|webm|mov|mp3|wav|m4a)$/.test(ext)) return '🎞';
  return '·';
};

function toggleFilePanel() {
  state.filePanel.open = !state.filePanel.open;
  renderFilePanel();
}
$('#btn-files').addEventListener('click', toggleFilePanel);
for (const b of document.querySelectorAll('.fp-tabs button')) {
  b.addEventListener('click', () => {
    state.filePanel.mode = b.dataset.mode;
    renderFilePanel();
  });
}
$('#fp-refresh').addEventListener('click', () => {
  const tab = activeTab();
  if (!tab) return;
  if (state.filePanel.mode === 'recent') pollRecent(true);
  else loadBrowse(tab, tab.browsePath || tab.cwd);
});

function renderFilePanel() {
  const fp = $('#filepanel');
  fp.hidden = !state.filePanel.open;
  $('#btn-files').classList.toggle('on', state.filePanel.open);
  for (const b of fp.querySelectorAll('.fp-tabs button')) b.classList.toggle('active', b.dataset.mode === state.filePanel.mode);
  if (!state.filePanel.open) return;
  const tab = activeTab();
  if (!tab) {
    $('#fp-path').replaceChildren();
    $('#fp-list').replaceChildren(h('div', { class: 'muted pad' }, '열린 세션이 없습니다'));
    return;
  }
  if (state.filePanel.mode === 'recent') renderRecent(tab);
  else loadBrowse(tab, tab.browsePath || tab.resolvedCwd || tab.cwd);
}

function atButton(tab, fullPath) {
  return h('button', {
    class: 'fat',
    title: 'Claude 입력창에 @경로로 넣기',
    onclick: (e) => {
      e.stopPropagation();
      const base = tab.resolvedCwd || '';
      let p = fullPath;
      if (base && p.startsWith(base)) p = p.slice(base.length).replace(/^[\\/]/, '');
      if (tab.status === 'running') tab.term.paste(`@${p} `);
      tab.term.focus();
    },
  }, '@');
}

function renderRecent(tab) {
  $('#fp-path').replaceChildren(h('span', {}, '이 세션 시작 후 만들어지거나 바뀐 파일'));
  const list = $('#fp-list');
  const scroll = list.scrollTop;
  list.replaceChildren();
  if (tab.status !== 'running' && !tab.recentFiles) {
    list.append(h('div', { class: 'muted pad' }, '세션이 실행 중일 때 표시됩니다'));
    return;
  }
  if (!tab.recentFiles) {
    list.append(h('div', { class: 'muted pad' }, '확인 중…'));
    pollRecent(true);
    return;
  }
  if (!tab.recentFiles.length) {
    list.append(h('div', { class: 'muted pad' }, '아직 없습니다. Claude가 파일을 만들거나 고치면 여기에 뜨고, 새 문서는 알림으로도 알려드립니다.'));
    return;
  }
  for (const f of tab.recentFiles) {
    const name = basename(f.rel || f.path);
    const dir = (f.rel || '').split(/[\\/]/).slice(0, -1).join('/');
    list.append(
      h('div', { class: `frow${Date.now() - f.mtime < 60000 ? ' fresh' : ''}`, title: f.path, onclick: () => openFile(tab, f.path, '') },
        h('span', { class: 'ficon' }, fileIcon(name)),
        h('span', { class: 'fname' }, name, dir ? h('span', { class: 'fdir' }, dir) : null),
        atButton(tab, f.path),
        h('span', { class: 'fmeta' }, timeAgo(f.mtime)))
    );
  }
  list.scrollTop = scroll;
}

async function loadBrowse(tab, dir) {
  const list = $('#fp-list');
  list.replaceChildren(h('div', { class: 'muted pad' }, '불러오는 중…'));
  try {
    const r = await deck.list({ hostId: tab.hostId, dir, base: tab.resolvedCwd || tab.cwd });
    if (state.activeId !== tab.id || state.filePanel.mode !== 'browse') return;
    tab.browsePath = r.path;
    $('#fp-path').replaceChildren(
      r.parent ? h('button', { class: 'up', title: '상위 폴더', onclick: () => loadBrowse(tab, r.parent) }, '↑') : null,
      h('span', {}, r.path)
    );
    list.replaceChildren();
    const entries = [...r.entries].sort((a, b) => (a.name.startsWith('.') - b.name.startsWith('.')) || 0);
    for (const e of entries) {
      const full = joinPath(r.path, e.name, r.sep);
      list.append(
        h('div', {
          class: `frow${e.dir ? ' is-dir' : ''}${e.name.startsWith('.') ? ' dot-entry' : ''}`,
          title: full,
          onclick: () => (e.dir ? loadBrowse(tab, full) : openFile(tab, full, '')),
        },
        h('span', { class: 'ficon' }, fileIcon(e.name, e.dir)),
        h('span', { class: 'fname' }, e.name),
        atButton(tab, full),
        h('span', { class: 'fmeta' }, e.dir ? '' : fmtSize(e.size)))
      );
    }
    if (!entries.length) list.append(h('div', { class: 'muted pad' }, '빈 폴더'));
  } catch (err) {
    list.replaceChildren(h('div', { class: 'error' }, cleanErr(err)));
  }
}

async function pollRecent(force = false) {
  const tab = activeTab();
  if (!tab || tab.status !== 'running' || tab.polling) return;
  if (!force && document.hidden) return;
  tab.polling = true;
  try {
    const files = await deck.recent({ hostId: tab.hostId, dir: tab.resolvedCwd || tab.cwd, sinceMs: tab.startedAt - 60000 });
    const prev = tab.knownFiles;
    tab.knownFiles = new Set(files.map((f) => f.path));
    tab.recentFiles = files;
    if (prev) {
      const fresh = files.filter((f) => !prev.has(f.path) && VIEWABLE.test(f.path));
      for (const f of fresh.slice(0, 3)) fileToast(tab, f);
    }
    if (state.filePanel.open && state.filePanel.mode === 'recent' && state.activeId === tab.id) renderRecent(tab);
  } catch {
  } finally {
    tab.polling = false;
  }
}
setInterval(pollRecent, 5000);

function fileToast(tab, f) {
  const t = toast(
    h('div', {}, `새 파일 · ${basename(f.path)}`, h('small', {}, `${tab.name} · ${f.rel || f.path}`)),
    {
      timeout: 10000,
      actions: [{ label: '열기', primary: true, onClick: () => (t.close(), openFile(tab, f.path, '')) }],
    }
  );
}

// ───────────────────────── viewer ─────────────────────────
async function openFile(tab, file, base) {
  const t = toast(`불러오는 중… ${basename(file)}`, { sticky: true });
  try {
    const r = await deck.fetch({ hostId: tab.hostId, file, base: base === '' ? undefined : tab.resolvedCwd || tab.cwd });
    if (r.dir) {
      setActive(tab.id);
      state.filePanel.open = true;
      state.filePanel.mode = 'browse';
      tab.browsePath = r.path;
      renderFilePanel();
      return;
    }
    showViewer(tab, r);
  } catch (err) {
    toast(`열 수 없습니다: ${cleanErr(err)}`, { error: true });
  } finally {
    t.close();
  }
}

const IMG_EXT = /^(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/;
const OFFICE_EXT = /^(docx?|xlsx?|pptx?|hwpx?|zip|7z|rar|exe|msi|dmg)$/;

function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n') { row.push(cur.replace(/\r$/, '')); rows.push(row); row = []; cur = ''; if (rows.length > 1000) break; }
    else cur += c;
  }
  if (cur || row.length) rows.push([...row, cur]);
  return rows;
}

function markdownDoc(md, baseUrl) {
  const html = marked.parse(md, { gfm: true, breaks: false });
  return `<!doctype html><html><head><meta charset="utf-8"><base href="${esc(baseUrl)}">
<style>
body{font-family:'Pretendard','Segoe UI','Malgun Gothic',sans-serif;max-width:860px;margin:0 auto;padding:32px 40px 80px;color:#1f2328;line-height:1.7;font-size:15px}
h1,h2,h3{line-height:1.3;margin-top:1.6em}h1{font-size:1.9em;border-bottom:1px solid #eaecef;padding-bottom:.3em}h2{font-size:1.45em;border-bottom:1px solid #eaecef;padding-bottom:.25em}
code{font-family:'Cascadia Mono',Consolas,monospace;background:#f3f4f6;padding:.15em .35em;border-radius:4px;font-size:.88em}
pre{background:#f6f8fa;padding:14px 16px;border-radius:8px;overflow:auto}pre code{background:none;padding:0}
table{border-collapse:collapse;margin:1em 0}td,th{border:1px solid #d0d7de;padding:6px 12px}th{background:#f6f8fa}
blockquote{margin:0;padding:0 1em;color:#57606a;border-left:4px solid #d0d7de}img{max-width:100%}a{color:#0969da}
hr{border:0;border-top:1px solid #d0d7de;margin:2em 0}
</style></head><body>${html}</body></html>`;
}

async function renderViewerBody(r) {
  const ext = r.name.split('.').pop().toLowerCase();
  if (IMG_EXT.test(ext)) return h('img', { src: r.url });
  if (ext === 'pdf') return h('iframe', { class: 'viewer-frame', src: r.url });
  if (/^html?$/.test(ext)) return h('iframe', { class: 'viewer-frame', src: r.url, sandbox: 'allow-scripts' });
  if (/^(mp4|webm|mov)$/.test(ext)) return h('video', { src: r.url, controls: true });
  if (/^(mp3|wav|ogg|m4a)$/.test(ext)) return h('audio', { src: r.url, controls: true });
  if (OFFICE_EXT.test(ext)) {
    return h('div', { class: 'viewer-note' },
      `${r.name} (${fmtSize(r.size)})`, h('br'), '이 형식은 외부 앱에서 열어야 합니다.', h('br'), h('br'),
      h('button', { class: 'primary', onclick: () => deck.openExternal(r.localPath) }, '외부 앱으로 열기'));
  }
  const res = await deck.readText(r.localPath);
  if (res.binary) {
    return h('div', { class: 'viewer-note' }, '텍스트가 아닌 파일입니다.', h('br'), h('br'),
      h('button', { class: 'primary', onclick: () => deck.openExternal(r.localPath) }, '외부 앱으로 열기'));
  }
  const text = res.text + (res.truncated ? '\n\n… (3MB 이후 생략)' : '');
  if (/^(md|markdown|mdx)$/.test(ext)) {
    const baseUrl = r.url.replace(/\?.*$/, '').replace(/[^/]*$/, '');
    return h('iframe', { class: 'viewer-frame', sandbox: '', srcdoc: markdownDoc(text, baseUrl) });
  }
  if (/^(csv|tsv)$/.test(ext)) {
    const rows = parseCsv(text, ext === 'tsv' ? '\t' : ',');
    const [head, ...body] = rows;
    return h('table', { class: 'viewer-table' },
      h('thead', {}, h('tr', {}, (head || []).map((c) => h('th', {}, c)))),
      h('tbody', {}, body.map((r2) => h('tr', {}, r2.map((c) => h('td', { title: c }, c))))));
  }
  let shown = text;
  if (ext === 'json') {
    try {
      shown = JSON.stringify(JSON.parse(text), null, 2);
    } catch {}
  }
  return h('pre', { class: 'viewer-pre' }, shown);
}

async function showViewer(tab, r) {
  const body = h('div', { class: 'viewer-body' }, h('div', { class: 'viewer-note' }, '불러오는 중…'));
  const reload = async () => {
    try {
      const fresh = await deck.fetch({ hostId: tab.hostId, file: r.remotePath || r.localPath });
      Object.assign(r, fresh);
      body.replaceChildren(await renderViewerBody(r));
    } catch (err) {
      body.replaceChildren(h('div', { class: 'error' }, cleanErr(err)));
    }
  };
  const head = h('div', { class: 'viewer-head' },
    h('div', { class: 'viewer-title' },
      h('div', { class: 'vname' }, r.name),
      h('div', { class: 'vpath', title: r.remotePath || r.localPath },
        `${isRemote(tab) ? hostById(tab.hostId).name + ':' : ''}${r.remotePath || r.localPath} · ${fmtSize(r.size)}`)),
    h('div', { class: 'viewer-actions' },
      h('button', { class: 'btn btn-sm', onclick: reload }, '↻ 새로고침'),
      h('button', { class: 'btn btn-sm', onclick: () => deck.openExternal(r.localPath) }, '외부 앱으로 열기'),
      h('button', { class: 'btn btn-sm', onclick: () => deck.showInFolder(r.localPath) }, '폴더 열기'),
      h('button', {
        class: 'btn btn-sm',
        onclick: async () => {
          const saved = await deck.saveAs({ localPath: r.localPath, name: r.name });
          if (saved) toast(`저장했습니다: ${saved}`);
        },
      }, '다른 이름으로 저장'),
      h('button', { class: 'btn btn-sm', onclick: () => m.close() }, '닫기 (Esc)')));
  const m = openModal({ wide: true, raw: [head, body] });
  try {
    body.replaceChildren(await renderViewerBody(r));
  } catch (err) {
    body.replaceChildren(h('div', { class: 'error' }, cleanErr(err)));
  }
}

// ───────────────────────── modals / menus / toasts ─────────────────────────
function openModal({ title, body, actions = [], wide = false, raw = null, onCancel }) {
  const root = $('#modal-root');
  const back = h('div', { class: 'modal-back' });
  const box = h('div', { class: `modal${wide ? ' wide' : ''}` });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    back.remove();
    if (!document.querySelector('.modal-back')) activeTab()?.term.focus();
  };
  const cancel = () => {
    close();
    onCancel?.();
  };
  if (raw) box.append(...raw);
  else {
    box.append(h('div', { class: 'modal-head' }, title));
    box.append(h('div', { class: 'modal-body' }, body));
    box.append(
      h('div', { class: 'modal-foot' },
        actions.map((a) => h('button', { class: a.primary ? 'primary' : a.danger ? 'danger' : 'btn', onclick: a.onClick }, a.label)))
    );
  }
  back.append(box);
  back.addEventListener('mousedown', (e) => {
    if (e.target === back) back.dataset.down = '1';
  });
  back.addEventListener('mouseup', (e) => {
    if (e.target === back && back.dataset.down) cancel();
    delete back.dataset.down;
  });
  back.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && !e.isComposing && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      const primary = actions.find((a) => a.primary);
      if (primary) {
        e.preventDefault();
        primary.onClick();
      }
    }
  });
  root.append(back);
  setTimeout(() => (box.querySelector('input, select') || box.querySelector('button.primary') || box).focus?.(), 0);
  box.tabIndex = -1;
  return { close, el: box };
}

function confirmModal({ title, message, okLabel = '확인', danger = false }) {
  return new Promise((resolve) => {
    const m = openModal({
      title,
      body: h('div', { class: 'prompt-msg' }, message),
      onCancel: () => resolve(false),
      actions: [
        { label: '취소', onClick: () => (m.close(), resolve(false)) },
        { label: okLabel, primary: !danger, danger, onClick: () => (m.close(), resolve(true)) },
      ],
    });
    if (danger) setTimeout(() => m.el.querySelector('.danger')?.focus(), 0);
  });
}

function choiceModal({ title, message, choices }) {
  return new Promise((resolve) => {
    const done = (v) => (m.close(), resolve(v));
    const m = openModal({
      title,
      body: h('div', { class: 'prompt-msg' }, message),
      onCancel: () => resolve(null),
      actions: [
        { label: '취소', onClick: () => done(null) },
        ...choices.map((c) => ({ label: c.label, primary: c.primary, danger: c.danger, onClick: () => done(c.value) })),
      ],
    });
  });
}

function promptModal(req) {
  return new Promise((resolve) => {
    const input = req.input ? h('input', { type: req.input === 'password' ? 'password' : 'text', autocomplete: 'off' }) : null;
    const done = (v) => (m.close(), resolve(v));
    const m = openModal({
      title: req.title,
      body: h('div', {}, h('div', { class: 'prompt-msg' }, req.message || ''), input ? h('div', { class: 'field' }, input) : null),
      onCancel: () => resolve(null),
      actions: [
        { label: '취소', onClick: () => done(null) },
        { label: req.okLabel || '확인', primary: !req.danger, danger: req.danger, onClick: () => done(input ? input.value : true) },
      ],
    });
  });
}
deck.onPrompt(async (req) => deck.answerPrompt(req.rid, await promptModal(req)));

function showMenu(x, y, items) {
  const root = $('#menu-root');
  root.replaceChildren();
  const menu = h('div', { class: 'ctx-menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === '-') {
      menu.append(h('div', { class: 'ctx-sep' }));
      continue;
    }
    menu.append(
      h('button', {
        class: `ctx-item${it.danger ? ' danger-item' : ''}`,
        onclick: () => {
          root.replaceChildren();
          it.onClick();
        },
      }, h('span', {}, it.label), it.sc ? h('span', { class: 'sc' }, it.sc) : null)
    );
  }
  root.append(menu);
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
  const off = (e) => {
    if (!menu.contains(e.target)) {
      root.replaceChildren();
      removeEventListener('mousedown', off, true);
    }
  };
  setTimeout(() => addEventListener('mousedown', off, true), 0);
}

function toast(msg, { error = false, sticky = false, timeout = 3500, actions = [] } = {}) {
  const el = h('div', { class: `toast${error ? ' error' : ''}` },
    h('div', { class: 'tmsg' }, msg),
    actions.map((a) => h('button', { class: a.primary ? 'primary btn-sm' : 'btn btn-sm', onclick: a.onClick }, a.label)));
  $('#toasts').append(el);
  const close = () => el.remove();
  if (!sticky) setTimeout(close, error ? 7000 : timeout);
  return { close };
}

// ───────────────────────── new session ─────────────────────────
function programOptions(selected, { extras = true } = {}) {
  return [
    ...programs().map((p) => h('option', { value: p, selected: p === selected }, p)),
    h('option', { value: '__add' }, '＋ 다른 프로그램 추가…'),
    extras ? h('option', { value: '__shell', selected: selected === '__shell' }, '셸만 열기') : null,
    extras ? h('option', { value: '__custom', selected: selected === '__custom' }, '명령 직접 입력…') : null,
  ];
}

async function addProgramModal() {
  const v = await promptModal({
    title: '실행 프로그램 추가',
    message:
      'claude 대신 실행할 명령을 입력하세요.\n예: claude-glm, ccr code, npx @anthropic-ai/claude-code\n\n' +
      '로컬은 PowerShell 프로필의 함수와 별칭을,\n원격은 .bashrc의 별칭을 그대로 쓸 수 있습니다.',
    input: 'text',
    okLabel: '추가',
  });
  const p = (v || '').trim();
  if (!p) return null;
  if (!programs().includes(p)) {
    state.settings.programs = [...programs(), p];
    deck.setConfig({ settings: state.settings });
  }
  return p;
}

async function newSessionModal(preset = {}) {
  const cfg = await deck.getConfig();
  state.recentPaths = cfg.recentPaths || {};
  let hostId = preset.hostId || state.lastHostId || 'local';
  if (!state.hosts.find((x) => x.id === hostId)) hostId = 'local';

  const hostOptions = () => [
    ...state.hosts.map((x) =>
      h('option', { value: x.id, selected: x.id === hostId }, x.kind === 'local' ? `💻 로컬 (${x.detail})` : `🖥 ${x.name} · ${x.detail}`)),
    h('option', { value: '__add' }, '＋ 서버 추가…'),
  ];
  const hostSel = h('select', {}, hostOptions());
  const pathIn = h('input', { type: 'text', spellcheck: 'false', placeholder: '~ 또는 절대 경로' });
  const chips = h('div', { class: 'chips' });
  let lastProg = preset.program || state.lastProgram || programs()[0];
  const progSel = h('select', {}, programOptions(lastProg));
  const customIn = h('input', { type: 'text', spellcheck: 'false', placeholder: '예: npm run dev', style: 'margin-top:6px' });
  const modeSel = h('select', {}, MODES.map((x) => h('option', { value: x.flag }, x.label)));
  const argsIn = h('input', { type: 'text', spellcheck: 'false', placeholder: '예: --model opus   --dangerously-skip-permissions' });
  const nameIn = h('input', { type: 'text', placeholder: '비워두면 폴더 이름' });
  const favChk = h('input', { type: 'checkbox' });
  const keepChk = h('input', { type: 'checkbox', checked: state.lastKeep !== false });
  const keepRow = h('div', { class: 'field' },
    h('label', { class: 'check' }, keepChk, '세션 보존 (서버 tmux에서 실행해서, 창을 닫거나 연결이 끊겨도 계속 돌아감)'));
  const liveBox = h('div', { class: 'live-sessions' });
  let liveSeq = 0;
  const refreshLive = async () => {
    const seq = ++liveSeq;
    keepRow.hidden = hostId === 'local';
    liveBox.replaceChildren();
    if (hostId === 'local') return;
    let list = [];
    try {
      list = await deck.tmuxList(hostId);
    } catch {
      return;
    }
    if (seq !== liveSeq) return;
    const open = new Set(state.tabs.map((t) => t.tmux).filter(Boolean));
    list = list.filter((x) => !open.has(x.name));
    if (!list.length) return;
    const hostForLive = hostId;
    liveBox.append(
      h('label', {}, '이 서버에서 계속 실행 중인 세션 (눌러서 다시 붙기)'),
      h('div', { class: 'chips' },
        list.map((x) =>
          h('button', {
            class: 'chip live',
            title: (x.cwd || '') + (x.attached ? '\n지금 다른 곳에 연결되어 있음' : ''),
            onclick: () => {
              m.close();
              createTab({
                hostId: hostForLive,
                cwd: x.cwd || '~',
                command: programs()[0],
                tmux: x.name,
                name: x.name.replace(/^deck-/, '').replace(/-[a-z0-9]{4}$/, ''),
              });
            },
          }, '⏺ ' + x.name)))
    );
  };
  const agentFields = h('div', {},
    h('div', { class: 'field' }, h('label', {}, '대화'), modeSel),
    h('div', { class: 'field' }, h('label', {}, '추가 옵션 (선택)'), argsIn));
  const syncProgFields = () => {
    customIn.hidden = progSel.value !== '__custom';
    agentFields.hidden = progSel.value === '__custom' || progSel.value === '__shell';
  };
  syncProgFields();

  const fillPaths = () => {
    const recent = state.recentPaths[hostId] || [];
    pathIn.value = preset.cwd || recent[0] || '~';
    preset.cwd = null;
    refreshLive();
    chips.replaceChildren(...recent.slice(0, 8).map((p) => h('button', { class: 'chip', title: p, onclick: () => ((pathIn.value = p), pathIn.focus()) }, shortPath(p))));
  };
  fillPaths();
  hostSel.addEventListener('change', async () => {
    if (hostSel.value === '__add') {
      const added = await hostFormModal();
      state.hosts = await deck.hosts();
      hostId = added?.id || hostId;
      hostSel.replaceChildren(...hostOptions());
      hostSel.value = hostId;
    } else hostId = hostSel.value;
    fillPaths();
  });
  progSel.addEventListener('change', async () => {
    if (progSel.value === '__add') {
      const p = await addProgramModal();
      progSel.replaceChildren(...programOptions(p || lastProg));
    }
    lastProg = progSel.value;
    syncProgFields();
    if (!customIn.hidden) customIn.focus();
  });
  const browse = async () => {
    const picked = hostId === 'local' ? await deck.pickDir({ defaultPath: pathIn.value }) : await dirBrowserModal(hostId, pathIn.value);
    if (picked) pathIn.value = picked;
  };

  const launch = () => {
    const v = progSel.value;
    if (v === '__add') return;
    let command;
    let program = null;
    if (v === '__custom') command = customIn.value.trim();
    else if (v === '__shell') command = '';
    else {
      program = v;
      command = [v, modeSel.value, argsIn.value.trim()].filter(Boolean).join(' ');
      state.lastProgram = v;
    }
    const cwd = pathIn.value.trim() || '~';
    const name = nameIn.value.trim() || undefined;
    const tmux = hostId !== 'local' && keepChk.checked ? tmuxNameFor(cwd) : null;
    if (hostId !== 'local') state.lastKeep = keepChk.checked;
    state.lastHostId = hostId;
    m.close();
    const tab = createTab({ hostId, cwd, command, program, name, tmux });
    if (favChk.checked) addFavorite({ name: tab.name, hostId, cwd, command, program, keep: !!tmux });
  };

  const m = openModal({
    title: '새 세션',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', {}, '어디서'), hostSel),
      h('div', { class: 'field' }, h('label', {}, '폴더'),
        h('div', { class: 'row' }, h('div', { class: 'grow' }, pathIn), h('button', { class: 'btn', onclick: browse }, '찾아보기…')),
        chips, liveBox),
      h('div', { class: 'field' }, h('label', {}, '실행 프로그램'), progSel, customIn),
      agentFields,
      keepRow,
      h('div', { class: 'field' }, h('label', {}, '탭 이름'), nameIn),
      h('label', { class: 'check' }, favChk, '빠른 실행에 저장')),
    actions: [
      { label: '취소', onClick: () => m.close() },
      { label: '시작', primary: true, onClick: launch },
    ],
  });
  setTimeout(() => {
    pathIn.focus();
    pathIn.select();
  }, 0);
}

// Switch a tab to another program (e.g. claude → claude-glm), keeping its flags and args
function changeProgramModal(t) {
  const current = t.program || programs()[0];
  const sel = h('select', {}, programOptions(current, { extras: false }));
  sel.addEventListener('change', async () => {
    if (sel.value !== '__add') return;
    const p = await addProgramModal();
    sel.replaceChildren(...programOptions(p || current, { extras: false }));
  });
  const apply = (keepConversation) => {
    const program = sel.value;
    if (program === '__add') return;
    const rest = isAgent(t) ? t.command.slice(t.program.length) : '';
    t.program = program;
    t.command = program + rest;
    persistTabs();
    renderTabs();
    m.close();
    restartTab(t, keepConversation ? continueCommand(t) : freshCommand(t));
  };
  const m = openModal({
    title: `"${t.name}" 실행 프로그램 변경`,
    body: h('div', {},
      h('div', { class: 'field' }, h('label', {}, '프로그램'), sel),
      h('div', { class: 'prompt-msg' }, `지금: ${t.command || '(셸)'}`),
      h('div', { class: 'hint' },
        '바꾸면 이 탭의 세션을 다시 시작합니다. 같은 대화 기록을 쓰는 래퍼(claude-glm 등)라면 이어서 시작할 수 있고, ' +
        '별도 설정 폴더를 쓰는 프로그램이면 새 대화로 시작하세요.')),
    actions: [
      { label: '취소', onClick: () => m.close() },
      { label: '새 대화로 시작', onClick: () => apply(false) },
      { label: '바꾸고 이어서 시작', primary: true, onClick: () => apply(true) },
    ],
  });
}

function dirBrowserModal(hostId, start) {
  return new Promise((resolve) => {
    let cur = start || '~';
    const list = h('div', { class: 'dir-list' });
    const pathEl = h('input', { class: 'dir-path', spellcheck: false });
    const done = (v) => (m.close(), resolve(v));
    const m = openModal({
      title: `${hostById(hostId).name} · 폴더 선택`,
      body: h('div', {}, pathEl, list, h('div', { class: 'hint' }, '경로를 직접 입력하고 Enter를 눌러도 됩니다.')),
      onCancel: () => resolve(null),
      actions: [
        { label: '취소', onClick: () => done(null) },
        { label: '이 폴더 선택', primary: true, onClick: () => done(cur) },
      ],
    });
    const row = (label, full, icon = '📁') =>
      h('div', { class: `frow is-dir${label.startsWith('.') && label !== '..' ? ' dot-entry' : ''}`, onclick: () => load(full), ondblclick: () => done(full) },
        h('span', { class: 'ficon' }, icon), h('span', { class: 'fname' }, label));
    async function load(p) {
      list.replaceChildren(h('div', { class: 'muted pad' }, hostId === 'local' ? '불러오는 중…' : '서버에 연결하는 중…'));
      try {
        const r = await deck.list({ hostId, dir: p });
        cur = r.path;
        pathEl.value = cur;
        const dirs = r.entries.filter((e) => e.dir).sort((a, b) => a.name.startsWith('.') - b.name.startsWith('.'));
        list.replaceChildren(
          ...(r.parent ? [row('..', r.parent, '↑')] : []),
          ...dirs.map((e) => row(e.name, joinPath(r.path, e.name, r.sep)))
        );
      } catch (err) {
        list.replaceChildren(h('div', { class: 'error' }, cleanErr(err)));
      }
    }
    pathEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        load(pathEl.value);
      }
    });
    load(cur);
  });
}

// ───────────────────────── hosts & settings ─────────────────────────
function hostFormModal() {
  return new Promise((resolve) => {
    const f = {
      name: h('input', { type: 'text', placeholder: '예: prod-api' }),
      host: h('input', { type: 'text', placeholder: '예: 10.0.0.5 또는 api.example.com' }),
      port: h('input', { type: 'number', value: '22' }),
      user: h('input', { type: 'text', placeholder: '예: ubuntu' }),
      key: h('input', { type: 'text', placeholder: '비워두면 ~/.ssh 기본 키 → 비밀번호 순으로 시도' }),
    };
    const done = (v) => (m.close(), resolve(v));
    const m = openModal({
      title: '서버 추가',
      body: h('div', {},
        h('div', { class: 'field' }, h('label', {}, '이름'), f.name),
        h('div', { class: 'row' },
          h('div', { class: 'field grow' }, h('label', {}, '호스트'), f.host),
          h('div', { class: 'field', style: 'width:96px' }, h('label', {}, '포트'), f.port)),
        h('div', { class: 'field' }, h('label', {}, '사용자'), f.user),
        h('div', { class: 'field' }, h('label', {}, '개인 키 파일'),
          h('div', { class: 'row' }, h('div', { class: 'grow' }, f.key),
            h('button', { class: 'btn', onclick: async () => { const p = await deck.pickFile({}); if (p) f.key.value = p; } }, '찾아보기…'))),
        h('div', { class: 'hint' }, '~/.ssh/config 에 있는 서버는 자동으로 목록에 뜹니다. 비밀번호는 저장하지 않고 연결할 때마다 묻습니다.')),
      onCancel: () => resolve(null),
      actions: [
        { label: '취소', onClick: () => done(null) },
        {
          label: '추가',
          primary: true,
          onClick: async () => {
            if (!f.host.value.trim()) return f.host.focus();
            const added = await deck.addHost({
              name: f.name.value.trim(),
              host: f.host.value.trim(),
              port: f.port.value,
              user: f.user.value.trim(),
              identityFile: f.key.value.trim(),
            });
            done(added);
          },
        },
      ],
    });
  });
}

async function hostsModal() {
  const body = h('div', {});
  const render = () => {
    body.replaceChildren(
      ...state.hosts.filter((x) => x.kind === 'ssh').map((x) => {
        const status = h('span', { class: 'tag' }, x.custom ? '직접 추가' : 'ssh config');
        return h('div', { class: 'host-row' },
          h('span', {}, '🖥'),
          h('div', { class: 'grow' }, h('div', { class: 'hname' }, x.name), h('div', { class: 'hdetail' }, x.detail + (x.identityFile ? `  🔑 ${basename(x.identityFile)}` : ''))),
          status,
          h('button', {
            class: 'btn btn-sm',
            onclick: async () => {
              status.className = 'tag';
              status.textContent = '연결 중…';
              try {
                const home = await deck.testHost(x.id);
                status.className = 'tag ok';
                status.textContent = `연결됨 · ${home}`;
              } catch (err) {
                status.className = 'tag bad';
                status.textContent = '실패';
                toast(`${x.name}: ${cleanErr(err)}`, { error: true });
              }
            },
          }, '연결 테스트'),
          h('button', { class: 'btn btn-sm', onclick: () => { m.close(); newSessionModal({ hostId: x.id }); } }, '세션 열기'),
          x.custom
            ? h('button', {
                class: 'danger btn-sm',
                onclick: async () => {
                  await deck.removeHost(x.id);
                  state.hosts = await deck.hosts();
                  render();
                },
              }, '삭제')
            : null);
      }),
      h('div', { class: 'hint' }, '~/.ssh/config 의 Host 항목을 자동으로 읽습니다 (HostName, User, Port, IdentityFile).')
    );
  };
  state.hosts = await deck.hosts();
  render();
  const m = openModal({
    title: '서버 관리',
    body,
    actions: [
      {
        label: '＋ 서버 추가',
        onClick: async () => {
          await hostFormModal();
          state.hosts = await deck.hosts();
          render();
        },
      },
      { label: '닫기', primary: true, onClick: () => m.close() },
    ],
  });
}

function settingsModal() {
  const s = state.settings;
  const font = h('input', { type: 'number', value: String(s.fontSize), min: '9', max: '28' });
  const shellSel = h('select', {},
    [['auto', '자동 (PowerShell 7 있으면 우선)'], ['pwsh', 'PowerShell 7 (pwsh)'], ['powershell', 'Windows PowerShell 5.1'], ['cmd', '명령 프롬프트 (cmd)']]
      .map(([v, l]) => h('option', { value: v, selected: s.localShell === v }, l)));
  const progs = h('textarea', { rows: 4, spellcheck: 'false' });
  progs.value = programs().join('\n');
  const notify = h('input', { type: 'checkbox', checked: s.notify });
  const m = openModal({
    title: '설정',
    body: h('div', {},
      h('div', { class: 'field' }, h('label', {}, '글꼴 크기'), font, h('div', { class: 'hint' }, 'Ctrl + = / Ctrl + - 로도 조절됩니다.')),
      h('div', { class: 'field' }, h('label', {}, '로컬 세션 셸'), shellSel, h('div', { class: 'hint' }, '다음에 여는 로컬 세션부터 적용됩니다.')),
      h('div', { class: 'field' }, h('label', {}, '실행 프로그램'), progs,
        h('div', { class: 'hint' }, '한 줄에 하나씩 적습니다. 새 세션 창과 탭 메뉴의 "실행 프로그램 변경"에 나옵니다. 예: claude, claude-glm')),
      h('label', { class: 'check' }, notify, '창이 백그라운드일 때 Claude 응답 완료를 Windows 알림으로 받기')),
    actions: [
      { label: '취소', onClick: () => m.close() },
      {
        label: '저장',
        primary: true,
        onClick: () => {
          const list = progs.value.split('\n').map((x) => x.trim()).filter(Boolean);
          state.settings = { ...s, localShell: shellSel.value, notify: notify.checked, programs: list.length ? list : ['claude'] };
          setFontSize(parseInt(font.value, 10) || 14);
          m.close();
        },
      },
    ],
  });
}

$('#btn-new').addEventListener('click', () => newSessionModal());
$('#btn-new-empty').addEventListener('click', () => newSessionModal());
$('#btn-hosts').addEventListener('click', hostsModal);
$('#btn-settings').addEventListener('click', settingsModal);

// ───────────────────────── boot ─────────────────────────
(async function init() {
  const [hosts, cfg] = await Promise.all([deck.hosts(), deck.getConfig()]);
  state.hosts = hosts;
  state.settings = { ...state.settings, ...(cfg.settings || {}) };
  if (!state.settings.programs?.length) state.settings.programs = ['claude'];
  state.favorites = cfg.favorites || [];
  state.recentPaths = cfg.recentPaths || {};
  for (const t of cfg.tabs || []) createTab({ ...t, paused: true }, { activate: false });
  const first = tabById(cfg.activeTab) || state.tabs[0];
  if (first) setActive(first.id);
  renderTabs();
  renderFavorites();
  updateTopbar();
})();
