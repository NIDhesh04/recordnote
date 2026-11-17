import { escapeHtml, deriveClientSubjectCode, formatClientTime } from './js/utils.js';
import { renderMarkdown } from './js/markdown.js';
import { uploadFileWithProgress, createGdriveSession } from './js/api.js';
import { renderTranscriptChunks } from './js/transcript-view.js';

let currentSourceMode = 'local';
let selectedLocalFile = null;
let currentSessionId = null;
let currentSessionData = null;
let currentReaderTab = 'notes';
let activeEventSource = null;
let cachedSubjects = [];
let lastModifiedChunkIndex = null;

// DOM Elements
const newRecordingBtn = document.getElementById('newRecordingBtn');
const sidebarSubjectFilter = document.getElementById('sidebarSubjectFilter');
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

const subjectSelect = document.getElementById('subjectSelect');
const newSubjectFieldsBox = document.getElementById('newSubjectFieldsBox');
const newSubjectNameInput = document.getElementById('newSubjectNameInput');
const newSubjectCodeInput = document.getElementById('newSubjectCodeInput');

const gdriveUrlInput = document.getElementById('gdriveUrlInput');
const titleInput = document.getElementById('titleInput');
const topicInput = document.getElementById('topicInput');
const chunkSecSelect = document.getElementById('chunkSecSelect');
const trimStartInput = document.getElementById('trimStartInput');
const trimEndInput = document.getElementById('trimEndInput');
const localAudioPreviewWrap = document.getElementById('localAudioPreviewWrap');
const localAudioPreview = document.getElementById('localAudioPreview');
const setStartFromPlayerBtn = document.getElementById('setStartFromPlayerBtn');
const setEndFromPlayerBtn = document.getElementById('setEndFromPlayerBtn');
const clearTrimBtn = document.getElementById('clearTrimBtn');
const importForm = document.getElementById('importForm');
const startPipelineBtn = document.getElementById('startPipelineBtn');
const uploadProgressBarWrap = document.getElementById('uploadProgressBarWrap');
const uploadProgressLabel = document.getElementById('uploadProgressLabel');
const uploadProgressFill = document.getElementById('uploadProgressFill');
const formErrorBox = document.getElementById('formErrorBox');

// Session Detail DOM
const sessionCodeBadge = document.getElementById('sessionCodeBadge');
const sessionSubjectBadge = document.getElementById('sessionSubjectBadge');
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
const notesSyncBanner = document.getElementById('notesSyncBanner');
const notesSyncBannerText = document.getElementById('notesSyncBannerText');
const smartUpdateNotesBtn = document.getElementById('smartUpdateNotesBtn');
const fullRebuildNotesBannerBtn = document.getElementById('fullRebuildNotesBannerBtn');

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

// ============================================================================
// SUBJECTS DROPDOWN & FILTER
// ============================================================================

async function loadSubjects(selectedSubjectId = '') {
  try {
    const res = await fetch('/api/subjects');
    const data = await res.json();
    cachedSubjects = data.subjects || [];

    const currentVal = selectedSubjectId || subjectSelect.value;
    subjectSelect.innerHTML =
      cachedSubjects
        .map(
          (s) =>
            `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.code)}) — ${
              s.lectureCount || 0
            } lectures</option>`
        )
        .join('') + `<option value="__new__">+ Create New Subject in Database...</option>`;

    if (currentVal && currentVal !== '__new__' && cachedSubjects.some((s) => s.id === currentVal)) {
      subjectSelect.value = currentVal;
    } else if (cachedSubjects.length > 0) {
      subjectSelect.value = cachedSubjects[0].id;
    }

    newSubjectFieldsBox.classList.toggle('hidden', subjectSelect.value !== '__new__');

    const filterVal = sidebarSubjectFilter.value || 'all';
    sidebarSubjectFilter.innerHTML =
      `<option value="all">All Subjects</option>` +
      cachedSubjects
        .map(
          (s) =>
            `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)} (${escapeHtml(s.code)})</option>`
        )
        .join('');

    if (filterVal === 'all' || cachedSubjects.some((s) => s.id === filterVal)) {
      sidebarSubjectFilter.value = filterVal;
    }
  } catch (err) {
    console.error('Failed to load subjects from PostgreSQL:', err);
  }
}

subjectSelect.addEventListener('change', () => {
  const isNew = subjectSelect.value === '__new__';
  newSubjectFieldsBox.classList.toggle('hidden', !isNew);
  if (isNew) newSubjectNameInput.focus();
});

newSubjectNameInput.addEventListener('input', () => {
  newSubjectCodeInput.value = deriveClientSubjectCode(newSubjectNameInput.value);
});

