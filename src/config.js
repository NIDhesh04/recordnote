import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

// Load .env manually so running with `node src/server.js` always works
// even without passing `--env-file=.env`
function loadEnvFile() {
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envPath)) return;
  const content = fs.readFileSync(envPath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eqIdx = line.indexOf('=');
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = val;
    }
  }
}

loadEnvFile();

export const CONFIG = {
  port: Number(process.env.PORT || 3456),
  // Active Free Tier API Key (never uses GEMINI_API_KEY_PAID unless explicitly requested)
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  // Ordered list of Gemini models to try (starts with highest-quality Flash model available on Free Tier)
  geminiModels: [
    'gemini-2.5-flash',
    'gemini-2.0-flash',
    'gemini-1.5-flash'
  ],
  // Chunking configuration for 40-45 min lecture recordings
  chunkTargetSec: Number(process.env.CHUNK_TARGET_SEC || 300), // 5 minutes per chunk
  chunkSearchWindowBeforeSec: 35, // look up to 35s before target for a clean silence
  chunkSearchWindowAfterSec: 25,  // look up to 25s after target for a clean silence
  chunkFallbackOverlapSec: 4,     // if no silence exists in window, overlap by 4s so no word is cut
  // Free Tier pacing (15 RPM limit => ~4.2 seconds minimum spacing between requests)
  freeTierMinIntervalMs: Number(process.env.FREE_TIER_INTERVAL_MS || 4200),
  // Supported input audio/video extensions
  supportedExtensions: new Set([
    '.mp3',
    '.aac',
    '.m4a',
    '.wav',
    '.ogg',
    '.flac',
    '.webm',
    '.mp4',
    '.mpeg',
    '.mpga',
    '.opus',
    '.wma'
  ]),
  dataDir: path.join(ROOT_DIR, 'data'),
  sessionsDir: path.join(ROOT_DIR, 'data', 'sessions'),
  tempDir: path.join(ROOT_DIR, 'data', 'temp')
};

// Ensure data directories exist
fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });
fs.mkdirSync(CONFIG.tempDir, { recursive: true });
