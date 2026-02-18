/**
 * Chat Markers - options.js
 * Manages saved markers across all conversations.
 */

'use strict';

const MARKER_KEY_PREFIX = 'chat_markers::';

let toastTimer;
function showToast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.opacity = '0'; }, duration);
}

/** Load all Chat Markers entries from storage */
async function loadAllEntries() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith(MARKER_KEY_PREFIX))
    .map(([k, v]) => {
      const markers = Array.isArray(v) ? v : (v?.markers || []);
      return { key: k, markers };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Render the list of stored conversations */
async function renderList() {
  const listEl = document.getElementById('storage-list');
  const entries = await loadAllEntries();

  if (entries.length === 0) {
    listEl.innerHTML = '<span id="empty-msg">No markers saved yet. Visit a ChatGPT conversation and add notes!</span>';
    return;
  }

  listEl.innerHTML = '';
  entries.forEach(({ key, markers }) => {
    const row = document.createElement('div');
    row.className = 'storage-row';

    const shortKey = key.replace(MARKER_KEY_PREFIX, '');
    row.innerHTML = `
      <span class="storage-key" title="${key}">${shortKey}</span>
      <span class="storage-count">${markers.length} note${markers.length !== 1 ? 's' : ''}</span>
      <button class="storage-del" data-key="${key}" title="Delete markers for this conversation">🗑</button>
    `;

    row.querySelector('.storage-del').onclick = async (e) => {
      const k = e.currentTarget.getAttribute('data-key');
      if (confirm(`Delete all ${markers.length} markers for:\n${shortKey}?`)) {
        await chrome.storage.local.remove(k);
        showToast('Deleted.');
        renderList();
      }
    };

    listEl.appendChild(row);
  });
}

/** Export all markers as a single JSON file */
async function exportAll() {
  const entries = await loadAllEntries();
  if (entries.length === 0) { showToast('Nothing to export.'); return; }

  const data = {
    exportedAt: new Date().toISOString(),
    schemaVersion: 2,
    conversations: entries
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-markers-all-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('✅ Exported all conversations!');
}

/** Clear all markers */
async function clearAll() {
  const entries = await loadAllEntries();
  if (entries.length === 0) { showToast('Nothing to clear.'); return; }
  if (!confirm(`Delete ALL ${entries.length} conversation(s) worth of markers?\nThis cannot be undone.`)) return;
  const keys = entries.map(e => e.key);
  await chrome.storage.local.remove(keys);
  showToast('✅ All markers cleared.');
  renderList();
}

/** Import from JSON file */
async function importFile(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    let imported = 0;

    // Handle both single-chat export and all-chat export
    if (data.conversations) {
      // All-chat export
      for (const conv of data.conversations) {
        if (!conv.key || !Array.isArray(conv.markers)) continue;
        const existing = await chrome.storage.local.get(conv.key);
        const existingMarkers = (existing[conv.key]?.markers || []);
        const existingIds = new Set(existingMarkers.map(m => m.id));
        const toAdd = conv.markers.filter(m => m.id && !existingIds.has(m.id));
        if (toAdd.length > 0) {
          await chrome.storage.local.set({
            [conv.key]: { schemaVersion: 2, markers: [...existingMarkers, ...toAdd] }
          });
          imported += toAdd.length;
        }
      }
    } else if (data.chatKey && Array.isArray(data.markers)) {
      // Single-chat export
      const existing = await chrome.storage.local.get(data.chatKey);
      const existingMarkers = (existing[data.chatKey]?.markers || []);
      const existingIds = new Set(existingMarkers.map(m => m.id));
      const toAdd = data.markers.filter(m => m.id && !existingIds.has(m.id));
      await chrome.storage.local.set({
        [data.chatKey]: { schemaVersion: 2, markers: [...existingMarkers, ...toAdd] }
      });
      imported = toAdd.length;
    } else {
      throw new Error('Unrecognized format');
    }

    showToast(`✅ Imported ${imported} marker(s).`);
    renderList();
  } catch (err) {
    showToast('❌ Import failed: ' + err.message);
  }
  e.target.value = '';
}

// ── Bind events ──
document.getElementById('btn-refresh').onclick   = renderList;
document.getElementById('btn-clear-all').onclick  = clearAll;
document.getElementById('btn-export-all').onclick = exportAll;
document.getElementById('btn-import').onclick     = () => document.getElementById('import-file').click();
document.getElementById('import-file').onchange   = importFile;

// Init
renderList();