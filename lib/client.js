/**
 * dsh-conversation-toc — browser half.
 *
 * A pure-DOM (vanilla JS, no React) conversation outline for the dsh web GUI.
 * The chat transcript renders every message as a row carrying stable
 * `data-chat-anchor-key` / `data-chat-flow-kind` attributes inside a
 * `[data-chat-flow]` list, scrolled by a `[data-conversation-scroll]` port.
 * This plugin scans those rows, renders a floating outline (目录) with a
 * role badge + text snippet per record, and scrolls the transcript to the
 * clicked message. It rebuilds itself as messages stream in or sessions
 * switch (MutationObserver), and highlights the entry nearest the top of the
 * viewport (scroll spy).
 *
 * Failure policy: every DOM / runtime wiring failure is logged, never thrown —
 * the web shell fails the whole boot when a plugin apply throws.
 */

window.__ModuleLoader__.load({
  id: 'dsh-conversation-toc',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const inject = [];

const NS = 'dsh-conversation-toc';

/** Single-instance claim (dedup across hot-reload / duplicate injection). */
const MOUNTED = Symbol.for('dsh-conversation-toc.mounted');
function claim() {
  if (globalThis[MOUNTED]) return false;
  globalThis[MOUNTED] = true;
  return true;
}

/** Chat-flow node kinds → TOC role. Unknown kinds fall back to "other". */
const KIND_META = {
  user: { role: 'user', zh: '你', en: 'You' },
  steering: { role: 'user', zh: '你', en: 'You' },
  assistant: { role: 'assistant', zh: '助手', en: 'AI' },
  'tool-result': { role: 'tool', zh: '工具', en: 'Tool' },
  command: { role: 'tool', zh: '命令', en: 'Cmd' },
  context: { role: 'context', zh: '上下文', en: 'Ctx' },
  'model-retry': { role: 'other', zh: '重试', en: 'Retry' },
  'turn-error': { role: 'other', zh: '错误', en: 'Err' },
  'turn-max-tokens': { role: 'other', zh: '超限', en: 'Cap' },
  compaction: { role: 'other', zh: '压缩', en: 'Compact' },
  unknown: { role: 'other', zh: '其他', en: 'Other' },
};

const MAX_SNIPPET = 72;

/** Language mirroring: the shell owns <html lang>. */
let zh = true;
function syncLang() {
  zh = (document.documentElement.lang || '').toLowerCase().startsWith('zh');
}
function t(key) {
  const d = zh
    ? { title: '问题目录', empty: '暂无问题', toggle: '问题目录', close: '关闭', folded: '（已折叠）', loading: '正在加载历史…', loadMore: '加载更早的问题' }
    : { title: 'Questions', empty: 'No questions yet', toggle: 'Questions', close: 'Close', folded: '(folded)', loading: 'Loading history…', loadMore: 'Load earlier questions' };
  return d[key] || key;
}
function labelOf(kind) {
  const meta = KIND_META[kind];
  if (meta === undefined) return zh ? '其他' : 'Other';
  return zh ? meta.zh : meta.en;
}

/** Collapse a message row's text into a one-line preview. */
function snippetOf(row) {
  const text = (row.textContent || '').replace(/\s+/g, ' ').trim();
  if (text === '') return '';
  return text.length > MAX_SNIPPET ? `${text.slice(0, MAX_SNIPPET)}…` : text;
}

/** Resolve a stable anchor key to its live transcript row. */
function findRowByKey(key) {
  const list = document.querySelector('[data-chat-flow]');
  if (list === null) return null;
  for (const row of list.querySelectorAll('[data-chat-anchor-key]')) {
    if (row.dataset.chatAnchorKey === key) return row;
  }
  return null;
}

/** Scroll the conversation scrollport so `row` sits near the top.
 * Uses an instant jump (no `behavior:'smooth'`): smooth scrolling is async and
 * gets cancelled by the DSH paging re-anchor. A single rAF re-assert beats any
 * late re-anchor without a long timer ladder (which would trigger DSH's
 * scroll handler — a full-row forced-reflow pass — many times and stall clicks). */
function scrollToRow(row) {
  const scrollport = row.closest('[data-conversation-scroll]');
  if (scrollport === null) {
    row.scrollIntoView({ block: 'start' });
    return;
  }
  const applyScroll = () => {
    if (!row.isConnected) return;
    const top =
      row.getBoundingClientRect().top -
      scrollport.getBoundingClientRect().top +
      scrollport.scrollTop;
    const target = Math.max(0, top - 12);
    if (Math.abs(scrollport.scrollTop - target) <= 1) return;
    scrollport.scrollTop = target;
  };
  applyScroll();
  requestAnimationFrame(applyScroll);
}

/**
 * Best-effort: page in older history so questions folded behind the DSH
 * "load older" boundary enter the DOM and show up in the outline. The
 * conversation view already anchors scroll position on each load, so the
 * user's reading position stays put. Self-terminating and capped.
 */
let loadingOlderActive = false;
let stopAutoLoad = false;
let pagingActive = false;
let onPagingStart = null;
let onPagingDone = null;

/** End the paging phase and rebuild the outline once against the final DOM. */
function finishPaging() {
  loadingOlderActive = false;
  pagingActive = false;
  if (onPagingDone !== null) {
    try {
      onPagingDone();
    } catch (error) {
      console.error(`[${NS}] paging rebuild failed:`, error);
    }
  }
}

/** Run in the browser's idle slot so user clicks are never starved by paging. */
function idle(fn) {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(fn, { timeout: 1500 });
  } else {
    setTimeout(fn, 250);
  }
}

/** Find the "load older" button — the only button in the flow that is not
 * inside a transcript row. */
function findLoadOlderButton(flow) {
  for (const candidate of flow.querySelectorAll('button')) {
    if (candidate.closest('[data-chat-anchor-key]') !== null) continue;
    return candidate;
  }
  return null;
}

/**
 * Page backward (idle-scheduled) until the row for `key` re-enters the DOM,
 * then call `onFound(row)`. Loads only as far as the target — not to the bottom —
 * so a short history resolves in a page or two. Loading state (spinner + click
 * lock) is driven by pagingActive / onPagingStart / onPagingDone.
 */
function loadUntil(key, onFound) {
  if (loadingOlderActive) {
    if (onFound !== null) onFound(findRowByKey(key));
    return;
  }
  loadingOlderActive = true;
  stopAutoLoad = false;
  pagingActive = true;
  if (onPagingStart !== null) {
    try {
      onPagingStart();
    } catch (error) {
      console.error(`[${NS}] paging start failed:`, error);
    }
  }
  const step = () => {
    if (stopAutoLoad) {
      finishPaging();
      if (onFound !== null) onFound(null);
      return;
    }
    const row = findRowByKey(key);
    if (row !== null) {
      finishPaging();
      if (onFound !== null) onFound(row);
      return;
    }
    const flow = document.querySelector('[data-chat-flow]');
    if (flow === null) {
      finishPaging();
      if (onFound !== null) onFound(null);
      return;
    }
    const button = findLoadOlderButton(flow);
    if (button === null) {
      finishPaging();
      if (onFound !== null) onFound(null);
      return;
    }
    if (button.disabled) {
      // Still loading the previous page; retry shortly.
      idle(step);
      return;
    }
    button.click();
    idle(step);
  };
  step();
}

/** Halt any in-progress paging (used when the panel closes). */
function stopAutoLoadOlder() {
  stopAutoLoad = true;
  finishPaging();
}

// ---------- Full question list via the session wire API ----------
// DSH folds older history out of the DOM, so scanning `[data-chat-flow]` only
// sees the visible window. To show EVERY question (like chat.deepseek.com's
// right-hand outline) we read the durable event log through the session API
// instead — no paging, no DOM churn. Keys follow the conversation layer's rule:
// context.key = `<kind.length>:<kind><id>` for the "input-message" definition
// (id = event.data.id), which is exactly what `data-chat-anchor-key` holds.
const INPUT_MESSAGE_KIND = "input-message";
const USER_KEY_PREFIX = INPUT_MESSAGE_KIND.length + ":" + INPUT_MESSAGE_KIND; // "13:input-message"

/** Flatten a message content block array into one trimmed text line. */
function textOfContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block !== null && block !== undefined && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Read every user question of a session from the wire history (ascending seq).
 * Uses the Session's own `history` verb so subagent sessions (which route to
 * `subagents.history`) are handled identically to plain sessions. */
