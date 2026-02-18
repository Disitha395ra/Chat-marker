/**
 * Chat Markers - content.js
 * Injects a sidebar with bookmark/note markers into ChatGPT conversations.
 */
'use strict';

const SCHEMA_VERSION = 2;
const EXTENSION_PREFIX = 'cm-';
const HIGHLIGHT_DURATION = 2000;
const DEBOUNCE_DELAY = 300;
const STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;

// ─── State ────────────────────────────────────────────────────────────────────
let chatKey = '';
let markers = [];
let sidebarEl = null;
let modalEl = null;
let panelOpen = false;
let rafScheduled = false;
let resizeObserver = null;

// ─── Utilities ────────────────────────────────────────────────────────────────
function debounce(fn, delay) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
}

function hashString(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function buildMsgHash(role, text) {
  return hashString(role + '||' + text.trim().slice(0, 120));
}

function getTextSnippet(el, len = 120) {
  return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, len);
}

function genId() {
  return EXTENSION_PREFIX + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Chat Key ─────────────────────────────────────────────────────────────────
function deriveChatKey() {
  const pathname = location.pathname;
  const match = pathname.match(/\/(?:c|chat|g\/[^/]+\/c)\/([a-zA-Z0-9_-]{8,})/);
  const id = match ? match[1] : pathname.replace(/\//g, '_');
  return 'chat_markers::' + id;
}

let lastPathname = location.pathname;
function watchUrlChange() {
  const check = () => {
    if (location.pathname !== lastPathname) {
      lastPathname = location.pathname;
      onChatChange();
    }
  };
  window.addEventListener('popstate', check);
  setInterval(check, 800);
}

// ─── Storage ──────────────────────────────────────────────────────────────────
async function loadMarkers() {
  try {
    const result = await chrome.storage.local.get(chatKey);
    const raw = result[chatKey];
    if (!raw) return [];
    const data = Array.isArray(raw) ? { schemaVersion: 1, markers: raw } : raw;
    return migrateSchema(data).markers || [];
  } catch (e) {
    console.error('[ChatMarkers] Load error:', e);
    return [];
  }
}

async function saveMarkers(markersArr) {
  if (!Array.isArray(markersArr)) return;
  const payload = { schemaVersion: SCHEMA_VERSION, markers: markersArr };
  const json = JSON.stringify(payload);
  if (json.length > STORAGE_QUOTA_BYTES) {
    showToast('⚠️ Storage limit approaching. Export and clear old notes.', 'warn');
  }
  try {
    await chrome.storage.local.set({ [chatKey]: payload });
  } catch (e) {
    if (e.message && e.message.includes('QUOTA_BYTES')) {
      showToast('❌ Storage quota exceeded! Export your notes and delete some.', 'error');
    } else {
      console.error('[ChatMarkers] Save error:', e);
    }
  }
}

function migrateSchema(data) {
  let { schemaVersion = 1, markers: ms = [] } = data;
  if (schemaVersion < 2) {
    ms = ms.map(m => {
      if (m.msgRef && !m.msgRef.hash && m.msgRef.snippet) {
        m.msgRef.hash = hashString((m.msgRef.role || '') + '||' + m.msgRef.snippet);
      }
      return m;
    });
    schemaVersion = 2;
  }
  return { schemaVersion, markers: ms };
}

// ─── Message Discovery ────────────────────────────────────────────────────────
function discoverMessages() {
  let nodes = Array.from(document.querySelectorAll('[data-message-author-role]'));
  if (nodes.length === 0) {
    nodes = Array.from(document.querySelectorAll(
      '[class*="ConversationTurn"], [class*="conversation-turn"], article'
    ));
  }
  return nodes.map((el, index) => {
    const role = el.getAttribute('data-message-author-role') || 'unknown';
    const snippet = getTextSnippet(el);
    const hash = buildMsgHash(role, snippet);
    return { el, role, index, hash, snippet };
  });
}

function remapMarkers(storedMarkers, currentMsgs) {
  return storedMarkers.map(marker => {
    const ref = marker.msgRef;
    if (!ref) return { ...marker, _domEl: null, _missing: true };

    // 1) Exact hash
    let found = currentMsgs.find(m => m.hash === ref.hash);

    // 2) Role + snippet prefix
    if (!found && ref.snippet) {
      const prefix = ref.snippet.slice(0, 40).toLowerCase();
      found = currentMsgs.find(m =>
        m.role === ref.role && m.snippet.toLowerCase().startsWith(prefix)
      );
    }

    // 3) Index hint fallback
    if (!found && ref.indexHint !== undefined) {
      const sameRole = currentMsgs.filter(m => m.role === ref.role);
      if (sameRole.length > 0) {
        found = sameRole.reduce((best, m) =>
          Math.abs(m.index - ref.indexHint) < Math.abs(best.index - ref.indexHint) ? m : best
        );
      }
    }

    return { ...marker, _domEl: found ? found.el : null, _missing: !found };
  });
}

// ─── Note Button Injection ────────────────────────────────────────────────────
function injectNoteButtons(currentMsgs) {
  document.querySelectorAll('.cm-add-note-btn').forEach(b => b.remove());
  currentMsgs.forEach(({ el, role, index, hash, snippet }) => {
    if (el.querySelector('.cm-add-note-btn')) return;
    const btn = document.createElement('button');
    btn.className = 'cm-add-note-btn';
    btn.title = 'Add a Chat Marker note';
    btn.textContent = '＋';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const existing = markers.find(m => m.msgRef && m.msgRef.hash === hash);
      openModal(existing || null, { role, hash, snippet, indexHint: index });
    });
    el.style.position = 'relative';
    el.appendChild(btn);
  });
}

