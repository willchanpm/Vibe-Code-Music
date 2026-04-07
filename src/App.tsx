import { useCallback, useEffect, useRef, useState } from 'react';

import './App.css';
import { createBookSphereScene } from './visualizer/createBookSphereScene';
import { createKekkoReactiveScene } from './visualizer/createKekkoReactiveScene';
import type { AmbientVisualizerScene, InitialColors } from './visualizer/visualizerTypes';

/** Which Three.js look to use — “blob” is the original icosahedron shader; “kekkorider” matches the linked demo’s particles + bloom style. */
type VisualizerMode = 'blob' | 'kekkorider';

/** Default wireframe tint before any book is generated — matches the server’s fallback prompt palette. */
const PREVIEW_COLORS: InitialColors = { r: 0.6, g: 0.75, b: 1.0 };

/**
 * Product name shown in the sidebar header. The browser tab title lives in `index.html` — keep both in sync
 * if you rename the app.
 */
const APP_NAME = 'Page Score';

/** Mirrors `book` from POST /api/ambient — Open Library catalog result (cover + snippet prove which title we matched). */
type BookInfo = {
  matched: boolean;
  queryTitle: string;
  resolvedTitle: string;
  authors: string[];
  coverUrl: string | null;
  summarySnippet: string | null;
  openLibraryUrl: string | null;
  lookupError: string | null;
  /** Subject tags — used server-side for theme-aware music prompts; optional for older responses. */
  themes?: string[];
  firstPublishYear?: number | null;
  openingLine?: string | null;
  descriptionSnippet?: string | null;
};

type AmbientResponse = {
  audioBase64: string;
  mimeType: string;
  promptUsed: string;
  moodTags: string[];
  uRed: number;
  uGreen: number;
  uBlue: number;
  cached?: boolean;
  book?: BookInfo;
  error?: string;
};

/** Native browser tooltips (`title` attribute) — short lines so the default yellow box stays readable. */
const CONTROL_HINTS = {
  bookTitle: 'Open Library lookup; music matches the book found.',
  visualizer: '3D look only; same audio, no new generation.',
  // When off, the server asks ElevenLabs for instrumental-only; when on, prompts include original lyrics/vocals.
  wantLyrics: 'Off: instrumental only. On: generate music with lyrics.',
  useGpt: 'Richer prompt from catalog; off uses title only.',
  skipCache: 'Ignore cache; pay for a new track.',
  generate: 'Generate music from your book and settings.',
  play: 'Play sound in the 3D view.',
  pause: 'Pause playback.',
} as const;

/**
 * A toggle switch: still a real checkbox under the hood (great for forms + screen readers),
 * but we hide it and show a sliding “pill” instead. `role="switch"` tells assistive tech it’s on/off, not a list of options.
 */
function SwitchRow({
  id,
  checked,
  onChange,
  label,
  tooltip,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Optional hover hint on the whole row (native `title` tooltip). */
  tooltip?: string;
}) {
  return (
    <label className="switch-row" htmlFor={id} title={tooltip}>
      <span className="switch-row__text">{label}</span>
      <span className="switch">
        <input
          id={id}
          type="checkbox"
          role="switch"
          className="switch__input"
          checked={checked}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="switch__track" aria-hidden="true">
          <span className="switch__thumb" />
        </span>
      </span>
    </label>
  );
}

/**
 * Compact “now playing” strip on the visualizer: cover + title + short snippet so you see which book
 * matched without scrolling the left panel (like Spotify’s bottom bar over album art).
 */