async function fetchAllQuestions(session) {
  const all = [];
  let beforeSeq;
  let hasMore = true;
  for (let page = 0; page < 200 && hasMore; page++) {
    const payload = { maxMessages: 50 };
    if (beforeSeq !== undefined) payload.beforeSeq = beforeSeq;
    let rpc;
    try {
      rpc = await session.history(payload);
    } catch (error) {
      console.error(`[${NS}] history fetch failed:`, error);
      break;
    }
    const result = rpc && rpc.result;
    if (!result || !result.ok) break;
    const events = result.value && result.value.events;
    if (!Array.isArray(events) || events.length === 0) break;
    all.unshift(...events); // earlier pages prepend, keeping the list ascending
    hasMore = result.value ? result.value.hasMore === true : false;
    beforeSeq = events[0] && events[0].event ? events[0].event.seq : undefined;
    if (beforeSeq === undefined) break;
  }
  const questions = [];
  for (const entry of all) {
    const event = entry && entry.event;
    if (!event || event.type !== "user/message") continue;
    const data = event.data;
    if (!data || !data.source || data.source.kind !== "user") continue;
    questions.push({
      key: USER_KEY_PREFIX + String(data.id),
      seq: event.seq,
      snippet: textOfContent(data.content),
    });
  }
  return questions;
}

