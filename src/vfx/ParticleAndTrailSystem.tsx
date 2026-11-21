import React, { useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { SURFACE_CONFIGS, gameRefs, useGameStore } from '../state/gameStore';
import { SpinType } from '../types/game';

const TRAIL_COUNT = 36;
const MAX_TRAJ_SEGMENTS = 48;
const MAX_TRAJ_NODES = 32;
const MAX_SPARKS = 180;
const MAX_SHOCKWAVES = 10;
const MAX_LINE_FLASHES = 6;

interface SpinPalette {
  head: THREE.Color;
  mid: THREE.Color;
  tail: THREE.Color;
  glow: string;
}

const SPIN_PALETTES: Record<SpinType, SpinPalette> = {
  topspin: {
    head: new THREE.Color('#ff2a85').multiplyScalar(2.1),
    mid: new THREE.Color('#ff7b00').multiplyScalar(1.8),
    tail: new THREE.Color('#ff0055').multiplyScalar(0.3),
    glow: '#ff2a85',
  },
  slice: {
    head: new THREE.Color('#c8ffff').multiplyScalar(2.1),
    mid: new THREE.Color('#00e5ff').multiplyScalar(1.8),
    tail: new THREE.Color('#0066ff').multiplyScalar(0.3),
    glow: '#00e5ff',
  },
  flat: {
    head: new THREE.Color('#ffffff').multiplyScalar(2.2),
    mid: new THREE.Color('#e6ff2a').multiplyScalar(1.9),
    tail: new THREE.Color('#a3ff00').multiplyScalar(0.35),
    glow: '#e6ff2a',
  },
};

interface SparkParticle {
  active: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  color: THREE.Color;
  age: number;
  maxAge: number;
  size: number;
}

interface ShockwaveData {
  active: boolean;
  age: number;
  maxAge: number;
  maxScale: number;
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  color: THREE.Color;
}

interface LineFlashData {
  active: boolean;
  age: number;
  maxAge: number;
  pos: THREE.Vector3;
  scale: THREE.Vector3;
  color: THREE.Color;
}

// Reusable scratch math objects (zero allocations inside useFrame)
const _tmpDir = new THREE.Vector3();
const _tmpToCam = new THREE.Vector3();
const _tmpSide = new THREE.Vector3();
const _tmpVec = new THREE.Vector3();
const _tmpVec2 = new THREE.Vector3();
const _tmpUp = new THREE.Vector3(0, 1, 0);
const _tmpForward = new THREE.Vector3(0, 0, 1);
const _tmpQuat = new THREE.Quaternion();
const _tmpScale = new THREE.Vector3();
const _tmpMat = new THREE.Matrix4();
const _tmpColor = new THREE.Color();
const _zeroScale = new THREE.Vector3(0.0001, 0.0001, 0.0001);

function createRadialGlowTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    const grad = ctx.createRadialGradient(64, 64, 2, 64, 64, 64);
    grad.addColorStop(0, 'rgba(255, 255, 255, 1)');
    grad.addColorStop(0.28, 'rgba(255, 255, 255, 0.65)');
    grad.addColorStop(0.62, 'rgba(255, 255, 255, 0.14)');
    grad.addColorStop(1, 'rgba(255, 255, 255, 0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 128, 128);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createReticleTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.clearRect(0, 0, 256, 256);
    ctx.translate(128, 128);

    // Outer dashed ring
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.lineWidth = 6;
    for (let i = 0; i < 4; i++) {
      const a0 = i * (Math.PI / 2) + 0.18;
      const a1 = (i + 1) * (Math.PI / 2) - 0.18;
      ctx.beginPath();
      ctx.arc(0, 0, 108, a0, a1);
      ctx.stroke();
    }

    // Inner thin precision ring
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.72)';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(0, 0, 68, 0, Math.PI * 2);
    ctx.stroke();

    // Crosshair ticks
    ctx.lineWidth = 4;
    for (let i = 0; i < 4; i++) {
      ctx.save();
      ctx.rotate(i * (Math.PI / 2));
      ctx.beginPath();
      ctx.moveTo(0, -120);
      ctx.lineTo(0, -84);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, -44);
      ctx.lineTo(0, -24);
      ctx.stroke();
      ctx.restore();
    }

    // Center dot
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.beginPath();
    ctx.arc(0, 0, 9, 0, Math.PI * 2);
    ctx.fill();
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function buildRibbonGeometry(segmentCount: number): THREE.BufferGeometry {
  const vertexCount = segmentCount * 2;
  const positions = new Float32Array(vertexCount * 3);
  const colors = new Float32Array(vertexCount * 3);
  const indices: number[] = [];

  for (let i = 0; i < segmentCount - 1; i++) {
    const a = i * 2;
    const b = a + 1;
    const c = a + 2;
    const d = a + 3;
    indices.push(a, b, c, b, d, c);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setIndex(indices);
  return geo;
}

function buildTrajectoryGeometry(maxSegments: number): THREE.BufferGeometry {
  const positions = new Float32Array(maxSegments * 2 * 3);
  const colors = new Float32Array(maxSegments * 2 * 3);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.setDrawRange(0, 0);
  return geo;
}

export const ParticleAndTrailSystem: React.FC = () => {
  // Trail state
  const trailPoints = useMemo(
    () => Array.from({ length: TRAIL_COUNT }, () => gameRefs.ballPos.clone()),
    []
  );
  const prevBallHeadRef = useRef(gameRefs.ballPos.clone());
  const outerRibbonGeo = useMemo(() => buildRibbonGeometry(TRAIL_COUNT), []);
  const innerRibbonGeo = useMemo(() => buildRibbonGeometry(TRAIL_COUNT), []);
  const outerRibbonRef = useRef<THREE.Mesh>(null);
  const innerRibbonRef = useRef<THREE.Mesh>(null);

  // Ball glow & spin vortex refs
  const ballAuraRef = useRef<THREE.Sprite>(null);
  const spinRing1Ref = useRef<THREE.Mesh>(null);
  const spinRing2Ref = useRef<THREE.Mesh>(null);
  const glowTex = useMemo(() => createRadialGlowTexture(), []);
  const reticleTex = useMemo(() => createReticleTexture(), []);

  // Predictive trajectory & landing reticle
  const trajGeo = useMemo(() => buildTrajectoryGeometry(MAX_TRAJ_SEGMENTS), []);
  const trajLinesRef = useRef<THREE.LineSegments>(null);
  const trajNodesRef = useRef<THREE.InstancedMesh>(null);
  const reticleGroupRef = useRef<THREE.Group>(null);
  const reticleOuterMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const reticleInnerMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const reticleBeamMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const reticleRingRef = useRef<THREE.Mesh>(null);
  const reticleSpinRingRef = useRef<THREE.Mesh>(null);

  // Sparks instanced mesh pool
  const sparksMeshRef = useRef<THREE.InstancedMesh>(null);
  const sparksPool = useMemo<SparkParticle[]>(
    () =>
      Array.from({ length: MAX_SPARKS }, () => ({
        active: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        color: new THREE.Color('#00d4ff'),
        age: 0,
        maxAge: 0.5,
        size: 1,
      })),
    []
  );
  const sparkCursorRef = useRef(0);

  // Shockwaves pool
  const shockwaveGroupRef = useRef<THREE.Group>(null);
  const shockwaveRefs = useRef<(THREE.Mesh | null)[]>([]);
  const shockwaves = useMemo<ShockwaveData[]>(
    () =>
      Array.from({ length: MAX_SHOCKWAVES }, () => ({
        active: false,
        age: 0,
        maxAge: 0.65,
        maxScale: 2.2,
        pos: new THREE.Vector3(),
        quat: new THREE.Quaternion(),
        color: new THREE.Color('#00d4ff'),
      })),
    []
  );
  const shockwaveCursorRef = useRef(0);

  // Laser court line flashes pool
  const lineFlashRefs = useRef<(THREE.Mesh | null)[]>([]);
  const lineFlashes = useMemo<LineFlashData[]>(
    () =>
      Array.from({ length: MAX_LINE_FLASHES }, () => ({
        active: false,
        age: 0,
        maxAge: 0.65,
        pos: new THREE.Vector3(),
        scale: new THREE.Vector3(1, 1, 1),
        color: new THREE.Color('#00ffa3'),
      })),
    []
  );
  const lineFlashCursorRef = useRef(0);

  const lastProcessedImpactIdRef = useRef<number>(-1);

  // Ensure instanced colors & matrices exist prior to first shader compile
  useLayoutEffect(() => {
    if (sparksMeshRef.current) {
      for (let i = 0; i < MAX_SPARKS; i++) {
        _tmpMat.compose(_tmpVec.set(0, -50, 0), _tmpQuat.identity(), _zeroScale);
        sparksMeshRef.current.setMatrixAt(i, _tmpMat);
        sparksMeshRef.current.setColorAt(i, _tmpColor.set('#00d4ff'));
      }
      sparksMeshRef.current.instanceMatrix.needsUpdate = true;
      if (sparksMeshRef.current.instanceColor) {
        sparksMeshRef.current.instanceColor.needsUpdate = true;
      }
    }

    if (trajNodesRef.current) {
      for (let i = 0; i < MAX_TRAJ_NODES; i++) {
        _tmpMat.compose(_tmpVec.set(0, -50, 0), _tmpQuat.identity(), _zeroScale);
        trajNodesRef.current.setMatrixAt(i, _tmpMat);
        trajNodesRef.current.setColorAt(i, _tmpColor.set('#00d4ff'));
      }
      trajNodesRef.current.instanceMatrix.needsUpdate = true;
      if (trajNodesRef.current.instanceColor) {
        trajNodesRef.current.instanceColor.needsUpdate = true;
      }
    }
  }, []);

  const spawnShockwave = (
    pos: THREE.Vector3,
    normal: THREE.Vector3,
    maxScale: number,
    maxAge: number,
    colorHex: string,
    hdrBoost = 2.0
  ) => {
    const idx = shockwaveCursorRef.current % MAX_SHOCKWAVES;
    shockwaveCursorRef.current += 1;
    const sw = shockwaves[idx];
    sw.active = true;
    sw.age = 0;
    sw.maxAge = maxAge;
    sw.maxScale = maxScale;
    sw.pos.copy(pos);
    sw.quat.setFromUnitVectors(_tmpForward, normal);
    sw.color.set(colorHex).multiplyScalar(hdrBoost);
  };

  const spawnLineFlash = (
    x: number,
    z: number,
    lenX: number,
    lenZ: number,
    colorHex: string
  ) => {
    const idx = lineFlashCursorRef.current % MAX_LINE_FLASHES;
    lineFlashCursorRef.current += 1;
    const lf = lineFlashes[idx];
    lf.active = true;
    lf.age = 0;
    lf.maxAge = 0.72;
    lf.pos.set(x, 0.024, z);
    lf.scale.set(lenX, 0.032, lenZ);
    lf.color.set(colorHex).multiplyScalar(2.6);
  };

  const spawnSparksForImpact = (
    posArr: [number, number, number],
    velArr: [number, number, number],
    speedKmh: number,
    type: 'bounce' | 'racket-player' | 'racket-ai' | 'net' | 'out',
    spin: SpinType,
    surfaceId: keyof typeof SURFACE_CONFIGS
  ) => {
    const surfaceCfg = SURFACE_CONFIGS[surfaceId];
    const spinColor = SPIN_PALETTES[spin].glow;
    const count = Math.min(
      44,
      Math.max(18, Math.round(16 + (speedKmh / 200) * 26))
    );
    const speedNorm = Math.max(0.5, Math.min(2.2, speedKmh / 120));

    let primaryHex = surfaceCfg.primaryColor;
    let secondaryHex = surfaceCfg.accentColor;

    if (type === 'racket-player') {
      primaryHex = '#00f5ff';
      secondaryHex = spinColor;
    } else if (type === 'racket-ai') {
      primaryHex = '#ff2a85';
      secondaryHex = spinColor;
    } else if (type === 'net') {
      primaryHex = '#c026d3';
      secondaryHex = '#00f5ff';
    } else if (type === 'out') {
      primaryHex = '#ff2255';
      secondaryHex = '#ff9900';
    }

    for (let i = 0; i < count; i++) {
      const idx = sparkCursorRef.current % MAX_SPARKS;
      sparkCursorRef.current += 1;
      const p = sparksPool[idx];
      p.active = true;
      p.age = 0;
      p.maxAge = 0.28 + Math.random() * 0.36;
      p.size = 0.75 + Math.random() * 0.95;
      p.pos.set(posArr[0], Math.max(0.02, posArr[1]), posArr[2]);

      const spread = type === 'bounce' ? 5.2 : 6.8;
      const vx =
        velArr[0] * 0.28 + (Math.random() - 0.5) * spread * speedNorm;
      const vy =
        type === 'bounce' || type === 'out'
          ? Math.abs(velArr[1]) * 0.35 + (1.8 + Math.random() * 5.2) * speedNorm
          : velArr[1] * 0.25 + (Math.random() - 0.35) * spread * speedNorm;
      const vz =
        velArr[2] * 0.28 + (Math.random() - 0.5) * spread * speedNorm;

      p.vel.set(vx, vy, vz);
      p.color
        .set(i % 2 === 0 ? primaryHex : secondaryHex)
        .multiplyScalar(2.3);
    }
  };

  useFrame((state, rawDelta) => {
    const store = useGameStore.getState();
    const dt = Math.min(rawDelta, 0.05);
    const simDt = dt * store.timeScale;
    const elapsed = state.clock.elapsedTime;
    const activeSpin: SpinType =
      store.phase === 'pre-serve' ||
      store.phase === 'serve-toss' ||
      !store.lastImpact
        ? store.currentSpin
        : store.lastImpact.spin;
    const palette = SPIN_PALETTES[activeSpin];
    const surfaceCfg = SURFACE_CONFIGS[store.surface];

    // ---------------------------------------------------------
    // 1. TRIGGER IMPACT VFX WHEN lastImpact UPDATES
    // ---------------------------------------------------------
    const impact = store.lastImpact;
    if (impact === null) {
      lastProcessedImpactIdRef.current = -1;
    } else if (impact.id !== lastProcessedImpactIdRef.current) {
      lastProcessedImpactIdRef.current = impact.id;

      spawnSparksForImpact(
        impact.position,
        impact.velocity,
        impact.speedKmh,
        impact.type,
        impact.spin,
        impact.surface
      );

      _tmpVec.set(impact.position[0], impact.position[1], impact.position[2]);

      if (impact.type === 'bounce' || impact.type === 'out') {
        const ringPos = _tmpVec2.set(impact.position[0], 0.018, impact.position[2]);
        const ringColor =
          impact.type === 'out' ? '#ff2255' : surfaceCfg.primaryColor;
        const maxScale =
          1.4 + Math.min(1.8, (impact.speedKmh / 180) * 1.4);
        spawnShockwave(ringPos, _tmpUp, maxScale, 0.62, ringColor, 2.2);

        if (impact.type === 'bounce') {
          // Inner secondary ripple ring
          spawnShockwave(
            ringPos,
            _tmpUp,
            maxScale * 0.65,
            0.42,
            surfaceCfg.secondaryColor,
            1.8
          );
        }

        // Hawk-Eye laser line flash if bounce lands near court lines
        const bx = impact.position[0];
        const bz = impact.position[2];
        const lineThresh = 0.58;
        const lineFlashColor =
          impact.type === 'out' ? '#ff2255' : surfaceCfg.accentColor;

        if (Math.abs(Math.abs(bz) - 11.885) < lineThresh && Math.abs(bx) <= 5.7) {
          spawnLineFlash(0, bz > 0 ? 11.885 : -11.885, 10.97, 0.09, lineFlashColor);
        }
        if (Math.abs(Math.abs(bz) - 6.4) < lineThresh && Math.abs(bx) <= 4.35) {
          spawnLineFlash(0, bz > 0 ? 6.4 : -6.4, 8.23, 0.08, lineFlashColor);
        }
        if (Math.abs(Math.abs(bx) - 4.115) < lineThresh && Math.abs(bz) <= 12.1) {
          spawnLineFlash(bx > 0 ? 4.115 : -4.115, 0, 0.08, 23.77, lineFlashColor);
        }
        if (Math.abs(Math.abs(bx) - 5.485) < lineThresh && Math.abs(bz) <= 12.1) {
          spawnLineFlash(bx > 0 ? 5.485 : -5.485, 0, 0.08, 23.77, lineFlashColor);
        }
        if (Math.abs(bx) < lineThresh && Math.abs(bz) <= 6.55) {
          spawnLineFlash(0, 0, 0.07, 12.8, lineFlashColor);
        }
      } else if (impact.type === 'net') {
        spawnShockwave(_tmpVec, _tmpForward, 1.5, 0.5, '#ff00dd', 2.4);
      } else if (
        (impact.type === 'racket-player' || impact.type === 'racket-ai') &&
        impact.speedKmh >= 135
      ) {
        // Sonic shockwave perpendicular to shot velocity
        _tmpDir.set(impact.velocity[0], impact.velocity[1], impact.velocity[2]);
        if (_tmpDir.lengthSq() > 0.01) {
          _tmpDir.normalize();
          spawnShockwave(
            _tmpVec,
            _tmpDir,
            0.42 + Math.min(0.38, (impact.speedKmh - 135) / 180),
            0.28,
            SPIN_PALETTES[impact.spin].glow,
            1.5
          );
        }
      }
    }

    // ---------------------------------------------------------
    // 2. BALL TRAIL RIBBON (CAMERA-FACING TAPERED HDR RIBBON)
    // ---------------------------------------------------------
    const ballPos = gameRefs.ballPos;
    const distMoved = ballPos.distanceTo(prevBallHeadRef.current);
    if (distMoved > 2.5) {
      // Discontinuity (serve reset or replay jump): snap history cleanly
      for (let i = 0; i < TRAIL_COUNT; i++) {
        trailPoints[i].copy(ballPos);
      }
    } else {
      for (let i = TRAIL_COUNT - 1; i > 0; i--) {
        trailPoints[i].copy(trailPoints[i - 1]);
      }
      trailPoints[0].copy(ballPos);
    }
    prevBallHeadRef.current.copy(ballPos);

    const ballSpeed = gameRefs.ballVel.length();
    const showTrail =
      store.phase === 'rally' ||
      store.phase === 'serve-toss' ||
      store.phase === 'point-over' ||
      store.phase === 'replay';
    const speedFactor = showTrail
      ? Math.min(1.35, Math.max(0.25, ballSpeed / 24))
      : 0.08;
    const slowMoGlow = store.isSlowMo ? 1.35 : 1.0;

    const updateRibbon = (
      geo: THREE.BufferGeometry,
      baseWidth: number,
      intensityBoost: number
    ) => {
      const posAttr = geo.getAttribute('position') as THREE.BufferAttribute;
      const colAttr = geo.getAttribute('color') as THREE.BufferAttribute;
      const posArr = posAttr.array as Float32Array;
      const colArr = colAttr.array as Float32Array;

      for (let i = 0; i < TRAIL_COUNT; i++) {
        const curr = trailPoints[i];
        const prev = i === 0 ? trailPoints[0] : trailPoints[i - 1];
        const next =
          i === TRAIL_COUNT - 1 ? trailPoints[i] : trailPoints[i + 1];

        _tmpDir.subVectors(prev, next);
        if (_tmpDir.lengthSq() < 1e-6) {
          _tmpDir.set(0, 0, 1);
        } else {
          _tmpDir.normalize();
        }

        _tmpToCam.subVectors(state.camera.position, curr).normalize();
        _tmpSide.crossVectors(_tmpDir, _tmpToCam);
        if (_tmpSide.lengthSq() < 1e-5) {
          _tmpSide.set(1, 0, 0);
        } else {
          _tmpSide.normalize();
        }

        const t = i / (TRAIL_COUNT - 1);
        const taper = Math.pow(1 - t, 1.55) * baseWidth * speedFactor;

        const vIdx = i * 6;
        posArr[vIdx] = curr.x + _tmpSide.x * taper;
        posArr[vIdx + 1] = curr.y + _tmpSide.y * taper;
        posArr[vIdx + 2] = curr.z + _tmpSide.z * taper;

        posArr[vIdx + 3] = curr.x - _tmpSide.x * taper;
        posArr[vIdx + 4] = curr.y - _tmpSide.y * taper;
        posArr[vIdx + 5] = curr.z - _tmpSide.z * taper;

        // Color gradient: head -> mid -> tail fade
        if (t < 0.45) {
          _tmpColor.lerpColors(palette.head, palette.mid, t / 0.45);
        } else {
          _tmpColor.lerpColors(palette.mid, palette.tail, (t - 0.45) / 0.55);
        }
        const fade = Math.pow(1 - t, 1.4) * intensityBoost * slowMoGlow;
        const r = _tmpColor.r * fade;
        const g = _tmpColor.g * fade;
        const b = _tmpColor.b * fade;

        colArr[vIdx] = r;
        colArr[vIdx + 1] = g;
        colArr[vIdx + 2] = b;
        colArr[vIdx + 3] = r;
        colArr[vIdx + 4] = g;
        colArr[vIdx + 5] = b;
      }

      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    };

    updateRibbon(outerRibbonGeo, 0.088, 1.0);
    updateRibbon(innerRibbonGeo, 0.032, 1.45);

    // Ball aura & spin vortex rings
    if (ballAuraRef.current) {
      ballAuraRef.current.position.copy(ballPos);
      const auraScale =
        0.34 + (store.isSlowMo ? 0.14 : 0) + Math.min(0.22, ballSpeed * 0.004);
      ballAuraRef.current.scale.set(auraScale, auraScale, 1);
      const mat = ballAuraRef.current.material as THREE.SpriteMaterial;
      mat.color.set(palette.glow).multiplyScalar(1.3);
      mat.opacity = showTrail ? 0.55 : 0.3;
    }

    const spinRate = (store.spinRpm / 60) * 0.12 * (store.isSlowMo ? 0.4 : 1);
    if (spinRing1Ref.current) {
      spinRing1Ref.current.position.copy(ballPos);
      spinRing1Ref.current.rotation.x += spinRate * dt * 8;
      spinRing1Ref.current.rotation.y =
        activeSpin === 'slice' ? 0.55 : -0.25;
      const mat1 = spinRing1Ref.current.material as THREE.MeshBasicMaterial;
      mat1.color.copy(palette.head);
      mat1.opacity = showTrail ? 0.7 : 0.25;
    }
    if (spinRing2Ref.current) {
      spinRing2Ref.current.position.copy(ballPos);
      spinRing2Ref.current.rotation.y += spinRate * dt * 10;
      spinRing2Ref.current.rotation.z =
        activeSpin === 'topspin' ? 0.35 : 0.9;
      const mat2 = spinRing2Ref.current.material as THREE.MeshBasicMaterial;
      mat2.color.copy(palette.mid);
      mat2.opacity = showTrail ? 0.48 : 0.18;
    }

    // ---------------------------------------------------------
    // 3. MAGNUS PREDICTIVE TRAJECTORY ARC + LANDING RETICLE
    // ---------------------------------------------------------
    const trajPts = gameRefs.trajectoryPoints;
    const landing = gameRefs.predictedLanding;
    const showPrediction =
      (store.phase === 'rally' || store.phase === 'serve-toss') &&
      trajPts.length >= 2;

    const isPredictedOut =
      Math.abs(landing.x) > 4.115 || Math.abs(landing.z) > 11.885;

    if (trajLinesRef.current && trajNodesRef.current) {
      trajLinesRef.current.visible = showPrediction;
      trajNodesRef.current.visible = showPrediction;

      if (showPrediction) {
        const posAttr = trajGeo.getAttribute('position') as THREE.BufferAttribute;
        const colAttr = trajGeo.getAttribute('color') as THREE.BufferAttribute;
        const posArr = posAttr.array as Float32Array;
        const colArr = colAttr.array as Float32Array;

        const segLimit = Math.min(MAX_TRAJ_SEGMENTS, trajPts.length - 1);
        const startColor = palette.head;
        const endColor = isPredictedOut
          ? _tmpColor.set('#ff2255').multiplyScalar(2.1)
          : _tmpColor.set(surfaceCfg.secondaryColor).multiplyScalar(1.9);

        let drawnSegs = 0;
        for (let i = 0; i < segLimit; i++) {
          // Animated dashed effect: keep 70% of each segment drawn with marching pulse
          const p0 = trajPts[i];
          const p1 = trajPts[i + 1];
          const t0 = i / segLimit;
          const t1 = (i + 1) / segLimit;

          const dashPhase = (elapsed * 3.5 - i * 0.25) % 1;
          const dashGain = dashPhase > -0.35 ? 1.0 : 0.38;

          _tmpVec.lerpVectors(p0, p1, 0.82);

          const base = drawnSegs * 6;
          posArr[base] = p0.x;
          posArr[base + 1] = p0.y;
          posArr[base + 2] = p0.z;
          posArr[base + 3] = _tmpVec.x;
          posArr[base + 4] = _tmpVec.y;
          posArr[base + 5] = _tmpVec.z;

          const r0 = THREE.MathUtils.lerp(startColor.r, endColor.r, t0) * dashGain;
          const g0 = THREE.MathUtils.lerp(startColor.g, endColor.g, t0) * dashGain;
          const b0 = THREE.MathUtils.lerp(startColor.b, endColor.b, t0) * dashGain;

          const r1 = THREE.MathUtils.lerp(startColor.r, endColor.r, t1) * dashGain;
          const g1 = THREE.MathUtils.lerp(startColor.g, endColor.g, t1) * dashGain;
          const b1 = THREE.MathUtils.lerp(startColor.b, endColor.b, t1) * dashGain;

          colArr[base] = r0;
          colArr[base + 1] = g0;
          colArr[base + 2] = b0;
          colArr[base + 3] = r1;
          colArr[base + 4] = g1;
          colArr[base + 5] = b1;

          drawnSegs++;
        }

        trajGeo.setDrawRange(0, drawnSegs * 2);
        posAttr.needsUpdate = true;
        colAttr.needsUpdate = true;

        // Telemetry bead nodes along the curve
        const nodeStep = Math.max(1, Math.floor(trajPts.length / MAX_TRAJ_NODES));
        let nodeIdx = 0;
        for (
          let i = 0;
          i < trajPts.length && nodeIdx < MAX_TRAJ_NODES;
          i += nodeStep
        ) {
          const pt = trajPts[i];
          const frac = i / Math.max(1, trajPts.length - 1);
          const pulse =
            0.75 + 0.55 * Math.sin(elapsed * 10 - i * 0.65);
          const s = (0.024 + (1 - frac) * 0.012) * pulse;
          _tmpMat.compose(
            pt,
            _tmpQuat.identity(),
            _tmpScale.set(s, s, s)
          );
          trajNodesRef.current.setMatrixAt(nodeIdx, _tmpMat);
          _tmpColor.lerpColors(startColor, endColor, frac);
          trajNodesRef.current.setColorAt(nodeIdx, _tmpColor);
          nodeIdx++;
        }
        for (; nodeIdx < MAX_TRAJ_NODES; nodeIdx++) {
          _tmpMat.compose(_tmpVec.set(0, -50, 0), _tmpQuat.identity(), _zeroScale);
          trajNodesRef.current.setMatrixAt(nodeIdx, _tmpMat);
        }
        trajNodesRef.current.instanceMatrix.needsUpdate = true;
        if (trajNodesRef.current.instanceColor) {
          trajNodesRef.current.instanceColor.needsUpdate = true;
        }
      }
    }

    // Landing Reticle
    if (reticleGroupRef.current) {
      reticleGroupRef.current.visible = showPrediction;
      if (showPrediction) {
        reticleGroupRef.current.position.set(landing.x, 0.018, landing.z);
        const pulse = 0.92 + 0.14 * Math.sin(elapsed * 8.5);
        reticleGroupRef.current.scale.set(pulse, 1, pulse);

        if (reticleRingRef.current) {
          reticleRingRef.current.rotation.z = elapsed * 1.8;
        }
        if (reticleSpinRingRef.current) {
          reticleSpinRingRef.current.rotation.z = -elapsed * 3.2;
        }

        const reticleColorHex = isPredictedOut ? '#ff2255' : palette.glow;
        if (reticleOuterMatRef.current) {
          reticleOuterMatRef.current.color
            .set(reticleColorHex)
            .multiplyScalar(2.1);
        }
        if (reticleInnerMatRef.current) {
          reticleInnerMatRef.current.color
            .set(isPredictedOut ? '#ff8800' : surfaceCfg.primaryColor)
            .multiplyScalar(1.8);
        }
        if (reticleBeamMatRef.current) {
          reticleBeamMatRef.current.color
            .set(reticleColorHex)
            .multiplyScalar(1.4);
        }
      }
    }

    // ---------------------------------------------------------
    // 4. UPDATE INSTANCED SPARK BURSTS
    // ---------------------------------------------------------
    if (sparksMeshRef.current) {
      for (let i = 0; i < MAX_SPARKS; i++) {
        const p = sparksPool[i];
        if (!p.active) {
          _tmpMat.compose(_tmpVec.set(0, -50, 0), _tmpQuat.identity(), _zeroScale);
          sparksMeshRef.current.setMatrixAt(i, _tmpMat);
          continue;
        }

        p.age += simDt;
        if (p.age >= p.maxAge) {
          p.active = false;
          _tmpMat.compose(_tmpVec.set(0, -50, 0), _tmpQuat.identity(), _zeroScale);
          sparksMeshRef.current.setMatrixAt(i, _tmpMat);
          continue;
        }

        // Gravity & air drag
        p.vel.y -= 14.5 * simDt;
        const drag = Math.exp(-2.8 * simDt);
        p.vel.multiplyScalar(drag);
        p.pos.addScaledVector(p.vel, simDt);

        if (p.pos.y < 0.015) {
          p.pos.y = 0.015;
          p.vel.y = Math.abs(p.vel.y) * 0.45;
          p.vel.x *= 0.8;
          p.vel.z *= 0.8;
        }

        const lifeRatio = 1 - p.age / p.maxAge;
        const speed = p.vel.length();
        if (speed > 0.01) {
          _tmpDir.copy(p.vel).divideScalar(speed);
          _tmpQuat.setFromUnitVectors(_tmpForward, _tmpDir);
        } else {
          _tmpQuat.identity();
        }

        const stretch = Math.min(2.8, Math.max(0.45, speed * 0.22)) * p.size * lifeRatio;
        const thickness = 0.75 * p.size * lifeRatio;
        _tmpScale.set(thickness, thickness, stretch);
        _tmpMat.compose(p.pos, _tmpQuat, _tmpScale);
        sparksMeshRef.current.setMatrixAt(i, _tmpMat);

        _tmpColor.copy(p.color).multiplyScalar(lifeRatio);
        sparksMeshRef.current.setColorAt(i, _tmpColor);
      }

      sparksMeshRef.current.instanceMatrix.needsUpdate = true;
      if (sparksMeshRef.current.instanceColor) {
        sparksMeshRef.current.instanceColor.needsUpdate = true;
      }
    }

    // ---------------------------------------------------------
    // 5. UPDATE EXPANDING SHOCKWAVE RINGS
    // ---------------------------------------------------------
    for (let i = 0; i < MAX_SHOCKWAVES; i++) {
      const sw = shockwaves[i];
      const mesh = shockwaveRefs.current[i];
      if (!mesh) continue;

      if (!sw.active) {
        mesh.visible = false;
        continue;
      }

      sw.age += simDt;
      if (sw.age >= sw.maxAge) {
        sw.active = false;
        mesh.visible = false;
        continue;
      }

      const t = sw.age / sw.maxAge;
      const eased = 1 - Math.pow(1 - t, 3);
      const scale = 0.14 + eased * sw.maxScale;

      mesh.visible = true;
      mesh.position.copy(sw.pos);
      mesh.quaternion.copy(sw.quat);
      mesh.scale.set(scale, scale, 1);

      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.copy(sw.color);
      mat.opacity = (1 - t) * (1 - t) * 0.85;
    }

    // ---------------------------------------------------------
    // 6. UPDATE LASER LINE FLASHES
    // ---------------------------------------------------------
    for (let i = 0; i < MAX_LINE_FLASHES; i++) {
      const lf = lineFlashes[i];
      const mesh = lineFlashRefs.current[i];
      if (!mesh) continue;

      if (!lf.active) {
        mesh.visible = false;
        continue;
      }

      lf.age += dt;
      if (lf.age >= lf.maxAge) {
        lf.active = false;
        mesh.visible = false;
        continue;
      }

      const t = lf.age / lf.maxAge;
      const fade = Math.pow(1 - t, 1.8);
      mesh.visible = true;
      mesh.position.copy(lf.pos);
      mesh.scale.set(lf.scale.x, lf.scale.y * (0.6 + fade), lf.scale.z);

      const mat = mesh.material as THREE.MeshBasicMaterial;
      mat.color.copy(lf.color);
      mat.opacity = fade * 0.92;
    }
  });

  return (
    <group name="vfx-particle-and-trail-system">
      {/* Tapered HDR Ball Ribbon Trails */}
      <mesh ref={outerRibbonRef} geometry={outerRibbonGeo} frustumCulled={false}>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.78}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={innerRibbonRef} geometry={innerRibbonGeo} frustumCulled={false}>
        <meshBasicMaterial
          vertexColors
          transparent
          opacity={0.95}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </mesh>

      {/* Ball Glow Aura & Spin Vortex Rings */}
      <sprite ref={ballAuraRef} frustumCulled={false}>
        <spriteMaterial
          map={glowTex}
          transparent
          opacity={0.5}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </sprite>
      <mesh ref={spinRing1Ref} frustumCulled={false}>
        <torusGeometry args={[0.068, 0.0042, 8, 24]} />
        <meshBasicMaterial
          transparent
          opacity={0.65}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={spinRing2Ref} frustumCulled={false}>
        <torusGeometry args={[0.086, 0.0032, 8, 24]} />
        <meshBasicMaterial
          transparent
          opacity={0.42}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      {/* Magnus Predictive Trajectory Arc */}
      <lineSegments ref={trajLinesRef} geometry={trajGeo} frustumCulled={false}>
        <lineBasicMaterial
          vertexColors
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </lineSegments>
      <instancedMesh
        ref={trajNodesRef}
        args={[undefined, undefined, MAX_TRAJ_NODES]}
        frustumCulled={false}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          transparent
          opacity={0.9}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Holographic Landing Reticle */}
      <group ref={reticleGroupRef} visible={false}>
        <mesh ref={reticleRingRef} rotation={[-Math.PI / 2, 0, 0]}>
          <planeGeometry args={[0.78, 0.78]} />
          <meshBasicMaterial
            ref={reticleOuterMatRef}
            map={reticleTex}
            transparent
            opacity={0.92}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
        <mesh ref={reticleSpinRingRef} rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.005, 0]}>
          <ringGeometry args={[0.17, 0.21, 24]} />
          <meshBasicMaterial
            ref={reticleInnerMatRef}
            transparent
            opacity={0.85}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
        <mesh position={[0, 0.26, 0]}>
          <cylinderGeometry args={[0.012, 0.14, 0.52, 16, 1, true]} />
          <meshBasicMaterial
            ref={reticleBeamMatRef}
            transparent
            opacity={0.28}
            blending={THREE.AdditiveBlending}
            depthWrite={false}
            side={THREE.DoubleSide}
            toneMapped={false}
          />
        </mesh>
      </group>

      {/* Instanced 3D Velocity-Aligned Sparks */}
      <instancedMesh
        ref={sparksMeshRef}
        args={[undefined, undefined, MAX_SPARKS]}
        frustumCulled={false}
      >
        <boxGeometry args={[0.014, 0.014, 0.14]} />
        <meshBasicMaterial
          transparent
          opacity={0.95}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </instancedMesh>

      {/* Expanding Shockwave Ripples */}
      <group ref={shockwaveGroupRef}>
        {shockwaves.map((_, idx) => (
          <mesh
            key={`sw-${idx}`}
            ref={(el) => {
              shockwaveRefs.current[idx] = el;
            }}
            visible={false}
            frustumCulled={false}
          >
            <ringGeometry args={[0.78, 1.0, 36]} />
            <meshBasicMaterial
              transparent
              opacity={0.8}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              side={THREE.DoubleSide}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>

      {/* Hawk-Eye Laser Line Flashes */}
      <group>
        {lineFlashes.map((_, idx) => (
          <mesh
            key={`lf-${idx}`}
            ref={(el) => {
              lineFlashRefs.current[idx] = el;
            }}
            visible={false}
            frustumCulled={false}
          >
            <boxGeometry args={[1, 1, 1]} />
            <meshBasicMaterial
              transparent
              opacity={0.9}
              blending={THREE.AdditiveBlending}
              depthWrite={false}
              toneMapped={false}
            />
          </mesh>
        ))}
      </group>
    </group>
  );
};
