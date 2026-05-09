// --- State ---
let sessions = [];
let activeSessionId = null;
let currentDoc = null;
// isStreaming is now per-session via streamingState
let currentFilePath = null;
let c3BrandMode = false;

// --- DOM ---
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const sessionListEl = $('#session-list');
const newDocBtn = $('#new-doc-btn');
const messagesEl = $('#messages');
const messagesInner = $('#messages-inner');
const chatInput = $('#chat-input');
const chatForm = $('#chat-form');
const sendBtn = $('#send-btn');
const docContent = $('#doc-content');
const docArtifactTitle = $('#doc-artifact-title');
const fileList = $('#file-list');
const filePathDisplay = $('#file-path-display');
const fileUpBtn = $('#file-up-btn');
const fileInput = $('#file-input');
const saveModal = $('#save-modal');
const savePathInput = $('#save-path-input');
const toastEl = $('#toast');

// --- Init ---

async function init() {
  await loadSessions();
  if (sessions.length === 0) {
    await createSession('New Document');
  } else {
    switchSession(sessions[0].id);
  }
  await loadFiles();
  setupEventListeners();
}

// --- Sessions ---

async function loadSessions() {
  const res = await fetch('/api/sessions');
  sessions = await res.json();
  renderSessionList();
}

// --- Open Tabs ---

function openTab(sessionId) {
  if (!openTabs.includes(sessionId)) {
    openTabs.push(sessionId);
  }
  renderOpenTabs();
}

function closeOpenTab(sessionId) {
  openTabs = openTabs.filter(id => id !== sessionId);
  renderOpenTabs();
  // If we closed the active tab, switch to another open tab or first session
  if (activeSessionId === sessionId) {
    if (openTabs.length > 0) {
      switchSession(openTabs[openTabs.length - 1]);
    } else if (sessions.length > 0) {
      switchSession(sessions[0].id);
    }
  }
}

function renderOpenTabs() {
  const container = $('#open-tabs');
  container.innerHTML = '';
  openTabs.forEach(id => {
    const s = sessions.find(s => s.id === id);
    if (!s) return;

    const isActive = id === activeSessionId;
    const isLoading = !!streamingState[id];
    const state = isLoading ? 'loading' : (sessionReadState[id] || 'read');

    const tab = document.createElement('div');
    tab.className = `open-tab${isActive ? ' active' : ''}`;

    let statusDot = '';
    if (state === 'loading') statusDot = '<span class="tab-status loading"></span>';
    else if (state === 'unread') statusDot = '<span class="tab-status unread"></span>';

    tab.innerHTML = `
      ${statusDot}
      <span class="tab-label">${esc(s.title)}</span>
      <span class="tab-close">&times;</span>
    `;

    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) {
        closeOpenTab(id);
      } else {
        switchSession(id);
        markSessionRead(id);
      }
    });

    container.appendChild(tab);
  });
}

// Track read state per session
const sessionReadState = {}; // sessionId -> 'read' | 'unread' | 'loading'

function markSessionRead(id) {
  sessionReadState[id] = 'read';
  renderSessionList();
  renderOpenTabs();
}

function markSessionUnread(id) {
  if (activeSessionId !== id) {
    sessionReadState[id] = 'unread';
    renderSessionList();
    renderOpenTabs();
  }
}

function renderSessionList() {
  // Sort by updated_at descending (most recent first)
  sessions.sort((a, b) => {
    // Append Z if missing so UTC parsing is consistent
    const fixTs = (t) => t && !t.endsWith('Z') ? t + 'Z' : t;
    const ta = new Date(fixTs(a.updated_at || a.created_at)).getTime() || 0;
    const tb = new Date(fixTs(b.updated_at || b.created_at)).getTime() || 0;
    return tb - ta;
  });

  sessionListEl.innerHTML = '';
  sessions.forEach(s => {
    const isStreaming = !!streamingState[s.id];
    const state = isStreaming ? 'loading' : (sessionReadState[s.id] || 'read');
    const isActive = s.id === activeSessionId;

    const item = document.createElement('div');
    item.className = `session-item${isActive ? ' active' : ''}`;
    item.dataset.id = s.id;

    let icon = '';
    if (state === 'loading') {
      icon = '<span class="session-status loading" title="Generating..."></span>';
    } else if (state === 'unread') {
      icon = '<span class="session-status unread" title="New response"></span>';
    }

    item.innerHTML = `
      <div class="session-item-row">
        ${icon}
        <span class="session-title">${esc(s.title)}</span>
        <button class="session-clone-btn" title="Clone session">&#10697;</button>
      </div>
      <span class="session-time">${relativeTime(s.updated_at || s.created_at)}</span>
    `;
    item.querySelector('.session-clone-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      cloneSession(s.id);
    });
    item.addEventListener('click', () => {
      switchSession(s.id);
      markSessionRead(s.id);
    });
    item.addEventListener('dblclick', () => renameSession(s.id, s.title));
    sessionListEl.appendChild(item);
  });
}

function relativeTime(timestamp) {
  if (!timestamp) return 'Just now';
  const now = Date.now();
  const fixed = timestamp.endsWith('Z') ? timestamp : timestamp + 'Z';
  const then = new Date(fixed).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return 'Just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHr < 24) return `${diffHr}h ago`;
  if (diffDay === 1) return 'Yesterday';
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

let _creatingSession = false;
async function createSession(title) {
  if (_creatingSession) return;
  _creatingSession = true;

  // Clean up any existing empty "New Document" sessions first
  const empties = sessions.filter(s => s.title === 'New Document' && s.id !== activeSessionId);
  for (const s of empties) {
    // Check if it has any messages or documents
    try {
      const [msgRes, docRes] = await Promise.all([
        fetch(`/api/sessions/${s.id}/messages`),
        fetch(`/api/sessions/${s.id}/document`),
      ]);
      const msgs = await msgRes.json();
      const doc = await docRes.json();
      if (msgs.length === 0 && !doc) {
        await fetch(`/api/sessions/${s.id}`, { method: 'DELETE' });
        sessions = sessions.filter(x => x.id !== s.id);
        openTabs = openTabs.filter(id => id !== s.id);
      }
    } catch {}
  }

  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title || 'New Document' }),
  });
  const session = await res.json();
  sessions.unshift(session);
  renderSessionList();
  switchSession(session.id);
  _creatingSession = false;
}