const CSS = `
[data-dsh-conversation-toc-toggle] {
  position: fixed;
  right: 24px;
  top: 84px;
  z-index: 998;
  width: 32px;
  height: 32px;
  border-radius: 10px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e6eb);
  background: var(--dsw-alias-bg-elevated, #ffffff);
  color: var(--dsw-alias-label-secondary, #646a73);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--dsw-shadow-lv2, 0 4px 14px rgba(0,0,0,0.08));
  padding: 0;
}
[data-dsh-conversation-toc-toggle]:hover {
  color: var(--dsw-alias-label-primary, #1f2329);
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
}
[data-dsh-conversation-toc-toggle] .dctoc-count {
  position: absolute;
  top: -5px;
  right: -6px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 7px;
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  color: #fff;
  font-size: 10px;
  line-height: 14px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

[data-dsh-conversation-toc-panel] {
  position: fixed;
  right: 24px;
  top: 124px;
  z-index: 999;
  width: 320px;
  max-height: min(60vh, 560px);
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e6eb);
  background: var(--dsw-alias-bg-elevated, #ffffff);
  box-shadow: var(--dsw-shadow-lv3, 0 12px 32px rgba(0,0,0,0.16));
  overflow: hidden;
}
[data-dsh-conversation-toc-panel][hidden] { display: none; }

[data-dsh-conversation-toc-panel] .dctoc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e6eb);
}
[data-dsh-conversation-toc-panel] .dctoc-title {
  color: var(--dsw-alias-label-primary, #1f2329);
  font-size: 14px;
  font-weight: 500;
  line-height: 20px;
}
[data-dsh-conversation-toc-panel] .dctoc-close {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--dsw-alias-label-secondary, #646a73);
  cursor: pointer;
  border-radius: 6px;
  display: grid;
  place-items: center;
  font-size: 16px;
  line-height: 1;
}
[data-dsh-conversation-toc-panel] .dctoc-close:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
}

[data-dsh-conversation-toc-panel] .dctoc-loading {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: var(--dsw-alias-label-tertiary, #8a9099);
  font-size: 12px;
  line-height: 18px;
}
[data-dsh-conversation-toc-panel] .dctoc-loading[hidden] { display: none; }
[data-dsh-conversation-toc-panel] .dctoc-spinner {
  flex: none;
  width: 13px;
  height: 13px;
  border: 2px solid var(--dsw-alias-border-l2, #e5e6eb);
  border-top-color: var(--dsw-static-deepseek-500, #4d6bfe);
  border-radius: 50%;
  animation: dctoc-spin 0.8s linear infinite;
}
@keyframes dctoc-spin {
  to { transform: rotate(360deg); }
}

[data-dsh-conversation-toc-panel] .dctoc-list {
  overflow-y: auto;
  min-height: 0;
  padding: 6px;
}
[data-dsh-conversation-toc-panel] .dctoc-entry {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 8px;
  border-radius: 8px;
  cursor: pointer;
  user-select: none;
}
[data-dsh-conversation-toc-panel] .dctoc-entry:hover {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.04));
}
[data-dsh-conversation-toc-panel] .dctoc-entry.dctoc-active {
  background: var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05));
  box-shadow: inset 2px 0 0 var(--dsw-static-deepseek-500, #4d6bfe);
}
[data-dsh-conversation-toc-panel] .dctoc-badge {
  flex: none;
  min-width: 34px;
  text-align: center;
  border-radius: 6px;
  padding: 1px 5px;
  font-size: 11px;
  line-height: 16px;
  font-weight: 500;
  user-select: none;
}
[data-dsh-conversation-toc-panel] .dctoc-badge[data-role="user"] {
  background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 14%, transparent);
  color: var(--dsw-alias-label-primary-bluish, #4d6bfe);
}
[data-dsh-conversation-toc-panel] .dctoc-badge[data-role="assistant"] {
  background: color-mix(in srgb, var(--dsw-alias-state-business-primary, #16a34a) 14%, transparent);
  color: var(--dsw-alias-state-business-primary, #16a34a);
}
[data-dsh-conversation-toc-panel] .dctoc-badge[data-role="tool"] {
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8a9099) 16%, transparent);
  color: var(--dsw-alias-label-secondary, #646a73);
}
[data-dsh-conversation-toc-panel] .dctoc-badge[data-role="context"],
[data-dsh-conversation-toc-panel] .dctoc-badge[data-role="other"] {
  background: color-mix(in srgb, var(--dsw-alias-label-tertiary, #8a9099) 16%, transparent);
  color: var(--dsw-alias-label-tertiary, #8a9099);
}
[data-dsh-conversation-toc-panel] .dctoc-snippet {
  flex: 1;
  min-width: 0;
  color: var(--dsw-alias-label-secondary, #646a73);
  font-size: 12px;
  line-height: 18px;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  word-break: break-word;
}
[data-dsh-conversation-toc-panel] .dctoc-empty {
  padding: 16px 12px;
  color: var(--dsw-alias-label-tertiary, #8a9099);
  font-size: 13px;
  line-height: 20px;
  text-align: center;
}
`;

