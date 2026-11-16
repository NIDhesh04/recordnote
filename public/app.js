let currentSourceMode = 'local';
let selectedLocalFile = null;
let currentSessionId = null;
let currentSessionData = null;
let currentReaderTab = 'notes';
let activeEventSource = null;

// DOM Elements
const newRecordingBtn = document.getElementById('newRecordingBtn');
const sessionCountBadge = document.getElementById('sessionCountBadge');
const sessionListEl = document.getElementById('sessionList');

const importView = document.getElementById('importView');
const sessionView = document.getElementById('sessionView');

const sourceTabs = document.querySelectorAll('.source-tab');
const localSourceBox = document.getElementById('localSourceBox');
const gdriveSourceBox = document.getElementById('gdriveSourceBox');

const dropZone = document.getElementById('dropZone');
const audioFileInput = document.getElementById('audioFileInput');
const browseFileBtn = document.getElementById('browseFileBtn');
const dropTitle = document.getElementById('dropTitle');
const dropSub = document.getElementById('dropSub');

const gdriveUrlInput = document.getElementById('gdriveUrlInput');
const titleInput = document.getElementById('titleInput');
const topicInput = document.getElementById('topicInput');
const chunkSecSelect = document.getElementById('chunkSecSelect');
const importForm = document.getElementById('importForm');
const startPipelineBtn = document.getElementById('startPipelineBtn');
const uploadProgressBarWrap = document.getElementById('uploadProgressBarWrap');
const uploadProgressLabel = document.getElementById('uploadProgressLabel');
const uploadProgressFill = document.getElementById('uploadProgressFill');
const formErrorBox = document.getElementById('formErrorBox');

// Session Detail DOM
const sessionStatusBadge = document.getElementById('sessionStatusBadge');
const sessionSourceBadge = document.getElementById('sessionSourceBadge');
const sessionDurationBadge = document.getElementById('sessionDurationBadge');
const sessionTitleHeading = document.getElementById('sessionTitleHeading');
const sessionTopicSub = document.getElementById('sessionTopicSub');
const resumeSessionBtn = document.getElementById('resumeSessionBtn');
const regenerateNotesBtn = document.getElementById('regenerateNotesBtn');
const deleteSessionBtn = document.getElementById('deleteSessionBtn');

const liveStatusText = document.getElementById('liveStatusText');
const liveStatsText = document.getElementById('liveStatsText');
const liveProgressFill = document.getElementById('liveProgressFill');
const chunkPillsStrip = document.getElementById('chunkPillsStrip');
const sessionErrorBanner = document.getElementById('sessionErrorBanner');

const readerTabs = document.querySelectorAll('.reader-tab');
const notesWordCountBadge = document.getElementById('notesWordCountBadge');
const transcriptWordCountBadge = document.getElementById('transcriptWordCountBadge');
const readerSearchInput = document.getElementById('readerSearchInput');
const copyCurrentTabBtn = document.getElementById('copyCurrentTabBtn');
const exportNotesBtn = document.getElementById('exportNotesBtn');
const exportTranscriptBtn = document.getElementById('exportTranscriptBtn');

const notesTabPane = document.getElementById('notesTabPane');
const notesEmptyState = document.getElementById('notesEmptyState');
const notesMarkdownContainer = document.getElementById('notesMarkdownContainer');
const transcriptTabPane = document.getElementById('transcriptTabPane');
const transcriptChunksContainer = document.getElementById('transcriptChunksContainer');

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Clean, dependency-free Markdown to HTML renderer tailored for comprehensive lecture notes.
 */
