import { escapeHtml } from './utils.js';

export function renderMarkdown(md) {
  if (!md || !md.trim()) return '';

  const codeBlocks = [];
  const text = md.replace(/```([a-zA-Z0-9_-]*)\r?\n([\s\S]*?)```/g, (_, lang, code) => {
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
    s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/\[(\d{2}:\d{2}(?::\d{2})?)\]/g, '<code class="ts-badge">[$1]</code>');
    return s;
  };

  for (const raw of lines) {
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
      const quoteBody = trimmed
        .slice(2)
        .replace(/^\[!(IMPORTANT|NOTE|TIP|WARNING)\]\s*/i, '<strong>$1:</strong> ');
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
