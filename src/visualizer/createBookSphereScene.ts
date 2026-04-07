/**
 * Builds the full-screen Three.js scene: icosahedron blob shader, bloom, mouse camera drift,
 * and Web Audio playback + analyser driving vertex displacement (louder = more "wobble").
 */
import { GUI } from 'lil-gui';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

import { fragmentShader, vertexShader } from '../shaders/bookBlob';

import type { AmbientVisualizerScene, InitialColors } from './visualizerTypes';

/** Same shape as `AmbientVisualizerScene` — kept name for existing imports. */
export type BookSphereScene = AmbientVisualizerScene;
export type { InitialColors };

function getSize(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { width: Math.max(1, r.width), height: Math.max(1, r.height) };
}

export function createBookSphereScene(
  mountEl: HTMLElement,
  initialColors: InitialColors,
): AmbientVisualizerScene {
  const { width, height } = getSize(mountEl);

  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mountEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
  camera.position.set(6, 8, 14);

  const listener = new THREE.AudioListener();
  camera.add(listener);

  const sound = new THREE.Audio(listener);
  let analyser: THREE.AudioAnalyser | null = null;

  const uniforms = {
    u_time: { value: 0.0 },
    u_frequency: { value: 0.0 },
    u_red: { value: initialColors.r },
    u_green: { value: initialColors.g },
    u_blue: { value: initialColors.b },
  };

  const mat = new THREE.ShaderMaterial({
    wireframe: true,
    uniforms,
    vertexShader,
    fragmentShader,
  });

  const geo = new THREE.IcosahedronGeometry(4, 30);
  const mesh = new THREE.Mesh(geo, mat);
  scene.add(mesh);

  const renderScene = new RenderPass(scene, camera);
  // r172 constructor: resolution, strength, radius, threshold (then we still sync lil-gui below).
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(width, height), 0.4, 0.8, 0.5);

  const outputPass = new OutputPass();

  const bloomComposer = new EffectComposer(renderer);
  bloomComposer.addPass(renderScene);
  bloomComposer.addPass(bloomPass);
  bloomComposer.addPass(outputPass);

  const clock = new THREE.Clock();

  /** Mouse-driven camera drift (tutorial-style): soft follow toward cursor. */
  let mouseX = 0;
  let mouseY = 0;
  const onMouseMove = (e: MouseEvent) => {
    const halfX = window.innerWidth / 2;
    const halfY = window.innerHeight / 2;
    mouseX = (e.clientX - halfX) / 100;
    mouseY = (e.clientY - halfY) / 100;
  };
  window.addEventListener('mousemove', onMouseMove);

  const params = {
    red: initialColors.r,
    green: initialColors.g,
    blue: initialColors.b,
    threshold: 0.5,
    strength: 0.4,
    radius: 0.8,
  };

  const gui = new GUI({ title: 'Look & bloom' });
  const colorsFolder = gui.addFolder('Wireframe color');
  colorsFolder.add(params, 'red', 0, 1).onChange((v: number) => {
    uniforms.u_red.value = v;
    colorTarget.r = v;
  });
  colorsFolder.add(params, 'green', 0, 1).onChange((v: number) => {
    uniforms.u_green.value = v;
    colorTarget.g = v;
  });
  colorsFolder.add(params, 'blue', 0, 1).onChange((v: number) => {
    uniforms.u_blue.value = v;
    colorTarget.b = v;
  });

  /**
   * While audio plays, the wireframe slowly drifts toward new random colours (smooth, not strobing).
   * We pick targets in HSL space so hues stay vivid; `nextColorShuffleAt` schedules the next palette jump.
   */
  const colorTarget = { r: initialColors.r, g: initialColors.g, b: initialColors.b };
  let nextColorShuffleAt = 0;
  /** After you hit Play, wait a moment before the first random target so the GPT/book colour is visible briefly. */
  let playColorShufflePrimed = false;
  const scratchColor = new THREE.Color();

  const pickRandomWireframeTarget = () => {
    const h = Math.random();
    const s = 0.38 + Math.random() * 0.48;
    const l = 0.38 + Math.random() * 0.32;
    scratchColor.setHSL(h, s, l);
    colorTarget.r = scratchColor.r;
    colorTarget.g = scratchColor.g;
    colorTarget.b = scratchColor.b;
  };

  const setWireframeColors = (c: InitialColors) => {
    uniforms.u_red.value = c.r;
    uniforms.u_green.value = c.g;
    uniforms.u_blue.value = c.b;
    params.red = c.r;
    params.green = c.g;
    params.blue = c.b;
    colorTarget.r = c.r;
    colorTarget.g = c.g;
    colorTarget.b = c.b;
    colorsFolder.controllers.forEach((ctrl) => ctrl.updateDisplay());
  };

  const bloomFolder = gui.addFolder('Bloom');
  bloomFolder.add(params, 'threshold', 0, 1).onChange((v: number) => {
    bloomPass.threshold = v;
  });
  bloomFolder.add(params, 'strength', 0, 3).onChange((v: number) => {
    bloomPass.strength = v;
  });
  bloomFolder.add(params, 'radius', 0, 1).onChange((v: number) => {
    bloomPass.radius = v;
  });

  let raf = 0;
  const animate = () => {
    raf = requestAnimationFrame(animate);

    camera.position.x += (mouseX - camera.position.x) * 0.05;
    camera.position.y += (-mouseY - camera.position.y) * 0.05;
    camera.lookAt(scene.position);

    const elapsed = clock.getElapsedTime();
    uniforms.u_time.value = elapsed;
    // When there is no decoded track yet (or nothing playing), still nudge the blob so the preview feels alive.
    if (analyser && sound.buffer && sound.isPlaying) {
      uniforms.u_frequency.value = analyser.getAverageFrequency();

      // First time after Play: short delay, then repeat on a random interval so colours keep shifting.
      if (!playColorShufflePrimed) {
        playColorShufflePrimed = true;
        nextColorShuffleAt = elapsed + 1.8;
      }
      if (elapsed >= nextColorShuffleAt) {
        pickRandomWireframeTarget();
        nextColorShuffleAt = elapsed + 1.5 + Math.random() * 2.5;
      }
      const k = 0.042;
      uniforms.u_red.value += (colorTarget.r - uniforms.u_red.value) * k;
      uniforms.u_green.value += (colorTarget.g - uniforms.u_green.value) * k;
      uniforms.u_blue.value += (colorTarget.b - uniforms.u_blue.value) * k;
    } else {
      playColorShufflePrimed = false;
      const idle = (Math.sin(elapsed * 1.8) * 0.5 + 0.5) * 45;
      uniforms.u_frequency.value = idle;
    }

    bloomComposer.render();
  };
  animate();

  const ro = new ResizeObserver(() => {
    const s = getSize(mountEl);
    camera.aspect = s.width / s.height;
    camera.updateProjectionMatrix();
    renderer.setSize(s.width, s.height);
    bloomComposer.setSize(s.width, s.height);
    bloomPass.setSize(s.width, s.height);
  });
  ro.observe(mountEl);

  const dispose = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('mousemove', onMouseMove);
    ro.disconnect();
    gui.destroy();

    if (sound.isPlaying) sound.stop();
    geo.dispose();
    mat.dispose();
    bloomComposer.dispose();
    renderer.dispose();
    if (renderer.domElement.parentElement === mountEl) {
      mountEl.removeChild(renderer.domElement);
    }
  };

  const setAudioBuffer = (buffer: AudioBuffer) => {
    sound.setBuffer(buffer);
    analyser = new THREE.AudioAnalyser(sound, 64);
  };

  const loadAudioFromBase64 = async (base64: string) => {
    const raw = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0));
    const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
      listener.context.decodeAudioData(raw.buffer.slice(0), resolve, reject);
    });
    setAudioBuffer(buffer);
  };

  const play = () => {
    const ctx = listener.context;
    if (ctx.state === 'suspended') {
      void ctx.resume();
    }
    if (sound.buffer) {
      if (sound.isPlaying) sound.stop();
      sound.play();
    }
  };

  const pause = () => {
    if (sound.isPlaying) sound.pause();
  };

  return { play, pause, setAudioBuffer, loadAudioFromBase64, setWireframeColors, dispose };
}