function renderMarkdown(md) {
  if (!md || !md.trim()) return '';

  // Extract fenced code blocks first
  const codeBlocks = [];
  let text = md.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
    const idx = codeBlocks.length;
    codeBlocks.push(`<pre><code class="lang-${escapeHtml(lang)}">${escapeHtml(code.trimEnd())}</code></pre>`);
    return `@@CODEBLOCK_${idx}@@`;
  });

  const lines = text.split(/\r?\n/);
  const out = [];
  let inList = false;
  let listType = 'ul';

  const closeList = () => {
    if (inList) {
      out.push(`</${listType}>`);
      inList = false;
    }
  };

  const formatInline = (line) => {
    let s = escapeHtml(line);
    // Inline code
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    // Bold
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    // Timestamp badges [00:12] or [01:12:04]
    s = s.replace(/\[(\d{2}:\d{2}(?::\d{2})?)\]/g, '<code class="ts-badge">[$1]</code>');
    return s;
  };

  for (let raw of lines) {
    const trimmed = raw.trim();

    if (/^@@CODEBLOCK_(\d+)@@$/.test(trimmed)) {
      closeList();
      const idx = Number(trimmed.match(/^@@CODEBLOCK_(\d+)@@$/)[1]);
      out.push(codeBlocks[idx]);
      continue;
    }

    if (!trimmed) {
      closeList();
      continue;
    }

    if (/^---+$/.test(trimmed)) {
      closeList();
      out.push('<hr />');
      continue;
    }

    if (trimmed.startsWith('#### ')) {
      closeList();
      out.push(`<h4>${formatInline(trimmed.slice(5))}</h4>`);
      continue;
    }
    if (trimmed.startsWith('### ')) {
      closeList();
      out.push(`<h3>${formatInline(trimmed.slice(4))}</h3>`);
      continue;
    }
    if (trimmed.startsWith('## ')) {
      closeList();
      out.push(`<h2>${formatInline(trimmed.slice(3))}</h2>`);
      continue;
    }
    if (trimmed.startsWith('# ')) {
      closeList();
      out.push(`<h1>${formatInline(trimmed.slice(2))}</h1>`);
      continue;
    }

    if (trimmed.startsWith('> ')) {
      closeList();
      const quoteBody = trimmed.slice(2).replace(/^\[!(IMPORTANT|NOTE|TIP|WARNING)\]\s*/i, '<strong>$1:</strong> ');
      out.push(`<blockquote>${formatInline(quoteBody)}</blockquote>`);
      continue;
    }

    const ulMatch = raw.match(/^\s*[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inList || listType !== 'ul') {
        closeList();
        out.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      out.push(`<li>${formatInline(ulMatch[1])}</li>`);
      continue;
    }

    const olMatch = raw.match(/^\s*\d+\.\s+(.+)$/);
    if (olMatch) {
      if (!inList || listType !== 'ol') {
        closeList();
        out.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      out.push(`<li>${formatInline(olMatch[1])}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${formatInline(trimmed)}</p>`);
  }

  closeList();
  return out.join('\n');
}

// Switch between Local Upload and Google Drive Import
sourceTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    sourceTabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentSourceMode = btn.dataset.source;
    if (currentSourceMode === 'local') {
      localSourceBox.classList.remove('hidden');
      gdriveSourceBox.classList.add('hidden');
    } else {
      localSourceBox.classList.add('hidden');
      gdriveSourceBox.classList.remove('hidden');
    }
  });
});

// File Selection & Drag-and-Drop
browseFileBtn.addEventListener('click', () => audioFileInput.click());
dropZone.addEventListener('click', (e) => {
  if (e.target !== browseFileBtn) audioFileInput.click();
});

audioFileInput.addEventListener('change', () => {
  if (audioFileInput.files && audioFileInput.files[0]) {
    selectLocalFile(audioFileInput.files[0]);
  }
});

dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('dragover');
});

dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  if (e.dataTransfer.files && e.dataTransfer.files[0]) {
    selectLocalFile(e.dataTransfer.files[0]);
  }
});

function selectLocalFile(file) {
  selectedLocalFile = file;
  const mb = (file.size / (1024 * 1024)).toFixed(2);
  dropTitle.innerHTML = `Selected: <strong>${escapeHtml(file.name)}</strong> (${mb} MB)`;
  dropSub.textContent = 'Ready to normalize, smart-chunk, and transcribe verbatim.';
  if (!titleInput.value.trim()) {
    titleInput.value = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
  }
}

// Show Import View
newRecordingBtn.addEventListener('click', () => {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }
  currentSessionId = null;
  sessionView.classList.add('hidden');
  importView.classList.remove('hidden');
  renderSidebarHighlight();
});