// ─── Modal ────────────────────────────────────────────────────────────────────
const COLORS = [
  { value: 'yellow', label: '🟡 Yellow' },
  { value: 'blue',   label: '🔵 Blue'   },
  { value: 'green',  label: '🟢 Green'  },
  { value: 'red',    label: '🔴 Red'    },
  { value: 'purple', label: '🟣 Purple' },
];

function openModal(existingMarker, msgRefData) {
  closeModal();
  modalEl = document.createElement('div');
  modalEl.className = 'cm-modal-overlay';
  modalEl.innerHTML = `
    <div class="cm-modal" role="dialog" aria-modal="true">
      <div class="cm-modal-header">
        <span>${existingMarker ? '✏️ Edit Note' : '＋ Add Note'}</span>
        <button class="cm-modal-close" title="Close">✕</button>
      </div>
      <div class="cm-modal-body">
        <label for="cm-note-text">Note</label>
        <textarea id="cm-note-text" placeholder="Enter your note…" rows="3">${existingMarker ? esc(existingMarker.note) : ''}</textarea>
        <label for="cm-note-tag">Tag (optional)</label>
        <input id="cm-note-tag" type="text" placeholder="e.g. important, question" value="${existingMarker ? esc(existingMarker.tag || '') : ''}">
        <label for="cm-note-color">Color</label>
        <select id="cm-note-color">
          ${COLORS.map(c => `<option value="${c.value}" ${(existingMarker?.color || 'yellow') === c.value ? 'selected' : ''}>${c.label}</option>`).join('')}
        </select>
      </div>
      <div class="cm-modal-footer">
        ${existingMarker ? '<button class="cm-btn cm-btn-danger cm-modal-delete">🗑 Delete</button>' : ''}
        <button class="cm-btn cm-btn-secondary cm-modal-cancel">Cancel</button>
        <button class="cm-btn cm-btn-primary cm-modal-save">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);
  setTimeout(() => modalEl.querySelector('#cm-note-text')?.focus(), 50);

  modalEl.querySelector('.cm-modal-close').onclick = closeModal;
  modalEl.querySelector('.cm-modal-cancel').onclick = closeModal;
  modalEl.addEventListener('click', e => { if (e.target === modalEl) closeModal(); });

  const delBtn = modalEl.querySelector('.cm-modal-delete');
  if (delBtn) delBtn.onclick = () => { deleteMarker(existingMarker.id); closeModal(); };

  modalEl.querySelector('.cm-modal-save').onclick = () => {
    const note = modalEl.querySelector('#cm-note-text').value.trim();
    const tag  = modalEl.querySelector('#cm-note-tag').value.trim();
    const color = modalEl.querySelector('#cm-note-color').value;
    if (!note) { modalEl.querySelector('#cm-note-text').classList.add('cm-error'); return; }
    saveMarkerFromModal(existingMarker, msgRefData, note, tag, color);
    closeModal();
  };

  modalEl.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') modalEl.querySelector('.cm-modal-save').click();
  });
}

function closeModal() {
  if (modalEl) { modalEl.remove(); modalEl = null; }
}

async function saveMarkerFromModal(existingMarker, msgRefData, note, tag, color) {
  const now = new Date().toISOString();
  if (existingMarker) {
    const idx = markers.findIndex(m => m.id === existingMarker.id);
    if (idx !== -1) markers[idx] = { ...markers[idx], note, tag, color, updatedAt: now };
  } else {
    markers.push({
      id: genId(),
      msgRef: {
        role: msgRefData.role, hash: msgRefData.hash,
        snippet: msgRefData.snippet, indexHint: msgRefData.indexHint
      },
      note, tag, color, createdAt: now, updatedAt: now
    });
  }
  await saveMarkers(markers);
  rebuildUI();
}

async function deleteMarker(id) {
  markers = markers.filter(m => m.id !== id);
  await saveMarkers(markers);
  rebuildUI();
}

// ─── Sidebar ──────────────────────────────────────────────────────────────────
function buildSidebar() {
  if (sidebarEl) sidebarEl.remove();
  sidebarEl = document.createElement('div');
  sidebarEl.id = 'cm-sidebar';
  sidebarEl.innerHTML = `
    <div class="cm-sidebar-header">
      <span class="cm-title">📌 Markers</span>
      <div class="cm-header-actions">
        <button class="cm-icon-btn cm-toggle-panel" title="Toggle marker list">☰</button>
        <button class="cm-icon-btn cm-help-btn" title="Help">?</button>
      </div>
    </div>
    <div class="cm-track-container">
      <div class="cm-track" id="cm-track"></div>
    </div>
    <div class="cm-panel" id="cm-panel" style="display:none;">
      <div class="cm-panel-toolbar">
        <input class="cm-search" id="cm-search" type="text" placeholder="Search notes…">
        <button class="cm-icon-btn cm-export-btn" title="Export notes">⬆</button>
        <button class="cm-icon-btn cm-import-btn" title="Import notes">⬇</button>
        <input type="file" id="cm-import-file" accept=".json" style="display:none">
      </div>
      <div class="cm-note-list" id="cm-note-list"></div>
    </div>
    <div class="cm-help-panel" id="cm-help-panel" style="display:none;">
      <div class="cm-help-content">
        <strong>Chat Markers Help</strong>
        <ul>
          <li>Hover a message → click <b>＋</b> to add a note</li>
          <li>Click a <b>track pip</b> to jump to that message</li>
          <li>Right-click a pip to <b>delete</b> it</li>
          <li>Use <b>⬆ Export</b> / <b>⬇ Import</b> to backup/restore</li>
          <li>Notes persist per conversation URL</li>
          <li>Press <b>Ctrl+Enter</b> to save in modal</li>
          <li>Developed by : <b>Disitha Ranasinghe</b></li>
        </ul>
        <button class="cm-btn cm-btn-secondary cm-close-help">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(sidebarEl);

  sidebarEl.querySelector('.cm-toggle-panel').onclick = () => {
    panelOpen = !panelOpen;
    document.getElementById('cm-panel').style.display = panelOpen ? 'flex' : 'none';
    document.getElementById('cm-help-panel').style.display = 'none';
  };

  sidebarEl.querySelector('.cm-help-btn').onclick = () => {
    const hp = document.getElementById('cm-help-panel');
    hp.style.display = hp.style.display === 'none' ? 'block' : 'none';
    document.getElementById('cm-panel').style.display = 'none';
    panelOpen = false;
  };
  sidebarEl.querySelector('.cm-close-help').onclick = () => {
    document.getElementById('cm-help-panel').style.display = 'none';
  };

  const searchEl = document.getElementById('cm-search');
  searchEl.addEventListener('input', debounce(() => renderNoteList(searchEl.value), 200));
  sidebarEl.querySelector('.cm-export-btn').onclick = exportNotes;
  sidebarEl.querySelector('.cm-import-btn').onclick = () => document.getElementById('cm-import-file').click();
  document.getElementById('cm-import-file').onchange = importNotes;
}