async function renameSession(id, currentTitle) {
  const name = prompt('Session name:', currentTitle);
  if (!name || name === currentTitle) return;
  manuallyRenamed.add(id);
  await fetch(`/api/sessions/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: name }),
  });
  const s = sessions.find(s => s.id === id);
  if (s) s.title = name;
  renderSessionList();
  renderOpenTabs();
}

async function cloneSession(sourceId) {
  // Fetch the document from the source session
  let sourceDoc = null;
  try {
    const docRes = await fetch(`/api/sessions/${sourceId}/document`);
    sourceDoc = await docRes.json();
  } catch {}

  const sourceSession = sessions.find(s => s.id === sourceId);
  const sourceTitle = sourceSession ? sourceSession.title : 'Document';
  const newTitle = `Copy of ${sourceTitle}`;

  // Create a new session
  const sessionRes = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: newTitle }),
  });
  const newSession = await sessionRes.json();
  sessions.unshift(newSession);
  manuallyRenamed.add(newSession.id); // Preserve "Copy of..." title

  // Copy document content to the new session if it exists
  if (sourceDoc && sourceDoc.content) {
    await fetch(`/api/sessions/${newSession.id}/document`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: sourceDoc.content,
        filename: sourceDoc.filename,
      }),
    });
  }

  renderSessionList();
  switchSession(newSession.id);

  // Pre-populate the chat input for adapting
  chatInput.value = 'Adapt this document for ';
  chatInput.focus();
  toast(`Cloned "${sourceTitle}"`, 'success');
}

// Track per-session streaming state
const streamingState = {}; // sessionId -> { sendTime }

// Track sessions that were manually renamed (don't auto-override their title)
const manuallyRenamed = new Set();

// Open tabs — sessions currently open as tabs
let openTabs = []; // array of session IDs

async function switchSession(id) {
  activeSessionId = id;
  openTab(id);
  renderSessionList();
  renderOpenTabs();
  // Load document first so renderMessages can check currentDoc for welcome mode
  await loadDocument(id);
  await loadMessages(id);
  // If this session is still streaming, show the indicator
  if (streamingState[id]) {
    const bubble = getStreamingBubble();
    const elapsed = Math.floor((Date.now() - streamingState[id].sendTime) / 1000);
    bubble.innerHTML = `<div class="thinking-indicator">
      <span class="thinking-label">Working</span><span class="thinking-dots-anim"></span>
      <span class="thinking-time">${elapsed}s</span>
    </div>`;
  }
  sendBtn.disabled = !!streamingState[id];
  chatInput.focus();
}

// --- Messages ---

async function loadMessages(sessionId) {
  const res = await fetch(`/api/sessions/${sessionId}/messages`);
  const messages = await res.json();
  renderMessages(messages);
}

function renderMessages(messages) {
  const hasStreaming = !!streamingState[activeSessionId];
  if (messages.length === 0 && !currentDoc && !hasStreaming) {
    messagesInner.innerHTML = '';
    enterWelcomeMode();
    return;
  }

  exitWelcomeMode();

  if (messages.length === 0 && !hasStreaming) {
    messagesInner.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">&#9998;</div>
        <div class="empty-state-text">Start a conversation.<br>Ask Claude to create or edit a document.</div>
      </div>
    `;
    return;
  }

  messagesInner.innerHTML = messages.map(m => {
    const content = stripDocumentTags(m.content);
    return `
      <div class="msg ${m.role}">
        <div class="msg-header">${m.role === 'user' ? 'You' : 'Claude'}</div>
        <div class="msg-body">${esc(content)}</div>
      </div>
    `;
  }).join('');

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function appendMessage(role, content) {
  const existing = messagesInner.querySelector('.empty-state');
  if (existing) messagesInner.innerHTML = '';

  const div = document.createElement('div');
  div.className = `msg ${role}`;
  div.innerHTML = `
    <div class="msg-header">${role === 'user' ? 'You' : 'Claude'}</div>
    <div class="msg-body">${esc(content)}</div>
  `;
  messagesInner.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function getStreamingBubble() {
  const last = messagesInner.querySelector('.msg:last-child');
  if (last && last.classList.contains('assistant')) {
    return last.querySelector('.msg-body');
  }
  const div = appendMessage('assistant', '');
  return div.querySelector('.msg-body');
}

// --- Document ---

async function loadDocument(sessionId) {
  const res = await fetch(`/api/sessions/${sessionId}/document`);
  currentDoc = await res.json();

  if (currentDoc) {
    renderInIframe(currentDoc.content);
    updateArtifactTitle(currentDoc.content, currentDoc.filename);
    detectFormatAndUpdateUI(currentDoc.filename);
  } else {
    renderInIframe('<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:800px;color:#8C877D;font-family:-apple-system,sans-serif;"><div style="font-size:48px;margin-bottom:12px;">&#128196;</div><div>Upload a document or ask Claude to create one</div></div>');
    docArtifactTitle.textContent = 'No document';
    detectFormatAndUpdateUI(null);
  }
}

function detectFormatAndUpdateUI(filename) {
  const badge = $('#doc-format-badge');
  const btnDocx = $('#btn-export-docx');
  const btnPdf = $('#btn-export-pdf');

  if (!filename) {
    badge.textContent = '';
    btnDocx.style.display = 'none';
    btnPdf.style.display = 'none';
    return;
  }

  const ext = filename.substring(filename.lastIndexOf('.')).toLowerCase();
  let format = '';

  if (ext === '.docx' || ext === '.doc') {
    format = 'DOCX';
    btnDocx.style.display = '';
    btnPdf.style.display = 'none';
  } else if (ext === '.html' || ext === '.htm') {
    format = 'HTML';
    btnDocx.style.display = 'none';
    btnPdf.style.display = '';
  } else if (ext === '.txt') {
    format = 'TXT';
    btnDocx.style.display = 'none';
    btnPdf.style.display = '';
  } else if (ext === '.md') {
    format = 'MD';
    btnDocx.style.display = 'none';
    btnPdf.style.display = '';
  } else {
    format = ext.replace('.', '').toUpperCase();
    btnDocx.style.display = '';
    btnPdf.style.display = '';
  }

  badge.textContent = format;
}

function updateArtifactTitle(html, filename) {
  const match = html.match(/<h1[^>]*>(.*?)<\/h1>/i) || html.match(/<h2[^>]*>(.*?)<\/h2>/i) || html.match(/<title[^>]*>(.*?)<\/title>/i);
  let title = '';
  if (match) {
    title = match[1].replace(/<[^>]+>/g, '').trim().substring(0, 80);
  }
  docArtifactTitle.textContent = title || filename || 'Untitled';

  // Keep session name in sync with artifact title (unless manually renamed)
  if (title && activeSessionId && !manuallyRenamed.has(activeSessionId)) {
    const s = sessions.find(s => s.id === activeSessionId);
    if (s && s.title !== title) {
      s.title = title;
      fetch(`/api/sessions/${activeSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      renderSessionList();
      renderOpenTabs();
    }
  }
}

async function copyDocToClipboard() {
  const content = getCurrentDocContent();
  if (!content || !currentDoc) {
    toast('No document to copy', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(content);
    toast('Copied to clipboard', 'success');
  } catch (err) {
    toast('Failed to copy', 'error');
  }
}

// Default styles injected into iframe when Claude doesn't provide its own
const DEFAULT_DOC_STYLES = `
  body {
    font-family: 'Georgia', 'Times New Roman', serif;
    font-size: 15px;
    line-height: 1.7;
    color: #1a1a1a;
    padding: 72px;
    margin: 0;
    max-width: 816px;
  }
  h1 { font-size: 28px; margin-bottom: 20px; font-weight: 700; color: #111; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  h2 { font-size: 22px; margin: 28px 0 14px; font-weight: 600; color: #222; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  h3 { font-size: 18px; margin: 24px 0 12px; font-weight: 600; color: #333; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  p { margin-bottom: 14px; }
  ul, ol { margin: 14px 0; padding-left: 28px; }
  li { margin-bottom: 8px; }
  table { border-collapse: collapse; width: 100%; margin: 20px 0; }
  th, td { border: 1px solid #ddd; padding: 10px 14px; text-align: left; }
  th { background: #f5f5f5; font-weight: 600; font-family: -apple-system, sans-serif; font-size: 14px; }
  blockquote { border-left: 3px solid #ccc; padding-left: 20px; color: #555; margin: 14px 0; font-style: italic; }
  strong { font-weight: 700; }
  img { max-width: 100%; }
  * { box-sizing: border-box; }
`;

function renderInIframe(html) {
  const frame = document.getElementById('doc-frame');
  const hasStyles = /<style[\s\S]*?<\/style>/i.test(html);
  const fullHtml = `<!DOCTYPE html><html><head><meta charset="utf-8">
    ${hasStyles ? '' : `<style>${DEFAULT_DOC_STYLES}</style>`}
    </head><body>${html}</body></html>`;
  frame.srcdoc = fullHtml;

  frame.onload = () => {
    try {
      const body = frame.contentDocument.body;
      const height = Math.max(body.scrollHeight, 1056);
      frame.style.height = height + 'px';
    } catch(e) {}
    scaleDocPage();
  };
}

function updateDocPreview(html) {
  renderInIframe(html);
  updateArtifactTitle(html, currentDoc?.filename);
  exitWelcomeMode();
  scheduleAutosave();
  if (activeSessionId) {
    fetch(`/api/sessions/${activeSessionId}/document`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: html }),
    });

    // Auto-name session from document heading
    autoNameSession(html);
  }
}

// --- Chat ---

function autoNameSession(html) {
  const s = sessions.find(s => s.id === activeSessionId);
  if (!s || s.title !== 'New Document') return;

  // Try doc heading first
  const match = html.match(/<h1[^>]*>(.*?)<\/h1>/i) || html.match(/<h2[^>]*>(.*?)<\/h2>/i) || html.match(/<title[^>]*>(.*?)<\/title>/i);
  if (match) {
    const title = match[1].replace(/<[^>]+>/g, '').trim().substring(0, 60);
    if (title) {
      s.title = title;
      fetch(`/api/sessions/${activeSessionId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      renderSessionList();
      renderOpenTabs();
    }
  }
}

function autoNameFromMessage(text) {
  const s = sessions.find(s => s.id === activeSessionId);
  if (!s || s.title !== 'New Document') return;

  // Use first ~50 chars of the first user message
  const title = text.trim().substring(0, 50).replace(/\n/g, ' ');
  if (title) {
    s.title = title;
    fetch(`/api/sessions/${activeSessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    renderSessionList();
    renderOpenTabs();
  }
}

async function clearChat() {
  if (!activeSessionId) return;
  await fetch(`/api/sessions/${activeSessionId}/messages`, { method: 'DELETE' });
  messagesInner.innerHTML = `
    <div class="empty-state">
      <div class="empty-state-icon">&#9998;</div>
      <div class="empty-state-text">Chat cleared. Document preserved.</div>
    </div>
  `;
  toast('Chat cleared', 'success');
}

async function sendMessage(text) {
  if (!text.trim() || !activeSessionId) return;
  if (streamingState[activeSessionId]) {
    toast('Still waiting for Claude...', '');
    return;
  }

  // Handle /clear command
  if (text.trim() === '/clear') {
    chatInput.value = '';
    await clearChat();
    return;
  }

  const streamSessionId = activeSessionId;
  sendBtn.disabled = true;
  chatInput.value = '';
  autoResize(chatInput);

  exitWelcomeMode();
  appendMessage('user', text);
  autoNameFromMessage(text);

  const bubble = getStreamingBubble();
  bubble.innerHTML = `<div class="thinking-indicator">
    <span class="thinking-label">Thinking</span><span class="thinking-dots-anim"></span>
    <span class="thinking-time">0s</span>
  </div>`;

  let fullText = '';
  const sendTime = Date.now();
  // Update time immediately and every second
  let timeTimer = setInterval(() => {
    const timeEl = bubble.querySelector('.thinking-time');
    if (timeEl) timeEl.textContent = `${Math.floor((Date.now() - sendTime) / 1000)}s`;
  }, 1000);

  const thinkingWords = [
    'Thinking', 'Reasoning', 'Analyzing', 'Searching tools',
    'Reading context', 'Working', 'Processing', 'Composing',
  ];
  let wordIdx = 0;
  let thinkingTimer = setInterval(() => {
    const label = bubble.querySelector('.thinking-label');
    const timeEl = bubble.querySelector('.thinking-time');
    if (!label) return;
    const elapsed = Math.floor((Date.now() - sendTime) / 1000);
    // Rotate words only if not showing a tool name
    if (!label.textContent.startsWith('Using ')) {
      wordIdx = (wordIdx + 1) % thinkingWords.length;
      label.textContent = thinkingWords[wordIdx];
    }
    if (timeEl) timeEl.textContent = `${elapsed}s`;
  }, 2000);

  // Track this stream per-session
  streamingState[streamSessionId] = { sendTime };
  // Bump updated_at and rerender sidebar
  const streamSession = sessions.find(s => s.id === streamSessionId);
  if (streamSession) streamSession.updated_at = new Date().toISOString();
  renderSessionList();

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/sessions/${streamSessionId}/chat`);
  xhr.setRequestHeader('Content-Type', 'application/json');

  let lastProcessed = 0;

  xhr.onprogress = function () {
    const newData = xhr.responseText.slice(lastProcessed);
    lastProcessed = xhr.responseText.length;

    // Only update UI if we're still viewing this session
    const isViewing = activeSessionId === streamSessionId;

    const lines = newData.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      try {
        const event = JSON.parse(line.slice(6));
        if (event.type === 'text') {
          fullText += event.content;
          if (isViewing) {
            bubble.innerHTML = esc(stripDocumentTags(fullText)) +
              `<div class="thinking-indicator inline-thinking">
                <span class="thinking-label">Working</span><span class="thinking-dots-anim"></span>
                <span class="thinking-time">${Math.floor((Date.now() - sendTime) / 1000)}s</span>
              </div>`;
            messagesEl.scrollTop = messagesEl.scrollHeight;
          }
        } else if (event.type === 'tool_use') {
          if (isViewing) {
            const indicator = bubble.querySelector('.thinking-label');
            if (indicator) indicator.textContent = `Using ${event.tool}`;
          }
        } else if (event.type === 'document_update') {
          if (isViewing) {
            updateDocPreview(event.content);
            toast('Document updated', 'success');
          }
        } else if (event.type === 'error') {
          if (isViewing) bubble.textContent = `Error: ${event.content}`;
        }
      } catch {}
    }
  };

  xhr.onloadend = function () {
    clearInterval(thinkingTimer);
    clearInterval(timeTimer);
    delete streamingState[streamSessionId];

    // Only update UI if still viewing this session
    if (activeSessionId === streamSessionId) {
      const inlineThinking = bubble.querySelector('.inline-thinking');
      if (inlineThinking) inlineThinking.remove();
      if (!fullText && xhr.status !== 200) {
        bubble.textContent = `Error: Request failed (${xhr.status})`;
      } else if (fullText) {
        bubble.textContent = stripDocumentTags(fullText);
      } else {
        // No text response (e.g. only a document_update) — clear the thinking indicator
        bubble.textContent = 'Done — document updated.';
      }
      sendBtn.disabled = false;
      chatInput.focus();
    } else {
      // Response finished in background — mark as unread
      markSessionUnread(streamSessionId);
      const bgSession = sessions.find(s => s.id === streamSessionId);
      if (bgSession) bgSession.updated_at = new Date().toISOString();
      sendBtn.disabled = false;
    }
    renderSessionList();
  };

  // Append C3 brand instruction if toggle is on
  let finalMessage = text;
  if (c3BrandMode) {
    finalMessage += '\n\n[BRANDING: Apply C3 AI brand styling — black (#000000) and white palette, "C3 AI" wordmark, bold uppercase section headers with black backgrounds, clean sans-serif typography (Inter), black header bars with white text, accent borders, "C3 AI | Confidential" footer. Make it look like an official C3 AI document.]';
  }
  xhr.send(JSON.stringify({ message: finalMessage }));
}

// --- File Browser ---

async function loadFiles(dirPath) {
  const params = dirPath ? `?path=${encodeURIComponent(dirPath)}` : '';
  try {
    const res = await fetch(`/api/fs/list${params}`);
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }

    currentFilePath = data.path;
    filePathDisplay.textContent = data.path.replace(/^\/Users\/[^/]+/, '~');
    filePathDisplay.title = data.path;

    fileList.innerHTML = data.items.map(item => `
      <div class="fs-item ${item.isDir ? 'dir' : 'file'}" data-path="${esc(item.path)}" data-is-dir="${item.isDir}">
        <span class="fs-icon">${item.isDir ? '&#128193;' : fileIcon(item.name)}</span>
        <span class="fs-name">${esc(item.name)}</span>
      </div>
    `).join('');

    fileUpBtn.dataset.parent = data.parent;
  } catch (err) {
    toast(`Failed to load files: ${err.message}`, 'error');
  }
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const icons = {
    docx: '&#128462;', doc: '&#128462;', pdf: '&#128459;',
    html: '&#127760;', htm: '&#127760;',
    txt: '&#128196;', md: '&#128196;',
    png: '&#128444;', jpg: '&#128444;', jpeg: '&#128444;', gif: '&#128444;',
    js: '&#128221;', py: '&#128221;', ts: '&#128221;',
  };
  return icons[ext] || '&#128196;';
}

async function openFileInDoc(filePath) {
  const supportedExts = ['.docx', '.html', '.htm', '.txt', '.md'];
  const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
  if (!supportedExts.includes(ext)) {
    toast('Unsupported file type', 'error');
    return;
  }

  // Check if there's already a session for this file
  // We need to check documents in each session — look for matching save_path
  let existingSession = null;
  for (const s of sessions) {
    try {
      const docRes = await fetch(`/api/sessions/${s.id}/document`);
      const doc = await docRes.json();
      if (doc && doc.save_path === filePath) {
        existingSession = s;
        break;
      }
    } catch {}
  }

  if (existingSession) {
    // Switch to existing session for this file
    switchSession(existingSession.id);
    toast(`Switched to ${existingSession.title}`, 'success');
    return;
  }

  try {
    const res = await fetch(`/api/fs/read?path=${encodeURIComponent(filePath)}`);
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }

    // Create a new session for this file
    const filename = data.filename;
    const title = filename.replace(/\.[^.]+$/, '');
    const sessionRes = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const newSession = await sessionRes.json();
    sessions.unshift(newSession);

    // Save the document to the new session
    await fetch(`/api/sessions/${newSession.id}/document`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content: data.content,
        filename: data.filename,
        save_path: filePath,
      }),
    });

    // Switch to the new session (loads both chat + doc)
    renderSessionList();
    switchSession(newSession.id);
    toast(`Opened ${filename}`, 'success');
  } catch (err) {
    toast(`Failed to open file: ${err.message}`, 'error');
  }
}

// --- Save ---

async function saveDocument() {
  if (!currentDoc) {
    toast('No document to save', 'error');
    return;
  }

  if (currentDoc.save_path) {
    await saveToPath(currentDoc.save_path);
  } else {
    showSaveAs();
  }
}

function showSaveAs() {
  savePathInput.value = currentDoc?.save_path || `${currentFilePath || ''}/${currentDoc?.filename || 'document.html'}`;
  saveModal.classList.add('visible');
  savePathInput.focus();
  savePathInput.select();
}

function getCurrentDocContent() {
  const docPanel = $('#doc-panel');
  if (docPanel.classList.contains('source-view')) {
    return $('#doc-source').value;
  }
  const frame = document.getElementById('doc-frame');
  if (frame && frame.contentDocument && frame.contentDocument.body) {
    return frame.contentDocument.body.innerHTML;
  }
  return currentDoc?.content || '';
}

async function saveToPath(savePath) {
  try {
    const content = getCurrentDocContent();
    const res = await fetch('/api/fs/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: savePath, content }),
    });
    const data = await res.json();
    if (data.error) {
      toast(data.error, 'error');
      return;
    }

    await fetch(`/api/sessions/${activeSessionId}/document`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ save_path: savePath }),
    });

    if (currentDoc) currentDoc.save_path = savePath;
    toast(`Saved to ${savePath}`, 'success');
  } catch (err) {
    toast(`Failed to save: ${err.message}`, 'error');
  }
}

