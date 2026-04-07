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
    '[page-score] ELEVENLABS_API_KEY is missing. Copy .env.example to .env in the project root and add your key.',
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

// Bump when GPT/Open Library shaping changes so cached audio isn’t stale vs new prompts.
const PROMPT_VERSION = '2';

type GptResult = {
  ambientPrompt: string;
  moodTags: string[];
  suggestedWireframeColor: { r: number; g: number; b: number };
};

/** What we send to the client so you can see the app matched a real catalog entry (Open Library). */
type BookLookupResult = {
  /** True when Open Library returned at least one search hit for your query. */
  matched: boolean;
  /** What you typed in the form (echoed back for clarity). */
  queryTitle: string;
  /** Canonical title from Open Library (may differ slightly from your spelling). */
  resolvedTitle: string;
  authors: string[];
  /** Medium JPEG from covers.openlibrary.org, or null if none. */
  coverUrl: string | null;
  /** Short plain-text blurb: work description, first sentence, subjects, or year — proves which book we mean. */
  summarySnippet: string | null;
  /** Link to the work on openlibrary.org (handy for “is this the right edition?”). */
  openLibraryUrl: string | null;
  /** Set when the HTTP call failed so you know lookup did not run normally. */
  lookupError: string | null;
  /** Subject / shelf tags from search + work record — used for theme-aware music prompts. */
  themes: string[];
  /** Publication year from search when present. */
  firstPublishYear: number | null;
  /** First line of the book when Open Library has it — tone hint for GPT (not shown separately if same as summary). */
  openingLine: string | null;
  /** Longer work-level description when the `/works/...` record has one — richer than search alone. */
  descriptionSnippet: string | null;
};

type OlSearchDoc = {
  title?: string;
  author_name?: string[];
  cover_i?: number;
  key?: string;
  first_sentence?: string[];
  subject?: string[];
  first_publish_year?: number;
};

function fallbackPrompt(title: string, wantLyrics: boolean): GptResult {
  if (wantLyrics) {
    return {
      ambientPrompt: `Ambient reading music inspired by "${title}". Soft, sparse vocals with gentle original lyrics about mood and atmosphere only — never quote the book. Calm, spacious, suitable for focus.`,
      moodTags: ['calm', 'reading', 'ambient', 'vocals'],
      suggestedWireframeColor: { r: 0.65, g: 0.55, b: 0.95 },
    };
  }
  return {
    ambientPrompt: `Instrumental ambient reading music inspired by the book "${title}". Calm, spacious, minimal percussion, no vocals, suitable for deep focus while reading.`,
    moodTags: ['calm', 'reading', 'ambient'],
    suggestedWireframeColor: { r: 0.6, g: 0.75, b: 1.0 },
  };
}

/**
 * Build a structured user message for GPT: themes, synopsis, and opening line give enough substance
 * to translate *ideas* into *sound* (tempo, instruments, texture) for ElevenLabs — not just the title.
 */
function buildGptUserContent(resolvedTitle: string, book: BookLookupResult): string {
  const parts: string[] = [];
  parts.push(`**Title:** ${resolvedTitle}`);
  if (book.authors.length) parts.push(`**Author(s):** ${book.authors.join(', ')}`);
  if (book.firstPublishYear != null) {
    parts.push(`**First published (catalog):** ${book.firstPublishYear}`);
  }
  if (book.themes.length) {
    // Cap length so the request stays within model context while still listing enough tags.
    const joined = book.themes.slice(0, 18).join(', ');
    parts.push(`**Themes / catalog tags:** ${joined}`);
  }
  if (book.descriptionSnippet) {
    parts.push(
      `**Synopsis / about (Open Library — infer mood and setting, do not quote):** ${book.descriptionSnippet.slice(0, 650)}`,
    );
  }
  if (book.openingLine) {
    parts.push(
      `**Opening line (tone and voice only — do not quote or paraphrase in the music prompt):** ${book.openingLine.slice(0, 420)}`,
    );
  }
  // Fallback when we only had a minimal catalog note (e.g. year-only match).
  if (!book.descriptionSnippet && !book.openingLine && book.summarySnippet) {
    parts.push(`**Catalog note:** ${book.summarySnippet.slice(0, 420)}`);
  }
  return parts.join('\n');
}

