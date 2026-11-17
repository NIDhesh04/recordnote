export function formatSeconds(sec) {
  const total = Math.max(0, Math.floor(Number(sec) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function countWords(text) {
  if (!text || typeof text !== 'string') return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function getRollingTail(text, maxChars = 450) {
  if (!text) return '';
  const cleaned = text.trim();
  if (cleaned.length <= maxChars) return cleaned;
  const sliced = cleaned.slice(-maxChars);
  const firstSpace = sliced.indexOf(' ');
  return firstSpace > 0 ? sliced.slice(firstSpace + 1) : sliced;
}

export function decodeHeaderValue(val) {
  if (!val) return '';
  try {
    return decodeURIComponent(String(val));
  } catch {
    return String(val);
  }
}
