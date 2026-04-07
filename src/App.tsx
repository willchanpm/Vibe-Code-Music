import { useCallback, useEffect, useRef, useState } from 'react';

import './App.css';
import { createBookSphereScene } from './visualizer/createBookSphereScene';
import { createKekkoReactiveScene } from './visualizer/createKekkoReactiveScene';
import type { AmbientVisualizerScene, InitialColors } from './visualizer/visualizerTypes';

/** Which Three.js look to use — “blob” is the original icosahedron shader; “kekkorider” matches the linked demo’s particles + bloom style. */
type VisualizerMode = 'blob' | 'kekkorider';

/** Default wireframe tint before any book is generated — matches the server’s fallback prompt palette. */
const PREVIEW_COLORS: InitialColors = { r: 0.6, g: 0.75, b: 1.0 };

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

/**
 * A toggle switch: still a real checkbox under the hood (great for forms + screen readers),
 * but we hide it and show a sliding “pill” instead. `role="switch"` tells assistive tech it’s on/off, not a list of options.
 */
function SwitchRow({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <label className="switch-row" htmlFor={id}>
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

function App() {
  const [title, setTitle] = useState('');
  const [useGpt, setUseGpt] = useState(true);
  const [skipCache, setSkipCache] = useState(false);
  /** Off = instrumental only (ElevenLabs `force_instrumental`). On = vocals/lyrics allowed (not guaranteed every time). */
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

  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<AmbientVisualizerScene | null>(null);

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
        <h1>Book ambient</h1>
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
          />
        </div>

        <div className="visualizer-block">
          <label htmlFor="visualizer-mode">Visualizer</label>
          <select
            id="visualizer-mode"
            value={visualizerMode}
            onChange={(e) => setVisualizerMode(e.target.value as VisualizerMode)}
            aria-describedby="visualizer-hint"
          >
            <option value="blob">Wireframe blob (original)</option>
            <option value="kekkorider">Particles + bloom (kekkorider-style)</option>
          </select>
          <p id="visualizer-hint" className="hint visualizer-block__hint">
            The second style is based on the open-source demo{' '}
            <a
              href="https://github.com/kekkorider/threejs-audio-reactive-visual"
              target="_blank"
              rel="noreferrer"
            >
              kekkorider/threejs-audio-reactive-visual
            </a>
            . After you generate audio, you can switch here without paying again.
          </p>
        </div>

        <SwitchRow
          id="want-lyrics"
          checked={wantLyrics}
          onChange={setWantLyrics}
          label="Include vocals / lyrics (off = instrumental only)"
        />

        <SwitchRow
          id="use-gpt"
          checked={useGpt}
          onChange={setUseGpt}
          label="Use GPT"
        />

        <SwitchRow
          id="skip-cache"
          checked={skipCache}
          onChange={setSkipCache}
          label="Skip cache (pay again — forces new ElevenLabs generation)"
        />

        <div className="row">
          <button
            type="button"
            className="primary"
            onClick={() => void handleGenerate()}
            disabled={loading}
          >
            {loading ? 'Generating…' : 'Generate audio'}
          </button>
          <button type="button" className="secondary" onClick={handlePlay} disabled={!audioReady}>
            Play
          </button>
          <button type="button" className="secondary" onClick={handlePause} disabled={!audioReady}>
            Pause
          </button>
        </div>

        {error && <div className="error">{error}</div>}

        {ambient?.book && (
          <div className="book-card">
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
        )}
      </aside>

      <div className="canvas-wrap" ref={canvasRef} aria-label="3D audio visualizer" />
    </div>
  );
}

export default App;
