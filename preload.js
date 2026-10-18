const { ipcRenderer } = require('electron');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CHANNEL_TOGGLE = 'gemini-find:toggle';
const CHANNEL_STEP = 'gemini-find:step';
const CHANNEL_RESET = 'gemini-find:reset';

const HIGHLIGHT_ALL = 'gemini-find-all';
const HIGHLIGHT_ACTIVE = 'gemini-find-active';
const HIGHLIGHT_STYLE_ID = 'gemini-find-highlight-style';

const HOST_ID = 'gemini-find-bar-host';

// Single character inserted into the text stream at block/message boundaries.
// Queries come from a one-line input, so they can never contain it, which
// prevents a match from ever spanning two messages or paragraphs.
const SENTINEL = '\u0000';

const DEBOUNCE_SEARCH_MS = 140;
const DEBOUNCE_MUTATION_MS = 350;
// After an explicit jump we keep re-centering the active match when content
// shifts (infinite scroll loads older messages above the viewport), but only
// for a short settle window so we never fight the user's own scrolling.
const JUMP_SETTLE_MS = 5000;
const MAX_HIGHLIGHT_RANGES = 2000;
const MAX_MATCHES = 20000;
const PREFILL_MAX_LENGTH = 80;

const BLOCKISH_DISPLAYS = new Set([
  'inline',
  'contents',
  'inline-block',
  'inline-flex',
  'inline-grid',
  'ruby',
]);

const MUTATION_OPTIONS = { childList: true, subtree: true, characterData: true };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  visible: false,
  matchCase: false,
  matches: [], // DOM Range[] for the current query, in document order
  activeIdx: -1,
  scope: null, // conversation element the search runs over
  chunks: null, // { node | null, text }[] pieces of the text stream
  chunkStarts: null, // stream offset where each chunk begins
  dirty: false, // page mutated since the last stream build
  pendingJumpUntil: 0, // see JUMP_SETTLE_MS
  restoreFocus: null, // element focused before the bar was opened
  searchTimer: null,
  observer: null, // watches the conversation for content changes
  themeObserver: null, // watches <html>/<body> for theme changes
};

// Lazily created toolbar (see ensureUI).
let ui = null;

function logError(err) {
  console.error('[gemini-desktop:find]', err);
}

function guard(fn) {
  return (...args) => {
    try {
      fn(...args);
    } catch (err) {
      logError(err);
    }
  };
}

function supportsHighlights() {
  return (
    typeof CSS !== 'undefined' &&
    typeof CSS.highlights !== 'undefined' &&
    typeof Highlight !== 'undefined'
  );
}

// ---------------------------------------------------------------------------
// Toolbar UI (shadow DOM)
// ---------------------------------------------------------------------------

const FIND_STYLES = `
:host([data-theme='dark']) {
  --bg: #2b2b30;
  --fg: #e8e8ec;
  --muted: #97979f;
  --border: rgba(255, 255, 255, 0.16);
  --hover: rgba(255, 255, 255, 0.1);
  --checked: rgba(255, 255, 255, 0.18);
  --none: #ff7b7b;
  --focus: #6aa5ff;
}
:host([data-theme='light']) {
  --bg: #ffffff;
  --fg: #1b1b1f;
  --muted: #6f6f78;
  --border: rgba(0, 0, 0, 0.16);
  --hover: rgba(0, 0, 0, 0.07);
  --checked: rgba(0, 0, 0, 0.12);
  --none: #d93025;
  --focus: #1a73e8;
}
:host {
  color-scheme: light dark;
}
.bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 6px;
  min-height: 36px;
  padding: 4px 6px 4px 10px;
  background: var(--bg);
  color: var(--fg);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.32);
  font: 13px/1.4 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  user-select: none;
}
input {
  box-sizing: border-box;
  width: 224px;
  padding: 4px 0;
  border: 0;
  outline: none;
  background: transparent;
  color: inherit;
  font: inherit;
  -webkit-user-select: text;
  user-select: text;
}
input::placeholder {
  color: var(--muted);
}
.counter {
  min-width: 46px;
  padding: 0 4px;
  color: var(--muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.counter.is-empty {
  visibility: hidden;
}
.counter.is-none {
  color: var(--none);
}
.sep {
  width: 1px;
  align-self: stretch;
  margin: 2px 1px;
  background: var(--border);
}
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  margin: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--fg);
  font: inherit;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
}
.btn:hover {
  background: var(--hover);
}
.btn:focus-visible {
  outline: 2px solid var(--focus);
  outline-offset: 1px;
}
.btn.is-on {
  background: var(--checked);
}
.btn.is-case {
  width: 30px;
  letter-spacing: 0.3px;
}
.btn svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
`;