/** Inject the plugin stylesheet exactly once per page. */
function injectStyles() {
  const tag = document.querySelector(`style[data-plugin-css="${NS}"]`);
  if (tag !== null) return;
  const style = document.createElement('style');
  style.dataset.pluginCss = NS;
  style.textContent = CSS;
  document.head.appendChild(style);
}

/** One floating-outline UI: toggle button + panel, DOM-level, self-contained. */
function mountUi(ctx) {
  const disposers = [];
  syncLang();

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.setAttribute('data-dsh-conversation-toc-toggle', '');
  toggle.setAttribute('aria-label', t('toggle'));
  toggle.innerHTML =
    '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>' +
    '<span class="dctoc-count" hidden></span>';

  const panel = document.createElement('div');
  panel.setAttribute('data-dsh-conversation-toc-panel', '');
  panel.hidden = true;
  panel.innerHTML =
    '<div class="dctoc-header">' +
      `<span class="dctoc-title">${t('title')}</span>` +
      `<button type="button" class="dctoc-close" aria-label="${t('close')}">×</button>` +
    '</div>' +
    `<div class="dctoc-loading" hidden><span class="dctoc-spinner"></span><span>${t('loading')}</span></div>` +
    '<div class="dctoc-list"></div>' +
    `<div class="dctoc-empty">${t('empty')}</div>`;

  document.body.appendChild(toggle);
  document.body.appendChild(panel);

  const listEl = panel.querySelector('.dctoc-list');
  const emptyEl = panel.querySelector('.dctoc-empty');
  const countEl = toggle.querySelector('.dctoc-count');
  const loadingEl = panel.querySelector('.dctoc-loading');

  let open = false;
  const setOpen = (next) => {
    open = next;
    panel.hidden = !open;
    if (open) {
      render();
      requestAnimationFrame(() => {
        if (activeKey !== undefined) scrollActiveIntoView(activeKey);
      });
    } else if (loadingOlderActive) {
      stopAutoLoadOlder();
    }
  };

  const onToggleClick = () => setOpen(!open);
  const onCloseClick = () => setOpen(false);
  const onKeydown = (event) => {
    if (event.key === 'Escape' && open) setOpen(false);
  };
  const onMousedown = (event) => {
    if (!open) return;
    const target = event.target;
    if (target instanceof Node && !panel.contains(target) && !toggle.contains(target)) {
      setOpen(false);
    }
  };
  toggle.addEventListener('click', onToggleClick);
  const closeBtn = panel.querySelector('.dctoc-close');
  closeBtn.addEventListener('click', onCloseClick);
  document.addEventListener('keydown', onKeydown);
  document.addEventListener('mousedown', onMousedown);
  disposers.push(() => {
    toggle.removeEventListener('click', onToggleClick);
    closeBtn.removeEventListener('click', onCloseClick);
    document.removeEventListener('keydown', onKeydown);
    document.removeEventListener('mousedown', onMousedown);
  });

  // Event delegation for entry clicks: resolve key → live row → scroll.
  listEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target === null) return;
    const entry = target.closest('.dctoc-entry');
    if (entry === null) return;
    const key = entry.dataset.key;
    if (key === undefined) return;
    if (pagingActive) return; // locked while older history is loading
    const row = findRowByKey(key);
    if (row !== null) {
      scrollToRow(row);
      markActive(key);
      return;
    }
    // Target row is outside the DOM (folded behind the "load older" boundary):
    // page backward until it re-enters, then jump. Spinner + lock show meanwhile.
    loadUntil(key, (found) => {
      if (found !== null) {
        scrollToRow(found);
        markActive(key);
      }
    });
  });

  // Rebuild the outline from the session's full question list.
  let entries = [];
  let activeKey = undefined;

  // Cached full question list, keyed by session id (avoids refetching on every
  // streaming mutation; the DOM merge below covers in-flight new messages).
  let cachedSessionId;
  let cachedQuestions = null;

  async function render() {
    try {
      let sessions;
      try {
        sessions = ctx.get('sessions');
      } catch (error) {
        sessions = undefined;
      }
      const currentId =
        sessions && sessions.list && typeof sessions.list.getSnapshot === 'function'
          ? sessions.list.getSnapshot().current
          : undefined;
      if (currentId === undefined) {
        entries = [];
        listEl.replaceChildren();
        emptyEl.style.display = '';
        countEl.hidden = true;
        activeKey = undefined;
        return;
      }
      if (cachedSessionId !== undefined && cachedSessionId !== currentId) {
        activeKey = undefined; // session switched; reset the highlight
      }

      let questions;
      if (cachedSessionId === currentId && cachedQuestions !== null) {
        questions = cachedQuestions.slice();
      } else {
        const session =
          sessions.manager && typeof sessions.manager.get === 'function'
            ? sessions.manager.get(currentId)
            : undefined;
        if (!session || typeof session.history !== 'function') {
          questions = [];
        } else {
          questions = await fetchAllQuestions(session);
          cachedSessionId = currentId;
          cachedQuestions = questions;
        }
      }

      // Merge user rows live in the DOM but not yet durable (a streaming prompt
      // the host hasn't persisted to history yet).
      const list = document.querySelector('[data-chat-flow]');
      if (list !== null) {
        const known = new Set(questions.map((q) => q.key));
        for (const row of list.querySelectorAll('[data-chat-anchor-key]')) {
          if ((row.dataset.chatFlowKind || '') !== 'user') continue;
          const key = row.dataset.chatAnchorKey;
          if (known.has(key)) continue;
          questions.push({ key, seq: Number.MAX_SAFE_INTEGER, snippet: snippetOf(row) });
        }
      }

      entries = questions;

      if (entries.length === 0) {
        listEl.replaceChildren();
        emptyEl.style.display = '';
        countEl.hidden = true;
        activeKey = undefined;
        return;
      }

      emptyEl.style.display = 'none';
      countEl.textContent = String(entries.length);
      countEl.hidden = false;

      const frag = document.createDocumentFragment();
      entries.forEach((entry, index) => {
        const item = document.createElement('div');
        item.className = 'dctoc-entry';
        item.dataset.key = entry.key;
        const snippet = entry.snippet === '' ? t('folded') : entry.snippet;
        item.innerHTML =
          `<span class="dctoc-badge" data-role="user">${index + 1}</span>` +
          `<span class="dctoc-snippet">${escapeHtml(snippet)}</span>`;
        frag.appendChild(item);
      });
      listEl.replaceChildren(frag);
      if (activeKey !== undefined) markActive(activeKey);
    } catch (error) {
      console.error(`[${NS}] render failed:`, error);
    }
  }

  // Wire the paging start/completion hooks used by loadUntil.
  onPagingStart = () => {
    loadingEl.hidden = false;
  };
  onPagingDone = () => {
    loadingEl.hidden = true;
    try {
      render();
    } catch (error) {
      console.error(`[${NS}] render failed:`, error);
    }
  };

  const roleOf = (kind) => (KIND_META[kind] || {}).role || 'other';

  const scrollActiveIntoView = (key) => {
    // Don't auto-scroll the outline list while paging: the re-anchoring + rebuild
    // would make the scrollbar jitter as entries keep getting prepended.
    if (pagingActive) return;
    for (const item of listEl.querySelectorAll('.dctoc-entry')) {
      if (item.dataset.key !== key) continue;
      const itemTop = item.getBoundingClientRect().top;
      const listTop = listEl.getBoundingClientRect().top;
      const rel = itemTop - listTop + listEl.scrollTop;
      listEl.scrollTop = Math.max(0, rel - (listEl.clientHeight - item.clientHeight) / 2);
      break;
    }
  };

  const markActive = (key) => {
    activeKey = key;
    for (const item of listEl.querySelectorAll('.dctoc-entry')) {
      item.classList.toggle('dctoc-active', item.dataset.key === key);
    }
    if (key !== undefined) scrollActiveIntoView(key);
  };

  // Scroll spy: highlight the entry whose row sits at / above the top edge.
  // Reacts to transcript / window scrolls only — scrolls of the outline's own
  // list are ignored, otherwise re-centering the active entry would fight the
  // user's drag / wheel and make the panel scrollbar jitter in place.
  let spyTimer = 0;
  const updateScrollSpy = (event) => {
    if (event !== undefined) {
      const target = event.target;
      if (target instanceof Node && panel.contains(target)) return;
    }
    if (spyTimer !== 0) return;
    spyTimer = requestAnimationFrame(() => {
      spyTimer = 0;
      const scrollport = document.querySelector('[data-conversation-scroll]');
      if (scrollport === null) return;
      const topEdge = scrollport.getBoundingClientRect().top + 40;
      const list = document.querySelector('[data-chat-flow]');
      if (list === null) return;
      let current = undefined;
      for (const row of list.querySelectorAll('[data-chat-anchor-key]')) {
        if ((row.dataset.chatFlowKind || '') !== 'user') continue;
        if (row.getBoundingClientRect().top <= topEdge) current = row.dataset.chatAnchorKey;
      }
      if (current !== undefined) markActive(current);
    });
  };
  document.addEventListener('scroll', updateScrollSpy, true);

  // Rebuild on transcript changes (streaming, session switch, view change).
  // Debounced so a long stream collapses into a few rebuilds per second.
  let rebuildTimer = undefined;
  const scheduleRebuild = () => {
    if (rebuildTimer !== undefined) return;
    rebuildTimer = setTimeout(() => {
      rebuildTimer = undefined;
      if (pagingActive) return; // paging rebuilds once via finishPaging
      try {
        render();
      } catch (error) {
        console.error(`[${NS}] rebuild failed:`, error);
      }
    }, 120);
  };

  const observer = new MutationObserver((mutations) => {
    // Ignore our own panel/toggle mutations so rebuilding the outline doesn't
    // re-trigger the observer in a feedback loop.
    let relevant = false;
    for (const mutation of mutations) {
      const target = mutation.target;
      if (target instanceof Node && (panel.contains(target) || toggle.contains(target))) continue;
      relevant = true;
    }
    if (!relevant) return;
    scheduleRebuild();
    // Skip scroll-spy while paging: each of the 50 committed rows would trigger
    // a full-row getBoundingClientRect pass (forced reflow) and starve clicks.
    if (open && !pagingActive) updateScrollSpy();
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });

  render();

  return () => {
    onPagingStart = null;
    onPagingDone = null;
    observer.disconnect();
    document.removeEventListener('scroll', updateScrollSpy, true);
    for (const dispose of disposers) {
      try {
        dispose();
      } catch (error) {
        console.error(`[${NS}] dispose failed:`, error);
      }
    }
    toggle.remove();
    panel.remove();
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Client plugin body.
 * @param ctx - client root context (only `ctx.effect` is used, for cleanup).
 */
function apply(ctx) {
  if (!claim()) return;

  ctx.effect(
    () => () => {
      globalThis[MOUNTED] = false;
    },
    `${NS}: claim`,
  );

  let disposeUi;
  try {
    injectStyles();
    disposeUi = mountUi(ctx);
  } catch (error) {
    console.error(`[${NS}] mount failed:`, error);
  }

  ctx.effect(
    () => () => {
      if (disposeUi !== undefined) {
        try {
          disposeUi();
        } catch (error) {
          console.error(`[${NS}] dispose failed:`, error);
        }
      }
    },
    `${NS}: dispose`,
  );
}

    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
