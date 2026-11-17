import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, '..');

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

export function parsePgConfig() {
  if (process.env.PGHOST && process.env.PGUSER && process.env.PGPASSWORD) {
    return {
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      database: process.env.PGDATABASE || 'postgres'
    };
  }

  const rawUrl = process.env.DATABASE_URL || '';
  if (!rawUrl) {
    return {
      host: 'localhost',
      port: 5432,
      user: 'postgres',
      password: '',
      database: 'postgres'
    };
  }

  const match = rawUrl.match(/^postgres(?:ql)?:\/\/(.+)@([^:/]+)(?::(\d+))?\/([^?]+)$/i);
  if (match) {
    const creds = match[1];
    const host = match[2];
    const port = Number(match[3] || 5432);
    const database = match[4];
    const colonIdx = creds.indexOf(':');
    const user = colonIdx !== -1 ? decodeURIComponent(creds.slice(0, colonIdx)) : decodeURIComponent(creds);
    const password = colonIdx !== -1 ? decodeURIComponent(creds.slice(colonIdx + 1)) : '';
    return { host, port, user, password, database };
  }

  return { connectionString: rawUrl };
}

export const CONFIG = {
  port: Number(process.env.PORT || 3456),
  // Paid Tier Primary API Key + Optional Fallback Key
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiApiKeyFallback: process.env.GEMINI_API_KEY_FREE || process.env.GEMINI_API_KEY_PAID || '',
  // Default lightweight model for standard chunk processing
  defaultChunkModel: 'gemini-2.5-flash',
  // Heavy reasoning model used ONLY when a single chunk hallucinates or is manually reprocessed
  retryHeavyModel: 'gemini-2.5-pro',
  geminiModels: ['gemini-2.5-flash', 'gemini-2.0-flash'],
  availableTranscriberModels: [
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (Deep Accuracy / Anti-Hallucination)' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (Fast Standard + Guardrails)' },
    { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (Alternative Fast Model)' }
  ],
  pg: parsePgConfig(),
  chunkTargetSec: Number(process.env.CHUNK_TARGET_SEC || 300),
  chunkSearchWindowBeforeSec: 35,
  chunkSearchWindowAfterSec: 25,
  chunkFallbackOverlapSec: 4,
  // Paid tier needs no artificial 4.2s sleep—just a tiny 250ms courtesy burst spacing
  apiMinIntervalMs: Number(process.env.API_MIN_INTERVAL_MS || 250),
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

fs.mkdirSync(CONFIG.sessionsDir, { recursive: true });
fs.mkdirSync(CONFIG.tempDir, { recursive: true });