const SVG_NS = 'http://www.w3.org/2000/svg';

// NOTE: The bar is built with createElement/textContent instead of
// innerHTML. Gemini's page enables Trusted Types
// (`require-trusted-types-for 'script'`), which blocks innerHTML
// assignments and would silently break UI creation.
function svgIcon(pathD) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(SVG_NS, 'path');
  p.setAttribute('d', pathD);
  svg.appendChild(p);
  return svg;
}

function makeButton({ action, className, title, ariaLabel, text, pathD }) {
  const btn = document.createElement('button');
  btn.type = 'button';
  if (action) btn.setAttribute('data-action', action);
  if (className) btn.className = className;
  if (title) btn.title = title;
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  if (text) btn.textContent = text;
  if (pathD) btn.appendChild(svgIcon(pathD));
  return btn;
}

function ensureUI() {
  if (ui) return ui;
  if (!document.body) {
    // Defer creation until body exists
    throw new Error('document.body not ready');
  }

  const host = document.createElement('div');
  host.id = HOST_ID;
  // Inline styles so no page rule can affect the host's geometry.
  host.style.cssText =
    'all: initial; position: fixed; top: 50px; right: 14px;' +
    'z-index: 2147483647; display: none;';

  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = FIND_STYLES;
  shadow.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'bar';
  bar.setAttribute('role', 'search');

  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Find in conversation';
  input.spellcheck = false;
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('autocapitalize', 'off');
  input.setAttribute('aria-label', 'Find in conversation');

  const counter = document.createElement('span');
  counter.className = 'counter is-empty';
  counter.setAttribute('aria-live', 'polite');
  counter.setAttribute('aria-atomic', 'true');

  const sep = document.createElement('span');
  sep.className = 'sep';
  sep.setAttribute('aria-hidden', 'true');

  const caseBtn = makeButton({
    className: 'btn is-case',
    title: 'Match case',
    ariaLabel: 'Match case',
    text: 'Aa',
  });
  caseBtn.setAttribute('aria-pressed', 'false');

  const prevBtn = makeButton({
    action: 'prev',
    className: 'btn',
    title: 'Previous match (Shift+Enter)',
    ariaLabel: 'Previous match',
    pathD: 'M3 10l5-5 5 5',
  });
  const nextBtn = makeButton({
    action: 'next',
    className: 'btn',
    title: 'Next match (Enter)',
    ariaLabel: 'Next match',
    pathD: 'M3 6l5 5 5-5',
  });
  const closeBtn = makeButton({
    action: 'close',
    className: 'btn',
    title: 'Close (Esc)',
    ariaLabel: 'Close',
    pathD: 'M4 4l8 8M12 4l-8 8',
  });

  bar.appendChild(input);
  bar.appendChild(counter);
  bar.appendChild(sep);
  bar.appendChild(caseBtn);
  bar.appendChild(prevBtn);
  bar.appendChild(nextBtn);
  bar.appendChild(closeBtn);
  shadow.appendChild(bar);

  // Keep focus in the query field when clicking the bar
  bar.addEventListener('mousedown', (e) => {
    if (e.composedPath().includes(input)) return;
    e.preventDefault();
  });

  input.addEventListener(
    'input',
    guard(() => scheduleSearch(DEBOUNCE_SEARCH_MS, { jump: true, fresh: true }))
  );

  caseBtn.addEventListener('click', guard(toggleMatchCase));
  prevBtn.addEventListener('click', guard(() => step(false)));
  nextBtn.addEventListener('click', guard(() => step(true)));
  closeBtn.addEventListener('click', guard(closeBar));

  document.body.appendChild(host);

  ui = { host, bar, input, counter, caseBtn };
  return ui;
}

// ---------------------------------------------------------------------------
// Theme detection
// ---------------------------------------------------------------------------