function BookNowPlayingStrip({ book }: { book: BookInfo }) {
  const displayTitle = book.matched ? book.resolvedTitle : book.queryTitle;

  return (
    <aside
      className="now-playing"
      role="region"
      aria-label="Book matched for this track"
    >
      <div className="now-playing__inner">
        {book.coverUrl && (
          <img
            className="now-playing__cover"
            src={book.coverUrl}
            alt=""
            width={56}
            height={84}
            loading="lazy"
          />
        )}
        <div className="now-playing__text">
          <p className="now-playing__label">
            {book.matched ? 'Open Library' : 'Catalog lookup'}
          </p>
          <p className="now-playing__title">{displayTitle}</p>
          {book.authors.length > 0 && (
            <p className="now-playing__authors">{book.authors.join(', ')}</p>
          )}
          {book.summarySnippet && (
            <p className="now-playing__snippet">{book.summarySnippet}</p>
          )}
          {!book.matched && book.lookupError && (
            <p className="now-playing__warn">{book.lookupError}</p>
          )}
          {book.openLibraryUrl && (
            <a
              className="now-playing__link"
              href={book.openLibraryUrl}
              target="_blank"
              rel="noreferrer"
            >
              View on Open Library
            </a>
          )}
        </div>
      </div>
    </aside>
  );
}

