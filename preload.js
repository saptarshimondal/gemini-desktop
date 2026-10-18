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

// Elements that identify a chat message. Gemini uses user-query/model-response/
// message-content; other apps use data-message-* attributes.
const MESSAGE_SELECTORS = [
  'user-query',
  'model-response',
  '[data-message-id]',
  '[data-message-author-role]',
  'article',
].join(', ');

// Nearest ancestor (below body) whose overflow makes it the message scroller.
function findScrollContainer(el) {
  let node = el;
  while (node && node !== document.body && node !== document.documentElement) {
    try {
      const st = window.getComputedStyle(node);
      if (st.overflowY === 'auto' || st.overflowY === 'scroll') return node;
    } catch (e) {
      // ignore
    }
    node = node.parentElement;
  }
  return null;
}

// Resolve the element the search runs over. Rules, in order:
//  1. With messages on the page, pick the scroll container (or smallest common
//     ancestor) that holds ALL of them -- never a single message, never the
//     sidebar/composer that live outside the message list.
//  2. Empty conversation: the main column, found via the composer's ancestor
//     chain (skips the left sidebar).
//  3. Last resort: <main>, then body.
function findConversationScope() {
  let messages = [];
  try {
    messages = Array.prototype.slice.call(
      document.querySelectorAll(MESSAGE_SELECTORS)
    ).filter((m) => !inFindHost(m));
  } catch (e) {
    messages = [];
  }

  if (messages.length > 0) {
    const first = messages[0];
    const last = messages[messages.length - 1];

    // 1a. The scroll container that contains every message.
    try {
      const scroller = findScrollContainer(last);
      if (
        scroller &&
        !inFindHost(scroller) &&
        scroller.contains(first) &&
        scroller.contains(last)
      ) {
        const inside = scroller.querySelectorAll(MESSAGE_SELECTORS).length;
        if (inside >= messages.length) return scroller;
      }
    } catch (e) {
      // fall through
    }

    // 1b. Smallest common ancestor of the first and last message.
    try {
      let node = first.parentElement;
      while (node && node !== document.body && node !== document.documentElement) {
        if (node.contains(last) && !inFindHost(node)) return node;
        node = node.parentElement;
      }
      if (first.parentElement) return first.parentElement;
    } catch (e) {
      // fall through
    }
  }

  // 2. Empty conversation: main column via the composer's ancestor chain.
  try {
    const composer = document.querySelector(
      'textarea, [contenteditable]:not([contenteditable="false"])'
    );
    if (composer) {
      const minLeft = Math.max(40, window.innerWidth * 0.08);
      let el = composer.parentElement;
      let chosen = null;
      while (el && el !== document.body && el !== document.documentElement) {
        const r = el.getBoundingClientRect();
        if (r.left > minLeft && r.width > window.innerWidth * 0.45) chosen = el;
        el = el.parentElement;
      }
      if (chosen) return chosen;
    }
  } catch (e) {
    // fall through
  }

  // 3. Last resort.
  return document.querySelector('main') || document.body;
}