/** Optional: ask OpenAI for a richer prompt + RGB for the Three.js wireframe. */
async function expandWithGpt(
  resolvedTitle: string,
  book: BookLookupResult,
  wantLyrics: boolean,
): Promise<GptResult> {
  if (!OPENAI_KEY) return fallbackPrompt(resolvedTitle, wantLyrics);

  // System prompt: steer toward ElevenLabs-friendly language (texture, tempo, instruments) from *themes*, not title alone.
  const systemLyrics = wantLyrics
    ? [
        'You write a single text prompt for ElevenLabs Music (generative audio) for someone reading a book.',
        'Use the structured book facts (themes, synopsis, era). Turn abstract ideas into concrete sound: suggested instruments and layers, tempo/energy, emotional color, and atmosphere (e.g. intimate vs vast, warm vs cold).',
        'Vocals allowed: very soft, sparse singing with short ORIGINAL lyrics that evoke mood only — never quote, name, or closely paraphrase the book’s wording.',
        'Do not claim an official soundtrack; avoid pasting the book title into the prompt as a marketing line.',
        'Return JSON only: ambientPrompt (one flowing string, max 450 characters), moodTags (3–6 short strings), suggestedWireframeColor: { r, g, b } each 0–1 matching the emotional palette.',
      ].join(' ')
    : [
        'You write a single text prompt for ElevenLabs Music (instrumental generative audio) for focused reading.',
        'Use themes, synopsis, and publication era from the user message. Translate themes (e.g. exile, nature, dread, wonder) into sonic choices: instrumentation, texture, tempo, space/reverb, and mood — not just “calm ambient.”',
        'If the book’s ideas are tense, melancholic, or strange, the music may reflect that while staying listenable and not harsh (still suitable as reading music).',
        'No vocals, no lyrics, no copyrighted text, no quoting the book.',
        'Return JSON only: ambientPrompt (one flowing string, max 450 characters), moodTags (3–6 short strings), suggestedWireframeColor: { r, g, b } each 0–1 matching the emotional palette.',
      ].join(' ');

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
          content: systemLyrics,
        },
        {
          role: 'user',
          content: buildGptUserContent(resolvedTitle, book),
        },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.warn('OpenAI error, using fallback prompt:', res.status, errText);
    return fallbackPrompt(resolvedTitle, wantLyrics);
  }

  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) return fallbackPrompt(resolvedTitle, wantLyrics);

  try {
    const parsed = JSON.parse(raw) as GptResult;
    if (!parsed.ambientPrompt || typeof parsed.ambientPrompt !== 'string') {
      return fallbackPrompt(resolvedTitle, wantLyrics);
    }
    const c = parsed.suggestedWireframeColor ?? { r: 0.6, g: 0.75, b: 1 };
    const trimmed = parsed.ambientPrompt.trim().slice(0, 450);
    return {
      ambientPrompt: trimmed,
      moodTags: Array.isArray(parsed.moodTags) ? parsed.moodTags : [],
      suggestedWireframeColor: {
        r: clamp01(c.r),
        g: clamp01(c.g),
        b: clamp01(c.b),
      },
    };
  } catch {
    return fallbackPrompt(resolvedTitle, wantLyrics);
  }
}

/** Open Library sometimes stores description as a string, sometimes as { type, value }. */
function normalizeOlDescription(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (raw && typeof raw === 'object' && 'value' in raw && typeof (raw as { value: unknown }).value === 'string') {
    return (raw as { value: string }).value;
  }
  return '';
}