function rebuildUI() {
  if (!sidebarEl) buildSidebar();
  const currentMsgs = discoverMessages();
  const remapped = remapMarkers(markers, currentMsgs);
  markers = markers.map((m, i) => ({ ...m, _domEl: remapped[i]._domEl, _missing: remapped[i]._missing }));
  renderTrack();
  renderNoteList(document.getElementById('cm-search')?.value || '');
}

function renderTrack() {
  const track = document.getElementById('cm-track');
  if (!track) return;
  track.innerHTML = '';
  const totalH = document.documentElement.scrollHeight - document.documentElement.clientHeight;
  if (totalH <= 0) return;

  markers.forEach(marker => {
    const pip = document.createElement('button');
    pip.className = `cm-pip cm-pip-${marker.color || 'yellow'}${marker._missing ? ' cm-pip-missing' : ''}`;
    pip.title = (marker._missing ? '⚠ Message not found\n' : '') + marker.note;

    let pct = 50;
    if (marker._domEl) {
      const rect = marker._domEl.getBoundingClientRect();
      const msgScrollY = window.scrollY + rect.top;
      pct = Math.min(99, Math.max(1, (msgScrollY / (totalH + document.documentElement.clientHeight)) * 100));
    }
    pip.style.top = pct + '%';

    pip.addEventListener('click', () => scrollToMarker(marker));
    pip.addEventListener('contextmenu', e => {
      e.preventDefault();
      if (confirm(`Delete note:\n"${marker.note.slice(0, 60)}"`)) deleteMarker(marker.id);
    });
    track.appendChild(pip);
  });
}

