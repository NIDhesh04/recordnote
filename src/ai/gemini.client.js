import { CONFIG } from '../config.js';

let lastGeminiCallTimestamp = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function enforceApiPacing() {
  const now = Date.now();
  const elapsed = now - lastGeminiCallTimestamp;
  if (lastGeminiCallTimestamp > 0 && elapsed < CONFIG.apiMinIntervalMs) {
    await sleep(CONFIG.apiMinIntervalMs - elapsed);
  }
  lastGeminiCallTimestamp = Date.now();
}

export async function callGeminiWithRetry(
  { contents, systemInstruction, generationConfig = {}, preferredModel = null },
  onStatus = null
) {
  const keys = [CONFIG.geminiApiKey, CONFIG.geminiApiKeyFallback].filter(Boolean);
  if (keys.length === 0) {
    throw new Error('GEMINI_API_KEY is missing in .env');
  }

  const models = preferredModel
    ? [preferredModel, ...CONFIG.geminiModels.filter((m) => m !== preferredModel)]
    : [...CONFIG.geminiModels];

  let lastError = null;

  for (const apiKey of keys) {
    for (const model of models) {
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await enforceApiPacing();

        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const body = {
          contents,
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 65536,
            ...generationConfig
          }
        };

        if (systemInstruction) {
          body.systemInstruction = {
            parts: [{ text: systemInstruction }]
          };
        }

        try {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });

          if (res.ok) {
            const data = await res.json();
            const text = (data?.candidates?.[0]?.content?.parts || [])
              .map((p) => p.text || '')
              .join('')
              .trim();

            if (!text) {
              const finishReason = data?.candidates?.[0]?.finishReason || 'UNKNOWN';
              throw new Error(`Gemini (${model}) returned empty output (finishReason: ${finishReason})`);
            }

            return { text, model };
          }

          const errText = await res.text();
          let errMessage = `HTTP ${res.status}: ${errText.slice(0, 300)}`;
          try {
            const parsed = JSON.parse(errText);
            if (parsed?.error?.message) errMessage = parsed.error.message;
          } catch {
            // ignore
          }

          if (res.status === 404) {
            lastError = new Error(`Model ${model} not available: ${errMessage}`);
            break;
          }

          if (res.status === 429 || res.status === 503) {
            const waitSec = attempt * 4;
            if (onStatus) {
              onStatus(`Transient API throttle on ${model}; retrying in ${waitSec}s (${attempt}/${maxAttempts})...`);
            }
            await sleep(waitSec * 1000);
            lastError = new Error(errMessage);
            continue;
          }

          throw new Error(errMessage);
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            await sleep(attempt * 2000);
          }
        }
      }
    }
  }

  throw lastError || new Error('All Gemini models failed to respond.');
}