/** Turn long markdown-ish text into a short, readable snippet for the UI + GPT. */
function cleanCatalogSnippet(text: string, maxLen: number): string {
  let s = text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^>\s*/gm, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > maxLen) s = s.slice(0, maxLen - 1).trimEnd() + '…';
  return s;
}

/** Dedupe subject strings while keeping first-seen order (search hits before work extras). */
function dedupeSubjects(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const t = s.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Second request: `/works/...` often has a fuller description and a long `subjects` list than search alone.
 * We merge those with search subjects so GPT sees themes even when there’s no first sentence.
 */
async function fetchOpenLibraryWorkExtras(workKey: string): Promise<{
  descriptionSnippet: string | null;
  subjects: string[];
}> {
  const id = workKey.replace(/^\/works\//, '');
  try {
    const res = await fetch(`https://openlibrary.org/works/${id}.json`);
    if (!res.ok) return { descriptionSnippet: null, subjects: [] };
    const w = (await res.json()) as { description?: unknown; subjects?: unknown };
    const raw = normalizeOlDescription(w.description);
    const descriptionSnippet = raw ? cleanCatalogSnippet(raw, 650) : null;
    const subjects = Array.isArray(w.subjects)
      ? w.subjects.filter((x): x is string => typeof x === 'string').map((s) => s.trim())
      : [];
    return { descriptionSnippet, subjects: subjects.slice(0, 24) };
  } catch {
    return { descriptionSnippet: null, subjects: [] };
  }
}

/**
 * Looks up the book in Open Library’s public catalog (no API key).
 * This is the step that proves we’re not only echoing your string — we resolve title, authors, cover, and a snippet.
 */
async function lookupOpenLibrary(query: string): Promise<BookLookupResult> {
  const base: BookLookupResult = {
    matched: false,
    queryTitle: query,
    resolvedTitle: query.trim(),
    authors: [],
    coverUrl: null,
    summarySnippet: null,
    openLibraryUrl: null,
    lookupError: null,
    themes: [],
    firstPublishYear: null,
    openingLine: null,
    descriptionSnippet: null,
  };

  const q = query.trim();
  if (!q) {
    return { ...base, lookupError: 'Empty title' };
  }

  try {
    const url = `https://openlibrary.org/search.json?q=${encodeURIComponent(q)}&limit=1`;
    const res = await fetch(url);
    if (!res.ok) {
      return { ...base, lookupError: `Open Library search failed (HTTP ${res.status})` };
    }

    const data = (await res.json()) as { docs?: OlSearchDoc[] };
    const doc = data.docs?.[0];
    if (!doc?.title) {
      return { ...base, lookupError: 'No catalog match for this search' };
    }

    const resolvedTitle = doc.title;
    const authors = Array.isArray(doc.author_name) ? doc.author_name : [];
    const coverUrl =
      typeof doc.cover_i === 'number'
        ? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`
        : null;
    const openLibraryUrl = doc.key ? `https://openlibrary.org${doc.key}` : null;

    const subjectsFromSearch = Array.isArray(doc.subject)
      ? doc.subject.filter((s): s is string => typeof s === 'string').map((s) => s.trim())
      : [];

    let descriptionSnippet: string | null = null;
    let subjectsFromWork: string[] = [];
    if (doc.key) {
      const extras = await fetchOpenLibraryWorkExtras(doc.key);
      descriptionSnippet = extras.descriptionSnippet;
      subjectsFromWork = extras.subjects;
    }

    const themes = dedupeSubjects([...subjectsFromSearch, ...subjectsFromWork]).slice(0, 18);

    let openingLine: string | null = null;
    if (Array.isArray(doc.first_sentence) && doc.first_sentence[0]) {
      openingLine = cleanCatalogSnippet(String(doc.first_sentence[0]), 280);
    }

    const firstPublishYear =
      typeof doc.first_publish_year === 'number' ? doc.first_publish_year : null;

    // One short line for the UI card — opening line is most “human”; else synopsis; else themes/year.
    let summarySnippet: string | null = null;
    if (openingLine) {
      summarySnippet = openingLine;
    } else if (descriptionSnippet) {
      summarySnippet = cleanCatalogSnippet(descriptionSnippet, 320);
    } else if (themes.length > 0) {
      summarySnippet = `Themes include: ${themes.slice(0, 5).join(', ')}.`;
    } else if (firstPublishYear != null) {
      summarySnippet = `First published in ${firstPublishYear}.`;
    }

    return {
      matched: true,
      queryTitle: q,
      resolvedTitle,
      authors,
      coverUrl,
      summarySnippet,
      openLibraryUrl,
      lookupError: null,
      themes,
      firstPublishYear,
      openingLine,
      descriptionSnippet,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    return { ...base, lookupError: msg };
  }
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0.5;
  return Math.min(1, Math.max(0, n));
}

/** Calls ElevenLabs `POST /v1/music` and returns MP3 bytes. */
async function composeMusic(
  prompt: string,
  musicLengthMs: number,
  forceInstrumental: boolean,
): Promise<ArrayBuffer> {
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
      // ElevenLabs: true = guaranteed instrumental; false = model may add vocals (pairs with our "lyrics" UI toggle).
      force_instrumental: forceInstrumental,
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    throw new Error(`ElevenLabs music failed: ${res.status} ${errBody}`);
  }

  return res.arrayBuffer();
}

function cacheKey(
  title: string,
  musicLengthMs: number,
  useGpt: boolean,
  wantLyrics: boolean,
): string {
  const h = createHash('sha256');
  h.update(
    `${PROMPT_VERSION}|${title.trim().toLowerCase()}|${musicLengthMs}|${useGpt ? 'gpt' : 'nogpt'}|${wantLyrics ? 'lyrics' : 'instr'}`,
  );
  return h.digest('hex');
}

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, hasElevenLabs: Boolean(ELEVENLABS_KEY), hasOpenAI: Boolean(OPENAI_KEY) });
});