async function exportDocx() {
  if (!activeSessionId || !currentDoc) {
    toast('No document to export', 'error');
    return;
  }

  const defaultPath = currentDoc.save_path
    ? currentDoc.save_path.replace(/\.[^.]+$/, '.docx')
    : `${currentFilePath || ''}/${(currentDoc.filename || 'document').replace(/\.[^.]+$/, '')}.docx`;

  savePathInput.value = defaultPath;
  saveModal.classList.add('visible');
  savePathInput.focus();
  savePathInput.select();
}

// --- PDF Export ---

function exportPdf() {
  const frame = document.getElementById('doc-frame');
  if (!frame || !frame.contentDocument || !frame.contentDocument.body) {
    toast('No document to export', 'error');
    return;
  }
  const content = frame.contentDocument.documentElement.outerHTML;
  const win = window.open('', '_blank');
  win.document.write(content);
  win.document.close();
  win.print();
}

// --- Event Listeners ---

function setupEventListeners() {
  // New document
  newDocBtn.addEventListener('click', () => createSession());

  // Chat
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendMessage(chatInput.value);
  });

  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(chatInput.value);
    }
  });

  chatInput.addEventListener('input', () => autoResize(chatInput));

  // Welcome cards
  $('#welcome-new').addEventListener('click', () => {
    exitWelcomeMode();
    // Show empty state placeholder if no messages
    if (!messagesInner.innerHTML.trim()) {
      messagesInner.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">&#9998;</div>
          <div class="empty-state-text">Start a conversation.<br>Ask Claude to create or edit a document.</div>
        </div>
      `;
    }
    chatInput.focus();
  });
  $('#welcome-open').addEventListener('click', () => fileInput.click());
  $('#welcome-sharepoint').addEventListener('click', () => openSharePointModal());

  // SharePoint modal
  $('#sp-close').addEventListener('click', () => $('#sp-modal').classList.remove('visible'));
  $('#sp-search-btn').addEventListener('click', () => searchSharePoint($('#sp-search-input').value));
  $('#sp-search-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') searchSharePoint($('#sp-search-input').value);
    if (e.key === 'Escape') $('#sp-modal').classList.remove('visible');
  });

  // Doc toolbar
  $('#btn-upload').addEventListener('click', () => fileInput.click());
  $('#btn-save').addEventListener('click', saveDocument);
  $('#btn-save-as').addEventListener('click', showSaveAs);
  $('#btn-export-docx').addEventListener('click', exportDocx);
  $('#btn-export-pdf').addEventListener('click', exportPdf);
  $('#btn-copy-doc').addEventListener('click', copyDocToClipboard);

  // C3 Brandify — adds branding instruction to the prompt
  $('#btn-brandify').addEventListener('click', () => {
    c3BrandMode = !c3BrandMode;
    $('#btn-brandify').classList.toggle('active', c3BrandMode);
    toast(c3BrandMode ? 'C3 branding ON — next edit will apply C3 style' : 'C3 branding OFF', c3BrandMode ? 'success' : '');
  });
  $('#btn-undo').addEventListener('click', undoLastChange);
  $('#btn-versions').addEventListener('click', showVersionHistory);
  $('#versions-close').addEventListener('click', () => $('#versions-modal').classList.remove('visible'));

  // Send as email
  $('#btn-send-email').addEventListener('click', openEmailModal);
  $('#email-cancel').addEventListener('click', () => $('#email-modal').classList.remove('visible'));
  $('#email-copy').addEventListener('click', copyEmailDraft);
  $('#email-send').addEventListener('click', sendViaOutlook);

  // Presentation mode
  $('#btn-present').addEventListener('click', togglePresentationMode);

  // Find in document
  $('#btn-search-doc').addEventListener('click', toggleFindBar);
  $('#doc-find-close').addEventListener('click', () => { $('#doc-find-bar').style.display = 'none'; });
  $('#doc-find-input').addEventListener('input', (e) => findInDoc(e.target.value));
  $('#doc-find-next').addEventListener('click', () => findInDoc($('#doc-find-input').value, 'next'));
  $('#doc-find-prev').addEventListener('click', () => findInDoc($('#doc-find-input').value, 'prev'));

  // View toggle (Preview / Source) — icon buttons
  $$('.toolbar-icon-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      const docPanel = $('#doc-panel');
      const source = $('#doc-source');
      const frame = document.getElementById('doc-frame');

      // Update active button
      $('#btn-view-preview').classList.toggle('active', view === 'preview');
      $('#btn-view-source').classList.toggle('active', view === 'source');

      if (view === 'source') {
        let html = '';
        if (frame && frame.contentDocument && frame.contentDocument.body) {
          html = frame.contentDocument.body.innerHTML;
        } else if (currentDoc) {
          html = currentDoc.content;
        }
        source.value = html;
        docPanel.classList.add('source-view');
      } else {
        const edited = source.value;
        if (edited && currentDoc) {
          currentDoc.content = edited;
          renderInIframe(edited);
          fetch(`/api/sessions/${activeSessionId}/document`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: edited }),
          });
        }
        docPanel.classList.remove('source-view');
      }
    });
  });

  // Hide doc panel
  $('#btn-hide-doc').addEventListener('click', () => {
    $('#doc-panel').classList.add('hidden');
    $('#divider').style.display = 'none';
    $('#btn-show-doc').style.display = 'block';
  });

  // Show doc panel
  $('#btn-show-doc').addEventListener('click', () => {
    $('#doc-panel').classList.remove('hidden');
    $('#divider').style.display = '';
    $('#btn-show-doc').style.display = 'none';
    scaleDocPage();
  });

  // Sidebar collapse toggle
  $('#sidebar-toggle-btn').addEventListener('click', () => {
    $('#sidebar').classList.toggle('collapsed');
  });
  $('#sidebar-new-collapsed').addEventListener('click', () => createSession());

  // Tool chips
  $('#btn-sharepoint').addEventListener('click', () => openSharePointModal());

  $('#btn-tools-list').addEventListener('click', () => {
    chatInput.value = 'List all your available MCP tools and skills';
    sendMessage(chatInput.value);
  });

  // Open Claude.ai for design work
  $('#btn-claude-design').addEventListener('click', () => {
    window.open('https://claude.ai/design', '_blank');
  });

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // Create a new session for the uploaded file
    const title = file.name.replace(/\.[^.]+$/, '');
    const sessionRes = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    });
    const newSession = await sessionRes.json();
    sessions.unshift(newSession);
    renderSessionList();

    const form = new FormData();
    form.append('file', file);

    try {
      const res = await fetch(`/api/sessions/${newSession.id}/upload`, {
        method: 'POST',
        body: form,
      });
      const data = await res.json();
      if (data.error) {
        toast(data.error, 'error');
        return;
      }
      // Switch to the new session
      switchSession(newSession.id);
      toast(`Opened ${data.filename}`, 'success');
    } catch (err) {
      toast(`Upload failed: ${err.message}`, 'error');
    }
    fileInput.value = '';
  });

  // File browser
  fileUpBtn.addEventListener('click', () => {
    const parent = fileUpBtn.dataset.parent;
    if (parent) loadFiles(parent);
  });

  fileList.addEventListener('click', (e) => {
    const item = e.target.closest('.fs-item');
    if (!item) return;

    // SharePoint file
    if (item.classList.contains('sp-browse-item')) {
      const name = item.querySelector('.fs-name').textContent;
      openSharePointFile(item.dataset.path, item.dataset.site, name);
      return;
    }

    // Local file
    const itemPath = item.dataset.path;
    if (item.dataset.isDir === 'true') {
      loadFiles(itemPath);
      $('#file-search').value = '';
    } else {
      openFileInDoc(itemPath);
    }
  });

  // Save modal
  $('#save-cancel').addEventListener('click', () => saveModal.classList.remove('visible'));
  $('#save-confirm').addEventListener('click', () => {
    const savePath = savePathInput.value.trim();
    if (savePath) {
      saveToPath(savePath);
      saveModal.classList.remove('visible');
    }
  });

  savePathInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const savePath = savePathInput.value.trim();
      if (savePath) {
        saveToPath(savePath);
        saveModal.classList.remove('visible');
      }
    }
    if (e.key === 'Escape') saveModal.classList.remove('visible');
  });

  // File source toggle (Local / SharePoint)
  let fileSource = 'local';
  $$('.file-source-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      fileSource = btn.dataset.source;
      $$('.file-source-btn').forEach(b => b.classList.toggle('active', b === btn));
      const searchInput = $('#file-search');
      if (fileSource === 'sharepoint') {
        searchInput.placeholder = 'Search SharePoint...';
        $('#file-path-bar').style.display = 'none';
        fileList.innerHTML = '<div style="padding:12px;color:var(--subtext);font-size:12px;">Type to search SharePoint files</div>';
      } else {
        searchInput.placeholder = 'Search files...';
        $('#file-path-bar').style.display = '';
        searchInput.value = '';
        loadFiles(currentFilePath);
      }
    });
  });

  // File panel toggle
  const fileToggle = $('#file-toggle-btn');
  if (fileToggle) {
    fileToggle.addEventListener('click', () => {
      $('#file-panel').classList.toggle('collapsed');
    });
  }

  // Sidebar chat search
  $('#sidebar-search').addEventListener('input', (e) => {
    const q = e.target.value.toLowerCase();
    document.querySelectorAll('.session-item').forEach(item => {
      const title = item.querySelector('.session-title').textContent.toLowerCase();
      item.style.display = title.includes(q) || !q ? '' : 'none';
    });
  });

  // File search — recursive local or SharePoint search with debounce
  let fileSearchTimer = null;
  async function runFileSearch(q) {
      fileList.innerHTML = '<div style="padding:12px;color:var(--subtext);font-size:12px;">Searching<span class="thinking-dots-anim"></span></div>';

      if (fileSource === 'sharepoint') {
        // SharePoint search
        try {
          const res = await fetch('/api/sharepoint/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: q }),
          });
          const data = await res.json();
          if (!data.results || data.results.length === 0) {
            fileList.innerHTML = `<div style="padding:12px;color:var(--subtext);font-size:12px;">${data.message ? esc(data.message).substring(0, 200) : 'No results'}</div>`;
            return;
          }
          fileList.innerHTML = data.results.map(f => `
            <div class="fs-item file sp-browse-item" data-path="${esc(f.path || '')}" data-site="${esc(f.site || '')}" data-url="${esc(f.url || '')}">
              <span class="fs-icon">&#128196;</span>
              <span class="fs-name" title="${esc(f.path || f.name)}">${esc(f.name)}</span>
            </div>
          `).join('');
        } catch (err) {
          fileList.innerHTML = `<div style="padding:12px;color:var(--red);font-size:12px;">Search failed</div>`;
        }
      } else {
        // Local filesystem recursive search
        try {
          const res = await fetch(`/api/fs/search?q=${encodeURIComponent(q)}&path=${encodeURIComponent(currentFilePath || '')}`);
          const data = await res.json();
          if (data.results.length === 0) {
            fileList.innerHTML = '<div style="padding:12px;color:var(--subtext);font-size:12px;">No results</div>';
            return;
          }
          fileList.innerHTML = data.results.map(item => `
            <div class="fs-item ${item.isDir ? 'dir' : 'file'}" data-path="${esc(item.path)}" data-is-dir="${item.isDir}">
              <span class="fs-icon">${item.isDir ? '&#128193;' : '&#128196;'}</span>
              <span class="fs-name" title="${esc(item.path)}">${esc(item.name)}</span>
            </div>
          `).join('');
        } catch {}
      }
  }

  $('#file-search').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(fileSearchTimer);
      const q = e.target.value.trim();
      if (q && q.length >= 2) runFileSearch(q);
    }
  });

  $('#file-search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    clearTimeout(fileSearchTimer);
    if (!q || q.length < 2) {
      if (fileSource === 'local') loadFiles(currentFilePath);
      else fileList.innerHTML = '<div style="padding:12px;color:var(--subtext);font-size:12px;">Type to search SharePoint files</div>';
      return;
    }
    fileSearchTimer = setTimeout(() => runFileSearch(q), fileSource === 'sharepoint' ? 800 : 300);
  });

  // Panel resize
  setupResize();

  // Keyboard shortcuts — act like Electron app
  document.addEventListener('keydown', (e) => {
    // Escape exits presentation mode
    if (e.key === 'Escape' && presentationActive) {
      e.preventDefault();
      exitPresentationMode();
      return;
    }
    // Cmd+P toggles presentation mode (overrides print)
    if (e.metaKey && !e.shiftKey && e.key === 'p') {
      e.preventDefault();
      togglePresentationMode();
      return;
    }
    if (e.metaKey && e.key === 's') {
      e.preventDefault();
      saveDocument();
    }
    if (e.metaKey && e.key === 'f') {
      e.preventDefault();
      toggleFindBar();
    }
    if (e.metaKey && e.key === 'z' && !e.shiftKey) {
      // Only override Cmd+Z when not in a text input
      if (document.activeElement.tagName !== 'TEXTAREA' && document.activeElement.tagName !== 'INPUT') {
        e.preventDefault();
        undoLastChange();
      }
    }
    if (e.metaKey && e.key === 'w') {
      e.preventDefault();
      if (openTabs.length > 1) {
        closeOpenTab(activeSessionId);
      }
    }
    if (e.metaKey && e.key === 't') {
      e.preventDefault();
      createSession();
    }
    if (e.metaKey && e.key === 'n') {
      e.preventDefault();
      createSession();
    }
  });
}

// --- Panel Resize ---

function setupResize() {
  const divider = $('#divider');
  const chatPanel = $('#chat-panel');
  let startX, startWidth;

  divider.addEventListener('mousedown', (e) => {
    startX = e.clientX;
    startWidth = chatPanel.offsetWidth;
    divider.classList.add('dragging');

    const onMove = (e) => {
      const delta = e.clientX - startX;
      chatPanel.style.width = `${startWidth + delta}px`;
      chatPanel.style.flex = 'none';
    };

    const onUp = () => {
      divider.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// --- Helpers ---

function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function stripDocumentTags(text) {
  return text.replace(/<updated_document>[\s\S]*?<\/updated_document>/g, '[Document updated]').trim();
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function enterWelcomeMode() {
  $('#welcome-state').classList.add('visible');
  $('#messages').style.display = 'none';
  $('#main-area').classList.add('welcome-mode');
  populateWelcomeRecents();
}

function populateWelcomeRecents() {
  const container = $('#welcome-recents');
  // Show sessions that have documents (not empty ones)
  const withDocs = sessions.filter(s => s.title !== 'New Document').slice(0, 5);
  if (withDocs.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <div class="welcome-recents-label">Continue where you left off</div>
    ${withDocs.map(s => `
      <button class="welcome-recent-item" data-id="${s.id}">
        <span class="recent-icon">&#128196;</span>
        <span class="recent-title">${esc(s.title)}</span>
        <span class="recent-time">${relativeTime(s.updated_at || s.created_at)}</span>
      </button>
    `).join('')}
  `;
  container.querySelectorAll('.welcome-recent-item').forEach(btn => {
    btn.addEventListener('click', () => switchSession(btn.dataset.id));
  });
}

function exitWelcomeMode() {
  $('#welcome-state').classList.remove('visible');
  $('#messages').style.display = '';
  $('#main-area').classList.remove('welcome-mode');
}

function toast(message, type = '') {
  toastEl.textContent = message;
  toastEl.className = `visible ${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toastEl.className = '';
  }, 3000);
}

// --- Doc page scaling ---

// --- SharePoint Browse ---

function openSharePointModal() {
  $('#sp-modal').classList.add('visible');
  $('#sp-search-input').focus();
}

async function searchSharePoint(query) {
  const results = $('#sp-results');
  results.innerHTML = '<div style="text-align:center;color:var(--subtext);padding:40px 0;">Searching SharePoint<span class="thinking-dots-anim"></span></div>';

  try {
    const res = await fetch('/api/sharepoint/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();

    if (data.results && data.results.length > 0) {
      results.innerHTML = data.results.map(f => `
        <button class="sp-file-item" data-path="${esc(f.path || '')}" data-site="${esc(f.site || '')}">
          <span class="sp-file-icon">&#128196;</span>
          <div class="sp-file-info">
            <div class="sp-file-name">${esc(f.name)}</div>
            <div class="sp-file-meta">${esc(f.site || '')} ${f.modified ? '· ' + f.modified : ''}</div>
          </div>
        </button>
      `).join('');

      results.querySelectorAll('.sp-file-item').forEach(btn => {
        btn.addEventListener('click', () => openSharePointFile(btn.dataset.path, btn.dataset.site, btn.querySelector('.sp-file-name').textContent));
      });
    } else {
      const msg = data.message || 'No files found';
      results.innerHTML = `<div style="padding:20px;color:var(--subtext);font-size:13px;">${esc(msg)}</div>`;
    }
  } catch (err) {
    results.innerHTML = `<div style="padding:20px;color:var(--red);">Search failed: ${esc(err.message)}</div>`;
  }
}

async function openSharePointFile(filePath, site, filename) {
  const results = $('#sp-results');
  results.innerHTML = '<div style="text-align:center;color:var(--subtext);padding:40px 0;">Downloading file<span class="thinking-dots-anim"></span></div>';

  try {
    const res = await fetch('/api/sharepoint/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: filePath, site }),
    });
    const data = await res.json();

    if (data.content) {
      // Create new session for the SP file
      const title = filename.replace(/\.[^.]+$/, '');
      const sessionRes = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title }),
      });
      const newSession = await sessionRes.json();
      sessions.unshift(newSession);

      await fetch(`/api/sessions/${newSession.id}/document`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: data.content,
          filename: data.filename || filename,
        }),
      });

      renderSessionList();
      switchSession(newSession.id);
      $('#sp-modal').classList.remove('visible');
      toast(`Opened ${filename} from SharePoint`, 'success');
    } else {
      results.innerHTML = `<div style="padding:20px;color:var(--red);">${esc(data.error || 'Failed to download')}</div>`;
    }
  } catch (err) {
    results.innerHTML = `<div style="padding:20px;color:var(--red);">Download failed: ${esc(err.message)}</div>`;
  }
}

// --- Autosave ---

let autosaveTimer = null;

function scheduleAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (!activeSessionId || !currentDoc || !currentDoc.save_path) return;
    const content = getCurrentDocContent();
    if (content && content !== currentDoc.content) {
      fetch('/api/fs/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: currentDoc.save_path, content }),
      }).then(() => toast('Auto-saved', 'success'));
    }
  }, 5000);
}

// --- Undo / Version History ---

async function undoLastChange() {
  if (!activeSessionId) return;
  try {
    const res = await fetch(`/api/sessions/${activeSessionId}/versions`);
    const versions = await res.json();
    // Need at least 2 versions — current and previous
    if (versions.length < 2) {
      toast('Nothing to undo', '');
      return;
    }
    // versions[0] is current, versions[1] is previous
    const prevRes = await fetch(`/api/sessions/${activeSessionId}/versions/${versions[1].id}`);
    const prev = await prevRes.json();
    if (prev.content) {
      renderInIframe(prev.content);
      currentDoc.content = prev.content;
      // Save the revert as the new current
      await fetch(`/api/sessions/${activeSessionId}/document`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: prev.content }),
      });
      toast('Undone', 'success');
    }
  } catch (err) {
    toast('Undo failed', 'error');
  }
}

async function showVersionHistory() {
  if (!activeSessionId) return;
  const res = await fetch(`/api/sessions/${activeSessionId}/versions`);
  const versions = await res.json();
  const list = $('#versions-list');

  if (versions.length === 0) {
    list.innerHTML = '<div style="padding:20px;color:var(--subtext);text-align:center;">No versions yet</div>';
  } else {
    list.innerHTML = versions.map(v => `
      <button class="welcome-recent-item" data-version-id="${v.id}">
        <span class="recent-icon">${v.label === 'claude edit' ? '&#10022;' : '&#9998;'}</span>
        <span class="recent-title">${v.label || 'Edit'}</span>
        <span class="recent-time">${relativeTime(v.created_at)}</span>
      </button>
    `).join('');

    list.querySelectorAll('[data-version-id]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const vRes = await fetch(`/api/sessions/${activeSessionId}/versions/${btn.dataset.versionId}`);
        const vData = await vRes.json();
        if (vData.content) {
          renderInIframe(vData.content);
          currentDoc.content = vData.content;
          await fetch(`/api/sessions/${activeSessionId}/document`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content: vData.content }),
          });
          $('#versions-modal').classList.remove('visible');
          toast('Restored version', 'success');
        }
      });
    });
  }

  $('#versions-modal').classList.add('visible');
}

// --- Find in Document ---

function toggleFindBar() {
  const bar = $('#doc-find-bar');
  if (bar.style.display === 'none' || !bar.style.display) {
    bar.style.display = 'flex';
    $('#doc-find-input').focus();
    $('#doc-find-input').select();
  } else {
    bar.style.display = 'none';
    clearFindHighlights();
  }
}

let findMatches = [];
let findIndex = -1;
let lastFindQuery = '';

function findInDoc(query, direction) {
  const frame = document.getElementById('doc-frame');
  if (!frame || !frame.contentDocument) return;

  if (!query || query.length < 2) {
    clearFindHighlights();
    $('#doc-find-count').textContent = '';
    lastFindQuery = '';
    return;
  }

  // If query changed, rebuild highlights; otherwise just navigate
  if (query !== lastFindQuery) {
    clearFindHighlights();
    lastFindQuery = query;
    findIndex = -1;

    const body = frame.contentDocument.body;
    const walker = frame.contentDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    const matches = [];

    while (walker.nextNode()) {
      const node = walker.currentNode;
      const lowerText = node.textContent.toLowerCase();
      const lowerQuery = query.toLowerCase();
      let idx = lowerText.indexOf(lowerQuery);
      while (idx !== -1) {
        matches.push({ node, index: idx, length: query.length });
        idx = lowerText.indexOf(lowerQuery, idx + 1);
      }
    }

    if (matches.length === 0) {
      $('#doc-find-count').textContent = '0 results';
      findIndex = -1;
      return;
    }

    // Highlight all matches (reverse order to preserve offsets)
    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];
      try {
        const range = frame.contentDocument.createRange();
        range.setStart(m.node, m.index);
        range.setEnd(m.node, m.index + m.length);
        const span = frame.contentDocument.createElement('mark');
        span.className = 'find-highlight';
        span.style.cssText = 'background:#FBBF24;padding:1px 0;border-radius:2px;';
        range.surroundContents(span);
      } catch(e) {}
    }
  }

  // Navigate among existing highlights
  const marks = frame.contentDocument.querySelectorAll('.find-highlight');
  if (marks.length === 0) return;

  if (direction === 'prev') {
    findIndex = findIndex <= 0 ? marks.length - 1 : findIndex - 1;
  } else {
    findIndex = findIndex >= marks.length - 1 ? 0 : findIndex + 1;
  }

  marks.forEach((m, i) => {
    m.style.background = i === findIndex ? '#F59E0B' : '#FBBF24';
    m.style.outline = i === findIndex ? '2px solid #D97706' : 'none';
  });

  if (marks[findIndex]) marks[findIndex].scrollIntoView({ block: 'center', behavior: 'smooth' });
  $('#doc-find-count').textContent = `${findIndex + 1} of ${marks.length}`;
}

function clearFindHighlights() {
  const frame = document.getElementById('doc-frame');
  if (!frame || !frame.contentDocument) return;
  frame.contentDocument.querySelectorAll('.find-highlight').forEach(mark => {
    const parent = mark.parentNode;
    parent.replaceChild(frame.contentDocument.createTextNode(mark.textContent), mark);
    parent.normalize();
  });
  findMatches = [];
  findIndex = -1;
  lastFindQuery = '';
}

// --- Email ---

function openEmailModal() {
  if (!currentDoc) {
    toast('No document to send', 'error');
    return;
  }
  const title = docArtifactTitle.textContent || 'Document';
  $('#email-subject').value = title;
  $('#email-body').value = `Hi,\n\nPlease find attached "${title}" for your review.\n\nLet me know if you have any questions or would like to discuss.\n\nBest regards`;
  $('#email-modal').classList.add('visible');
  $('#email-to').focus();
}

async function copyEmailDraft() {
  const to = $('#email-to').value.trim();
  const subject = $('#email-subject').value.trim();
  const body = $('#email-body').value.trim();
  const draft = `To: ${to}\nSubject: ${subject}\n\n${body}`;
  try {
    await navigator.clipboard.writeText(draft);
    toast('Email draft copied', 'success');
  } catch {
    toast('Failed to copy', 'error');
  }
}

function sendViaOutlook() {
  const to = $('#email-to').value.trim();
  const subject = $('#email-subject').value.trim();
  const body = $('#email-body').value.trim();

  if (!to) {
    toast('Please enter a recipient', 'error');
    $('#email-to').focus();
    return;
  }

  // Close the modal
  $('#email-modal').classList.remove('visible');

  // Send via chat — Claude will use Outlook MCP
  const prompt = `Send an email via Outlook to ${to} with subject "${subject}" and the following body:\n\n${body}`;
  sendMessage(prompt);
}

// --- Presentation Mode ---

let presentationActive = false;
let presentationHintTimer = null;

function togglePresentationMode() {
  if (presentationActive) {
    exitPresentationMode();
  } else {
    enterPresentationMode();
  }
}

function enterPresentationMode() {
  const frame = document.getElementById('doc-frame');
  if (!frame || !frame.contentDocument || !frame.contentDocument.body) {
    toast('No document to present', 'error');
    return;
  }

  const overlay = $('#presentation-mode');
  const content = $('#presentation-content');
  const hint = $('#presentation-hint');

  // Get the full HTML from the doc iframe
  const docHtml = frame.contentDocument.documentElement.outerHTML;

  // Create an iframe for style isolation
  content.innerHTML = '';
  const pFrame = document.createElement('iframe');
  pFrame.sandbox = 'allow-same-origin';
  pFrame.srcdoc = docHtml;
  content.appendChild(pFrame);

  pFrame.onload = () => {
    try {
      const body = pFrame.contentDocument.body;
      pFrame.style.height = body.scrollHeight + 'px';
    } catch(e) {}
  };

  overlay.classList.add('visible');
  presentationActive = true;

  // Fade the hint after 3s
  hint.classList.remove('faded');
  clearTimeout(presentationHintTimer);
  presentationHintTimer = setTimeout(() => {
    hint.classList.add('faded');
  }, 3000);
}

function exitPresentationMode() {
  const overlay = $('#presentation-mode');
  overlay.classList.remove('visible');
  $('#presentation-content').innerHTML = '';
  presentationActive = false;
  clearTimeout(presentationHintTimer);
}

// --- Doc Page Scaling ---

function scaleDocPage() {
  const container = document.getElementById('doc-content');
  const frame = document.getElementById('doc-frame');
  if (!frame) return;

  const containerWidth = container.clientWidth - 64;
  const pageWidth = 816;

  if (containerWidth < pageWidth) {
    const scale = containerWidth / pageWidth;
    frame.style.transform = `scale(${scale})`;
    frame.style.transformOrigin = 'top center';
    frame.style.width = `${pageWidth}px`;
  } else {
    frame.style.transform = '';
    frame.style.transformOrigin = '';
    frame.style.width = `${pageWidth}px`;
  }
}

const docResizeObserver = new ResizeObserver(() => scaleDocPage());
docResizeObserver.observe(document.getElementById('doc-content'));

// --- Go ---
init();