function renderNoteList(filter = '') {
  const list = document.getElementById('cm-note-list');
  if (!list) return;
  list.innerHTML = '';
  const lf = filter.toLowerCase();
  const filtered = markers.filter(m =>
    !lf || m.note.toLowerCase().includes(lf) || (m.tag && m.tag.toLowerCase().includes(lf))
  );

  if (filtered.length === 0) {
    list.innerHTML = `<div class="cm-empty">${filter ? 'No matches.' : 'No markers yet.<br>Hover a message and click ＋'}</div>`;
    return;
  }

  filtered.forEach(marker => {
    const item = document.createElement('div');
    item.className = `cm-note-item cm-note-${marker.color || 'yellow'}${marker._missing ? ' cm-note-missing' : ''}`;
    item.innerHTML = `
      <div class="cm-note-meta">
        ${marker.tag ? `<span class="cm-tag">${esc(marker.tag)}</span>` : ''}
        ${marker._missing ? '<span class="cm-badge-missing">⚠ Missing</span>' : ''}
        <span class="cm-note-date">${new Date(marker.createdAt).toLocaleDateString()}</span>
      </div>
      <div class="cm-note-text">${esc(marker.note)}</div>
      ${marker._missing ? `<div class="cm-relink-hint">Message not found. <button class="cm-relink-btn" data-id="${marker.id}">Re-link</button></div>` : ''}
      <div class="cm-note-actions">
        <button class="cm-note-edit" data-id="${marker.id}">✏ Edit</button>
        <button class="cm-note-delete" data-id="${marker.id}">🗑 Delete</button>
      </div>
    `;

    item.querySelector('.cm-note-edit').onclick = () => {
      const m = markers.find(x => x.id === marker.id);
      if (m) openModal(m, m.msgRef);
    };
    item.querySelector('.cm-note-delete').onclick = () => {
      if (confirm(`Delete note:\n"${marker.note.slice(0, 60)}"`)) deleteMarker(marker.id);
    };
    item.addEventListener('click', e => { if (e.target.tagName === 'BUTTON') return; scrollToMarker(marker); });

    const relinkBtn = item.querySelector('.cm-relink-btn');
    if (relinkBtn) relinkBtn.onclick = e => { e.stopPropagation(); startRelink(marker.id); };

    list.appendChild(item);
  });
}

// ─── Scroll & Highlight ───────────────────────────────────────────────────────
function scrollToMarker(marker) {
  if (!marker._domEl) { showToast('⚠️ Message not found in current view.', 'warn'); return; }
  marker._domEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
  highlightElement(marker._domEl);
}

function highlightElement(el) {
  el.classList.remove('cm-highlight');
  void el.offsetWidth;
  el.classList.add('cm-highlight');
  setTimeout(() => el.classList.remove('cm-highlight'), HIGHLIGHT_DURATION);
}

// ─── Re-link ──────────────────────────────────────────────────────────────────
let relinkActiveId = null;

