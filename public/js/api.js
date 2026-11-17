export function uploadFileWithProgress(
  file,
  { subjectId, newSubjectName, newSubjectCode, title, topic, chunkTargetSec, trimStart, trimEnd },
  onProgress
) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/sessions/upload', true);
    xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    xhr.setRequestHeader('X-Subject-Id', encodeURIComponent(subjectId || ''));
    xhr.setRequestHeader('X-New-Subject-Name', encodeURIComponent(newSubjectName || ''));
    xhr.setRequestHeader('X-New-Subject-Code', encodeURIComponent(newSubjectCode || ''));
    xhr.setRequestHeader('X-Title', encodeURIComponent(title || file.name));
    xhr.setRequestHeader('X-Topic', encodeURIComponent(topic || ''));
    xhr.setRequestHeader('X-Chunk-Sec', String(chunkTargetSec || 300));
    xhr.setRequestHeader('X-Trim-Start', encodeURIComponent(trimStart || ''));
    xhr.setRequestHeader('X-Trim-End', encodeURIComponent(trimEnd || ''));

    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable && onProgress) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
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

export async function createGdriveSession(payload) {
  const res = await fetch('/api/sessions/gdrive', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to start Google Drive import.');
  return data;
}

export async function requestChunkRetranscribe(sessionId, chunkIndex, payload) {
  const res = await fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/chunks/${chunkIndex}/retranscribe`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to reprocess chunk');
  return data;
}

export async function requestSaveChunkEdit(sessionId, chunkIndex, transcriptText) {
  const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/chunks/${chunkIndex}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ transcriptText })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Failed to save chunk edit');
  return data;
}
