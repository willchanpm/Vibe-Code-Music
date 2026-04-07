/**
 * Small Express API: turns a book title into an ElevenLabs Music prompt, then returns MP3 bytes as base64.
 * Keys stay on the server only — the React app calls `/api/ambient` through Vite's proxy in dev.
 */
import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import { createHash } from 'node:crypto';

const PORT = Number(process.env.PORT) || 3001;
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// dotenv only loads `.env` by default — not `.env.example`. If the key is "set" in .env.example only, the API will not see it.
if (!ELEVENLABS_KEY) {
  console.warn(
    '[vibe-code-music] ELEVENLABS_API_KEY is missing. Copy .env.example to .env in the project root and add your key.',
  );
}

/** In-memory cache: same book title + settings avoids repeat ElevenLabs charges. */
const audioCache = new Map<
  string,
  {
    audioBase64: string;
    promptUsed: string;
    uRed: number;
    uGreen: number;
    uBlue: number;
    moodTags: string[];
  }
>();

const PROMPT_VERSION = '1';

type GptResult = {
  ambientPrompt: string;
  moodTags: string[];
  suggestedWireframeColor: { r: number; g: number; b: number };
};

function fallbackPrompt(title: string): GptResult {
  return {
    ambientPrompt: `Instrumental ambient reading music inspired by the book "${title}". Calm, spacious, minimal percussion, no vocals, suitable for deep focus while reading.`,
    moodTags: ['calm', 'reading', 'ambient'],
    suggestedWireframeColor: { r: 0.6, g: 0.75, b: 1.0 },
  };
}

/** Optional: ask OpenAI for a richer prompt + RGB for the Three.js wireframe. */
async function expandWithGpt(title: string): Promise<GptResult> {
  if (!OPENAI_KEY) return fallbackPrompt(title);

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENAI_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You create short instrumental ambient music prompts for reading. Return JSON only with keys: ambientPrompt (string, max 400 chars), moodTags (array of 3-6 short strings), suggestedWireframeColor: { r, g, b } each 0-1 for a calm aesthetic matching the book mood. No vocals, no lyrics, no copyrighted text.',
        },
        {
          role: 'user',
          content: `Book title: "${title}".`,
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn('OpenAI error, using fallback prompt:', res.status, errText);
    return fallbackPrompt(title);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) return fallbackPrompt(title);

  try {
    const parsed = JSON.parse(raw) as GptResult;
    if (!parsed.ambientPrompt || typeof parsed.ambientPrompt !== 'string') {
      return fallbackPrompt(title);
    }
    const c = parsed.suggestedWireframeColor ?? { r: 0.6, g: 0.75, b: 1 };
    return {
      ambientPrompt: parsed.ambientPrompt,
      moodTags: Array.isArray(parsed.moodTags) ? parsed.moodTags : [],
      suggestedWireframeColor: {
        r: clamp01(c.r),
        g: clamp01(c.g),
        b: clamp01(c.b),
      },
    };
  } catch {
    return fallbackPrompt(title);
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Calls ElevenLabs `POST /v1/music` and returns MP3 bytes. */
async function composeMusic(prompt: string, musicLengthMs: number): Promise<ArrayBuffer> {
  if (!ELEVENLABS_KEY) {
    throw new Error('ELEVENLABS_API_KEY is not set');
  }

  const url = new URL('https://api.elevenlabs.io/v1/music');
  url.searchParams.set('output_format', 'mp3_44100_128');

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': ELEVENLABS_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      prompt,
      music_length_ms: musicLengthMs,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs music failed: ${res.status} ${errBody}`);
  }

  return res.arrayBuffer();
}

function cacheKey(title: string, musicLengthMs: number, useGpt: boolean): string {
  const h = createHash('sha256');
  h.update(`${PROMPT_VERSION}|${title.trim().toLowerCase()}|${musicLengthMs}|${useGpt ? 'gpt' : 'nogpt'}`);
  return h.digest('hex');
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasElevenLabs: Boolean(ELEVENLABS_KEY), hasOpenAI: Boolean(OPENAI_KEY) });
});

/**
 * Body: { title: string, musicLengthMs?: number, useGpt?: boolean, skipCache?: boolean }
 * Returns JSON: { audioBase64, mimeType, promptUsed, moodTags, uRed, uGreen, uBlue }
 */
app.post('/api/ambient', async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 200) {
      res.status(400).json({ error: 'Provide a book title (1–200 characters).' });
      return;
    }

    const musicLengthMs = Math.min(
      300_000,
      Math.max(10_000, Number(req.body?.musicLengthMs) || 120_000),
    );
    // Client checkbox + server key: only call GPT when both are true.
    const clientWantsGpt = req.body?.useGpt !== false;
    const useGpt = clientWantsGpt && Boolean(OPENAI_KEY);
    const skipCache = Boolean(req.body?.skipCache);

    const key = cacheKey(title, musicLengthMs, useGpt);
    if (!skipCache && audioCache.has(key)) {
      const hit = audioCache.get(key)!;
      res.json({
        audioBase64: hit.audioBase64,
        mimeType: 'audio/mpeg',
        promptUsed: hit.promptUsed,
        moodTags: hit.moodTags,
        uRed: hit.uRed,
        uGreen: hit.uGreen,
        uBlue: hit.uBlue,
        cached: true,
      });
      return;
    }

    const gpt = useGpt ? await expandWithGpt(title) : fallbackPrompt(title);
    const promptUsed = gpt.ambientPrompt;
    const buf = await composeMusic(promptUsed, musicLengthMs);
    const audioBase64 = Buffer.from(buf).toString('base64');

    const { r, g, b } = gpt.suggestedWireframeColor;
    const payload = {
      audioBase64,
      mimeType: 'audio/mpeg' as const,
      promptUsed,
      moodTags: gpt.moodTags,
      uRed: r,
      uGreen: g,
      uBlue: b,
      cached: false,
    };

    audioCache.set(key, {
      audioBase64,
      promptUsed,
      moodTags: gpt.moodTags,
      uRed: r,
      uGreen: g,
      uBlue: b,
    });

    res.json(payload);
  } catch (e) {
    console.error(e);
    const message = e instanceof Error ? e.message : 'Server error';
    res.status(500).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on http://127.0.0.1:${PORT}`);
});