sidebarSubjectFilter.addEventListener('change', () => {
  refreshSessionsList();
});

// ============================================================================
// IMPORT FORM & AUDIO TRIM CONTROLS
// ============================================================================

sourceTabs.forEach((btn) => {
  btn.addEventListener('click', () => {
    sourceTabs.forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentSourceMode = btn.dataset.source;
    localSourceBox.classList.toggle('hidden', currentSourceMode !== 'local');
    gdriveSourceBox.classList.toggle('hidden', currentSourceMode === 'local');
  });
});

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
  dropSub.textContent = 'Ready to normalize, smart-chunk, and transcribe into PostgreSQL.';
  if (!titleInput.value.trim()) {
    titleInput.value = file.name.replace(/\.[^/.]+$/, '').replace(/[_-]+/g, ' ');
  }

  try {
    localAudioPreview.src = URL.createObjectURL(file);
    localAudioPreviewWrap.classList.remove('hidden');
  } catch {
    localAudioPreviewWrap.classList.add('hidden');
  }
}

setStartFromPlayerBtn.addEventListener('click', () => {
  trimStartInput.value = formatClientTime(localAudioPreview.currentTime || 0);
});

setEndFromPlayerBtn.addEventListener('click', () => {
  if (localAudioPreview.currentTime > 0) {
    trimEndInput.value = formatClientTime(localAudioPreview.currentTime);
  }
});

clearTrimBtn.addEventListener('click', () => {
  trimStartInput.value = '';
  trimEndInput.value = '';
});

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

function showFormError(msg) {
  formErrorBox.textContent = msg;
  formErrorBox.classList.remove('hidden');
}

importForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  formErrorBox.classList.add('hidden');

  const isCreatingNewSubject = subjectSelect.value === '__new__';
  const subjectId = isCreatingNewSubject ? '' : subjectSelect.value;
  const newSubjectName = isCreatingNewSubject ? newSubjectNameInput.value.trim() : '';
  const newSubjectCode = isCreatingNewSubject ? newSubjectCodeInput.value.trim() : '';

  if (isCreatingNewSubject && !newSubjectName) {
    showFormError('Please enter a name for the new subject (e.g., Combinatorics or Operating Systems).');
    return;
  }

  const title = titleInput.value.trim();
  const topic = topicInput.value.trim();
  const chunkTargetSec = Number(chunkSecSelect.value || 300);
  const trimStart = trimStartInput.value.trim();
  const trimEnd = trimEndInput.value.trim();

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
      const created = await uploadFileWithProgress(
        selectedLocalFile,
        { subjectId, newSubjectName, newSubjectCode, title, topic, chunkTargetSec, trimStart, trimEnd },
        (pct) => {
          uploadProgressFill.style.width = `${pct}%`;
          uploadProgressLabel.textContent = `Uploading ${selectedLocalFile.name} (${pct}%)...`;
        }
      );
      uploadProgressBarWrap.classList.add('hidden');
      startPipelineBtn.disabled = false;
      newSubjectNameInput.value = '';
      newSubjectCodeInput.value = '';
      await loadSubjects(created.session.subjectId);
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
      const data = await createGdriveSession({
        subjectId,
        newSubjectName,
        newSubjectCode,
        gdriveUrl,
        title,
        topic,
        chunkTargetSec,
        trimStart,
        trimEnd
      });
      startPipelineBtn.disabled = false;
      newSubjectNameInput.value = '';
      newSubjectCodeInput.value = '';
      await loadSubjects(data.session.subjectId);
      await refreshSessionsList();
      await openSession(data.session.id);
    } catch (err) {
      startPipelineBtn.disabled = false;
      showFormError(err.message);
    }
  }
});

// ============================================================================
// SIDEBAR VAULT & SESSION DETAIL VIEW
// ============================================================================

