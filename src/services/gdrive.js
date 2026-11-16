import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

/**
 * Extracts a Google Drive File ID from any common Google Drive sharing URL or raw ID.
 */
export function extractGoogleDriveFileId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();

  // Direct file/d/<ID> pattern
  const fileDMatch = trimmed.match(/\/file\/d\/([a-zA-Z0-9_-]{15,})/);
  if (fileDMatch) return fileDMatch[1];

  // Query param ?id=<ID> or &id=<ID>
  const idParamMatch = trimmed.match(/[?&]id=([a-zA-Z0-9_-]{15,})/);
  if (idParamMatch) return idParamMatch[1];

  // Raw file ID (typically 25-44 alphanumeric/dash/underscore chars)
  if (/^[a-zA-Z0-9_-]{18,60}$/.test(trimmed)) {
    return trimmed;
  }

  return null;
}

function parseFilenameFromContentDisposition(header) {
  if (!header) return null;
  // Match filename*=UTF-8''...
  const utf8Match = header.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^["']|["']$/g, ''));
    } catch {
      // ignore
    }
  }
  // Match filename="..."
  const stdMatch = header.match(/filename=["']?([^"';]+)["']?/i);
  if (stdMatch) {
    return stdMatch[1].trim();
  }
  return null;
}

/**
 * Downloads an audio/video file from Google Drive given a share link or file ID.
 * Handles both direct small-file downloads and large-file virus-scan confirmation forms.
 */
export async function downloadFromGoogleDrive(urlOrId, destDir, onProgress = null) {
  const fileId = extractGoogleDriveFileId(urlOrId);
  if (!fileId) {
    throw new Error(
      'Invalid Google Drive link or File ID. Please paste a valid Google Drive share URL (e.g., https://drive.google.com/file/d/.../view?usp=sharing).'
    );
  }

  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
  };

  const initialUrl = `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
  if (onProgress) onProgress({ stage: 'connecting', message: `Connecting to Google Drive (File ID: ${fileId})...` });

  let response = await fetch(initialUrl, {
    method: 'GET',
    headers,
    redirect: 'follow'
  });

  if (!response.ok) {
    throw new Error(`Google Drive returned HTTP ${response.status}. Make sure the file sharing is set to "Anyone with the link".`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();

  // If Google Drive returned an HTML page, it's either a large-file virus scan confirmation prompt
  // or a permission denied login wall.
  if (contentType.includes('text/html')) {
    const html = await response.text();

    if (html.includes('ServiceLogin') || html.includes('accounts.google.com') || html.includes('You need access')) {
      throw new Error(
        'This Google Drive file is private. In Google Drive, right-click the file → Share → change General Access to "Anyone with the link", then try again.'
      );
    }

    // Extract large file confirmation parameters from HTML form (drive.usercontent.google.com/download)
    const actionMatch = html.match(/action="([^"]+)"/i);
    const confirmMatch = html.match(/name="confirm"\s+value="([^"]+)"/i);
    const uuidMatch = html.match(/name="uuid"\s+value="([^"]+)"/i);

    const downloadEndpoint = actionMatch
      ? actionMatch[1].replace(/&amp;/g, '&')
      : 'https://drive.usercontent.google.com/download';
    const confirmVal = confirmMatch ? confirmMatch[1] : 't';

    const confirmUrl = new URL(downloadEndpoint);
    confirmUrl.searchParams.set('id', fileId);
    confirmUrl.searchParams.set('export', 'download');
    confirmUrl.searchParams.set('confirm', confirmVal);
    if (uuidMatch) {
      confirmUrl.searchParams.set('uuid', uuidMatch[1]);
    }

    if (onProgress) {
      onProgress({ stage: 'confirming', message: 'Large audio file detected on Google Drive, confirming direct stream...' });
    }

    response = await fetch(confirmUrl.toString(), {
      method: 'GET',
      headers,
      redirect: 'follow'
    });

    if (!response.ok) {
      throw new Error(`Failed to stream file from Google Drive after confirmation (HTTP ${response.status}).`);
    }

    const secondContentType = (response.headers.get('content-type') || '').toLowerCase();
    if (secondContentType.includes('text/html')) {
      throw new Error(
        'Google Drive did not return an audio stream. Please verify that the file is shared with "Anyone with the link".'
      );
    }
  }

  // Determine filename & extension
  const disposition = response.headers.get('content-disposition');
  let fileName = parseFilenameFromContentDisposition(disposition);

  if (!fileName) {
    // Infer extension from content-type if possible, default to .mp3 (FFmpeg auto-detects container regardless)
    let ext = '.mp3';
    if (contentType.includes('aac')) ext = '.aac';
    else if (contentType.includes('mp4') || contentType.includes('m4a')) ext = '.m4a';
    else if (contentType.includes('wav')) ext = '.wav';
    else if (contentType.includes('ogg')) ext = '.ogg';
    fileName = `gdrive_${fileId.slice(0, 10)}${ext}`;
  }

  // Sanitize filename
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  fs.mkdirSync(destDir, { recursive: true });
  const destPath = path.join(destDir, safeFileName);

  const totalBytes = Number(response.headers.get('content-length') || 0);
  let downloadedBytes = 0;

  const fileStream = fs.createWriteStream(destPath);
  const bodyStream = Readable.fromWeb(response.body);

  bodyStream.on('data', (chunk) => {
    downloadedBytes += chunk.length;
    if (onProgress) {
      const mb = (downloadedBytes / (1024 * 1024)).toFixed(1);
      const totalMb = totalBytes ? (totalBytes / (1024 * 1024)).toFixed(1) : '?';
      onProgress({
        stage: 'downloading',
        downloadedBytes,
        totalBytes,
        message: totalBytes
          ? `Downloading ${safeFileName} from Google Drive (${mb} MB / ${totalMb} MB)...`
          : `Downloading ${safeFileName} from Google Drive (${mb} MB)...`
      });
    }
  });

  await pipeline(bodyStream, fileStream);

  return {
    filePath: destPath,
    fileName: safeFileName,
    sizeBytes: downloadedBytes
  };
}