function App() {
  const [title, setTitle] = useState('');
  const [useGpt, setUseGpt] = useState(true);
  const [skipCache, setSkipCache] = useState(false);
  /**
   * Lyrics toggle: off = instrumental only; on = the generator creates soft/sparse original lyrics with the track
   * (see server `wantLyrics` → ElevenLabs prompt + `force_instrumental`).
   */
  const [wantLyrics, setWantLyrics] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambient, setAmbient] = useState<
    Omit<AmbientResponse, 'audioBase64' | 'mimeType'> | null
  >(null);
  const [audioReady, setAudioReady] = useState(false);
  /** Lets you switch looks without regenerating audio — we keep the last MP3 in memory to reload into the new scene. */
  const [visualizerMode, setVisualizerMode] = useState<VisualizerMode>('blob');
  const lastAudioBase64Ref = useRef<string | null>(null);
  /** Tracks which mode the current `sceneRef` was built with (so “Generate” can recreate only when mode changes). */
  const sceneModeRef = useRef<VisualizerMode | null>(null);

  /** Inner div: only the WebGL canvas is mounted here so we can layer a book strip on top inside `.canvas-wrap`. */
  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<AmbientVisualizerScene | null>(null);
  /** After a successful generate, gently scroll the full book card into view in the sidebar (optional aid; overlay is primary). */
  const sidebarBookRef = useRef<HTMLDivElement>(null);

  /** On unmount, release WebGL + audio so dev hot reload does not leak GPU memory. */
  useEffect(() => {
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  /**
   * Lazily creates the Three.js scene the first time we have audio + colors (or recreates if you changed the visualizer mode).
   * Later generations with the same mode only update RGB from GPT and load a new buffer.
   */
  const ensureScene = useCallback((colors: InitialColors, mode: VisualizerMode) => {
    if (!canvasRef.current) return;
    if (!sceneRef.current || sceneModeRef.current !== mode) {
      sceneRef.current?.dispose();
      sceneRef.current =
        mode === 'kekkorider'
          ? createKekkoReactiveScene(canvasRef.current, colors)
          : createBookSphereScene(canvasRef.current, colors);
      sceneModeRef.current = mode;
    } else {
      sceneRef.current.setWireframeColors(colors);
    }
  }, []);

  /**
   * If you already generated a track and switch visualizer, rebuild the Three.js scene and reload the same base64 audio.
   * (Skipping when `ambient` is null avoids building a scene before the first successful generation.)
   */
  /**
   * Show the Three.js view as soon as the page loads (and when you change style before generating).
   * Uses a calm default color until GPT returns palette from your first successful generation.
   */
  useEffect(() => {
    if (!ambient) {
      ensureScene(PREVIEW_COLORS, visualizerMode);
    }
  }, [visualizerMode, ambient, ensureScene]);

  const prevVisualizerRef = useRef<VisualizerMode>(visualizerMode);
  useEffect(() => {
    if (prevVisualizerRef.current === visualizerMode) return;
    prevVisualizerRef.current = visualizerMode;
    if (!canvasRef.current || !ambient) return;

    const colors: InitialColors = {
      r: ambient.uRed,
      g: ambient.uGreen,
      b: ambient.uBlue,
    };
    sceneRef.current?.dispose();
    sceneRef.current =
      visualizerMode === 'kekkorider'
        ? createKekkoReactiveScene(canvasRef.current, colors)
        : createBookSphereScene(canvasRef.current, colors);
    sceneModeRef.current = visualizerMode;

    if (lastAudioBase64Ref.current) {
      void sceneRef.current.loadAudioFromBase64(lastAudioBase64Ref.current);
    }
  }, [visualizerMode, ambient]);

  /**
   * When a book appears in the response, scroll the sidebar card into view — respects “reduce motion”
   * so we don’t animate scroll for users who opted out of motion in the OS.
   */
  useEffect(() => {
    if (!ambient?.book || !sidebarBookRef.current) return;
    const el = sidebarBookRef.current;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    el.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
  }, [ambient?.book]);

  /** Calls our Express API → ElevenLabs MP3 → decode into the same AudioContext as the visualizer. */
  const handleGenerate = async () => {
    const t = title.trim();
    if (!t) {
      setError('Enter a book title first.');
      return;
    }

    setLoading(true);
    setError(null);
    setAudioReady(false);
    setAmbient(null);

    try {
      const res = await fetch('/api/ambient', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: t,
          musicLengthMs: 120_000,
          useGpt,
          skipCache,
          wantLyrics,
        }),
      });

      const raw = await res.text();
      let data: AmbientResponse;
      try {
        data = JSON.parse(raw) as AmbientResponse;
      } catch {
        setError(raw.slice(0, 240) || `Bad response (${res.status})`);
        return;
      }

      if (!res.ok) {
        setError(data.error ?? `Request failed (${res.status})`);
        return;
      }

      const colors: InitialColors = {
        r: data.uRed,
        g: data.uGreen,
        b: data.uBlue,
      };

      ensureScene(colors, visualizerMode);
      lastAudioBase64Ref.current = data.audioBase64;

      if (!sceneRef.current) {
        setError('Could not create the 3D view.');
        return;
      }

      await sceneRef.current.loadAudioFromBase64(data.audioBase64);

      setAmbient({
        promptUsed: data.promptUsed,
        moodTags: data.moodTags ?? [],
        uRed: data.uRed,
        uGreen: data.uGreen,
        uBlue: data.uBlue,
        cached: data.cached,
        book: data.book,
      });
      setAudioReady(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setLoading(false);
    }
  };

  const handlePlay = () => {
    sceneRef.current?.play();
  };

  const handlePause = () => {
    sceneRef.current?.pause();
  };

  return (
    <div className="app">
      <aside className="panel">
        <header className="panel__brand">
          <h1>{APP_NAME}</h1>
          {/* One-line pitch: what the app does before the longer how-it-works copy below. */}
          <p className="panel__tagline">AI music companion that matches the kind of book you’re reading.</p>
        </header>
        <p>
          Type the book you are reading. The server looks it up in{' '}
          <a href="https://openlibrary.org/" target="_blank" rel="noreferrer">
            Open Library
          </a>{' '}
          (cover + short summary), then asks ElevenLabs for instrumental ambient audio (and
          optionally GPT for a richer prompt), then the sphere reacts to the sound.
        </p>

        <div>
          <label htmlFor="book-title">Book title</label>
          <input
            id="book-title"
            type="text"
            placeholder="e.g. The Left Hand of Darkness"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            autoComplete="off"
            title={CONTROL_HINTS.bookTitle}
          />
        </div>

        <div className="visualizer-block">
          <label htmlFor="visualizer-mode">Visualizer</label>
          <select
            id="visualizer-mode"
            value={visualizerMode}
            onChange={(e) => setVisualizerMode(e.target.value as VisualizerMode)}
            title={CONTROL_HINTS.visualizer}
          >
            <option value="blob">Wireframe blob (original)</option>
            <option value="kekkorider">Particles + bloom (kekkorider-style)</option>
          </select>
        </div>

        <SwitchRow
          id="want-lyrics"
          checked={wantLyrics}
          onChange={setWantLyrics}
          label="Lyrics"
          tooltip={CONTROL_HINTS.wantLyrics}
        />

        <SwitchRow
          id="use-gpt"
          checked={useGpt}
          onChange={setUseGpt}
          label="Use GPT"
          tooltip={CONTROL_HINTS.useGpt}
        />

        <SwitchRow
          id="skip-cache"
          checked={skipCache}
          onChange={setSkipCache}
          label="Skip cache (pay again — forces new ElevenLabs generation)"
          tooltip={CONTROL_HINTS.skipCache}
        />

        <div className="row">
          {/* Span wrapper keeps `title` working when the inner button is disabled (browsers often skip disabled tooltips). */}
          <span className="row__action-wrap" title={CONTROL_HINTS.generate}>
            <button
              type="button"
              className="primary"
              disabled={loading}
              onClick={() => void handleGenerate()}
            >
              {loading ? 'Generating…' : 'Generate audio'}
            </button>
          </span>
          {/* Play/Pause: `secondary--ready` after audio loads — stronger glow vs greyed-out disabled state. */}
          <span className="row__action-wrap" title={CONTROL_HINTS.play}>
            <button
              type="button"
              className={audioReady ? 'secondary secondary--ready' : 'secondary'}
              disabled={!audioReady}
              onClick={handlePlay}
            >
              Play
            </button>
          </span>
          <span className="row__action-wrap" title={CONTROL_HINTS.pause}>
            <button
              type="button"
              className={audioReady ? 'secondary secondary--ready' : 'secondary'}
              disabled={!audioReady}
              onClick={handlePause}
            >
              Pause
            </button>
          </span>
        </div>

        {error && <div className="error">{error}</div>}

        {ambient?.book && (
          <div className="book-card" ref={sidebarBookRef} id="sidebar-book-card">
            {ambient.book.coverUrl && (
              <img
                className="book-card__cover"
                src={ambient.book.coverUrl}
                alt=""
                width={120}
                height={180}
                loading="lazy"
              />
            )}
            <div className="book-card__body">
              <p className="book-card__label">
                {ambient.book.matched ? 'Matched in Open Library' : 'Catalog lookup'}
              </p>
              <p className="book-card__title">
                {ambient.book.matched ? ambient.book.resolvedTitle : ambient.book.queryTitle}
              </p>
              {ambient.book.authors.length > 0 && (
                <p className="book-card__authors">{ambient.book.authors.join(', ')}</p>
              )}
              {ambient.book.summarySnippet && (
                <p className="book-card__snippet">{ambient.book.summarySnippet}</p>
              )}
              {/* When Open Library returns subject tags, we show a few — the server uses the full list for theme-aware music prompts. */}
              {ambient.book.themes && ambient.book.themes.length > 0 && (
                <p className="book-card__snippet book-card__themes">
                  Themes: {ambient.book.themes.slice(0, 8).join(', ')}
                  {ambient.book.themes.length > 8 ? '…' : ''}
                </p>
              )}
              {!ambient.book.matched && ambient.book.lookupError && (
                <p className="book-card__warn">{ambient.book.lookupError}</p>
              )}
              {ambient.book.openLibraryUrl && (
                <a
                  className="book-card__link"
                  href={ambient.book.openLibraryUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Open Library
                </a>
              )}
            </div>
          </div>
        )}

        {ambient && (
          <details className="meta-details">
            <summary className="meta-details__summary">Prompt &amp; technical details</summary>
            <div className="meta">
              <p>
                <strong>Prompt used</strong>
                <br />
                {ambient.promptUsed}
              </p>
              {ambient.moodTags.length > 0 && (
                <p>
                  <strong>Mood tags</strong>: {ambient.moodTags.join(', ')}
                </p>
              )}
              {ambient.cached && <p>Loaded from cache (same title + settings).</p>}
            </div>
          </details>
        )}
      </aside>

      <div className="canvas-wrap">
        {ambient?.book && <BookNowPlayingStrip book={ambient.book} />}
        <div className="canvas-mount" ref={canvasRef} aria-label="3D audio visualizer" />
      </div>
    </div>
  );
}

export default App;
