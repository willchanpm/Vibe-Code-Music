/**
 * Shared contract for both Three.js ambient visualizers (wireframe blob vs kekkorider-style).
 * The React app swaps implementations but keeps the same play/pause/audio API.
 */

export type InitialColors = { r: number; g: number; b: number };

export type AmbientVisualizerScene = {
  /** Call after user gesture so the browser allows audio (required policy). */
  play: () => void;
  pause: () => void;
  /** Replace the decoded track (e.g. new book). */
  setAudioBuffer: (buffer: AudioBuffer) => void;
  /**
   * Decode MP3 from base64 using the same AudioContext as playback (avoids context mismatch).
   */
  loadAudioFromBase64: (base64: string) => Promise<void>;
  /** When you generate a new track, GPT may suggest new RGB — sync materials + GUI. */
  setWireframeColors: (c: InitialColors) => void;
  /** Tear down WebGL, listeners, and GUI when React unmounts or hot reloads. */
  dispose: () => void;
};
