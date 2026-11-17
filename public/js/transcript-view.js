import { escapeHtml } from './utils.js';
import { requestChunkRetranscribe, requestSaveChunkEdit } from './api.js';

export function renderTranscriptChunks({
  containerEl,
  session,
  searchQuery = '',
  isRunning = false,
  onChunkModified,
  onRefreshSession
}) {
  const chunks = session.chunks || [];
  if (chunks.length === 0) {
    containerEl.innerHTML = `
      <div class="empty-state">
        <h3>Waiting for Audio Chunks...</h3>
        <p>Each 5-minute audio chunk is saved permanently to PostgreSQL (<code>transcript_chunks</code>) and displayed here.</p>
      </div>
    `;
    return;
  }

  const q = searchQuery.toLowerCase();
  const filtered = q
    ? chunks.filter((c) => (c.transcriptText || '').toLowerCase().includes(q))
    : chunks;

  containerEl.innerHTML = filtered
    .map((c) => {
      const audioSrc = `/api/sessions/${encodeURIComponent(session.id)}/chunks/${c.index}/audio`;
      const isTranscribing = Boolean(isRunning && c.status === 'transcribing');
      const bodyText = c.transcriptText
        ? escapeHtml(c.transcriptText)
        : isTranscribing
        ? '⟳ Extracting verbatim transcript with anti-hallucination guardrails...'
        : 'Pending transcription...';

      return `
        <div class="transcript-card" id="chunk-card-${c.index}" data-chunk-idx="${c.index}">
          <div class="transcript-card-header">
            <span class="transcript-card-title">[${escapeHtml(c.code)}] Segment ${c.index + 1} — (${
        c.startFormatted
      } to ${c.endFormatted})</span>
            <span class="transcript-card-meta">${c.wordCount || 0} words • Model: <strong>${escapeHtml(
        c.modelUsed || 'gemini-2.5-flash'
      )}</strong></span>
          </div>

          <div class="chunk-audio-row">
            <span>🔊 Listen (${c.startFormatted}–${c.endFormatted}):</span>
            <audio controls preload="none" src="${audioSrc}"></audio>
          </div>

          <div class="transcript-card-body" id="chunk-body-${c.index}">${bodyText}</div>

          <div class="hidden" id="chunk-edit-wrap-${c.index}">
            <textarea class="chunk-edit-textarea" id="chunk-edit-input-${c.index}">${escapeHtml(
        c.transcriptText || ''
      )}</textarea>
            <div style="display: flex; gap: 8px; margin-top: 8px;">
              <button type="button" class="btn btn-primary btn-sm save-chunk-edit-btn" data-idx="${c.index}">
                ✓ Save Transcript to PostgreSQL
              </button>
              <button type="button" class="btn btn-secondary btn-sm cancel-chunk-edit-btn" data-idx="${c.index}">
                Cancel
              </button>
            </div>
          </div>

          <div class="chunk-reprocess-bar">
            <select class="chunk-model-select" id="chunk-model-${c.index}" title="Choose model to re-extract ONLY this chunk">
              <option value="gemini-2.5-pro" selected>✦ Gemini 2.5 Pro (Deep Accuracy / Fix Hallucination)</option>
              <option value="gemini-2.5-flash">⚡ Gemini 2.5 Flash (Fast + Anti-Loop Guardrails)</option>
              <option value="gemini-2.0-flash">⚡ Gemini 2.0 Flash (Alternative Fast Model)</option>
            </select>

            <label class="chunk-checkbox-label" title="Run FFmpeg highpass/lowpass vocal isolation & dynamic boost before sending to Gemini">
              <input type="checkbox" id="chunk-enhance-${c.index}" checked />
              Speech-Boost &amp; Anti-Loop
            </label>

            <input
              type="text"
              class="chunk-hint-input"
              id="chunk-hint-${c.index}"
              placeholder="Optional hint (e.g., ignore background hum, focus on proof)..."
            />

            <button
              type="button"
              class="btn btn-primary btn-sm reprocess-chunk-btn"
              data-idx="${c.index}"
              data-update-notes="false"
              ${isTranscribing ? 'disabled' : ''}
            >
              ${isTranscribing ? '⟳ Processing...' : '↻ Reprocess Chunk'}
            </button>

            <button
              type="button"
              class="btn btn-secondary btn-sm reprocess-chunk-btn"
              data-idx="${c.index}"
              data-update-notes="true"
              title="Re-extract this chunk and immediately update lecture notes from this chunk onward"
              ${isTranscribing ? 'disabled' : ''}
            >
              ⚡ Reprocess + Update Notes
            </button>

            <button
              type="button"
              class="btn btn-secondary btn-sm toggle-chunk-edit-btn"
              data-idx="${c.index}"
            >
              ✏️ Edit Text
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  // Bind Per-Chunk Reprocess Buttons
  containerEl.querySelectorAll('.reprocess-chunk-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const updateNotesFromHere = btn.dataset.updateNotes === 'true';
      const modelSelect = document.getElementById(`chunk-model-${idx}`);
      const enhanceCheck = document.getElementById(`chunk-enhance-${idx}`);
      const hintInput = document.getElementById(`chunk-hint-${idx}`);

      const model = modelSelect ? modelSelect.value : 'gemini-2.5-pro';
      const enhanceAudio = enhanceCheck ? enhanceCheck.checked : true;
      const customHint = hintInput ? hintInput.value.trim() : '';

      btn.disabled = true;
      const origText = btn.textContent;
      btn.textContent = `⟳ Running ${model}...`;

      try {
        const data = await requestChunkRetranscribe(session.id, idx, {
          model,
          enhanceAudio,
          customHint,
          updateNotesFromHere
        });

        if (onChunkModified) {
          onChunkModified({
            chunkIndex: idx,
            model,
            updateNotesFromHere,
            message: data.message
          });
        }
        if (onRefreshSession) {
          await onRefreshSession(session.id);
        }
      } catch (err) {
        alert(`Chunk reprocess error: ${err.message}`);
        btn.disabled = false;
        btn.textContent = origText;
      }
    });
  });

  // Bind Manual Edit Toggle & Save Buttons
  containerEl.querySelectorAll('.toggle-chunk-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      document.getElementById(`chunk-body-${idx}`)?.classList.toggle('hidden');
      document.getElementById(`chunk-edit-wrap-${idx}`)?.classList.toggle('hidden');
    });
  });

  containerEl.querySelectorAll('.cancel-chunk-edit-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = Number(btn.dataset.idx);
      document.getElementById(`chunk-body-${idx}`)?.classList.remove('hidden');
      document.getElementById(`chunk-edit-wrap-${idx}`)?.classList.add('hidden');
    });
  });

  containerEl.querySelectorAll('.save-chunk-edit-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const idx = Number(btn.dataset.idx);
      const textarea = document.getElementById(`chunk-edit-input-${idx}`);
      const newText = textarea ? textarea.value.trim() : '';
      if (!newText) return;

      btn.disabled = true;
      btn.textContent = 'Saving...';
      try {
        await requestSaveChunkEdit(session.id, idx, newText);
        if (onChunkModified) {
          onChunkModified({
            chunkIndex: idx,
            model: 'Manual Edit',
            updateNotesFromHere: false,
            isManualEdit: true
          });
        }
        if (onRefreshSession) {
          await onRefreshSession(session.id);
        }
      } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = '✓ Save Transcript to PostgreSQL';
      }
    });
  });
}