// Submit Import Form
importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formErrorBox.classList.add('hidden');

  const title = titleInput.value.trim();
  const topic = topicInput.value.trim();
  const chunkTargetSec = Number(chunkSecSelect.value || 300);

  if (currentSourceMode === 'local') {
    if (!selectedLocalFile) {
      showFormError('Please select or drag-and-drop an audio file (.mp3, .aac, .m4a, .wav, etc.) from your computer.');
      return;
    }

    startPipelineBtn.disabled = true;
    uploadProgressBarWrap.classList.remove('hidden');
    uploadProgressFill.style.width = '0%';
    uploadProgressLabel.textContent = `Uploading ${selectedLocalFile.name}...`;

    try {
      const created = await uploadFileWithProgress(selectedLocalFile, {
        title,
        topic,
        chunkTargetSec
      });
      uploadProgressBarWrap.classList.add('hidden');
      startPipelineBtn.disabled = false;
      await refreshSessionsList();
      await openSession(created.session.id);
    } catch (err) {
      uploadProgressBarWrap.classList.add('hidden');
      startPipelineBtn.disabled = false;
      showFormError(err.message || 'Upload failed.');
    }
  } else {
    const gdriveUrl = gdriveUrlInput.value.trim();
    if (!gdriveUrl) {
      showFormError('Please paste a Google Drive shared link or File ID.');
      return;
    }

    startPipelineBtn.disabled = true;
    try {
      const res = await fetch('/api/sessions/gdrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gdriveUrl, title, topic, chunkTargetSec })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start Google Drive import.');
      startPipelineBtn.disabled = false;
      await refreshSessionsList();
      await openSession(data.session.id);
    } catch (err) {
      startPipelineBtn.disabled = false;
      showFormError(err.message);
    }
  }
});

function showFormError(msg) {
  formErrorBox.textContent = msg;
  formErrorBox.classList.remove('hidden');
}

function uploadFileWithProgress(file, { title, topic, chunkTargetSec }) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sessions/upload', true);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Title', encodeURIComponent(title || file.name));
    xhr.setRequestHeader('X-Topic', encodeURIComponent(topic || ''));
    xhr.setRequestHeader('X-Chunk-Sec', String(chunkTargetSec || 300));

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) {
        const pct = Math.round((ev.loaded / ev.total) * 100);
        uploadProgressFill.style.width = `${pct}%`;
        uploadProgressLabel.textContent = `Uploading ${file.name} (${pct}%)...`;
      }
    };

    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText || '{}');
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve(body);
        } else {
          reject(new Error(body.error || `Upload failed with status ${xhr.status}`));
        }
      } catch (err) {
        reject(err);
      }
    };

    xhr.onerror = () => reject(new Error('Network error during file upload'));
    xhr.send(file);
  });
}

// Fetch and render sidebar sessions list
async function refreshSessionsList() {
  try {
    const res = await fetch('/api/sessions');
    const data = await res.json();
    const sessions = data.sessions || [];
    sessionCountBadge.textContent = String(sessions.length);

    if (sessions.length === 0) {
      sessionListEl.innerHTML = `<div class="help-text" style="padding: 12px 6px;">No recordings stored yet. Import an .mp3, .aac, or Google Drive link to begin.</div>`;
      return;
    }

    sessionListEl.innerHTML = sessions
      .map((s) => {
        const isActive = s.id === currentSessionId ? 'active' : '';
        const dur = s.audioMetadata?.durationFormatted || '--:--';
        const statusLabel =
          s.status === 'completed'
            ? '✓ Done'
            : s.status === 'error'
            ? '⚠ Interrupted'
            : '⟳ Running';
        return `
          <div class="session-item ${isActive}" data-id="${escapeHtml(s.id)}">
            <div class="session-item-title">${escapeHtml(s.title)}</div>
            <div class="session-item-meta">
              <span>${dur} • ${s.completedChunks}/${s.totalChunks || '?'} chunks</span>
              <span>${statusLabel}</span>
            </div>
          </div>
        `;
      })
      .join('');

    sessionListEl.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', () => {
        openSession(item.dataset.id);
      });
    });
  } catch (err) {
    console.error('Failed to load sessions list:', err);
  }
}

function renderSidebarHighlight() {
  sessionListEl.querySelectorAll('.session-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === currentSessionId);
  });
}

// Open a session detail view & subscribe to live SSE updates
async function openSession(sessionId) {
  currentSessionId = sessionId;
  renderSidebarHighlight();

  importView.classList.add('hidden');
  sessionView.classList.remove('hidden');

  await fetchAndRenderSessionDetails(sessionId);
  connectSessionEventStream(sessionId);
}

async function fetchAndRenderSessionDetails(sessionId) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
  if (!res.ok) return;
  const payload = await res.json();
  currentSessionData = payload;
  renderSessionUI(payload);
}

