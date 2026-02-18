# Chat Markers – Chrome Extension

Adds persistent notes/bookmarks to ChatGPT conversations with a mini right-side scrollbar.

---

## Installation

1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `chat-markers-extension/` folder
5. Navigate to `https://chatgpt.com/` and start a conversation

---

## Testing Checklist

### ✅ Basic Functionality
- [ ] Extension loads without errors (check Extensions page)
- [ ] Sidebar appears on right side of ChatGPT page
- [ ] "＋" button appears on hover over each message

### ✅ Create a Marker
- [ ] Hover a message → click "＋" button → modal opens
- [ ] Enter a note, optional tag, choose color → Save
- [ ] Marker pip appears in the right track
- [ ] Note appears in the list (☰ toggle)
- [ ] Clicking the pip smoothly scrolls to and highlights the message

### ✅ Persistence After Refresh
- [ ] Add a marker, then refresh the page (F5)
- [ ] Marker still appears in sidebar and track
- [ ] Clicking it still scrolls to the correct message

### ✅ Per-Chat Separation
- [ ] Open Chat A → add markers
- [ ] Navigate to Chat B (new chat) → Chat A's markers do NOT appear
- [ ] Return to Chat A → markers are back

### ✅ Edit & Delete
- [ ] Click ☰ → find note → click ✏ Edit → change note → Save
- [ ] Right-click a pip → confirm delete
- [ ] Click 🗑 Delete in list → marker removed
- [ ] Undo: markers persist after page actions (scrolling, new messages)

### ✅ Search/Filter
- [ ] Open list panel, type in search box → filters notes in real-time

### ✅ Export & Import
- [ ] Click ⬆ Export → JSON file downloads
- [ ] Open JSON file → verify structure is correct
- [ ] Delete all markers
- [ ] Click ⬇ Import → select the JSON → markers restored

### ✅ Missing Message Handling
- [ ] Add a marker, then manually delete the message (or export/import to a different chat)
- [ ] Marker shows "⚠ Missing" badge in list
- [ ] Click "Re-link" → click a different message → marker re-linked

### ✅ Options Page
- [ ] Go to `chrome://extensions/` → Chat Markers → Details → Extension options
- [ ] All saved conversations appear with marker counts
- [ ] Export All → JSON with all conversations
- [ ] Delete individual conversation markers
- [ ] Clear All removes everything

### ✅ Dark Mode
- [ ] Switch OS to dark mode → sidebar, modal, track all use dark palette

---

## Data Model

```json
{
  "schemaVersion": 2,
  "markers": [
    {
      "id": "cm-abc123",
      "msgRef": {
        "role": "assistant",
        "hash": "x7f2k1",
        "snippet": "First 120 chars of message text…",
        "indexHint": 3
      },
      "note": "This is important",
      "tag": "key-point",
      "color": "yellow",
      "createdAt": "2024-01-01T12:00:00.000Z",
      "updatedAt": "2024-01-01T12:00:00.000Z"
    }
  ]
}
```

Storage key format: `chat_markers::<conversation-id>`