// Returns true when the scope had to be (re)resolved. On a change the text
// stream is stale and the mutation observer is watching a detached node, so
// callers must rebuild and re-attach.
function ensureScope() {
  if (state.scope && document.body.contains(state.scope)) {
    return false;
  }
  state.scope = findConversationScope();
  state.dirty = true;
  return true;
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
//
// The conversation is flattened into a single string with a position map so a
// query can match text spanning adjacent inline nodes (e.g. markdown emphasis
// or Angular-split text), while a NUL sentinel at every block boundary
// prevents matches from ever spanning two messages/paragraphs.
// ---------------------------------------------------------------------------

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function acceptTextNode(node) {
  const el = node.parentElement;
  if (!el) return false;
  if (inFindHost(el)) return false;
  const tag = el.nodeName;
  if (
    tag === 'SCRIPT' ||
    tag === 'STYLE' ||
    tag === 'NOSCRIPT' ||
    tag === 'TEMPLATE' ||
    tag === 'TEXTAREA' ||
    tag === 'INPUT' ||
    tag === 'OPTION'
  ) {
    return false;
  }
  if (el.closest && el.closest('svg')) return false;
  // Never search the message composer (or any other editable draft).
  const editable = el.closest('[contenteditable]');
  if (editable && editable.getAttribute('contenteditable') !== 'false') {
    return false;
  }
  if (el.closest('[aria-hidden="true"]')) return false;
  if (typeof el.checkVisibility === 'function') {
    // NOTE: contentVisibilityAuto is deliberately NOT requested. Gemini
    // virtualizes off-screen conversation turns with content-visibility:auto;
    // their text is real conversation content and must stay searchable.
    const hidden = !el.checkVisibility({
      opacityProperty: true,
      visibilityProperty: true,
      checkOpacity: true,
      checkVisibilityCSS: true,
    });
    if (hidden) return false;
  }
  return true;
}

function makeDisplayGetter(cache) {
  return (el) => {
    let d = cache.get(el);
    if (d === undefined) {
      try {
        d = window.getComputedStyle(el).display;
      } catch (e) {
        d = 'block';
      }
      cache.set(el, d);
    }
    return d;
  };
}

// True when a block-level box separates prevEl from nextEl in document order.
function hasBlockBoundary(prevEl, nextEl, root, getDisplay) {
  const pathFrom = (el) => {
    const out = [];
    let cur = el;
    while (cur) {
      out.push(cur);
      if (cur === root) break;
      cur = cur.parentElement;
    }
    return out;
  };
  const a = pathFrom(prevEl);
  const b = pathFrom(nextEl);

  let common = null;
  let ia = -1;
  for (let i = 0; i < a.length; i++) {
    if (a[i].contains(nextEl)) {
      common = a[i];
      ia = i;
      break;
    }
  }
  if (!common) return true; // unrelated trees -> be safe, separate them

  const ib = b.indexOf(common);
  if (ib === -1) return true;

  for (let i = 0; i < ia; i++) {
    if (!BLOCKISH_DISPLAYS.has(getDisplay(a[i]))) return true;
  }
  for (let i = 0; i < ib; i++) {
    if (!BLOCKISH_DISPLAYS.has(getDisplay(b[i]))) return true;
  }
  return false;
}

function buildChunks(scope) {
  const chunks = [];
  const starts = [];
  const displayCache = new Map();
  const getDisplay = makeDisplayGetter(displayCache);
  let streamLen = 0;
  let prevParent = null;

  let walker;
  try {
    walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.data && acceptTextNode(node)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT,
    });
  } catch (e) {
    state.chunks = [];
    state.chunkStarts = [];
    return;
  }

  let node;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (prevParent && hasBlockBoundary(prevParent, parent, scope, getDisplay)) {
      starts.push(streamLen);
      chunks.push({ node: null, text: SENTINEL });
      streamLen += SENTINEL.length;
    }
    starts.push(streamLen);
    chunks.push({ node: node, text: node.data });
    streamLen += node.data.length;
    prevParent = parent;
  }

  state.chunks = chunks;
  state.chunkStarts = starts;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

// Map a stream offset to { node, offset } inside the text node that owns it.
function locate(offset, preferEnd) {
  const starts = state.chunkStarts;
  const chunks = state.chunks;
  if (!chunks.length) return null;

  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }

  // Landed on a sentinel (only possible for an end offset sitting right
  // before a block boundary): resolve to the adjacent real text node.
  if (!chunks[lo].node) {
    if (preferEnd) {
      while (lo > 0 && !chunks[lo].node) lo--;
      if (!chunks[lo].node) return null;
      return { node: chunks[lo].node, offset: chunks[lo].text.length };
    }
    while (lo < chunks.length - 1 && !chunks[lo].node) lo++;
    if (!chunks[lo].node) return null;
    return { node: chunks[lo].node, offset: 0 };
  }

  return { node: chunks[lo].node, offset: offset - starts[lo] };
}

function makeRange(startOffset, endOffset) {
  const s = locate(startOffset, false);
  const e = locate(endOffset, true);
  if (!s || !e) return null;
  try {
    const range = document.createRange();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  } catch (err) {
    return null; // nodes detached between mutations
  }
}

