import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Vignette,
} from '@react-three/postprocessing';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
} from 'postprocessing';
import { gameRefs, SURFACE_CONFIGS, useGameStore } from '../state/gameStore';
import { SpinType } from '../types/game';

interface TowerConfig {
  position: [number, number, number];
  baseTarget: [number, number, number];
  seed: number;
  role: 'primary' | 'secondary';
}

const TOWER_CONFIGS: readonly TowerConfig[] = [
  {
    position: [-15.2, 19.5, -18.5],
    baseTarget: [2.4, 0, -4.4],
    seed: 0.0,
    role: 'primary',
  },
  {
    position: [15.2, 19.5, -18.5],
    baseTarget: [-2.4, 0, -4.4],
    seed: 1.57,
    role: 'secondary',
  },
  {
    position: [-15.5, 19.5, 19.8],
    baseTarget: [2.4, 0, 4.4],
    seed: 3.14,
    role: 'secondary',
  },
  {
    position: [15.5, 19.5, 19.8],
    baseTarget: [-2.4, 0, 4.4],
    seed: 4.71,
    role: 'primary',
  },
];

const SPIN_LIGHT_COLORS: Record<SpinType, string> = {
  topspin: '#ff388c',
  slice: '#00eeff',
  flat: '#e4ff33',
};

const BASE_SKY_GLOW = new THREE.Color('#0d1b3e');
const BASE_GROUND_GLOW = new THREE.Color('#090414');
const COOL_WHITE = new THREE.Color('#eef6ff');
const HOT_WHITE = new THREE.Color('#ffffff');
const NET_FLASH_COLOR = new THREE.Color('#ff2255');
const OUT_FLASH_COLOR = new THREE.Color('#ff1a3c');
const DOWN_AXIS = new THREE.Vector3(0, -1, 0);

// Scratch math objects to avoid per-frame allocations in useFrame
const _primaryCol = new THREE.Color();
const _secondaryCol = new THREE.Color();
const _accentCol = new THREE.Color();
const _targetKeyCol = new THREE.Color();
const _targetSkyCol = new THREE.Color();
const _targetGroundCol = new THREE.Color();
const _targetBallCol = new THREE.Color();
const _spinCol = new THREE.Color();
const _flashCol = new THREE.Color();
const _coneCol = new THREE.Color();
const _towerPos = new THREE.Vector3();
const _targetPos = new THREE.Vector3();
const _beamDir = new THREE.Vector3();

