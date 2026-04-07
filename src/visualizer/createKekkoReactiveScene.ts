/**
 * Audio-reactive visual inspired by [kekkorider/threejs-audio-reactive-visual](https://github.com/kekkorider/threejs-audio-reactive-visual):
 * rotating wireframe icosahedron, instanced additive particles sampled on a sphere, bloom + afterimage,
 * and camera orbit driven by frequency data. Uses the same playback API as `createBookSphereScene`.
 */
import { GUI } from 'lil-gui';
import * as THREE from 'three';
import { AfterimagePass } from 'three/examples/jsm/postprocessing/AfterimagePass.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { MeshSurfaceSampler } from 'three/examples/jsm/math/MeshSurfaceSampler.js';

import {
  kekkoBackgroundFragmentShader,
  kekkoBackgroundVertexShader,
  kekkoParticleFragmentShader,
  kekkoParticleVertexShader,
} from '../shaders/kekkorider';

import type { AmbientVisualizerScene, InitialColors } from './visualizerTypes';

function getSize(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return { width: Math.max(1, r.width), height: Math.max(1, r.height) };
}

export function createKekkoReactiveScene(
  mountEl: HTMLElement,
  initialColors: InitialColors,
): AmbientVisualizerScene {
  const { width, height } = getSize(mountEl);

  const config = {
    /** When audio is playing we match the original demo’s “motion” amount (was GSAP-tweened). */
    cameraSpeed: 0,
    cameraRadius: 4.5,
    particlesSpeed: 0,
    particlesCount: 3000,
    bloomStrength: 1.45,
    bloomThreshold: 0.34,
    bloomRadius: 0.5,
  };

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setSize(width, height);
  renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
  renderer.setClearColor(new THREE.Color('#0d021f'));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  mountEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, width / height, 0.1, 100);
  camera.position.set(0, 0, config.cameraRadius);

  const listener = new THREE.AudioListener();
  camera.add(listener);

  const sound = new THREE.Audio(listener);
  let analyser: THREE.AudioAnalyser | null = null;

  const tint = new THREE.Vector3(initialColors.r, initialColors.g, initialColors.b);

  const mainGroup = new THREE.Group();
  scene.add(mainGroup);

  const sphereGeom = new THREE.SphereGeometry(2, 32, 16);
  const sphereWire = new THREE.MeshBasicMaterial({
    color: 0xffffff,
    wireframe: true,
    opacity: 0.1,
    transparent: true,
  });
  const sphere = new THREE.Mesh(sphereGeom, sphereWire);
  const sampler = new MeshSurfaceSampler(sphere).build();

  const bigSphereMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    wireframe: true,
    transparent: true,
    opacity: 0.1,
    uniforms: {
      uTime: { value: 0 },
      uTint: { value: tint.clone() },
    },
    vertexShader: kekkoBackgroundVertexShader,
    fragmentShader: kekkoBackgroundFragmentShader,
  });
  const bigSphere = new THREE.Mesh(new THREE.SphereGeometry(6.5, 120, 60), bigSphereMat);
  scene.add(bigSphere);

  const particleGeom = new THREE.SphereGeometry(0.01, 16, 16);
  const instanceDirectionAttr = new THREE.InstancedBufferAttribute(
    new Float32Array(config.particlesCount * 3),
    3,
  );
  const instanceRandomAttr = new THREE.InstancedBufferAttribute(new Float32Array(config.particlesCount), 1);
  particleGeom.setAttribute('instanceDirection', instanceDirectionAttr);
  particleGeom.setAttribute('instanceRandom', instanceRandomAttr);

  const particleMat = new THREE.ShaderMaterial({
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    uniforms: {
      uTime: { value: 1 },
      uInfluence: { value: 0 },
      uTint: { value: tint.clone() },
    },
    vertexShader: kekkoParticleVertexShader,
    fragmentShader: kekkoParticleFragmentShader,
  });

  const particles = new THREE.InstancedMesh(particleGeom, particleMat, config.particlesCount);

  const tempPosition = new THREE.Vector3();
  const tempObject = new THREE.Object3D();
  const center = new THREE.Vector3();

  for (let i = 0; i < config.particlesCount; i++) {
    sampler.sample(tempPosition);
    tempObject.position.copy(tempPosition);
    tempObject.scale.setScalar(0.5 + Math.random() * 0.5);
    tempObject.updateMatrix();
    particles.setMatrixAt(i, tempObject.matrix);

    const dir = new THREE.Vector3();
    dir.subVectors(tempPosition, center).normalize();
    instanceDirectionAttr.setXYZ(i, dir.x, dir.y, dir.z);
    instanceRandomAttr.setX(i, Math.random());
  }
  instanceDirectionAttr.needsUpdate = true;
  instanceRandomAttr.needsUpdate = true;

  mainGroup.add(particles);

  const icoGeom = new THREE.IcosahedronGeometry(1.2, 0);
  const icoMat = new THREE.MeshBasicMaterial({
    color: new THREE.Color(initialColors.r, initialColors.g, initialColors.b),
    wireframe: true,
    transparent: true,
    opacity: 0.5,
  });
  const icosahedron = new THREE.Mesh(icoGeom, icoMat);
  mainGroup.add(icosahedron);

  const renderPass = new RenderPass(scene, camera);
  const resolution = new THREE.Vector2(width, height);
  const bloomPass = new UnrealBloomPass(resolution, 0, 0, 0);
  bloomPass.threshold = config.bloomThreshold;
  bloomPass.strength = config.bloomStrength;
  bloomPass.radius = config.bloomRadius;

  const afterimagePass = new AfterimagePass();
  afterimagePass.uniforms.damp.value = 0.6;

  const outputPass = new OutputPass();

  const composer = new EffectComposer(renderer);
  composer.addPass(renderPass);
  composer.addPass(afterimagePass);
  composer.addPass(bloomPass);
  composer.addPass(outputPass);

  const clock = new THREE.Clock();
  let tick = 0;

  const gui = new GUI({ title: 'Kekko-style (bloom)' });
  const bloomFolder = gui.addFolder('Bloom');
  bloomFolder.add(bloomPass, 'enabled').name('Enabled');
  bloomFolder.add(bloomPass, 'strength', 0, 3).name('Strength');
  bloomFolder.add(bloomPass, 'threshold', 0, 1).name('Threshold');
  bloomFolder.add(bloomPass, 'radius', 0, 1).name('Radius');
  const afterFolder = gui.addFolder('Afterimage');
  afterFolder.add(afterimagePass, 'enabled').name('Enabled');
  afterFolder.add(afterimagePass.uniforms.damp, 'value', 0, 1).name('Damp');

  let raf = 0;
  const animate = () => {
    raf = requestAnimationFrame(animate);
    const elapsed = clock.getElapsedTime();

    mainGroup.rotation.y += 0.002;
    mainGroup.rotation.z += 0.0012;
    icosahedron.rotation.x += 0.009;
    bigSphere.rotation.z -= 0.003;
    bigSphere.rotation.y -= 0.001;

    const pMat = particles.material as THREE.ShaderMaterial;
    pMat.uniforms.uTime.value += 0.05 * config.particlesSpeed;
    bigSphereMat.uniforms.uTime.value = elapsed;

    const playing = sound.isPlaying;
    if (analyser && playing) {
      const d = analyser.getFrequencyData();
      let sum = 0;
      for (let i = 0; i < d.length; i++) sum += d[i];
      const avg = sum / d.length;
      pMat.uniforms.uInfluence.value = avg * 0.03;
      icosahedron.scale.setScalar(1 - avg * 0.006);

      tick += 0.01;
      camera.position.x = Math.sin(tick * 0.63) * 2.7 * config.cameraSpeed;
      camera.position.y = Math.sin(tick * 0.84) * 2.15 * config.cameraSpeed;
      camera.position.z = Math.cos(tick * 0.39) * config.cameraRadius * config.cameraSpeed;
      camera.lookAt(scene.position);
    } else {
      // Idle preview: gentle motion before audio is loaded or while paused so the canvas is never a static screenshot.
      const idle = (Math.sin(elapsed * 1.1) * 0.5 + 0.5) * 40;
      pMat.uniforms.uInfluence.value = idle * 0.018;
      icosahedron.scale.setScalar(1 - idle * 0.004);
      tick += 0.008;
      const orbit = analyser ? 0.28 : 0.42;
      camera.position.x = Math.sin(tick * 0.63) * 2.7 * orbit;
      camera.position.y = Math.sin(tick * 0.84) * 2.15 * orbit;
      camera.position.z = Math.cos(tick * 0.39) * config.cameraRadius * orbit;
      camera.lookAt(scene.position);
    }

    composer.render();
  };
  animate();

  const ro = new ResizeObserver(() => {
    const s = getSize(mountEl);
    camera.aspect = s.width / s.height;
    camera.updateProjectionMatrix();
    renderer.setSize(s.width, s.height);
    composer.setSize(s.width, s.height);
    bloomPass.setSize(s.width, s.height);
  });
  ro.observe(mountEl);

  const setWireframeColors = (c: InitialColors) => {
    tint.set(c.r, c.g, c.b);
    (bigSphereMat.uniforms.uTint.value as THREE.Vector3).copy(tint);
    (particleMat.uniforms.uTint.value as THREE.Vector3).copy(tint);
    icoMat.color.setRGB(c.r, c.g, c.b);
  };

  const dispose = () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
    gui.destroy();

    if (sound.isPlaying) sound.stop();
    sphereGeom.dispose();
    sphereWire.dispose();
    bigSphere.geometry.dispose();
    bigSphereMat.dispose();
    particleGeom.dispose();
    particleMat.dispose();
    icoGeom.dispose();
    icoMat.dispose();
    composer.dispose();
    renderer.dispose();
    if (renderer.domElement.parentElement === mountEl) {
      mountEl.removeChild(renderer.domElement);
    }
  };

  const setAudioBuffer = (buffer: AudioBuffer) => {
    sound.setBuffer(buffer);
    analyser = new THREE.AudioAnalyser(sound, 128);
    config.particlesSpeed = 0.55;
    config.cameraSpeed = 1;
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
    if (analyser) {
      config.particlesSpeed = 0.55;
      config.cameraSpeed = 1;
    }
  };

  const pause = () => {
    if (sound.isPlaying) sound.pause();
    config.particlesSpeed = 0;
    config.cameraSpeed = 0;
  };

  return { play, pause, setAudioBuffer, loadAudioFromBase64, setWireframeColors, dispose };
}