function connectSessionEventStream(sessionId) {
  if (activeEventSource) {
    activeEventSource.close();
    activeEventSource = null;
  }

  const es = new EventSource(`/api/sessions/${encodeURIComponent(sessionId)}/events`);
  activeEventSource = es;

  es.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.message) {
        liveStatusText.textContent = data.message;
      }
      if (
        data.type === 'chunks_ready' ||
        data.type === 'chunk_started' ||
        data.type === 'chunk_completed' ||
        data.type === 'note_section_started' ||
        data.type === 'note_section_completed' ||
        data.type === 'session_completed' ||
        data.type === 'error'
      ) {
        await fetchAndRenderSessionDetails(sessionId);
        await refreshSessionsList();
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };
}

function renderSessionUI(payload) {
  const { session, isRunning, fullTranscriptMarkdown, comprehensiveNotesMarkdown } = payload;

  sessionTitleHeading.textContent = session.title;
  sessionTopicSub.textContent = session.topic ? `Topic Context: ${session.topic}` : `Session ID: ${session.id}`;

  sessionSourceBadge.textContent =
    session.sourceType === 'gdrive' ? '☁️ Google Drive' : `💻 ${session.originalFileName || 'Local Audio'}`;
  sessionDurationBadge.textContent = session.audioMetadata?.durationFormatted || 'Processing...';

  // Status badge
  sessionStatusBadge.className = 'status-pill';
  if (session.status === 'completed') {
    sessionStatusBadge.classList.add('completed');
    sessionStatusBadge.textContent = 'Completed & Stored';
  } else if (session.status === 'error') {
    sessionStatusBadge.classList.add('error');
    sessionStatusBadge.textContent = 'Interrupted / Error';
  } else {
    sessionStatusBadge.classList.add('running');
    sessionStatusBadge.textContent = session.status.replace('_', ' ');
  }

  // Error banner & Resume button
  if (session.error) {
    sessionErrorBanner.textContent = `${session.error} — All completed chunks are safely stored on disk. Click "Resume / Retry Pipeline" to continue from where it paused.`;
    sessionErrorBanner.classList.remove('hidden');
  } else {
    sessionErrorBanner.classList.add('hidden');
  }

  if (session.status === 'error' || (!isRunning && session.status !== 'completed')) {
    resumeSessionBtn.classList.remove('hidden');
  } else {
    resumeSessionBtn.classList.add('hidden');
  }

  // Live progress calculation
  const chunks = session.chunks || [];
  const completedChunks = chunks.filter((c) => c.status === 'completed').length;
  const noteSections = session.noteSections || [];
  const completedNotes = noteSections.filter((n) => n.status === 'completed').length;

  let progressPct = 10;
  if (session.status === 'completed') {
    progressPct = 100;
  } else if (chunks.length > 0) {
    const chunkWeight = (completedChunks / chunks.length) * 65;
    const noteWeight = noteSections.length > 0 ? (completedNotes / noteSections.length) * 25 : 0;
    progressPct = Math.min(98, Math.round(10 + chunkWeight + noteWeight));
  }

  liveProgressFill.style.width = `${progressPct}%`;
  liveStatusText.textContent = session.statusMessage || 'Ready';
  liveStatsText.textContent = `${completedChunks}/${chunks.length} Chunks Stored • ${
    session.fullTranscriptWords || 0
  } Transcript Words • ${session.notesWords || 0} Note Words`;

  // Render chunk pills strip
  chunkPillsStrip.innerHTML = chunks
    .map((c) => {
      const cls = c.status === 'completed' ? 'completed' : c.status === 'transcribing' ? 'transcribing' : '';
      const icon = c.status === 'completed' ? '✓' : c.status === 'transcribing' ? '⟳' : '•';
      return `<span class="chunk-pill ${cls}" data-chunk-idx="${c.index}" title="Chunk ${c.index + 1}: ${c.wordCount || 0} words">${icon} Chunk ${
        c.index + 1
      } (${c.startFormatted}–${c.endFormatted})</span>`;
    })
    .join('');

  chunkPillsStrip.querySelectorAll('.chunk-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      switchReaderTab('transcript');
      const card = document.getElementById(`chunk-card-${pill.dataset.chunkIdx}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  // Word counts & export links
  notesWordCountBadge.textContent = `${session.notesWords || 0} words`;
  transcriptWordCountBadge.textContent = `${session.fullTranscriptWords || 0} words`;

  exportNotesBtn.href = `/api/sessions/${encodeURIComponent(session.id)}/export/notes.md`;
  exportTranscriptBtn.href = `/api/sessions/${encodeURIComponent(session.id)}/export/transcript.md`;

  renderReaderContent(session, comprehensiveNotesMarkdown, readerSearchInput.value.trim());
}

function renderReaderContent(session, comprehensiveNotesMarkdown, searchQuery = '') {
  // 1. Render Comprehensive Notes
  if (comprehensiveNotesMarkdown && comprehensiveNotesMarkdown.trim()) {
    notesEmptyState.classList.add('hidden');
    let mdToRender = comprehensiveNotesMarkdown;
    notesMarkdownContainer.innerHTML = renderMarkdown(mdToRender);
  } else {
    notesEmptyState.classList.remove('hidden');
    notesMarkdownContainer.innerHTML = '';
  }

  // 2. Render Stored Verbatim Transcript Chunks
  const chunks = session.chunks || [];
  const completedChunks = chunks.filter((c) => c.status === 'completed' && c.transcriptText);

  if (completedChunks.length === 0) {
    transcriptChunksContainer.innerHTML = `
      <div class="empty-state">
        <h3>Waiting for First Audio Chunk...</h3>
        <p>Each 5-minute audio chunk is saved permanently to disk and displayed here the moment Gemini finishes transcribing it.</p>
      </div>
    `;
    return;
  }

  const q = searchQuery.toLowerCase();
  const filtered = q
    ? completedChunks.filter((c) => c.transcriptText.toLowerCase().includes(q))
    : completedChunks;

  transcriptChunksContainer.innerHTML = filtered
    .map((c) => {
      return `
        <div class="transcript-card" id="chunk-card-${c.index}">
          <div class="transcript-card-header">
            <span class="transcript-card-title">Segment ${c.index + 1} — [${c.startFormatted} to ${c.endFormatted}]</span>
            <span class="transcript-card-meta">${c.wordCount || 0} words • Stored on disk (${escapeHtml(
        c.modelUsed || 'Gemini Flash'
      )})</span>
          </div>
          <div class="transcript-card-body">${escapeHtml(c.transcriptText)}</div>
        </div>
      `;
    })
    .join('');
}

// Reader Tab Switching
readerTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    switchReaderTab(btn.dataset.tab);
  });
});

function switchReaderTab(tabName) {
  currentReaderTab = tabName;
  readerTabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  if (tabName === 'notes') {
    notesTabPane.classList.remove('hidden');
    transcriptTabPane.classList.add('hidden');
  } else {
    notesTabPane.classList.add('hidden');
    transcriptTabPane.classList.remove('hidden');
  }
}

// Search Filter
readerSearchInput.addEventListener('input', () => {
  if (!currentSessionData) return;
  renderReaderContent(
    currentSessionData.session,
    currentSessionData.comprehensiveNotesMarkdown,
    readerSearchInput.value.trim()
  );
});

// Copy Current Tab Content
copyCurrentTabBtn.addEventListener('click', async () => {
  if (!currentSessionData) return;
  const textToCopy =
    currentReaderTab === 'notes'
      ? currentSessionData.comprehensiveNotesMarkdown
      : currentSessionData.fullTranscriptMarkdown;

  if (!textToCopy) return;
  await navigator.clipboard.writeText(textToCopy);
  const orig = copyCurrentTabBtn.textContent;
  copyCurrentTabBtn.textContent = '✓ Copied!';
  setTimeout(() => {
    copyCurrentTabBtn.textContent = orig;
  }, 1800);
});

// Resume / Regenerate / Delete Actions
resumeSessionBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/resume`, { method: 'POST' });
  await fetchAndRenderSessionDetails(currentSessionId);
});

regenerateNotesBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/regenerate-notes`, { method: 'POST' });
  await fetchAndRenderSessionDetails(currentSessionId);
});

deleteSessionBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  if (!confirm('Delete this stored recording session and its transcripts?')) return;
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`, { method: 'DELETE' });
  currentSessionId = null;
  currentSessionData = null;
  sessionView.classList.add('hidden');
  importView.classList.remove('hidden');
  await refreshSessionsList();
});

// Initial Boot
refreshSessionsList();