async function refreshSessionsList() {
  try {
    const filterSubject = sidebarSubjectFilter.value || 'all';
    const res = await fetch(`/api/sessions?subjectId=${encodeURIComponent(filterSubject)}`);
    const data = await res.json();
    const sessions = data.sessions || [];
    sessionCountBadge.textContent = String(sessions.length);

    if (sessions.length === 0) {
      sessionListEl.innerHTML = `<div class="help-text" style="padding: 12px 6px;">No lectures stored for this subject filter yet.</div>`;
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
            <div class="session-item-title">
              <span class="sidebar-code-tag">${escapeHtml(s.code)}</span>${escapeHtml(s.title)}
            </div>
            <div class="session-item-meta">
              <span>${escapeHtml(s.subjectName)} • ${dur} • ${s.completedChunks}/${s.totalChunks || '?'} chunks</span>
              <span>${statusLabel}</span>
            </div>
          </div>
        `;
      })
      .join('');

    sessionListEl.querySelectorAll('.session-item').forEach((item) => {
      item.addEventListener('click', () => openSession(item.dataset.id));
    });
  } catch (err) {
    console.error('Failed to load lectures list:', err);
  }
}

function renderSidebarHighlight() {
  sessionListEl.querySelectorAll('.session-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.id === currentSessionId);
  });
}

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
        data.type === 'chunk_reprocessed' ||
        data.type === 'note_section_started' ||
        data.type === 'note_section_completed' ||
        data.type === 'session_completed' ||
        data.type === 'error'
      ) {
        if (data.type === 'chunk_reprocessed' && lastModifiedChunkIndex !== null) {
          notesSyncBannerText.textContent = `✓ ${data.chunkCode || 'Chunk'} was re-extracted and saved in PostgreSQL! Ready to update the structured lecture notes:`;
          notesSyncBanner.classList.remove('hidden');
        }
        if (data.type === 'session_completed') {
          lastModifiedChunkIndex = null;
          notesSyncBanner.classList.add('hidden');
        }
        await fetchAndRenderSessionDetails(sessionId);
        await refreshSessionsList();
        await loadSubjects();
      }
    } catch (e) {
      console.error('SSE parse error:', e);
    }
  };
}

function renderSessionUI(payload) {
  const { session, isRunning, comprehensiveNotesMarkdown } = payload;

  sessionCodeBadge.textContent = session.code;
  sessionSubjectBadge.textContent = `${session.subjectName} (${session.subjectCode})`;
  sessionTitleHeading.textContent = session.title;
  sessionTopicSub.textContent = session.topic
    ? `Topic Context: ${session.topic} • PostgreSQL ID: ${session.id}`
    : `Lecture Code: ${session.code} • PostgreSQL ID: ${session.id}`;

  sessionSourceBadge.textContent =
    session.sourceType === 'gdrive' ? '☁️ Google Drive' : `💻 ${session.originalFileName || 'Local Audio'}`;
  sessionDurationBadge.textContent = session.audioMetadata?.durationFormatted || 'Processing...';

  sessionStatusBadge.className = 'status-pill';
  if (session.status === 'completed') {
    sessionStatusBadge.classList.add('completed');
    sessionStatusBadge.textContent = 'Stored in PostgreSQL';
  } else if (session.status === 'error') {
    sessionStatusBadge.classList.add('error');
    sessionStatusBadge.textContent = 'Interrupted / Error';
  } else {
    sessionStatusBadge.classList.add('running');
    sessionStatusBadge.textContent = session.status.replace('_', ' ');
  }

  if (session.error) {
    sessionErrorBanner.textContent = `${session.error} — All completed chunks are safely stored in PostgreSQL (transcript_chunks). Click "Resume / Retry Pipeline" to continue.`;
    sessionErrorBanner.classList.remove('hidden');
  } else {
    sessionErrorBanner.classList.add('hidden');
  }

  resumeSessionBtn.classList.toggle('hidden', !(session.status === 'error' || (!isRunning && session.status !== 'completed')));

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

  chunkPillsStrip.innerHTML = chunks
    .map((c) => {
      const cls = c.status === 'completed' ? 'completed' : c.status === 'transcribing' ? 'transcribing' : '';
      const icon = c.status === 'completed' ? '✓' : c.status === 'transcribing' ? '⟳' : '•';
      return `<span class="chunk-pill ${cls}" data-chunk-idx="${c.index}" title="${escapeHtml(c.code)}: ${
        c.wordCount || 0
      } words">${icon} ${escapeHtml(c.code)} (${c.startFormatted}–${c.endFormatted})</span>`;
    })
    .join('');

  chunkPillsStrip.querySelectorAll('.chunk-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      switchReaderTab('transcript');
      const card = document.getElementById(`chunk-card-${pill.dataset.chunkIdx}`);
      if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });

  notesWordCountBadge.textContent = `${session.notesWords || 0} words`;
  transcriptWordCountBadge.textContent = `${session.fullTranscriptWords || 0} words`;

  exportNotesBtn.href = `/api/sessions/${encodeURIComponent(session.id)}/export/notes.md`;
  exportTranscriptBtn.href = `/api/sessions/${encodeURIComponent(session.id)}/export/transcript.md`;

  renderReaderContent(session, comprehensiveNotesMarkdown, readerSearchInput.value.trim(), isRunning);
}