function applyTheme() {
  if (!ui) return;
  let isDark = false;
  const html = document.documentElement;
  const body = document.body;

  const htmlTheme = html && html.getAttribute('data-theme');
  if (htmlTheme) {
    isDark = htmlTheme.toLowerCase() === 'dark';
  }
  if (!isDark && body) {
    const cls = body.classList;
    if (cls.contains('dark') || cls.contains('dark-theme') || cls.contains('theme-dark')) {
      isDark = true;
    }
  }
  if (!isDark) {
    try {
      isDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch (e) {
      isDark = false;
    }
  }

  ui.host.setAttribute('data-theme', isDark ? 'dark' : 'light');
}

function startThemeObserver() {
  stopThemeObserver();
  if (!window.MutationObserver) return;
  const html = document.documentElement;
  const body = document.body;
  state.themeObserver = new MutationObserver(guard(applyTheme));
  if (html) {
    state.themeObserver.observe(html, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  }
  if (body) {
    state.themeObserver.observe(body, { attributes: true, attributeFilter: ['class'] });
  }
  try {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      if (mq.addEventListener) {
        mq.addEventListener('change', guard(applyTheme));
      }
    }
  } catch (e) {
    // ignore
  }
}

function stopThemeObserver() {
  if (state.themeObserver) {
    try {
      state.themeObserver.disconnect();
    } catch (e) {
      // ignore
    }
    state.themeObserver = null;
  }
}

// ---------------------------------------------------------------------------
// Scope discovery
// ---------------------------------------------------------------------------

function findConversationScope() {
  const candidates = [
    '[role="log"]',
    'main [data-message-author-role] article, main [data-message-author-role], main [role="article"]',
    'div[role="main"] [data-message-id], [data-message-id]',
    'c-wiz[data-conversation-id] [data-message-id]',
    'div.chat-history',
    'div.conversation-container',
    'main',
  ];

  for (let i = 0; i < candidates.length; i++) {
    try {
      const el = document.querySelector(candidates[i]);
      if (el && el.childNodes.length > 0) {
        // Prefer elements that actually contain message-like nodes
        const hasMessages = el.querySelector('[data-message-id], [role="user"], [role="assistant"]');
        if (hasMessages || el.scrollHeight > 100) {
          return el;
        }
      }
    } catch (e) {
      // skip
    }
  }

  return null;
}

function ensureScope() {
  if (state.scope && document.body.contains(state.scope)) {
    return state.scope;
  }
  state.scope = findConversationScope();
  return state.scope;
}

// ---------------------------------------------------------------------------
// Highlight styles
// ---------------------------------------------------------------------------

function ensureHighlightStyles() {
  if (!supportsHighlights()) return;
  let style = document.getElementById(HIGHLIGHT_STYLE_ID);
  if (!style) {
    style = document.createElement('style');
    style.id = HIGHLIGHT_STYLE_ID;
    document.head.appendChild(style);
  }
  // Theme-aware highlight colors
  const isDark = ui && ui.host.getAttribute('data-theme') === 'dark';
  style.textContent = `
::highlight(${HIGHLIGHT_ALL}) {
  background: ${isDark ? 'rgba(255, 213, 0, 0.35)' : 'rgba(255, 213, 0, 0.45)'};
  color: inherit;
}
::highlight(${HIGHLIGHT_ACTIVE}) {
  background: ${isDark ? 'rgba(255, 140, 0, 0.75)' : 'rgba(255, 140, 0, 0.9)'};
  color: inherit;
}
`;
}

// ---------------------------------------------------------------------------
// Stream building
// ---------------------------------------------------------------------------

function isElement(node) {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isText(node) {
  return node.nodeType === Node.TEXT_NODE;
}

function isNonTextNode(node) {
  if (isElement(node)) {
    const tag = node.tagName.toLowerCase();
    return tag === 'script' || tag === 'style' || tag === 'svg' || tag === 'noscript';
  }
  return false;
}

function isHidden(node) {
  if (!isElement(node)) return false;
  try {
    const style = window.getComputedStyle(node);
    if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) === 0) {
      return true;
    }
  } catch (e) {
    // ignore
  }
  return node.hasAttribute('hidden') || node.getAttribute('aria-hidden') === 'true';
}

function shouldIncludeNode(node) {
  if (isNonTextNode(node)) return false;
  if (isHidden(node)) return false;
  if (isText(node)) {
    return true;
  }
  if (isElement(node)) {
    const style = window.getComputedStyle(node);
    const disp = style.display;
    if (disp === 'none') return false;
    if (!BLOCKISH_DISPLAYS.has(disp)) {
      // For block elements, their text is included; we just need to traverse children.
      // Don't skip traversing.
    }
  }
  return true;
}

function isBlockishElement(node) {
  if (!isElement(node)) return false;
  try {
    const style = window.getComputedStyle(node);
    const disp = style.display;
    return disp !== 'inline' && disp !== 'contents' && !BLOCKISH_DISPLAYS.has(disp);
  } catch (e) {
    return false;
  }
}