const VOLUMETRIC_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewPos;

  void main() {
    vUv = uv;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    vViewPos = -mvPosition.xyz;
    vNormalView = normalize(normalMatrix * normal);
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const VOLUMETRIC_FRAGMENT_SHADER = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uTime;
  uniform float uSeed;

  varying vec2 vUv;
  varying vec3 vNormalView;
  varying vec3 vViewPos;

  void main() {
    vec3 viewDir = normalize(vViewPos);
    vec3 normal = normalize(vNormalView);

    // Smooth Fresnel edge roll-off eliminates hard cone silhouettes from all angles
    float ndotv = abs(dot(normal, viewDir));
    float edgeFade = pow(ndotv, 1.9);

    // Soft entry just below the spotlight lens (vUv.y <= 0.985) and gradual fade toward floor
    float topFade = smoothstep(0.985, 0.86, vUv.y);
    float bottomFade = pow(smoothstep(0.0, 0.86, vUv.y), 1.4);

    // Subtle atmospheric beam shafts
    float shaft = 0.86 + 0.14 * sin(vUv.x * 18.84955 + uTime * 1.35 + uSeed);

    float alpha = uOpacity * edgeFade * topFade * bottomFade * shaft;
    gl_FragColor = vec4(uColor * (0.95 + 0.25 * topFade), alpha);
  }
`;

export const LightingAndPostFX: React.FC = () => {
  const keyLightRef = useRef<THREE.DirectionalLight>(null);
  const hemiLightRef = useRef<THREE.HemisphereLight>(null);
  const farRimLightRef = useRef<THREE.DirectionalLight>(null);
  const nearFillLightRef = useRef<THREE.DirectionalLight>(null);
  const flankRimLightRef = useRef<THREE.DirectionalLight>(null);

  const ballLightRef = useRef<THREE.PointLight>(null);
  const impactLightRef = useRef<THREE.PointLight>(null);

  const towerBeamRefs = useRef<Array<THREE.Group | null>>([null, null, null, null]);
  const lensMatRefs = useRef<Array<THREE.MeshBasicMaterial | null>>([
    null,
    null,
    null,
    null,
  ]);
  const ringMatRefs = useRef<Array<THREE.MeshStandardMaterial | null>>([
    null,
    null,
    null,
    null,
  ]);

  const bloomEffectRef = useRef<BloomEffect | null>(null);
  const chromaticEffectRef = useRef<ChromaticAberrationEffect | null>(null);

  const lastImpactIdRef = useRef<number>(-1);
  const flashAgeRef = useRef<number>(0);
  const flashPeakRef = useRef<number>(0);
  const chromaticImpulseRef = useRef<number>(0);
  const bloomImpulseRef = useRef<number>(0);
  const elapsedRef = useRef<number>(0);

  const handleBloomRef = useCallback((instance: unknown) => {
    bloomEffectRef.current =
      instance && typeof instance === 'object' && 'intensity' in instance
        ? (instance as BloomEffect)
        : null;
  }, []);

  const handleChromaticRef = useCallback((instance: unknown) => {
    chromaticEffectRef.current =
      instance && typeof instance === 'object' && 'offset' in instance
        ? (instance as ChromaticAberrationEffect)
        : null;
  }, []);

  // Stable Vector2 passed once so ChromaticAberration effect instance is never re-created
  const chromaticOffset = useMemo(() => new THREE.Vector2(0, 0), []);

  // Shared volumetric cone geometry (apex at local origin, widening along -Y)
  const coneGeometry = useMemo(() => {
    const height = 31.0;
    const geo = new THREE.ConeGeometry(4.5, height, 32, 1, true);
    geo.translate(0, -height * 0.5, 0);
    return geo;
  }, []);

  // Per-tower ShaderMaterials so each corner spotlight can independently sweep & pulse
  const coneMaterials = useMemo(() => {
    const initialCfg = SURFACE_CONFIGS[useGameStore.getState().surface];
    return TOWER_CONFIGS.map((cfg) => {
      const initialColor =
        cfg.role === 'primary' ? initialCfg.primaryColor : initialCfg.secondaryColor;
      return new THREE.ShaderMaterial({
        uniforms: {
          uColor: { value: new THREE.Color(initialColor) },
          uOpacity: { value: 0.068 },
          uTime: { value: 0 },
          uSeed: { value: cfg.seed },
        },
        vertexShader: VOLUMETRIC_VERTEX_SHADER,
        fragmentShader: VOLUMETRIC_FRAGMENT_SHADER,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    });
  }, []);

  useEffect(() => {
    return () => {
      coneGeometry.dispose();
      coneMaterials.forEach((mat) => mat.dispose());
    };
  }, [coneGeometry, coneMaterials]);

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    elapsedRef.current += dt;
    const t = elapsedRef.current;

    const state = useGameStore.getState();
    const cfg = SURFACE_CONFIGS[state.surface];
    const excitement = state.crowdExcitement;
    const isCelebration = state.phase === 'point-over' || state.phase === 'replay';

    const colorLerpAlpha = 1 - Math.exp(-4.5 * dt);
    const fxLerpAlpha = 1 - Math.exp(-8.0 * dt);

    _primaryCol.set(cfg.primaryColor);
    _secondaryCol.set(cfg.secondaryColor);
    _accentCol.set(cfg.accentColor);

    // ------------------------------------------------------------------
    // 1. Dynamic Surface-Reactive Stadium Lights
    // ------------------------------------------------------------------
    if (keyLightRef.current) {
      _targetKeyCol.copy(COOL_WHITE).lerp(_primaryCol, 0.34);
      keyLightRef.current.color.lerp(_targetKeyCol, colorLerpAlpha);
      const targetIntensity =
        1.78 + excitement * 0.32 + (cfg.emissiveIntensity - 1.25) * 0.45;
      keyLightRef.current.intensity = THREE.MathUtils.lerp(
        keyLightRef.current.intensity,
        targetIntensity,
        colorLerpAlpha
      );
    }

    if (hemiLightRef.current) {
      _targetSkyCol.copy(BASE_SKY_GLOW).lerp(_primaryCol, 0.2);
      _targetGroundCol.copy(BASE_GROUND_GLOW).lerp(_secondaryCol, 0.18);
      hemiLightRef.current.color.lerp(_targetSkyCol, colorLerpAlpha);
      hemiLightRef.current.groundColor.lerp(_targetGroundCol, colorLerpAlpha);
      hemiLightRef.current.intensity = THREE.MathUtils.lerp(
        hemiLightRef.current.intensity,
        0.84 + excitement * 0.22,
        colorLerpAlpha
      );
    }

    if (farRimLightRef.current) {
      farRimLightRef.current.color.lerp(_secondaryCol, colorLerpAlpha);
      farRimLightRef.current.intensity = THREE.MathUtils.lerp(
        farRimLightRef.current.intensity,
        1.32 + excitement * 0.42,
        colorLerpAlpha
      );
    }

    if (nearFillLightRef.current) {
      nearFillLightRef.current.color.lerp(_accentCol, colorLerpAlpha);
      nearFillLightRef.current.intensity = THREE.MathUtils.lerp(
        nearFillLightRef.current.intensity,
        1.12 + excitement * 0.32,
        colorLerpAlpha
      );
    }

    if (flankRimLightRef.current) {
      flankRimLightRef.current.color.lerp(_primaryCol, colorLerpAlpha);
      flankRimLightRef.current.intensity = THREE.MathUtils.lerp(
        flankRimLightRef.current.intensity,
        0.68 + excitement * 0.26,
        colorLerpAlpha
      );
    }

    // ------------------------------------------------------------------
    // 2. Dynamic Ball-Tracking Point Light & Impact Flash
    // ------------------------------------------------------------------
    const impact = state.lastImpact;
    if (impact && impact.id !== lastImpactIdRef.current) {
      lastImpactIdRef.current = impact.id;
      flashAgeRef.current = 0;

      const speedNorm = THREE.MathUtils.clamp(impact.speedKmh / 185, 0.3, 1.35);
      const isRacket =
        impact.type === 'racket-player' || impact.type === 'racket-ai';

      if (impact.type === 'net') {
        _flashCol.copy(NET_FLASH_COLOR);
        flashPeakRef.current = 15.5 * speedNorm;
      } else if (impact.type === 'out') {
        _flashCol.copy(OUT_FLASH_COLOR);
        flashPeakRef.current = 12.0 * speedNorm;
      } else if (isRacket) {
        _flashCol
          .set(SPIN_LIGHT_COLORS[impact.spin])
          .lerp(HOT_WHITE, 0.42);
        flashPeakRef.current = 14.5 * speedNorm;
      } else {
        _flashCol.copy(_primaryCol).lerp(_accentCol, 0.35);
        flashPeakRef.current = 9.5 * speedNorm;
      }

      if (impactLightRef.current) {
        impactLightRef.current.position.set(
          impact.position[0],
          Math.max(impact.position[1], 0.26),
          impact.position[2]
        );
        impactLightRef.current.color.copy(_flashCol);
        impactLightRef.current.intensity = flashPeakRef.current;
      }

      // Trigger subtle post-FX punch on explosive shots (>160 km/h) or net clips
      if (impact.speedKmh > 160) {
        const overSpeed = THREE.MathUtils.clamp(
          (impact.speedKmh - 150) / 75,
          0.35,
          1.0
        );
        chromaticImpulseRef.current = Math.max(
          chromaticImpulseRef.current,
          overSpeed
        );
        bloomImpulseRef.current = Math.max(
          bloomImpulseRef.current,
          overSpeed * 0.85
        );
      } else if (impact.type === 'net') {
        chromaticImpulseRef.current = Math.max(chromaticImpulseRef.current, 0.45);
        bloomImpulseRef.current = Math.max(bloomImpulseRef.current, 0.4);
      }
    }

    if (ballLightRef.current) {
      ballLightRef.current.position.set(
        gameRefs.ballPos.x,
        Math.max(gameRefs.ballPos.y + 0.16, 0.24),
        gameRefs.ballPos.z
      );

      const liveSpin =
        state.phase !== 'pre-serve' && impact ? impact.spin : state.currentSpin;

      _spinCol.set(SPIN_LIGHT_COLORS[liveSpin]);
      _targetBallCol.copy(_spinCol).lerp(_accentCol, 0.22);
      ballLightRef.current.color.lerp(_targetBallCol, fxLerpAlpha);

      const speedBoost = THREE.MathUtils.clamp(
        gameRefs.ballVel.length() / 42,
        0,
        1.2
      );
      const targetBallIntensity =
        2.6 + speedBoost * 1.15 + (state.isSlowMo ? 0.8 : 0);
      ballLightRef.current.intensity = THREE.MathUtils.lerp(
        ballLightRef.current.intensity,
        targetBallIntensity,
        fxLerpAlpha
      );
    }

    if (impactLightRef.current && flashPeakRef.current > 0) {
      flashAgeRef.current += dt;
      // Exponential decay over ~0.35s (e^-3.7 ≈ 0.025)
      const decay = Math.exp(-flashAgeRef.current / 0.095);
      if (flashAgeRef.current > 0.42 || decay < 0.01) {
        impactLightRef.current.intensity = 0;
        flashPeakRef.current = 0;
      } else {
        impactLightRef.current.intensity = flashPeakRef.current * decay;
      }
    }

    // ------------------------------------------------------------------
    // 3. Volumetric Stadium Spotlight Cones
    // ------------------------------------------------------------------
    const rallyHeat = Math.min(1, state.rallyCount / 10);
    const focusX =
      isCelebration && impact
        ? impact.position[0] * 0.45
        : gameRefs.ballPos.x * 0.16;
    const focusZ =
      isCelebration && impact
        ? impact.position[2] * 0.45
        : gameRefs.ballPos.z * 0.12;

    for (let i = 0; i < TOWER_CONFIGS.length; i++) {
      const cfgTower = TOWER_CONFIGS[i];
      const beamGrp = towerBeamRefs.current[i];
      const coneMat = coneMaterials[i];
      const lensMat = lensMatRefs.current[i];
      const ringMat = ringMatRefs.current[i];

      _towerPos.set(
        cfgTower.position[0],
        cfgTower.position[1],
        cfgTower.position[2]
      );

      if (isCelebration) {
        // Dramatic sweeping celebration cones converging & crossing over court
        const sweepAngle = t * (1.85 + excitement * 0.75) + cfgTower.seed;
        const sweepRadius = 5.4 + Math.sin(t * 2.2 + cfgTower.seed) * 1.8;
        _targetPos.set(
          focusX + Math.cos(sweepAngle) * sweepRadius,
          0,
          focusZ + Math.sin(sweepAngle * 0.85) * (sweepRadius * 1.25)
        );
      } else {
        // Subtle atmospheric court tracking with calm breathing sway
        _targetPos.set(
          cfgTower.baseTarget[0] +
            focusX +
            Math.sin(t * 0.45 + cfgTower.seed) * 0.85,
          0,
          cfgTower.baseTarget[2] +
            focusZ +
            Math.cos(t * 0.38 + cfgTower.seed) * 1.15
        );
      }

      if (beamGrp) {
        _beamDir.copy(_targetPos).sub(_towerPos).normalize();
        beamGrp.quaternion.setFromUnitVectors(DOWN_AXIS, _beamDir);
      }

      // Alternating tower colors between primary, secondary, and accent
      if (isCelebration && i % 2 === 1) {
        _coneCol.copy(_accentCol).lerp(_secondaryCol, 0.5 + 0.5 * Math.sin(t * 3 + i));
      } else if (cfgTower.role === 'primary') {
        _coneCol.copy(_primaryCol);
      } else {
        _coneCol.copy(_secondaryCol);
      }

      coneMat.uniforms.uColor.value.lerp(_coneCol, colorLerpAlpha);
      coneMat.uniforms.uTime.value = t;

      const baseOpacity = 0.062 + excitement * 0.028 + rallyHeat * 0.012;
      const celebrationBoost = isCelebration
        ? 0.022 + 0.016 * Math.sin(t * 4.5 + cfgTower.seed)
        : 0;
      const targetOpacity = THREE.MathUtils.clamp(
        baseOpacity + celebrationBoost,
        0.055,
        0.12
      );
      coneMat.uniforms.uOpacity.value = THREE.MathUtils.lerp(
        coneMat.uniforms.uOpacity.value,
        targetOpacity,
        fxLerpAlpha
      );

      if (lensMat) {
        lensMat.color.copy(coneMat.uniforms.uColor.value);
      }
      if (ringMat) {
        ringMat.emissive.copy(coneMat.uniforms.uColor.value);
        ringMat.emissiveIntensity = 1.15 + excitement * 0.65;
      }
    }

    // ------------------------------------------------------------------
    // 4. Post-Processing Dynamic Modulation (Bloom & Chromatic Aberration)
    // ------------------------------------------------------------------
    chromaticImpulseRef.current = Math.max(
      0,
      chromaticImpulseRef.current - dt * 2.85
    );
    bloomImpulseRef.current = Math.max(0, bloomImpulseRef.current - dt * 3.1);

    const isReplayOrSlowMo = state.isSlowMo || state.phase === 'replay';

    if (bloomEffectRef.current) {
      const targetBloom = THREE.MathUtils.clamp(
        1.35 +
          (isReplayOrSlowMo ? 0.22 : 0) +
          bloomImpulseRef.current * 0.34 +
          excitement * 0.1,
        1.3,
        1.82
      );
      bloomEffectRef.current.intensity = THREE.MathUtils.lerp(
        bloomEffectRef.current.intensity,
        targetBloom,
        fxLerpAlpha
      );
    }

    const slowMoWave = isReplayOrSlowMo
      ? 0.00085 + 0.00025 * Math.sin(t * 5.0)
      : 0;
    const impactChromatic = chromaticImpulseRef.current * 0.0022;
    const targetOffsetX = slowMoWave + impactChromatic;
    const targetOffsetY = targetOffsetX * 0.58;

    const nextOffsetX = THREE.MathUtils.lerp(
      chromaticOffset.x,
      targetOffsetX,
      1 - Math.exp(-16 * dt)
    );
    const nextOffsetY = THREE.MathUtils.lerp(
      chromaticOffset.y,
      targetOffsetY,
      1 - Math.exp(-16 * dt)
    );
    chromaticOffset.set(
      nextOffsetX < 1e-5 ? 0 : nextOffsetX,
      nextOffsetY < 1e-5 ? 0 : nextOffsetY
    );

    if (chromaticEffectRef.current?.offset) {
      chromaticEffectRef.current.offset.copy(chromaticOffset);
    }
  });

  return (
    <>
      <group name="stadium-lighting-rig">
        {/* High-Altitude Cyberpunk Sky Glow / Hemisphere Ambient Light */}
        <hemisphereLight
          ref={hemiLightRef}
          args={['#0d1b3e', '#090414', 0.86]}
        />

        {/* Key Directional Light with Tight ±16m 2048px Court Shadows */}
        <directionalLight
          ref={keyLightRef}
          castShadow
          position={[10, 22, 12]}
          intensity={1.82}
          color="#d8f2ff"
          shadow-mapSize={[2048, 2048]}
          shadow-camera-left={-16}
          shadow-camera-right={16}
          shadow-camera-top={16}
          shadow-camera-bottom={-16}
          shadow-camera-near={1}
          shadow-camera-far={65}
          shadow-bias={-0.0004}
          shadow-normalBias={0.02}
        />

        {/* Opposing Rim / Fill Accent Lights for Crisp Metallic Silhouettes */}
        <directionalLight
          ref={farRimLightRef}
          position={[-13, 10, -17]}
          intensity={1.35}
          color="#ff00aa"
        />
        <directionalLight
          ref={nearFillLightRef}
          position={[13, 8, 16]}
          intensity={1.15}
          color="#3b82f6"
        />
        <directionalLight
          ref={flankRimLightRef}
          position={[-14, 5, 5]}
          intensity={0.7}
          color="#00d4ff"
        />

        {/* Dynamic Ball-Tracking Neon Point Light */}
        <pointLight
          ref={ballLightRef}
          position={[0.45, 1.1, 11.4]}
          intensity={2.8}
          distance={9}
          decay={2}
          color="#ff388c"
        />

        {/* Exponentially Decaying Impact Flash Point Light */}
        <pointLight
          ref={impactLightRef}
          position={[0, 1, 0]}
          intensity={0}
          distance={14}
          decay={1.8}
          color="#ffffff"
        />

        {/* 4 Corner Stadium Spotlight Towers & Volumetric Beams */}
        {TOWER_CONFIGS.map((tower, idx) => (
          <group key={idx} position={tower.position}>
            {/* Hovering Anti-Grav Spotlight Gimbal Ring */}
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.78, 0.06, 8, 24]} />
              <meshStandardMaterial
                ref={(el) => {
                  ringMatRefs.current[idx] = el;
                }}
                color="#0c1324"
                emissive="#00d4ff"
                emissiveIntensity={1.2}
                metalness={0.88}
                roughness={0.22}
                toneMapped={false}
              />
            </mesh>

            {/* Swiveling Spotlight Head + Soft Volumetric Light Cone */}
            <group
              ref={(el) => {
                towerBeamRefs.current[idx] = el;
              }}
            >
              <mesh position={[0, -0.15, 0]}>
                <cylinderGeometry args={[0.28, 0.46, 0.62, 12]} />
                <meshStandardMaterial
                  color="#0a0f1d"
                  metalness={0.9}
                  roughness={0.25}
                />
              </mesh>
              <mesh
                position={[0, -0.47, 0]}
                rotation={[Math.PI / 2, 0, 0]}
              >
                <circleGeometry args={[0.41, 20]} />
                <meshBasicMaterial
                  ref={(el) => {
                    lensMatRefs.current[idx] = el;
                  }}
                  color="#00d4ff"
                  toneMapped={false}
                />
              </mesh>
              <mesh
                geometry={coneGeometry}
                material={coneMaterials[idx]}
                frustumCulled={false}
              />
            </group>
          </group>
        ))}
      </group>

      {/* Cinematic Post-Processing Pipeline */}
      <EffectComposer multisampling={0}>
        <Bloom
          ref={handleBloomRef}
          mipmapBlur
          luminanceThreshold={0.22}
          luminanceSmoothing={0.4}
          intensity={1.35}
          radius={0.68}
        />
        <ChromaticAberration
          ref={handleChromaticRef}
          blendFunction={BlendFunction.NORMAL}
          offset={chromaticOffset}
          radialModulation={true}
          modulationOffset={0.18}
        />
        <Vignette
          blendFunction={BlendFunction.NORMAL}
          eskil={false}
          offset={0.2}
          darkness={0.55}
        />
      </EffectComposer>
    </>
  );
};
