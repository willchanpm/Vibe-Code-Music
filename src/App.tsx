import { useCallback, useEffect, useRef, useState } from 'react';

import './App.css';
import {
  createBookSphereScene,
  type BookSphereScene,
  type InitialColors,
} from './visualizer/createBookSphereScene';

type AmbientResponse = {
  audioBase64: string;
  mimeType: string;
  promptUsed: string;
  moodTags: string[];
  uRed: number;
  uGreen: number;
  uBlue: number;
  cached?: boolean;
  error?: string;
};

function App() {
  const [title, setTitle] = useState('');
  const [useGpt, setUseGpt] = useState(true);
  const [skipCache, setSkipCache] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambient, setAmbient] = useState<Omit<AmbientResponse, 'audioBase64' | 'mimeType'> | null>(
    null,
  );
  const [audioReady, setAudioReady] = useState(false);

  const canvasRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<BookSphereScene | null>(null);

  /** On unmount, release WebGL + audio so dev hot reload does not leak GPU memory. */
  useEffect(() => {
    return () => {
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  /**
   * Lazily creates the Three.js scene the first time we have audio + colors.
   * Later generations only swap the wireframe RGB (from GPT) and load a new buffer.
   */
  const ensureScene = useCallback((colors: InitialColors) => {
    if (!canvasRef.current) return;
    if (!sceneRef.current) {
      sceneRef.current = createBookSphereScene(canvasRef.current, colors);
    } else {
      sceneRef.current.setWireframeColors(colors);
    }
  }, []);

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

      ensureScene(colors);

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
          Type the book you are reading. The server asks ElevenLabs for instrumental ambient audio
          (and optionally GPT for a richer prompt), then the sphere reacts to the sound.
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

        <div className="row">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={useGpt}
              onChange={(e) => setUseGpt(e.target.checked)}
            />
            Use GPT prompt (needs OPENAI_API_KEY on server)
          </label>
        </div>

        <div className="row">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={skipCache}
              onChange={(e) => setSkipCache(e.target.checked)}
            />
            Skip cache (pay again — forces new ElevenLabs generation)
          </label>
        </div>

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