function buildChunks(scope) {
  const chunks = [];
  const chunkStarts = [];
  let streamLen = 0;

  function walk(node) {
    if (!node) return;
    if (isNonTextNode(node)) return;
    if (isHidden(node)) return;

    if (isText(node)) {
      const text = node.nodeValue;
      if (text && text.length > 0) {
        chunkStarts.push(streamLen);
        chunks.push({ node: node, text: text });
        streamLen += text.length;
      }
      return;
    }

    if (isElement(node)) {
      const tag = node.tagName.toLowerCase();
      if (tag === 'br') {
        chunkStarts.push(streamLen);
        chunks.push({ node: null, text: '\n' });
        streamLen += 1;
        return;
      }

      const isBlock = isBlockishElement(node);
      const childNodes = node.childNodes;
      for (let i = 0; i < childNodes.length; i++) {
        walk(childNodes[i]);
      }
      if (isBlock && chunks.length > 0) {
        // Add sentinel at block boundary
        const last = chunks[chunks.length - 1];
        if (last.text && last.text[last.text.length - 1] !== SENTINEL) {
          chunkStarts.push(streamLen);
          chunks.push({ node: null, text: SENTINEL });
          streamLen += 1;
        }
      }
      return;
    }

    const childNodes = node.childNodes;
    if (childNodes && childNodes.length) {
      for (let i = 0; i < childNodes.length; i++) {
        walk(childNodes[i]);
      }
    }
  }

  walk(scope);
  state.chunks = chunks;
  state.chunkStarts = chunkStarts;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function computeMatches(query) {
  const matches = [];
  if (!query || !supportsHighlights()) return matches;
  if (!state.scope || !state.chunks || state.chunks.length === 0) return matches;

  const flags = state.matchCase ? 'g' : 'gi';
  let re;
  try {
    re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags);
  } catch (e) {
    return matches;
  }

  let totalMatches = 0;
  for (let i = 0; i < state.chunks.length && totalMatches < MAX_MATCHES; i++) {
    const chunk = state.chunks[i];
    if (!chunk.node || !chunk.text) continue;
    const text = chunk.text;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = m.index + m[0].length;
      try {
        const range = document.createRange();
        range.setStart(chunk.node, start);
        range.setEnd(chunk.node, end);
        matches.push(range);
        totalMatches++;
        if (matches.length > MAX_HIGHLIGHT_RANGES) {
          // Still count total, but we won't highlight beyond limit? keep pushing ranges up to MAX_MATCHES,
          // but CSS highlights can handle many; cap to be safe
        }
      } catch (e) {
        // skip invalid range
      }
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  }

  // Cap to avoid excessive highlighting
  if (matches.length > MAX_HIGHLIGHT_RANGES) {
    return matches.slice(0, MAX_HIGHLIGHT_RANGES);
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Highlighting & scrolling
// ---------------------------------------------------------------------------

function clearHighlights() {
  if (!supportsHighlights()) return;
  try {
    CSS.highlights.delete(HIGHLIGHT_ALL);
  } catch (e) {
    // ignore
  }
  try {
    CSS.highlights.delete(HIGHLIGHT_ACTIVE);
  } catch (e) {
    // ignore
  }
}

function renderHighlights() {
  clearHighlights();
  if (!supportsHighlights()) return;
  if (!state.matches || state.matches.length === 0) return;

  const allRanges = state.matches.slice();
  if (allRanges.length === 0) return;

  try {
    CSS.highlights.set(HIGHLIGHT_ALL, new Highlight(...allRanges));
  } catch (e) {
    logError(e);
  }

  if (state.activeIdx >= 0 && state.activeIdx < state.matches.length) {
    const activeRange = state.matches[state.activeIdx];
    try {
      CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(activeRange));
    } catch (e) {
      logError(e);
    }
  }
  ensureHighlightStyles();
}

function findScrollable(el, horizontal) {
  let node = el;
  while (node && node !== document.body && node !== document.documentElement) {
    const style = window.getComputedStyle(node);
    const overflow = horizontal ? style.overflowX : style.overflowY;
    if (overflow === 'auto' || overflow === 'scroll') {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function jumpToActive() {
  if (state.activeIdx < 0 || !state.matches[state.activeIdx]) return;
  const range = state.matches[state.activeIdx];
  let rect;
  try {
    rect = range.getBoundingClientRect();
  } catch (e) {
    return;
  }
  const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement;
  const scroller = startEl ? findScrollable(startEl, false) : null;
  const margin = 80;

  if (scroller) {
    const sRect = scroller.getBoundingClientRect();
    const top = scroller.scrollTop + rect.top - sRect.top - margin;
    scroller.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  } else {
    const top = window.pageYOffset + rect.top - margin;
    window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }
}

function pickNearestIdx() {
  const n = state.matches.length;
  if (!n) return -1;
  const viewportCenter = window.innerHeight / 2;
  let bestIdx = 0;
  let bestDist = Infinity;
  for (let i = 0; i < n; i++) {
    const r = state.matches[i];
    let rect;
    try {
      rect = r.getBoundingClientRect();
    } catch (e) {
      continue;
    }
    const dist = Math.abs((rect.top + rect.bottom) / 2 - viewportCenter);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = i;
      if (bestDist < 40) break;
    }
  }
  return bestIdx;
}

// ---------------------------------------------------------------------------
// Search orchestration
// ---------------------------------------------------------------------------

function scheduleSearch(delay, opts) {
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
  if (delay > 0) {
    state.searchTimer = setTimeout(guard(() => rebuild(opts)), delay);
  } else {
    rebuild(opts);
  }
}

function markJumpIntent() {
  state.pendingJumpUntil = Date.now() + JUMP_SETTLE_MS;
}

function clearJumpIntent() {
  state.pendingJumpUntil = 0;
}

function isMatchInView(range) {
  if (!range) return false;
  let rect;
  try {
    rect = range.getBoundingClientRect();
  } catch (e) {
    return false;
  }
  if (!rect || (rect.width === 0 && rect.height === 0 && rect.top === 0)) {
    return false;
  }
  const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer
    : range.startContainer.parentElement;
  const scroller = startEl ? findScrollable(startEl, false) : null;
  const view = scroller
    ? scroller.getBoundingClientRect()
    : { top: 0, bottom: window.innerHeight };
  const margin = 6;
  return rect.top >= view.top + margin && rect.bottom <= view.bottom - margin;
}

function rebuild({ jump = false, fresh = false } = {}) {
  if (!ui) return;
  if (jump) markJumpIntent();
  if (state.dirty || !state.chunks) {
    ensureScope();
    state.dirty = false;
    if (state.scope) {
      buildChunks(state.scope);
    } else {
      state.chunks = null;
      state.chunkStarts = null;
    }
  }

  const query = ui.input.value;
  state.matches = computeMatches(query);

  if (!state.matches.length) {
    state.activeIdx = -1;
  } else if (fresh) {
    state.activeIdx = pickNearestIdx();
  } else if (state.activeIdx < 0) {
    state.activeIdx = 0;
  } else if (state.activeIdx >= state.matches.length) {
    state.activeIdx = state.matches.length - 1;
  }

  renderHighlights();
  updateCounter();
  if (state.activeIdx >= 0) {
    if (jump) {
      jumpToActive();
    } else if (
      Date.now() < state.pendingJumpUntil &&
      !isMatchInView(state.matches[state.activeIdx])
    ) {
      jumpToActive();
    }
  }
}

function updateCounter() {
  if (!ui) return;
  const total = state.matches.length;
  const active = state.activeIdx >= 0 ? state.activeIdx + 1 : 0;
  if (total === 0) {
    ui.counter.textContent = '';
    ui.counter.classList.add('is-empty');
    ui.counter.classList.remove('is-none');
    return;
  }
  ui.counter.textContent = active + '/' + total;
  ui.counter.classList.remove('is-empty');
  if (active === 0) {
    ui.counter.classList.add('is-none');
  } else {
    ui.counter.classList.remove('is-none');
  }
}

function renderActive({ jump }) {
  renderHighlights();
  updateCounter();
  if (jump) jumpToActive();
}

function step(forward) {
  if (!state.visible || !ui) return;
  if (state.dirty) rebuild({ jump: false, fresh: false });
  const n = state.matches.length;
  if (!n) return;
  if (state.activeIdx < 0) {
    state.activeIdx = forward ? 0 : n - 1;
  } else {
    state.activeIdx = (state.activeIdx + (forward ? 1 : -1) + n) % n;
  }
  markJumpIntent();
  renderActive({ jump: true });
}

function toggleMatchCase() {
  if (!ui) return;
  state.matchCase = !state.matchCase;
  ui.caseBtn.setAttribute('aria-pressed', String(state.matchCase));
  ui.caseBtn.classList.toggle('is-on', state.matchCase);
  state.dirty = true;
  scheduleSearch(0, { jump: true, fresh: true });
}

function captureRestoreFocus() {
  const el = document.activeElement;
  if (!el || el === document.body || inFindHost(el)) return null;
  return el;
}

function inFindHost(el) {
  if (!ui) return false;
  try {
    return ui.host.contains(el);
  } catch (e) {
    return false;
  }
}

function show() {
  try {
    ensureUI();
  } catch (e) {
    console.warn('[gemini-find] ensureUI failed, retrying on DOMContentLoaded:', e);
    document.addEventListener('DOMContentLoaded', guard(show), { once: true });
    return;
  }
  ensureHighlightStyles();

  const firstOpen = !state.visible;
  if (firstOpen) {
    if (!ui.input.value) {
      try {
        const sel = String(window.getSelection() || '');
        if (sel.length > 0 && sel.length <= PREFILL_MAX_LENGTH) {
          ui.input.value = sel;
        }
      } catch (e) {
        // ignore
      }
    }
    state.restoreFocus = captureRestoreFocus();
    state.visible = true;
    ui.host.style.display = 'block';
    applyTheme();
    startThemeObserver();
  }

  ensureScope();
  attachMutationObserver();
  ui.input.focus();
  ui.input.select();
  rebuild({ jump: true, fresh: true });
}

function closeBar() {
  if (state.searchTimer) {
    clearTimeout(state.searchTimer);
    state.searchTimer = null;
  }
  stopMutationObserver();
  stopThemeObserver();
  clearHighlights();
  if (ui) ui.host.style.display = 'none';

  if (state.visible && state.restoreFocus) {
    try {
      state.restoreFocus.focus({ preventScroll: true });
    } catch (e) {
      // ignore
    }
  }
  state.visible = false;
  state.restoreFocus = null;
  state.dirty = false;
  state.chunks = null;
  state.chunkStarts = null;
  clearJumpIntent();
}

function toggle() {
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', guard(toggle), { once: true });
    return;
  }
  if (!state.visible) {
    show();
    return;
  }
  if (ui && ui.host.contains(document.activeElement)) {
    ui.input.select();
  } else if (ui) {
    ui.input.focus();
    ui.input.select();
  } else {
    show();
  }
}

function reset() {
  closeBar();
}

// ---------------------------------------------------------------------------
// Mutation observer
// ---------------------------------------------------------------------------

let mutationTimer = null;

function onMutation() {
  state.dirty = true;
  if (mutationTimer) {
    clearTimeout(mutationTimer);
    mutationTimer = null;
  }
  mutationTimer = setTimeout(guard(() => {
    if (state.visible) {
      rebuild({ jump: false, fresh: false });
    }
  }), DEBOUNCE_MUTATION_MS);
}

function attachMutationObserver() {
  stopMutationObserver();
  if (!window.MutationObserver) return;
  ensureScope();
  if (!state.scope) return;
  state.observer = new MutationObserver(guard(onMutation));
  state.observer.observe(state.scope, MUTATION_OPTIONS);
}

function stopMutationObserver() {
  if (state.observer) {
    try {
      state.observer.disconnect();
    } catch (e) {
      // ignore
    }
    state.observer = null;
  }
  if (mutationTimer) {
    clearTimeout(mutationTimer);
    mutationTimer = null;
  }
}

// ---------------------------------------------------------------------------
// Keyboard handling inside bar
// ---------------------------------------------------------------------------

window.addEventListener(
  'keydown',
  (e) => {
    if (!state.visible || !ui) return;
    try {
      if (!e.composedPath().includes(ui.host)) return;
    } catch (err) {
      return;
    }
    if (e.key === 'Enter') {
      if (e.isComposing) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      step(!e.shiftKey);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      closeBar();
    }
  },
  true
);

// Stop re-centering on user scroll
window.addEventListener('wheel', clearJumpIntent, { passive: true });
window.addEventListener('touchmove', clearJumpIntent, { passive: true });

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

ipcRenderer.on(CHANNEL_TOGGLE, guard(() => {
  toggle();
}));
ipcRenderer.on(CHANNEL_STEP, (_event, payload) => {
  guard(() => step(Boolean(!payload || payload.forward !== false)))();
});
ipcRenderer.on(CHANNEL_RESET, guard(reset));

// Also handle Ctrl+F at document level (capture) in case main doesn't intercept
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && !e.altKey && e.key && e.key.toLowerCase() === 'f') {
    const target = e.target;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    toggle();
  }
}, true);