function startRelink(markerId) {
  relinkActiveId = markerId;
  showToast('Click a message to re-link this marker.', 'info', 5000);
  document.body.classList.add('cm-relink-mode');
  discoverMessages().forEach(({ el, role, hash, snippet, index }) => {
    el.classList.add('cm-relink-target');
    el._cmRelinkData = { role, hash, snippet, indexHint: index };
    el.addEventListener('click', onRelinkClick, { once: true });
  });
}

async function onRelinkClick(e) {
  if (!relinkActiveId) return;
  const data = e.currentTarget._cmRelinkData;
  if (!data) return;
  const idx = markers.findIndex(m => m.id === relinkActiveId);
  if (idx !== -1) {
    markers[idx].msgRef = data;
    markers[idx].updatedAt = new Date().toISOString();
    await saveMarkers(markers);
    showToast('✅ Marker re-linked!', 'success');
  }
  cancelRelink();
  rebuildUI();
}

function cancelRelink() {
  relinkActiveId = null;
  document.body.classList.remove('cm-relink-mode');
  document.querySelectorAll('.cm-relink-target').forEach(el => {
    el.classList.remove('cm-relink-target');
    el.removeEventListener('click', onRelinkClick);
  });
}

// ─── Export / Import ──────────────────────────────────────────────────────────
function exportNotes() {
  const data = {
    chatKey, exportedAt: new Date().toISOString(), schemaVersion: SCHEMA_VERSION,
    markers: markers.map(({ _domEl, _missing, ...clean }) => clean)
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-markers-${chatKey.replace(/[^a-z0-9]/gi, '_').slice(0, 40)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✅ Exported!', 'success');
}

async function importNotes(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data.markers || !Array.isArray(data.markers)) throw new Error('Invalid format');
    const valid = data.markers.filter(m => m.id && m.msgRef && m.note !== undefined);
    if (!valid.length) throw new Error('No valid markers found');
    const existingIds = new Set(markers.map(m => m.id));
    const toAdd = valid.filter(m => !existingIds.has(m.id));
    markers = [...markers, ...toAdd];
    await saveMarkers(markers);
    rebuildUI();
    showToast(`✅ Imported ${toAdd.length} marker(s).`, 'success');
  } catch (err) {
    showToast('❌ Import failed: ' + err.message, 'error');
  }
  e.target.value = '';
}

// ─── Toast ────────────────────────────────────────────────────────────────────
let toastTimeout;
function showToast(msg, type = 'info', duration = 3000) {
  let t = document.getElementById('cm-toast');
  if (!t) { t = document.createElement('div'); t.id = 'cm-toast'; document.body.appendChild(t); }
  t.className = `cm-toast cm-toast-${type}`;
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toastTimeout);
  toastTimeout = setTimeout(() => { t.style.opacity = '0'; }, duration);
}

// ─── Track Position Update ────────────────────────────────────────────────────
function updateTrackPositions() {
  if (!rafScheduled) {
    rafScheduled = true;
    requestAnimationFrame(() => { rafScheduled = false; renderTrack(); });
  }
}

// ─── MutationObserver ─────────────────────────────────────────────────────────
const debouncedRebuild = debounce(() => {
  const msgs = discoverMessages();
  injectNoteButtons(msgs);
  rebuildUI();
}, DEBOUNCE_DELAY);

let observer = null;
function startObserver() {
  if (observer) observer.disconnect();
  observer = new MutationObserver(mutations => {
    if (mutations.some(m => m.addedNodes.length > 0 || m.removedNodes.length > 0)) debouncedRebuild();
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────
async function onChatChange() {
  closeModal();
  cancelRelink();
  chatKey = deriveChatKey();
  markers = await loadMarkers();
  rebuildUI();
  injectNoteButtons(discoverMessages());
}

async function init() {
  chatKey = deriveChatKey();
  markers = await loadMarkers();
  buildSidebar();

  let attempts = 0;
  const scanAndInject = () => {
    const msgs = discoverMessages();
    if (msgs.length > 0 || attempts++ > 10) {
      injectNoteButtons(msgs);
      rebuildUI();
    } else {
      setTimeout(scanAndInject, 600);
    }
  };
  scanAndInject();

  window.addEventListener('scroll', updateTrackPositions, { passive: true });
  resizeObserver = new ResizeObserver(debounce(updateTrackPositions, 200));
  resizeObserver.observe(document.documentElement);
  startObserver();
  watchUrlChange();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}