/**
 * Body: { title: string, musicLengthMs?: number, useGpt?: boolean, skipCache?: boolean, wantLyrics?: boolean }
 * Returns JSON: { audioBase64, mimeType, promptUsed, moodTags, uRed, uGreen, uBlue, book, cached? }
 * `book` comes from Open Library (real catalog lookup). Music still uses your title string if no match.
 */
app.post('/api/ambient', async (req, res) => {
  try {
    const title = typeof req.body?.title === 'string' ? req.body.title.trim() : '';
    if (!title || title.length > 200) {
      res.status(400).json({ error: 'Provide a book title (1–200 characters).' });
      return;
    }

    // Always hit Open Library first so the response can show cover + snippet (proves which book we resolved).
    const book = await lookupOpenLibrary(title);
    const promptTitle = book.matched ? book.resolvedTitle : title;

    const musicLengthMs = Math.min(
      300_000,
      Math.max(10_000, Number(req.body?.musicLengthMs) || 120_000),
    );
    // Client checkbox + server key: only call GPT when both are true.
    const clientWantsGpt = req.body?.useGpt !== false;
    const useGpt = clientWantsGpt && Boolean(OPENAI_KEY);
    const skipCache = Boolean(req.body?.skipCache);
    // When false (default): instrumental only via ElevenLabs `force_instrumental`. When true: vocals/lyrics allowed.
    const wantLyrics = Boolean(req.body?.wantLyrics);

    const key = cacheKey(title, musicLengthMs, useGpt, wantLyrics);
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
        book,
      });
      return;
    }

    const gpt = useGpt
      ? await expandWithGpt(promptTitle, book, wantLyrics)
      : fallbackPrompt(promptTitle, wantLyrics);
    const promptUsed = gpt.ambientPrompt;
    const buf = await composeMusic(promptUsed, musicLengthMs, !wantLyrics);
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
      book,
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