function computeMatches(query) {
  const matches = [];
  if (!query || !state.chunks || state.chunks.length === 0) return matches;

  const stream = state.chunks.map((c) => c.text).join('');
  let re;
  try {
    re = new RegExp(
      escapeRegExp(query),
      state.matchCase ? 'g' : 'gi'
    );
  } catch (e) {
    return matches;
  }

  let m;
  while ((m = re.exec(stream)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    const range = makeRange(m.index, m.index + m[0].length);
    if (range) matches.push(range);
    if (matches.length >= MAX_MATCHES) break;
    if (re.lastIndex === m.index) re.lastIndex++;
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
    // Require real scrollability in this axis: CSS computes overflow-y to
    // "auto" on any element with overflow-x: auto (e.g. Gemini's code
    // blocks), which would otherwise be picked as the scroller even though
    // it can never scroll vertically.
    const hasOverflow = horizontal
      ? node.scrollWidth > node.clientWidth + 1
      : node.scrollHeight > node.clientHeight + 1;
    if ((overflow === 'auto' || overflow === 'scroll') && hasOverflow) {
      return node;
    }
    node = node.parentElement;
  }
  return null;
}

function centerOn(rect, startEl, behavior) {
  const scroller = startEl ? findScrollable(startEl, false) : null;
  const margin = 80;
  const smooth = behavior === 'smooth';

  if (scroller) {
    const sRect = scroller.getBoundingClientRect();
    const top = scroller.scrollTop + rect.top - sRect.top - margin;
    scroller.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  } else {
    const top = window.pageYOffset + rect.top - margin;
    window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
  }
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

  // Gemini virtualizes off-screen conversation turns with
  // content-visibility:auto: matches inside a skipped turn have no boxes, so
  // their rect is all zeros and there is nothing to center on. Scroll the
  // turn's container (which keeps a placeholder box) into view first; the
  // browser then renders its content and the real rect becomes measurable on
  // the next frames.
  const zeroRect = !rect || (rect.top === 0 && rect.left === 0 && rect.width === 0 && rect.height === 0);
  if (zeroRect && startEl) {
    let container = null;
    if (startEl.closest) {
      container =
        startEl.closest('.conversation-container') ||
        startEl.closest('model-response') ||
        startEl.closest('user-query') ||
        null;
    }
    if (!container) {
      // Fall back to the nearest ancestor that still has a box.
      let el = startEl;
      while (el && el !== document.body) {
        const r = el.getBoundingClientRect();
        if (r && (r.width > 0 || r.height > 0)) {
          container = el;
          break;
        }
        el = el.parentElement;
      }
    }
    if (!container) return;
    try {
      container.scrollIntoView({ block: 'center', behavior: 'auto' });
    } catch (e) {
      return;
    }
  } else {
    // Initial centering is instant: smooth scrolling races with the list
    // re-layout below and ends up stale (the follow-up passes would fight it).
    centerOn(rect, startEl, 'auto');
  }

  // Follow-up correction chain. Virtualized lists keep re-laying-out while
  // skipped turns between the old position and the target unskip and take
  // their real size, so the initial scroll target goes stale almost
  // immediately. Re-measure and correct in small instant steps until the
  // match is centered; the deadline and the jump token bound the work, and
  // a user scroll or step cancels it via clearJumpIntent()/jumpToActive().
  const jumpToken = state.jumpToken = (state.jumpToken || 0) + 1;
  // Generous budget: Gemini's infinite-scroller pins the scroll position
  // while it lazily loads older history (triggered by scrolling up), so the
  // chain may have to wait out the pin before it can converge. The chain is
  // cheap (one rect + one scrollTo per pass) and cancels itself on the next
  // user scroll, step, close or navigation.
  const deadline = Date.now() + 20000;
  const correct = (attempt) => {
    if (jumpToken !== state.jumpToken) return; // user stepped / scrolled away
    if (state.activeIdx < 0 || !state.matches[state.activeIdx]) return;
    const cur = state.matches[state.activeIdx];
    let r2;
    try {
      r2 = cur.getBoundingClientRect();
    } catch (e) {
      return;
    }
    if (!r2 || (r2.top === 0 && r2.left === 0 && r2.width === 0 && r2.height === 0)) {
      return; // not rendered (yet) -- the container scroll above should prevent this
    }
    const startEl2 =
      cur.startContainer.nodeType === Node.ELEMENT_NODE
        ? cur.startContainer
        : cur.startContainer.parentElement;
    const scroller = startEl2 ? findScrollable(startEl2, false) : null;
    const sRect = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, height: window.innerHeight };
    const delta = r2.top - (sRect.top + sRect.height / 2);
    if (Math.abs(delta) < 48) return; // centered -- done
    if (attempt > 0 && Date.now() > deadline) return; // out of budget
    const target = (scroller ? scroller.scrollTop : window.pageYOffset) + delta;
    try {
      if (scroller) scroller.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
      else window.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
    } catch (e) {
      return;
    }
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setTimeout(() => correct(attempt + 1), 120));
    });
  };
  requestAnimationFrame(() => {
    requestAnimationFrame(() => setTimeout(() => correct(0), 40));
  });
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
  // Abort any in-flight jump correction passes: the user has taken over.
  state.jumpToken = (state.jumpToken || 0) + 1;
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
    const scopeChanged = ensureScope();
    if (scopeChanged && state.visible) {
      // The old observer was watching a detached element; re-attach to the new scope.
      attachMutationObserver();
    }
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
    const hasQuery = ui.input.value.trim().length > 0;
    if (hasQuery) {
      ui.counter.textContent = 'No results';
      ui.counter.classList.remove('is-empty');
      ui.counter.classList.add('is-none');
    } else {
      ui.counter.textContent = '';
      ui.counter.classList.add('is-empty');
      ui.counter.classList.remove('is-none');
    }
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
