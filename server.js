// server.js
// Express proxy to safely call ElevenLabs API for voices
// Node 18+, run with: node server.js

import express from "express";
import axios from "axios";
import cors from "cors";
import rateLimit from "express-rate-limit";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
app.use(cors());
app.use(express.json());

// basic rate-limiter to protect API key abuse
const limiter = rateLimit({ windowMs: 10 * 1000, max: 60 });
app.use(limiter);

// ESM __dirname shim
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, "public");

// Serve static files from public and ensure root returns index.html
app.use(express.static(publicPath));
app.get("/", (req, res) => res.sendFile(path.join(publicPath, "index.html")));

const ELEVEN_KEY = process.env.ELEVENLABS_API_KEY;
if (!ELEVEN_KEY) console.warn("ELEVENLABS_API_KEY not set — proxy requests will fail.");
const ELEVEN_BASE = "https://api.elevenlabs.io/v1";

async function elevenRequest(path, opts = {}) {
  const url = `${ELEVEN_BASE}${path}`;
  const headers = {
    "xi-api-key": ELEVEN_KEY,
    Accept: "application/json",
    ...(opts.headers || {})
  };
  const params = opts.params || {};
  const timeout = opts.timeout || 10000;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await axios.get(url, { headers, params, timeout });
      return res.data;
    } catch (err) {
      const status = err?.response?.status;
      // do not retry on 4xx except 429
      if (status && status >= 400 && status < 500 && status !== 429) throw err;
      if (attempt === 2) throw err;
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
    }
  }
}

function normalizeListResponse(data) {
  // Normalize common shapes into { voices, next_page_token, has_more }
  const voices = data.voices || data.items || data.shared_voices || [];
  const next = data.next_page_token || data.next_cursor || data.next || null;
  const has_more = Boolean(data.has_more || data.hasMore || next);
  return { voices, next_page_token: next, has_more };
}

// GET /api/voices?cursor=&page_size=
app.get('/api/voices', async (req, res) => {
  try {
    const { cursor, page_size } = req.query;
    const params = {};
    if (page_size) params.page_size = page_size;
    if (cursor) params.cursor = cursor;

    const data = await elevenRequest('/voices', { params });
    const normalized = normalizeListResponse(data);
    res.json(normalized);
  } catch (err) {
    console.error('Error /api/voices:', err?.response?.data || err.message || err);
    res.status(err?.response?.status || 502).json({ error: 'Failed to fetch voices', detail: err?.response?.data || err.message });
  }
});

// GET /api/shared-voices?page=&page_size=
app.get('/api/shared-voices', async (req, res) => {
  try {
    const { page = 0, page_size = 50 } = req.query;
    const params = { page, page_size };

    let data;
    try {
      data = await elevenRequest('/voices/shared', { params });
    } catch (_) {
      data = await elevenRequest('/voices', { params });
    }

    const normalized = normalizeListResponse(data);
    res.json({ ...normalized, page: Number(page) });
  } catch (err) {
    console.error('Error /api/shared-voices:', err?.response?.data || err.message || err);
    res.status(err?.response?.status || 502).json({ error: 'Failed to fetch shared voices', detail: err?.response?.data || err.message });
  }
});

// Best-effort validate voice id
app.get('/api/voices/:voiceId', async (req, res) => {
  try {
    const { voiceId } = req.params;
    try {
      const data = await elevenRequest(`/voices/${encodeURIComponent(voiceId)}`);
      return res.json({ found: true, voice: data });
    } catch (err) {
      // fallback: scan first 200 voices
      const list = await elevenRequest('/voices', { params: { page_size: 200 } });
      const voices = list.voices || [];
      const found = voices.find(v => String(v.voice_id) === String(voiceId) || String(v.id) === String(voiceId));
      if (found) return res.json({ found: true, voice: found });
      return res.status(404).json({ found: false });
    }
  } catch (err) {
    res.status(502).json({ error: 'Validation failed', detail: err.message });
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Voice proxy listening on ${PORT}`));