function renderReaderContent(session, comprehensiveNotesMarkdown, searchQuery = '', isRunning = false) {
  if (comprehensiveNotesMarkdown && comprehensiveNotesMarkdown.trim()) {
    notesEmptyState.classList.add('hidden');
    notesMarkdownContainer.innerHTML = renderMarkdown(comprehensiveNotesMarkdown);

    notesMarkdownContainer.querySelectorAll('.ts-badge').forEach((badge) => {
      badge.title = 'Click to inspect the verbatim transcript chunk for this timestamp';
      badge.addEventListener('click', () => {
        const rawTs = badge.textContent.replace(/[\[\]]/g, '').trim();
        const parts = rawTs.split(':').map(Number);
        const sec = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
        const targetChunk =
          (session.chunks || []).find((c) => sec >= c.startTimeSec && sec <= c.endTimeSec) ||
          (session.chunks || [])[0];
        if (targetChunk) {
          switchReaderTab('transcript');
          const card = document.getElementById(`chunk-card-${targetChunk.index}`);
          if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  } else {
    notesEmptyState.classList.remove('hidden');
    notesMarkdownContainer.innerHTML = '';
  }

  renderTranscriptChunks({
    containerEl: transcriptChunksContainer,
    session,
    searchQuery,
    isRunning,
    onChunkModified: ({ chunkIndex, model, updateNotesFromHere, isManualEdit, message }) => {
      if (message) liveStatusText.textContent = message;
      if (!updateNotesFromHere) {
        lastModifiedChunkIndex =
          lastModifiedChunkIndex === null ? chunkIndex : Math.min(lastModifiedChunkIndex, chunkIndex);
        notesSyncBannerText.textContent = isManualEdit
          ? `✓ Chunk ${chunkIndex + 1} transcript was manually edited in PostgreSQL. Update the structured lecture notes?`
          : `⟳ Reprocessing Chunk ${chunkIndex + 1} (${session.code}-C${String(chunkIndex + 1).padStart(
              2,
              '0'
            )}) with ${model}... Once done, click here to update the structured lecture notes:`;
        notesSyncBanner.classList.remove('hidden');
      } else {
        lastModifiedChunkIndex = null;
        notesSyncBanner.classList.add('hidden');
      }
    },
    onRefreshSession: fetchAndRenderSessionDetails
  });
}

readerTabs.forEach((btn) => {
  btn.addEventListener('click', () => switchReaderTab(btn.dataset.tab));
});

function switchReaderTab(tabName) {
  currentReaderTab = tabName;
  readerTabs.forEach((b) => b.classList.toggle('active', b.dataset.tab === tabName));
  notesTabPane.classList.toggle('hidden', tabName !== 'notes');
  transcriptTabPane.classList.toggle('hidden', tabName === 'notes');
}

readerSearchInput.addEventListener('input', () => {
  if (!currentSessionData) return;
  renderReaderContent(
    currentSessionData.session,
    currentSessionData.comprehensiveNotesMarkdown,
    readerSearchInput.value.trim(),
    currentSessionData.isRunning
  );
});

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

resumeSessionBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/resume`, { method: 'POST' });
  await fetchAndRenderSessionDetails(currentSessionId);
});

regenerateNotesBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  notesSyncBanner.classList.add('hidden');
  lastModifiedChunkIndex = null;
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/regenerate-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  await fetchAndRenderSessionDetails(currentSessionId);
});

smartUpdateNotesBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  const startFrom = lastModifiedChunkIndex ?? 0;
  notesSyncBanner.classList.add('hidden');
  lastModifiedChunkIndex = null;
  switchReaderTab('notes');
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/regenerate-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startFromChunkIndex: startFrom })
  });
  await fetchAndRenderSessionDetails(currentSessionId);
});

fullRebuildNotesBannerBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  notesSyncBanner.classList.add('hidden');
  lastModifiedChunkIndex = null;
  switchReaderTab('notes');
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}/regenerate-notes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({})
  });
  await fetchAndRenderSessionDetails(currentSessionId);
});

deleteSessionBtn.addEventListener('click', async () => {
  if (!currentSessionId) return;
  if (!confirm('Delete this lecture and all its chunks/notes from PostgreSQL?')) return;
  await fetch(`/api/sessions/${encodeURIComponent(currentSessionId)}`, { method: 'DELETE' });
  currentSessionId = null;
  currentSessionData = null;
  sessionView.classList.add('hidden');
  importView.classList.remove('hidden');
  await loadSubjects();
  await refreshSessionsList();
});

// Initial Boot
loadSubjects().then(() => refreshSessionsList());
