import React, { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame } from '@react-three/fiber';
import { MeshReflectorMaterial } from '@react-three/drei';
import { SURFACE_CONFIGS, gameRefs, useGameStore } from '../state/gameStore';
import { SurfaceType } from '../types/game';

// ============================================================================
// Constants & Court Dimensions (ITF Standard, centered at (0,0,0))
// ============================================================================
const COURT_HALF_X_SINGLES = 4.115;
const COURT_HALF_X_DOUBLES = 5.485;
const COURT_HALF_Z = 11.885;
const SERVICE_LINE_Z = 6.4;
const NET_POST_X = 5.94;
const NET_CENTER_H = 0.914;
const NET_POST_H = 1.07;

const FLOOR_WIDTH = 18.8;
const FLOOR_LENGTH = 31.6;

const SPORE_COUNT = 160;
const SKYSCRAPER_COUNT = 380;
const MEGA_COUNT = 12;
const TRAFFIC_COUNT = 260;

// Deterministic PRNG for consistent procedural stadium & city layouts
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Clean geometry merger (normalizes to non-indexed position/normal/uv)
function mergeSimpleGeometries(
  geometries: THREE.BufferGeometry[]
): THREE.BufferGeometry {
  const normalized: THREE.BufferGeometry[] = [];
  let totalVerts = 0;

  for (const raw of geometries) {
    const g = raw.index ? raw.toNonIndexed() : raw.clone();
    if (!g.getAttribute('normal')) {
      g.computeVertexNormals();
    }
    const pos = g.getAttribute('position');
    if (pos) {
      totalVerts += pos.count;
      normalized.push(g);
    }
  }

  const positions = new Float32Array(totalVerts * 3);
  const normals = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);

  let offset = 0;
  for (const g of normalized) {
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const norm = g.getAttribute('normal') as THREE.BufferAttribute;
    const uv = g.getAttribute('uv') as THREE.BufferAttribute | undefined;

    for (let i = 0; i < pos.count; i++) {
      const idx3 = (offset + i) * 3;
      const idx2 = (offset + i) * 2;
      positions[idx3] = pos.getX(i);
      positions[idx3 + 1] = pos.getY(i);
      positions[idx3 + 2] = pos.getZ(i);

      normals[idx3] = norm.getX(i);
      normals[idx3 + 1] = norm.getY(i);
      normals[idx3 + 2] = norm.getZ(i);

      if (uv) {
        uvs[idx2] = uv.getX(i);
        uvs[idx2 + 1] = uv.getY(i);
      }
    }
    offset += pos.count;
    g.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.computeBoundingSphere();
  return merged;
}

function getNetHeightAtX(x: number): number {
  const ratio = Math.min(Math.abs(x), NET_POST_X) / NET_POST_X;
  return NET_CENTER_H + (NET_POST_H - NET_CENTER_H) * ratio * ratio;
}

function isNearCourtLine(x: number, z: number): boolean {
  const tol = 0.4;
  const nearBaseline =
    Math.abs(Math.abs(z) - COURT_HALF_Z) < tol &&
    Math.abs(x) <= COURT_HALF_X_DOUBLES + tol;
  const nearDoublesSide =
    Math.abs(Math.abs(x) - COURT_HALF_X_DOUBLES) < tol &&
    Math.abs(z) <= COURT_HALF_Z + tol;
  const nearSinglesSide =
    Math.abs(Math.abs(x) - COURT_HALF_X_SINGLES) < tol &&
    Math.abs(z) <= COURT_HALF_Z + tol;
  const nearService =
    Math.abs(Math.abs(z) - SERVICE_LINE_Z) < tol &&
    Math.abs(x) <= COURT_HALF_X_SINGLES + tol;
  const nearCenterService =
    Math.abs(x) < tol && Math.abs(z) <= SERVICE_LINE_Z + tol;
  return (
    nearBaseline ||
    nearDoublesSide ||
    nearSinglesSide ||
    nearService ||
    nearCenterService
  );
}

// ============================================================================
// GLSL Shaders
// ============================================================================

const COURT_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uMorphGrass;
  uniform float uMorphHard;
  uniform float uMorphClay;
  uniform vec3 uImpactPos;
  uniform float uImpactTime;
  uniform float uExcitement;

  varying vec3 vWorldPos;
  varying vec3 vClayNormal;
  varying float vWaveHeight;
  varying float vRippleIntensity;

  #include <fog_pars_vertex>

  float computeClayDisplacement(vec2 xz, out vec2 grad, out float rippleOut) {
    float clayMask = uMorphClay;
    if (clayMask < 0.001) {
      grad = vec2(0.0);
      rippleOut = 0.0;
      return 0.0;
    }

    // Smooth boundary fade so floor edges stay cleanly seated against curbs
    float edgeX = 1.0 - smoothstep(7.2, 9.2, abs(xz.x));
    float edgeZ = 1.0 - smoothstep(13.2, 15.6, abs(xz.y));
    float bounds = edgeX * edgeZ;

    // Gentle ferrofluid idle tide
    float t = uTime;
    float tide = sin(xz.x * 0.85 + t * 1.4) * cos(xz.y * 0.65 - t * 1.1) * 0.007;
    float dTideDx = 0.85 * cos(xz.x * 0.85 + t * 1.4) * cos(xz.y * 0.65 - t * 1.1) * 0.007;
    float dTideDz = -0.65 * sin(xz.x * 0.85 + t * 1.4) * sin(xz.y * 0.65 - t * 1.1) * 0.007;

    // Expanding bounce ripple radiating from uImpactPos
    float elapsed = max(0.0, uTime - uImpactTime);
    float rippleH = 0.0;
    vec2 rippleGrad = vec2(0.0);
    float rippleVis = 0.0;

    if (elapsed < 3.0) {
      vec2 delta = xz - uImpactPos.xz;
      float dist = length(delta) + 0.0001;
      vec2 dir = delta / dist;
      float waveRadius = elapsed * 12.5;
      float diff = dist - waveRadius;
      float env = exp(-diff * diff * 1.35) * exp(-elapsed * 1.9);
      float phase = diff * 13.0;
      float s = sin(phase);
      float c = cos(phase);
      float amp = 0.012 * clayMask * bounds;

      rippleH = env * s * amp;
      float dWaveDr = env * (13.0 * c - 2.7 * diff * s) * amp;
      rippleGrad = dir * dWaveDr * 2.6;
      rippleVis = env * (0.55 + 0.45 * abs(s)) * clayMask;
    }

    grad = (vec2(dTideDx, dTideDz) * clayMask * bounds * 2.2) + rippleGrad;
    rippleOut = rippleVis;
    return (tide * clayMask * bounds) + rippleH;
  }

  void main() {
    vec3 pos = position;
    vec4 baseWorld = modelMatrix * vec4(pos, 1.0);

    vec2 grad;
    float rippleVis;
    float dispY = computeClayDisplacement(baseWorld.xz, grad, rippleVis);

    // PlaneGeometry is rotated -PI/2 around X, so local +Z corresponds to world +Y
    pos.z += dispY;
    vWaveHeight = dispY;
    vRippleIntensity = rippleVis;
    vClayNormal = normalize(vec3(-grad.x, 1.0, -grad.y));

    vec4 worldPos = modelMatrix * vec4(pos, 1.0);
    vWorldPos = worldPos.xyz;

    vec4 mvPosition = viewMatrix * worldPos;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const COURT_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uMorphGrass;
  uniform float uMorphHard;
  uniform float uMorphClay;
  uniform vec3 uImpactPos;
  uniform float uImpactTime;
  uniform float uExcitement;
  uniform float uMorphWave;
  uniform vec3 uBallPos;
  uniform vec3 uBallColor;

  varying vec3 vWorldPos;
  varying vec3 vClayNormal;
  varying float vWaveHeight;
  varying float vRippleIntensity;

  #include <fog_pars_fragment>

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  // Distance to hexagon edge (0 at edge, >0 inside)
  float hexEdge(vec2 p) {
    p *= vec2(1.0, 1.7320508);
    vec2 r = vec2(1.0, 1.7320508);
    vec2 h = r * 0.5;
    vec2 a = mod(p, r) - h;
    vec2 b = mod(p - h, r) - h;
    vec2 gv = dot(a, a) < dot(b, b) ? a : b;
    float d = max(abs(gv.x), dot(abs(gv), normalize(r)));
    return 0.5 - d;
  }

  float gridLine(vec2 coord, float width) {
    vec2 g = abs(fract(coord - 0.5) - 0.5) / (fwidth(coord) * max(width, 0.5) + 0.0001);
    return 1.0 - min(min(g.x, g.y), 1.0);
  }

  void main() {
    vec2 xz = vWorldPos.xz;
    vec3 viewDir = normalize(cameraPosition - vWorldPos);

    // Court zone masks
    float inDoublesX = 1.0 - smoothstep(5.47, 5.50, abs(xz.x));
    float inDoublesZ = 1.0 - smoothstep(11.87, 11.90, abs(xz.y));
    float inCourt = inDoublesX * inDoublesZ;

    float inSinglesX = 1.0 - smoothstep(4.10, 4.13, abs(xz.x));
    float inSingles = inSinglesX * inDoublesZ;

    float borderX = smoothstep(8.55, 8.75, abs(xz.x)) * (1.0 - smoothstep(8.85, 9.05, abs(xz.x)));
    float borderZ = smoothstep(14.95, 15.15, abs(xz.y)) * (1.0 - smoothstep(15.25, 15.45, abs(xz.y)));
    float apronRim = max(
      borderX * step(abs(xz.y), 15.45),
      borderZ * step(abs(xz.x), 9.05)
    );

    float elapsed = max(0.0, uTime - uImpactTime);
    float impactDist = length(xz - uImpactPos.xz);
    float impactRing = exp(-pow((impactDist - elapsed * 12.0) * 1.8, 2.0)) * exp(-elapsed * 2.4);

    // =========================================================================
    // 1) NEON GRASS: Bioluminescent cyber-turf + mow stripes + hex blade grid
    // =========================================================================
    float mowStripe = 0.5 + 0.5 * cos(xz.x * 2.29);
    float crossStripe = 0.5 + 0.5 * cos(xz.y * 1.45);
    vec3 grassBaseInner = mix(vec3(0.008, 0.055, 0.042), vec3(0.015, 0.095, 0.068), mowStripe);
    vec3 grassBaseApron = mix(vec3(0.005, 0.025, 0.024), vec3(0.009, 0.042, 0.036), crossStripe);
    vec3 grassCol = mix(grassBaseApron, grassBaseInner, inCourt);

    float hexMain = 1.0 - smoothstep(0.01, 0.055, hexEdge(xz * 2.1));
    float hexFine = 1.0 - smoothstep(0.01, 0.075, hexEdge(xz * 6.5));
    float turfPulse = 0.55 + 0.45 * sin(uTime * 2.2 - length(xz) * 0.35);
    float bioMicro = smoothstep(0.75, 0.98, hash21(floor(xz * 18.0)));

    vec3 emerald = vec3(0.0, 1.0, 0.64);
    vec3 cyanAccent = vec3(0.0, 0.90, 1.0);
    vec3 voltAccent = vec3(0.64, 1.0, 0.0);

    grassCol += emerald * hexMain * (0.14 + 0.14 * turfPulse + 0.16 * uExcitement) * mix(0.45, 1.0, inCourt);
    grassCol += cyanAccent * hexFine * (0.04 + 0.08 * inSingles);
    grassCol += mix(emerald, voltAccent, 0.45) * bioMicro * 0.10 * (0.5 + 0.5 * sin(uTime * 3.0 + xz.x * 5.0));
    grassCol += voltAccent * impactRing * 0.42;

    // =========================================================================
    // 2) HOLOGRAPHIC HARD: Obsidian/sapphire acrylic + parallax grid + circuits
    // =========================================================================
    vec3 hardBaseInner = vec3(0.012, 0.030, 0.085);
    vec3 hardBaseApron = vec3(0.007, 0.015, 0.042);
    vec3 hardCol = mix(hardBaseApron, hardBaseInner, inCourt);

    // Parallax holographic telemetry sub-grid shifted by view angle
    vec2 parallaxOffset = (viewDir.xz / max(abs(viewDir.y), 0.28)) * 0.18;
    vec2 subGridUv = (xz + parallaxOffset) * 1.15;
    float subGrid = gridLine(subGridUv, 1.35);
    float fineGrid = gridLine((xz + parallaxOffset * 0.5) * 4.6, 1.1);

    // Surface circuit pathways (PCB traces + racing data pulses)
    vec2 cCell = abs(fract(xz * 0.55) - 0.5);
    float traceDiag = 1.0 - smoothstep(0.012, 0.032, abs(cCell.x - cCell.y));
    float traceAxis = 1.0 - smoothstep(0.010, 0.026, min(cCell.x, cCell.y));
    float circuitMask = max(traceDiag * step(0.18, cCell.x + cCell.y), traceAxis * 0.75);
    float dataPacket = pow(0.5 + 0.5 * sin(xz.y * 1.8 - uTime * (3.2 + uExcitement * 4.0) + floor(xz.x * 1.1) * 2.1), 8.0);

    vec3 hardCyan = vec3(0.0, 0.83, 1.0);
    vec3 hardMagenta = vec3(1.0, 0.0, 0.67);
    vec3 hardSapphire = vec3(0.23, 0.51, 0.96);

    hardCol += hardSapphire * subGrid * (0.24 + 0.18 * uExcitement) * mix(0.55, 1.0, inCourt);
    hardCol += hardCyan * fineGrid * 0.08;
    hardCol += mix(hardCyan, hardMagenta, 0.35 + 0.35 * sin(xz.x * 0.4 + uTime)) * circuitMask * (0.16 + 0.68 * dataPacket);
    hardCol += hardCyan * impactRing * 0.55;

    // Fresnel rim sheen on acrylic
    float fresnel = pow(1.0 - max(dot(viewDir, vec3(0.0, 1.0, 0.0)), 0.0), 3.0);
    hardCol += vec3(0.05, 0.20, 0.45) * fresnel * 0.45;

    // =========================================================================
    // 3) LIQUID CLAY: Molten magenta/crimson-gold ferrofluid + bounce ripples
    // =========================================================================
    vec3 clayBaseInner = vec3(0.068, 0.012, 0.035);
    vec3 clayBaseApron = vec3(0.032, 0.008, 0.022);
    vec3 clayCol = mix(clayBaseApron, clayBaseInner, inCourt);

    // Domain-warped ferrofluid currents
    float tClay = uTime * 0.9;
    vec2 warp = xz * 0.72 + vec2(
      sin(xz.y * 0.8 + tClay) * 0.55,
      cos(xz.x * 0.75 - tClay * 0.8) * 0.55
    );
    float veinRaw = abs(sin(warp.x * 2.3 + cos(warp.y * 2.1 - tClay * 0.6)));
    float moltenVein = pow(1.0 - clamp(veinRaw, 0.0, 1.0), 6.0);

    vec3 clayMagenta = vec3(1.0, 0.165, 0.52);
    vec3 clayGold = vec3(1.0, 0.60, 0.0);
    vec3 clayCrimson = vec3(1.0, 0.0, 0.33);

    clayCol += mix(clayCrimson, clayGold, 0.4 + 0.4 * sin(warp.y * 1.5)) * moltenVein * (0.34 + 0.25 * uExcitement);

    // Specular lighting on perturbed ferrofluid wave normals
    vec3 clayN = normalize(vClayNormal);
    vec3 keyLightDir = normalize(vec3(0.35, 0.85, 0.35));
    vec3 halfVec = normalize(keyLightDir + viewDir);
    float claySpec = pow(max(dot(clayN, halfVec), 0.0), 42.0);
    clayCol += vec3(1.0, 0.72, 0.45) * claySpec * 0.55;

    // Expanding incandescent wave crest on ball bounce
    clayCol += mix(clayMagenta, clayGold, clamp(vWaveHeight * 35.0 + 0.5, 0.0, 1.0)) * vRippleIntensity * 1.15;

    // =========================================================================
    // Morph Blend + Scanline Sweep + Live Ball Pool Glow + Apron Tech Rim
    // =========================================================================
    float morphSum = max(uMorphGrass + uMorphHard + uMorphClay, 0.0001);
    float wG = uMorphGrass / morphSum;
    float wH = uMorphHard / morphSum;
    float wC = uMorphClay / morphSum;

    vec3 color = grassCol * wG + hardCol * wH + clayCol * wC;

    // Subtle surface-tinted rim around outer apron & court edge
    vec3 activeAccent = emerald * wG + hardCyan * wH + clayMagenta * wC;
    vec3 activeSecond = cyanAccent * wG + hardMagenta * wH + clayGold * wC;
    color += activeAccent * apronRim * (0.45 + 0.35 * uExcitement);

    // Surface morph energy wave sweeping along Z when changing surface
    if (uMorphWave > 0.001 && uMorphWave < 0.999) {
      float waveZ = mix(-16.5, 16.5, uMorphWave);
      float scanBand = exp(-pow((xz.y - waveZ) * 1.1, 2.0));
      float scanGrid = 0.65 + 0.35 * sin(xz.x * 8.0 + uTime * 8.0);
      color += mix(activeAccent, activeSecond, 0.35) * scanBand * scanGrid * 0.50;
    }

    // Dynamic ball pool illumination on court floor (tight real-time height cue)
    float ballHorizDist = length(xz - uBallPos.xz);
    float ballHeightAtten = 1.0 / (1.0 + max(uBallPos.y, 0.0) * 0.85);
    float ballPool = exp(-ballHorizDist * ballHorizDist * 0.65) * ballHeightAtten;
    color += uBallColor * ballPool * 0.38;

    // Transparency for Holographic Hard so MeshReflectorMaterial shines through dark acrylic
    float hardPatternGlow = clamp(subGrid * 0.6 + circuitMask * dataPacket * 0.9 + impactRing, 0.0, 1.0);
    float hardAlpha = mix(0.46, 0.96, hardPatternGlow);
    float finalAlpha = mix(1.0, hardAlpha, wH);

    gl_FragColor = vec4(color, finalAlpha);

    #include <fog_fragment>
  }
`;

const NET_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uNetImpactTime;
  uniform float uNetImpactX;

  varying vec2 vNetUv;
  varying vec3 vNetWorld;
  varying float vNetWave;

  void main() {
    vNetUv = uv;
    vec3 pos = position;

    // Mesh spans X in [-5.94, +5.94], Y in [-0.535, +0.535] centered at y = 0.535
    float ratio = min(abs(pos.x), 5.94) / 5.94;
    float topY = 0.914 + (1.07 - 0.914) * ratio * ratio;
    float bottomY = 0.035;

    // Remap uv.y [0..1] strictly between bottomY and curved topY
    float worldY = mix(bottomY, topY, uv.y);

    // Damped Z ripple when ball strikes net
    float elapsed = max(0.0, uTime - uNetImpactTime);
    float impactEnergy = 0.0;
    if (elapsed < 2.2) {
      float distX = abs(pos.x - uNetImpactX);
      impactEnergy = exp(-elapsed * 4.2) * exp(-distX * 0.45) * sin(uv.y * 3.14159);
      pos.z += sin(elapsed * 46.0 - distX * 3.2) * impactEnergy * 0.16;
    }

    vec4 worldPos = modelMatrix * vec4(pos.x, worldY - 0.535, pos.z, 1.0);
    vNetWorld = worldPos.xyz;
    vNetWave = impactEnergy;

    gl_Position = projectionMatrix * viewMatrix * worldPos;
  }
`;

const NET_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform float uExcitement;
  uniform float uNetFlash;

  varying vec2 vNetUv;
  varying vec3 vNetWorld;
  varying float vNetWave;

  void main() {
    // Crisp holographic diamond + square laser grid
    vec2 scaleUv = vec2(vNetUv.x * 118.0, vNetUv.y * 12.0);
    vec2 cell = abs(fract(scaleUv) - 0.5);
    float grid = 1.0 - smoothstep(0.04, 0.12, min(cell.x, cell.y));

    vec2 diagUv = vec2(scaleUv.x + scaleUv.y, scaleUv.x - scaleUv.y) * 0.65;
    vec2 dCell = abs(fract(diagUv) - 0.5);
    float diamond = 1.0 - smoothstep(0.03, 0.10, min(dCell.x, dCell.y));

    float meshLine = max(grid * 0.72, diamond * 0.45);
    float scanline = 0.78 + 0.22 * sin(vNetUv.x * 45.0 - uTime * 4.0);
    float topRim = smoothstep(0.88, 1.0, vNetUv.y);

    vec3 baseTint = mix(uPrimaryColor, uSecondaryColor, 0.35 + 0.35 * sin(vNetUv.x * 6.283 + uTime));
    vec3 col = baseTint * (meshLine * (0.65 + 0.45 * uExcitement) * scanline + topRim * 0.55);

    // Impact flare
    float flare = clamp(uNetFlash + vNetWave * 2.5, 0.0, 1.5);
    col += vec3(1.0, 0.45, 0.85) * flare * (0.4 + 0.6 * meshLine);

    float alpha = clamp(meshLine * 0.62 + topRim * 0.32 + 0.04 + flare * 0.25, 0.0, 0.92);
    gl_FragColor = vec4(col, alpha);
  }
`;

const RIBBON_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const RIBBON_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform float uExcitement;
  uniform float uRallyIntensity;

  varying vec2 vUv;

  void main() {
    float speed = 0.28 + uExcitement * 0.85 + uRallyIntensity * 0.35;
    vec2 uv = vUv;

    // Scrolling chevron telemetry bands
    float chevronCoord = uv.x * 26.0 - uTime * speed * 4.5 + abs(uv.y - 0.5) * 3.5;
    float chevron = smoothstep(0.55, 0.88, fract(chevronCoord));

    // Audio-style equalizer bars along bottom
    float barId = floor(uv.x * 96.0);
    float barH = 0.22 + 0.55 * (0.5 + 0.5 * sin(barId * 1.7 + uTime * (4.0 + uExcitement * 6.0))) * (0.35 + 0.65 * uExcitement);
    float barMask = step(uv.y, barH) * step(0.18, fract(uv.x * 96.0));

    // Top/bottom neon trim lines
    float border = smoothstep(0.08, 0.0, uv.y) + smoothstep(0.92, 1.0, uv.y);

    vec3 bg = vec3(0.015, 0.022, 0.055);
    vec3 neon = mix(uPrimaryColor, uSecondaryColor, 0.5 + 0.5 * sin(uv.x * 12.0 - uTime * 2.0));

    vec3 col = bg;
    col += neon * chevron * (0.28 + 0.45 * uExcitement);
    col += mix(uSecondaryColor, vec3(1.0), 0.2) * barMask * (0.35 + 0.55 * uExcitement);
    col += uPrimaryColor * border * 0.85;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const PYLON_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uPrimaryColor;
  uniform vec3 uSecondaryColor;
  uniform vec3 uAccentColor;
  uniform float uExcitement;
  uniform float uRallyIntensity;

  varying vec2 vUv;

  void main() {
    vec2 uv = vUv;
    vec3 bg = vec3(0.012, 0.018, 0.042);

    // Subtle pixel telemetry grid & horizontal scanlines
    vec2 gridCell = abs(fract(vec2(uv.x * 16.0, uv.y * 10.0)) - 0.5);
    float fineGrid = 1.0 - smoothstep(0.02, 0.07, min(gridCell.x, gridCell.y));
    float scanline = 0.85 + 0.15 * sin(uv.y * 90.0 - uTime * 3.5);

    // Header telemetry bar + scrolling chevron status strip
    float headerMask = step(0.78, uv.y) * step(uv.y, 0.92) * step(0.06, uv.x) * step(uv.x, 0.94);
    float chevron = smoothstep(0.45, 0.85, fract(uv.x * 12.0 - uTime * (1.2 + uExcitement * 2.5)));

    // Central circular holographic radar ring + sweeping arc
    vec2 p = (uv - vec2(0.32, 0.44)) * vec2(1.55, 1.0);
    float r = length(p);
    float ang = atan(p.y, p.x);
    float ring1 = smoothstep(0.025, 0.006, abs(r - 0.24));
    float ring2 = smoothstep(0.020, 0.006, abs(r - 0.14));
    float sweep = smoothstep(0.4, 0.0, mod(ang + uTime * 2.2, 6.28318)) * step(r, 0.24);

    // Right-side audio/hype waveform spectrum bars
    float inBarsX = step(0.56, uv.x) * step(uv.x, 0.92);
    float inBarsY = step(0.14, uv.y) * step(uv.y, 0.68);
    float barId = floor((uv.x - 0.56) * 32.0);
    float barVal = 0.18 + 0.72 * (0.5 + 0.5 * sin(barId * 1.9 + uTime * (3.8 + uExcitement * 6.0))) * (0.35 + 0.65 * uExcitement);
    float barFill = step((uv.y - 0.14) / 0.54, barVal) * step(0.24, fract((uv.x - 0.56) * 32.0));
    float bars = inBarsX * inBarsY * barFill;

    // Outer frame border & chamfered corner brackets
    float edgeDist = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
    float border = smoothstep(0.028, 0.008, edgeDist);
    float corner = step(edgeDist, 0.055) * step(0.36, abs(uv.x - 0.5)) * step(0.32, abs(uv.y - 0.5));

    vec3 col = bg;
    col += uPrimaryColor * fineGrid * 0.14;
    col += mix(uPrimaryColor, uSecondaryColor, chevron) * headerMask * (0.35 + 0.45 * chevron);
    col += uPrimaryColor * (ring1 * 0.75 + ring2 * 0.5 + sweep * 0.35);
    col += mix(uSecondaryColor, uAccentColor, uRallyIntensity) * bars * (0.55 + 0.55 * uExcitement);
    col += mix(uPrimaryColor, uAccentColor, 0.4) * max(border * 0.75, corner * 0.45);
    col *= scanline;

    gl_FragColor = vec4(col, 1.0);
  }
`;

const THRUSTER_VERTEX_SHADER = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const THRUSTER_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform vec3 uPrimaryColor;
  uniform float uExcitement;

  varying vec2 vUv;

  void main() {
    // Upside-down cone: UV.y = 0 at wide top (hull nozzle), UV.y = 1 at bottom exhaust tip
    float topFade = 1.0 - smoothstep(0.08, 0.96, vUv.y);
    float pulse = 0.72 + 0.28 * sin(vUv.y * 24.0 - uTime * 11.0);
    float streaks = 0.7 + 0.3 * sin(vUv.x * 32.0 + uTime * 2.5);
    vec3 col = mix(uPrimaryColor, vec3(0.75, 0.95, 1.0), (1.0 - vUv.y) * 0.45) * (0.85 + 0.45 * uExcitement);
    float alpha = topFade * pulse * streaks * 0.36;
    gl_FragColor = vec4(col, alpha);
  }
`;

const SKYSCRAPER_VERTEX_SHADER = /* glsl */ `
  varying vec2 vSkyUv;
  varying vec3 vSkyNormal;
  varying vec3 vSkyColor;
  varying float vBuildingHeight;

  #include <fog_pars_vertex>

  void main() {
    vSkyUv = uv;
    vSkyNormal = normal;
    #ifdef USE_INSTANCING_COLOR
      vSkyColor = instanceColor;
    #else
      vSkyColor = vec3(0.0, 0.85, 1.0);
    #endif

    vec4 localPos = vec4(position, 1.0);
    // Extract approximate building scale Y from instanceMatrix column 1
    #ifdef USE_INSTANCING
      vBuildingHeight = length(instanceMatrix[1].xyz);
      localPos = instanceMatrix * localPos;
    #else
      vBuildingHeight = 30.0;
    #endif

    vec4 mvPosition = modelViewMatrix * localPos;
    gl_Position = projectionMatrix * mvPosition;

    #include <fog_vertex>
  }
`;

const SKYSCRAPER_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;
  uniform float uExcitement;

  varying vec2 vSkyUv;
  varying vec3 vSkyNormal;
  varying vec3 vSkyColor;
  varying float vBuildingHeight;

  #include <fog_pars_fragment>

  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  void main() {
    // Dark cyber obsidian concrete base
    vec3 wallCol = vec3(0.014, 0.020, 0.045);

    bool isRoof = abs(vSkyNormal.y) > 0.7;
    if (isRoof) {
      float roofBorder = max(
        smoothstep(0.42, 0.48, abs(vSkyUv.x - 0.5)),
        smoothstep(0.42, 0.48, abs(vSkyUv.y - 0.5))
      );
      wallCol += vSkyColor * roofBorder * 0.65;
    } else {
      // Procedural floor & window grid scaled by building height
      float floors = max(8.0, floor(vBuildingHeight * 0.75));
      float cols = 6.0;
      vec2 gridUv = vec2(vSkyUv.x * cols, vSkyUv.y * floors);
      vec2 cellId = floor(gridUv);
      vec2 f = fract(gridUv);

      float winMask = step(0.18, f.x) * step(f.x, 0.82) * step(0.24, f.y) * step(f.y, 0.78);
      float rnd = hash21(cellId + vSkyColor.rg * 37.0);
      float lit = step(0.44, rnd);

      // Horizontal neon floor trim every 8 floors
      float band = step(0.88, fract(vSkyUv.y * (floors * 0.125)));

      // Vertical corner neon strip on some towers
      float cornerStrip = smoothstep(0.06, 0.015, abs(vSkyUv.x - 0.04)) * step(0.35, fract(vSkyColor.b * 13.7));

      vec3 winTint = mix(vSkyColor, vec3(0.95, 0.98, 1.0), step(0.84, rnd) * 0.55);
      wallCol += winTint * winMask * lit * (0.42 + 0.18 * uExcitement);
      wallCol += vSkyColor * band * 0.25;
      wallCol += vSkyColor * cornerStrip * (0.65 + 0.2 * sin(uTime * 2.0 + vSkyColor.r * 10.0));
    }

    gl_FragColor = vec4(wallCol, 1.0);

    #include <fog_fragment>
  }
`;

// ============================================================================
// Scratch objects (zero GC allocations inside useFrame)
// ============================================================================
const _dummy = new THREE.Object3D();
const _tmpColor = new THREE.Color();
const _tmpColor2 = new THREE.Color();
const _targetPrimary = new THREE.Color();
const _targetSecondary = new THREE.Color();
const _targetAccent = new THREE.Color();
const _ballSpinColor = new THREE.Color();

// ============================================================================
// 1. Court Surface & Spores
// ============================================================================
interface CourtSurfaceProps {
  activeSurface: SurfaceType;
}

const CourtSurface: React.FC<CourtSurfaceProps> = ({ activeSurface }) => {
  const reflectorGroupRef = useRef<THREE.Group>(null);
  const reflectorMatRef = useRef<any>(null);
  const sporesRef = useRef<THREE.InstancedMesh>(null);

  const morphRef = useRef({
    grass: activeSurface === 'neon-grass' ? 1 : 0,
    hard: activeSurface === 'holographic-hard' ? 1 : 0,
    clay: activeSurface === 'liquid-clay' ? 1 : 0,
    wave: 1,
    prevSurface: activeSurface as SurfaceType,
  });

  const lastImpactIdRef = useRef<number>(-1);
  const elapsedRef = useRef(0);

  const courtMaterial = useMemo(() => {
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uMorphGrass: { value: activeSurface === 'neon-grass' ? 1 : 0 },
        uMorphHard: { value: activeSurface === 'holographic-hard' ? 1 : 0 },
        uMorphClay: { value: activeSurface === 'liquid-clay' ? 1 : 0 },
        uImpactPos: { value: new THREE.Vector3(0, 0, 0) },
        uImpactTime: { value: -10 },
        uExcitement: { value: 0.2 },
        uMorphWave: { value: 1.0 },
        uBallPos: { value: new THREE.Vector3(0, 1, 0) },
        uBallColor: { value: new THREE.Color('#00d4ff') },
      },
    ]);

    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: COURT_VERTEX_SHADER,
      fragmentShader: COURT_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: true,
      fog: true,
    });
  }, []);

  // Floating bio-luminescent spore metadata for Neon Grass
  const sporeData = useMemo(() => {
    const rand = mulberry32(7719);
    const items: Array<{
      x: number;
      y: number;
      z: number;
      speed: number;
      phase: number;
      radius: number;
      scale: number;
      color: THREE.Color;
    }> = [];
    const palette = ['#00ffa3', '#00e5ff', '#a3ff00'];
    for (let i = 0; i < SPORE_COUNT; i++) {
      items.push({
        x: (rand() - 0.5) * 16.8,
        y: 0.08 + rand() * 1.65,
        z: (rand() - 0.5) * 28.6,
        speed: 0.35 + rand() * 0.65,
        phase: rand() * Math.PI * 2,
        radius: 0.12 + rand() * 0.28,
        scale: 0.022 + rand() * 0.032,
        color: new THREE.Color(palette[i % palette.length]),
      });
    }
    return items;
  }, []);

  useLayoutEffect(() => {
    const mesh = sporesRef.current;
    if (!mesh) return;
    for (let i = 0; i < SPORE_COUNT; i++) {
      mesh.setColorAt(i, sporeData[i].color);
    }
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [sporeData]);

  useEffect(() => {
    return () => {
      courtMaterial.dispose();
    };
  }, [courtMaterial]);

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const state = useGameStore.getState();
    const timeScale = state.isSlowMo ? state.timeScale : 1.0;
    elapsedRef.current += dt * (0.35 + 0.65 * timeScale);
    const t = elapsedRef.current;

    // Trigger surface morph scanline wave if surface changed
    if (state.surface !== morphRef.current.prevSurface) {
      morphRef.current.prevSurface = state.surface;
      morphRef.current.wave = 0;
    }
    morphRef.current.wave = Math.min(1, morphRef.current.wave + dt * 1.35);

    // Smoothly damp morph weights
    const targetG = state.surface === 'neon-grass' ? 1 : 0;
    const targetH = state.surface === 'holographic-hard' ? 1 : 0;
    const targetC = state.surface === 'liquid-clay' ? 1 : 0;

    morphRef.current.grass = THREE.MathUtils.damp(morphRef.current.grass, targetG, 4.5, dt);
    morphRef.current.hard = THREE.MathUtils.damp(morphRef.current.hard, targetH, 4.5, dt);
    morphRef.current.clay = THREE.MathUtils.damp(morphRef.current.clay, targetC, 4.5, dt);

    const g = morphRef.current.grass;
    const h = morphRef.current.hard;
    const c = morphRef.current.clay;

    // Check new impact for court ripple (bounce / out)
    const impact = state.lastImpact;
    if (impact && impact.id !== lastImpactIdRef.current) {
      lastImpactIdRef.current = impact.id;
      if (impact.type === 'bounce' || impact.type === 'out') {
        courtMaterial.uniforms.uImpactPos.value.set(
          impact.position[0],
          impact.position[1],
          impact.position[2]
        );
        courtMaterial.uniforms.uImpactTime.value = t;
      }
    }

    // Update court shader uniforms
    courtMaterial.uniforms.uTime.value = t;
    courtMaterial.uniforms.uMorphGrass.value = g;
    courtMaterial.uniforms.uMorphHard.value = h;
    courtMaterial.uniforms.uMorphClay.value = c;
    courtMaterial.uniforms.uExcitement.value = state.crowdExcitement;
    courtMaterial.uniforms.uMorphWave.value = morphRef.current.wave;
    courtMaterial.uniforms.uBallPos.value.copy(gameRefs.ballPos);

    const activeSpin =
      state.phase === 'pre-serve' || !state.lastImpact
        ? state.currentSpin
        : state.lastImpact.spin;
    if (activeSpin === 'topspin') _ballSpinColor.set('#ff2a85');
    else if (activeSpin === 'slice') _ballSpinColor.set('#00e5ff');
    else _ballSpinColor.set('#e6ff2a');
    courtMaterial.uniforms.uBallColor.value.copy(_ballSpinColor);

    // Control mirror reflector visibility & strength
    if (reflectorGroupRef.current) {
      reflectorGroupRef.current.visible = h > 0.015;
    }
    if (reflectorMatRef.current) {
      reflectorMatRef.current.mixStrength = 1.65 * h;
    }

    // Update bio-luminescent spores when Neon Grass is visible
    const sporesMesh = sporesRef.current;
    if (sporesMesh) {
      sporesMesh.visible = g > 0.02;
      if (sporesMesh.visible) {
        for (let i = 0; i < SPORE_COUNT; i++) {
          const sp = sporeData[i];
          const sy = ((sp.y + t * sp.speed * 0.25) % 1.8) + 0.04;
          const sx = sp.x + Math.sin(t * sp.speed + sp.phase) * sp.radius;
          const sz = sp.z + Math.cos(t * sp.speed * 0.8 + sp.phase) * sp.radius;
          const pulse = (0.75 + 0.25 * Math.sin(t * 3.0 + sp.phase)) * g;
          _dummy.position.set(sx, sy, sz);
          _dummy.scale.setScalar(sp.scale * pulse);
          _dummy.updateMatrix();
          sporesMesh.setMatrixAt(i, _dummy.matrix);
        }
        sporesMesh.instanceMatrix.needsUpdate = true;
      }
    }
  });

  return (
    <group>
      {/* Mirror reflector base for Holographic Hard */}
      <group ref={reflectorGroupRef}>
        <mesh position={[0, -0.008, 0]} rotation={[-Math.PI / 2, 0, 0]} renderOrder={-3}>
          <planeGeometry args={[FLOOR_WIDTH, FLOOR_LENGTH]} />
          <MeshReflectorMaterial
            ref={reflectorMatRef}
            resolution={384}
            blur={[0, 0]}
            mirror={0.62}
            mixBlur={0}
            mixStrength={1.65}
            roughness={0.22}
            metalness={0.78}
            color="#040a1e"
            depthScale={0}
            minDepthThreshold={0.4}
            maxDepthThreshold={1.4}
          />
        </mesh>
      </group>

      {/* Main Morphing Custom GLSL Court Plane */}
      <mesh
        position={[0, 0, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        material={courtMaterial}
        renderOrder={-2}
      >
        <planeGeometry args={[FLOOR_WIDTH, FLOOR_LENGTH, 120, 184]} />
      </mesh>

      {/* Crisp Shadow Overlay so players, ball & net cast sharp shadows on all surfaces */}
      <mesh
        position={[0, 0.011, 0]}
        rotation={[-Math.PI / 2, 0, 0]}
        receiveShadow
        renderOrder={-1}
      >
        <planeGeometry args={[FLOOR_WIDTH, FLOOR_LENGTH]} />
        <shadowMaterial transparent opacity={0.46} color="#02030a" depthWrite={false} />
      </mesh>

      {/* Floating Bioluminescent Spores (Neon Grass) */}
      <instancedMesh
        ref={sporesRef}
        args={[undefined, undefined, SPORE_COUNT]}
        frustumCulled={false}
      >
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial
          toneMapped={false}
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </instancedMesh>
    </group>
  );
};

// ============================================================================
// 2. Official Tennis Court Lines & Tech Apron Trim
// ============================================================================
const CourtLinesAndTrim: React.FC = () => {
  const lineMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const trimMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const lastImpactIdRef = useRef(-1);
  const outFlashRef = useRef(0);
  const lineCallFlashRef = useRef(0);

  const { linesGeo, trimGeo } = useMemo(() => {
    const lineW = 0.055;
    const baseW = 0.075;
    const h = 0.004;

    const addStrip = (
      list: THREE.BufferGeometry[],
      x: number,
      z: number,
      w: number,
      d: number
    ) => {
      const box = new THREE.BoxGeometry(w, h, d);
      box.translate(x, 0.013, z);
      list.push(box);
    };

    const lines: THREE.BufferGeometry[] = [];
    // Baselines (Z = ±11.885)
    addStrip(lines, 0, COURT_HALF_Z, COURT_HALF_X_DOUBLES * 2 + lineW, baseW);
    addStrip(lines, 0, -COURT_HALF_Z, COURT_HALF_X_DOUBLES * 2 + lineW, baseW);
    // Doubles Sidelines (X = ±5.485)
    addStrip(lines, COURT_HALF_X_DOUBLES, 0, lineW, COURT_HALF_Z * 2 + baseW);
    addStrip(lines, -COURT_HALF_X_DOUBLES, 0, lineW, COURT_HALF_Z * 2 + baseW);
    // Singles Sidelines (X = ±4.115)
    addStrip(lines, COURT_HALF_X_SINGLES, 0, lineW, COURT_HALF_Z * 2);
    addStrip(lines, -COURT_HALF_X_SINGLES, 0, lineW, COURT_HALF_Z * 2);
    // Service Lines (Z = ±6.40)
    addStrip(lines, 0, SERVICE_LINE_Z, COURT_HALF_X_SINGLES * 2 + lineW, lineW);
    addStrip(lines, 0, -SERVICE_LINE_Z, COURT_HALF_X_SINGLES * 2 + lineW, lineW);
    // Center Service Line (X = 0)
    addStrip(lines, 0, 0, lineW, SERVICE_LINE_Z * 2);
    // Baseline Center Marks
    addStrip(lines, 0, COURT_HALF_Z - 0.14, lineW, 0.22);
    addStrip(lines, 0, -COURT_HALF_Z + 0.14, lineW, 0.22);

    const trims: THREE.BufferGeometry[] = [];
    // Outer cyber-apron boundary frame (X = ±8.75, Z = ±15.15)
    addStrip(trims, 0, 15.15, 17.56, 0.09);
    addStrip(trims, 0, -15.15, 17.56, 0.09);
    addStrip(trims, 8.75, 0, 0.09, 30.38);
    addStrip(trims, -8.75, 0, 0.09, 30.38);
    // Corner telemetry L-brackets around doubles corners
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        addStrip(trims, sx * 6.55, sz * 13.0, 0.9, 0.05);
        addStrip(trims, sx * 7.0, sz * 12.55, 0.05, 0.9);
      }
    }

    return {
      linesGeo: mergeSimpleGeometries(lines),
      trimGeo: mergeSimpleGeometries(trims),
    };
  }, []);

  useEffect(() => {
    return () => {
      linesGeo.dispose();
      trimGeo.dispose();
    };
  }, [linesGeo, trimGeo]);

  useFrame(({ clock }, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const state = useGameStore.getState();
    const cfg = SURFACE_CONFIGS[state.surface];

    const impact = state.lastImpact;
    if (impact && impact.id !== lastImpactIdRef.current) {
      lastImpactIdRef.current = impact.id;
      if (impact.type === 'out') {
        outFlashRef.current = 1.0;
      } else if (
        impact.type === 'bounce' &&
        isNearCourtLine(impact.position[0], impact.position[2])
      ) {
        lineCallFlashRef.current = 1.0;
      }
    }

    outFlashRef.current = Math.max(0, outFlashRef.current - dt * 1.9);
    lineCallFlashRef.current = Math.max(0, lineCallFlashRef.current - dt * 2.6);

    const t = clock.getElapsedTime();
    const pulse = 0.92 + 0.08 * Math.sin(t * 3.2) + state.crowdExcitement * 0.25;

    if (lineMatRef.current) {
      _tmpColor.set('#e8f8ff');
      _targetPrimary.set(cfg.primaryColor);
      _tmpColor.lerp(_targetPrimary, 0.16);

      if (lineCallFlashRef.current > 0.01) {
        _tmpColor2.set('#00ffff');
        _tmpColor.lerp(_tmpColor2, lineCallFlashRef.current);
      }
      if (outFlashRef.current > 0.01) {
        _tmpColor2.set('#ff1a4b');
        _tmpColor.lerp(_tmpColor2, outFlashRef.current);
      }

      lineMatRef.current.color.copy(_tmpColor);
      lineMatRef.current.emissive.copy(_tmpColor);
      lineMatRef.current.emissiveIntensity =
        1.15 * pulse +
        lineCallFlashRef.current * 1.4 +
        outFlashRef.current * 1.65;
    }

    if (trimMatRef.current) {
      _targetPrimary.set(cfg.primaryColor);
      _targetSecondary.set(cfg.secondaryColor);
      _tmpColor.copy(_targetPrimary).lerp(_targetSecondary, 0.35);
      if (outFlashRef.current > 0.01) {
        _tmpColor2.set('#ff1a4b');
        _tmpColor.lerp(_tmpColor2, outFlashRef.current * 0.8);
      }
      trimMatRef.current.color.copy(_tmpColor);
      trimMatRef.current.emissive.copy(_tmpColor);
      trimMatRef.current.emissiveIntensity =
        0.95 + state.crowdExcitement * 0.6 + outFlashRef.current * 1.1;
    }
  });

  return (
    <group>
      <mesh geometry={linesGeo}>
        <meshStandardMaterial
          ref={lineMatRef}
          color="#e8f8ff"
          emissive="#e8f8ff"
          emissiveIntensity={1.2}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>
      <mesh geometry={trimGeo}>
        <meshStandardMaterial
          ref={trimMatRef}
          color="#00d4ff"
          emissive="#00d4ff"
          emissiveIntensity={1.0}
          roughness={0.25}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
};

// ============================================================================
// 3. Glowing Holographic Net (Z = 0)
// ============================================================================
const HolographicNet: React.FC = () => {
  const tapeMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const postGlowMat = useMemo(
    () =>
      new THREE.MeshStandardMaterial({
        color: '#00d4ff',
        emissive: '#00d4ff',
        emissiveIntensity: 1.35,
        toneMapped: false,
      }),
    []
  );
  const lastImpactIdRef = useRef(-1);
  const netFlashRef = useRef(0);
  const elapsedRef = useRef(0);

  const netMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uNetImpactTime: { value: -10 },
        uNetImpactX: { value: 0 },
        uPrimaryColor: { value: new THREE.Color('#00d4ff') },
        uSecondaryColor: { value: new THREE.Color('#ff00aa') },
        uExcitement: { value: 0.2 },
        uNetFlash: { value: 0 },
      },
      vertexShader: NET_VERTEX_SHADER,
      fragmentShader: NET_FRAGMENT_SHADER,
      transparent: true,
      side: THREE.DoubleSide,
      depthWrite: false,
    });
  }, []);

  // Curved top net tape following exact physics parabola
  const tapeGeometry = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const segs = 36;
    for (let i = 0; i <= segs; i++) {
      const x = -NET_POST_X + (i / segs) * (NET_POST_X * 2);
      pts.push(new THREE.Vector3(x, getNetHeightAtX(x), 0));
    }
    const curve = new THREE.CatmullRomCurve3(pts);
    return new THREE.TubeGeometry(curve, 40, 0.026, 8, false);
  }, []);

  useEffect(() => {
    return () => {
      netMaterial.dispose();
      tapeGeometry.dispose();
      postGlowMat.dispose();
    };
  }, [netMaterial, tapeGeometry, postGlowMat]);

  useFrame((_, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const state = useGameStore.getState();
    const timeScale = state.isSlowMo ? state.timeScale : 1.0;
    elapsedRef.current += dt * (0.35 + 0.65 * timeScale);
    const t = elapsedRef.current;

    const impact = state.lastImpact;
    if (impact && impact.id !== lastImpactIdRef.current) {
      lastImpactIdRef.current = impact.id;
      if (impact.type === 'net') {
        netMaterial.uniforms.uNetImpactTime.value = t;
        netMaterial.uniforms.uNetImpactX.value = impact.position[0];
        netFlashRef.current = 1.4;
      }
    }

    netFlashRef.current = Math.max(0, netFlashRef.current - dt * 2.4);

    const cfg = SURFACE_CONFIGS[state.surface];
    _targetPrimary.set(cfg.primaryColor);
    _targetSecondary.set(cfg.secondaryColor);

    netMaterial.uniforms.uTime.value = t;
    netMaterial.uniforms.uPrimaryColor.value.lerp(_targetPrimary, dt * 6);
    netMaterial.uniforms.uSecondaryColor.value.lerp(_targetSecondary, dt * 6);
    netMaterial.uniforms.uExcitement.value = state.crowdExcitement;
    netMaterial.uniforms.uNetFlash.value = netFlashRef.current;

    if (tapeMatRef.current) {
      _tmpColor.set('#e6fbff').lerp(_targetPrimary, 0.25);
      if (netFlashRef.current > 0.01) {
        _tmpColor2.set('#ff3399');
        _tmpColor.lerp(_tmpColor2, Math.min(1, netFlashRef.current));
      }
      tapeMatRef.current.color.copy(_tmpColor);
      tapeMatRef.current.emissive.copy(_tmpColor);
      tapeMatRef.current.emissiveIntensity =
        1.1 + state.crowdExcitement * 0.4 + netFlashRef.current * 1.5;
    }

    postGlowMat.color.lerp(_targetPrimary, dt * 6);
    postGlowMat.emissive.lerp(_targetPrimary, dt * 6);
    if (netFlashRef.current > 0.01) {
      _tmpColor2.set('#ff3399');
      postGlowMat.emissive.lerp(_tmpColor2, Math.min(1, netFlashRef.current * 0.7));
    }
    postGlowMat.emissiveIntensity =
      1.3 + state.crowdExcitement * 0.45 + netFlashRef.current * 1.15;
  });

  return (
    <group>
      {/* Holographic Mesh Net Curtain */}
      <mesh position={[0, 0.535, 0]} material={netMaterial}>
        <planeGeometry args={[NET_POST_X * 2, NET_POST_H, 64, 14]} />
      </mesh>

      {/* Glowing Top Net Tape */}
      <mesh geometry={tapeGeometry} castShadow>
        <meshStandardMaterial
          ref={tapeMatRef}
          color="#e6fbff"
          emissive="#e6fbff"
          emissiveIntensity={1.15}
          roughness={0.2}
          toneMapped={false}
        />
      </mesh>

      {/* Center Tension Strap */}
      <mesh position={[0, NET_CENTER_H * 0.5, 0]}>
        <boxGeometry args={[0.045, NET_CENTER_H, 0.018]} />
        <meshStandardMaterial
          color="#101829"
          emissive="#00d4ff"
          emissiveIntensity={0.45}
          roughness={0.35}
        />
      </mesh>

      {/* Left & Right Angled Cyber-Carbon Net Posts (X = ±5.94) */}
      {([-1, 1] as const).map((side) => (
        <group key={side} position={[side * NET_POST_X, 0, 0]}>
          {/* Base Flange Collar */}
          <mesh position={[0, 0.04, 0]} castShadow>
            <cylinderGeometry args={[0.14, 0.17, 0.08, 8]} />
            <meshStandardMaterial color="#121828" metalness={0.85} roughness={0.25} />
          </mesh>
          {/* Sleek Angled Carbon Shaft */}
          <mesh
            position={[side * 0.04, 0.56, 0]}
            rotation={[0, 0, -side * 0.085]}
            castShadow
          >
            <cylinderGeometry args={[0.052, 0.072, 1.12, 10]} />
            <meshStandardMaterial color="#0b101d" metalness={0.88} roughness={0.22} />
          </mesh>
          {/* Glowing Vertical Energy Core */}
          <mesh
            position={[side * 0.04, 0.58, 0]}
            rotation={[0, 0, -side * 0.085]}
            material={postGlowMat}
          >
            <cylinderGeometry args={[0.028, 0.028, 0.96, 8]} />
          </mesh>
          {/* Top Beacon Halo */}
          <mesh
            position={[side * 0.085, 1.09, 0]}
            rotation={[Math.PI / 2, 0, 0]}
            material={postGlowMat}
          >
            <torusGeometry args={[0.085, 0.016, 8, 20]} />
          </mesh>
        </group>
      ))}
    </group>
  );
};

// ============================================================================
// 4. Floating Stadium Architecture, Thrusters, Arches, Ribbon Boards & Pylons
// ============================================================================
const FloatingStadiumArchitecture: React.FC = () => {
  const neonTrimMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const archNeonMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const pylonGroupRefs = useRef<Array<THREE.Group | null>>([null, null, null, null]);
  const pylonCoreRefs = useRef<Array<THREE.Mesh | null>>([null, null, null, null]);

  const thrusterRingMat = useMemo(
    () => new THREE.MeshBasicMaterial({ color: '#00e5ff', toneMapped: false }),
    []
  );
  const pylonCrystalMat = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: '#00ffff',
        wireframe: true,
        toneMapped: false,
      }),
    []
  );

  const ribbonMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPrimaryColor: { value: new THREE.Color('#00d4ff') },
        uSecondaryColor: { value: new THREE.Color('#ff00aa') },
        uExcitement: { value: 0.2 },
        uRallyIntensity: { value: 0 },
      },
      vertexShader: RIBBON_VERTEX_SHADER,
      fragmentShader: RIBBON_FRAGMENT_SHADER,
    });
  }, []);

  const pylonScreenMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPrimaryColor: { value: new THREE.Color('#00d4ff') },
        uSecondaryColor: { value: new THREE.Color('#ff00aa') },
        uAccentColor: { value: new THREE.Color('#3b82f6') },
        uExcitement: { value: 0.2 },
        uRallyIntensity: { value: 0 },
      },
      vertexShader: RIBBON_VERTEX_SHADER,
      fragmentShader: PYLON_FRAGMENT_SHADER,
    });
  }, []);

  const thrusterMaterial = useMemo(() => {
    return new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPrimaryColor: { value: new THREE.Color('#00d4ff') },
        uExcitement: { value: 0.2 },
      },
      vertexShader: THRUSTER_VERTEX_SHADER,
      fragmentShader: THRUSTER_FRAGMENT_SHADER,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
  }, []);

  // Curved Structural Neon Arch Ribs arching over East/West grandstands
  const { archFrameGeo, archNeonGeo } = useMemo(() => {
    const frames: THREE.BufferGeometry[] = [];
    const neons: THREE.BufferGeometry[] = [];
    const zPositions = [-13.0, -7.8, -2.6, 2.6, 7.8, 13.0];

    for (const z of zPositions) {
      for (const side of [-1, 1]) {
        const outerCurve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(side * 20.6, -1.0, z),
          new THREE.Vector3(side * 19.8, 5.8, z),
          new THREE.Vector3(side * 16.4, 11.4, z),
          new THREE.Vector3(side * 10.8, 13.8, z),
        ]);
        frames.push(new THREE.TubeGeometry(outerCurve, 20, 0.24, 6, false));

        const innerCurve = new THREE.CatmullRomCurve3([
          new THREE.Vector3(side * 20.25, -0.8, z),
          new THREE.Vector3(side * 19.45, 5.7, z),
          new THREE.Vector3(side * 16.1, 11.1, z),
          new THREE.Vector3(side * 10.8, 13.45, z),
        ]);
        neons.push(new THREE.TubeGeometry(innerCurve, 20, 0.065, 5, false));
      }
    }

    // Longitudinal East & West overhead spine trusses linking all 6 ribs
    for (const side of [-1, 1]) {
      const spine = new THREE.BoxGeometry(0.32, 0.32, 29.0);
      spine.translate(side * 10.8, 13.8, 0);
      frames.push(spine);

      const spineNeon = new THREE.BoxGeometry(0.1, 0.1, 29.2);
      spineNeon.translate(side * 10.62, 13.55, 0);
      neons.push(spineNeon);
    }

    return {
      archFrameGeo: mergeSimpleGeometries(frames),
      archNeonGeo: mergeSimpleGeometries(neons),
    };
  }, []);

  useEffect(() => {
    return () => {
      ribbonMaterial.dispose();
      pylonScreenMaterial.dispose();
      thrusterMaterial.dispose();
      thrusterRingMat.dispose();
      pylonCrystalMat.dispose();
      archFrameGeo.dispose();
      archNeonGeo.dispose();
    };
  }, [
    ribbonMaterial,
    pylonScreenMaterial,
    thrusterMaterial,
    thrusterRingMat,
    pylonCrystalMat,
    archFrameGeo,
    archNeonGeo,
  ]);

  const pylonCorners: Array<[number, number, number]> = useMemo(
    () => [
      [-13.8, 9.0, -18.5],
      [13.8, 9.0, -18.5],
      [-14.2, 9.2, 18.8],
      [14.2, 9.2, 18.8],
    ],
    []
  );

  useFrame(({ clock }, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const t = clock.getElapsedTime();
    const state = useGameStore.getState();
    const cfg = SURFACE_CONFIGS[state.surface];

    _targetPrimary.set(cfg.primaryColor);
    _targetSecondary.set(cfg.secondaryColor);
    _targetAccent.set(cfg.accentColor);

    const rallyIntensity = Math.min(1, state.rallyCount / 10);

    ribbonMaterial.uniforms.uTime.value = t;
    ribbonMaterial.uniforms.uPrimaryColor.value.lerp(_targetPrimary, dt * 5);
    ribbonMaterial.uniforms.uSecondaryColor.value.lerp(_targetSecondary, dt * 5);
    ribbonMaterial.uniforms.uExcitement.value = state.crowdExcitement;
    ribbonMaterial.uniforms.uRallyIntensity.value = rallyIntensity;

    thrusterMaterial.uniforms.uTime.value = t;
    thrusterMaterial.uniforms.uPrimaryColor.value.lerp(_targetPrimary, dt * 5);
    thrusterMaterial.uniforms.uExcitement.value = state.crowdExcitement;

    if (neonTrimMatRef.current) {
      neonTrimMatRef.current.color.lerp(_targetPrimary, dt * 5);
      neonTrimMatRef.current.emissive.lerp(_targetPrimary, dt * 5);
      neonTrimMatRef.current.emissiveIntensity =
        0.95 + state.crowdExcitement * 0.65 + rallyIntensity * 0.35;
    }

    if (archNeonMatRef.current) {
      archNeonMatRef.current.color.lerp(_targetSecondary, dt * 5);
      archNeonMatRef.current.emissive.lerp(_targetSecondary, dt * 5);
      archNeonMatRef.current.emissiveIntensity =
        0.85 + state.crowdExcitement * 0.55;
    }

    thrusterRingMat.color.lerp(_targetPrimary, dt * 5);
    pylonCrystalMat.color.lerp(_targetAccent, dt * 5);

    pylonScreenMaterial.uniforms.uTime.value = t;
    pylonScreenMaterial.uniforms.uPrimaryColor.value.lerp(_targetPrimary, dt * 5);
    pylonScreenMaterial.uniforms.uSecondaryColor.value.lerp(_targetSecondary, dt * 5);
    pylonScreenMaterial.uniforms.uAccentColor.value.lerp(_targetAccent, dt * 5);
    pylonScreenMaterial.uniforms.uExcitement.value = state.crowdExcitement;
    pylonScreenMaterial.uniforms.uRallyIntensity.value = rallyIntensity;

    // Gentle hover & core spin on the 4 corner holographic score-pylons
    for (let i = 0; i < 4; i++) {
      const grp = pylonGroupRefs.current[i];
      if (grp) {
        grp.position.y = pylonCorners[i][1] + Math.sin(t * 1.4 + i * 1.57) * 0.32;
      }
      const core = pylonCoreRefs.current[i];
      if (core) {
        core.rotation.y = t * 1.2 + i;
        core.rotation.x = Math.sin(t * 0.8 + i) * 0.25;
      }
    }
  });

  return (
    <group>
      {/* Court Foundation Pedestal */}
      <mesh position={[0, -0.22, 0]} receiveShadow>
        <boxGeometry args={[19.4, 0.4, 32.2]} />
        <meshStandardMaterial color="#090d1a" metalness={0.85} roughness={0.3} />
      </mesh>

      {/* Main Hovering Octagonal Stadium Chassis (y = -0.35 down to -4.5) */}
      <mesh position={[0, -1.45, 1.2]} rotation={[0, Math.PI / 8, 0]}>
        <cylinderGeometry args={[28.5, 23.0, 2.2, 8]} />
        <meshStandardMaterial color="#070b16" metalness={0.82} roughness={0.35} />
      </mesh>
      <mesh position={[0, -3.4, 1.2]} rotation={[0, Math.PI / 8, 0]}>
        <cylinderGeometry args={[21.5, 12.8, 1.9, 8]} />
        <meshStandardMaterial color="#050811" metalness={0.88} roughness={0.28} />
      </mesh>

      {/* Perimeter Glowing Hull Neon Ring */}
      <mesh position={[0, -0.42, 1.2]} rotation={[Math.PI / 2, 0, Math.PI / 8]}>
        <torusGeometry args={[28.5, 0.12, 6, 8]} />
        <meshStandardMaterial
          ref={neonTrimMatRef}
          color="#00d4ff"
          emissive="#00d4ff"
          emissiveIntensity={1.1}
          toneMapped={false}
        />
      </mesh>

      {/* Translucent Glass Perimeter Walkways around Court Apron */}
      <mesh position={[-9.75, 0.02, 0]}>
        <boxGeometry args={[0.7, 0.04, 32.8]} />
        <meshStandardMaterial
          color="#0a2038"
          metalness={0.9}
          roughness={0.12}
          transparent
          opacity={0.55}
        />
      </mesh>
      <mesh position={[9.75, 0.02, 0]}>
        <boxGeometry args={[0.7, 0.04, 32.8]} />
        <meshStandardMaterial
          color="#0a2038"
          metalness={0.9}
          roughness={0.12}
          transparent
          opacity={0.55}
        />
      </mesh>
      <mesh position={[0, 0.02, -16.15]}>
        <boxGeometry args={[20.2, 0.04, 0.7]} />
        <meshStandardMaterial
          color="#0a2038"
          metalness={0.9}
          roughness={0.12}
          transparent
          opacity={0.55}
        />
      </mesh>
      <mesh position={[0, 0.02, 16.15]}>
        <boxGeometry args={[20.2, 0.04, 0.7]} />
        <meshStandardMaterial
          color="#0a2038"
          metalness={0.9}
          roughness={0.12}
          transparent
          opacity={0.55}
        />
      </mesh>

      {/* Anti-Gravity Thruster Rings Underneath Hull */}
      {[
        { y: -2.9, r: 17.5, tube: 0.22 },
        { y: -3.8, r: 13.0, tube: 0.18 },
        { y: -4.55, r: 8.6, tube: 0.16 },
      ].map((ring, idx) => (
        <mesh
          key={idx}
          position={[0, ring.y, 1.2]}
          rotation={[Math.PI / 2, 0, 0]}
          material={thrusterRingMat}
        >
          <torusGeometry args={[ring.r, ring.tube, 8, 48]} />
        </mesh>
      ))}

      {/* Central Downward Anti-Grav Plasma Exhaust Cone */}
      <mesh position={[0, -7.8, 1.2]} rotation={[Math.PI, 0, 0]} material={thrusterMaterial}>
        <coneGeometry args={[12.5, 7.2, 32, 1, true]} />
      </mesh>

      {/* 4 Corner Anti-Grav Thruster Nacelles */}
      {(
        [
          [-16.2, -2.5, -18.5],
          [16.2, -2.5, -18.5],
          [-16.2, -2.5, 20.8],
          [16.2, -2.5, 20.8],
        ] as Array<[number, number, number]>
      ).map((pos, idx) => (
        <group key={idx} position={pos}>
          <mesh>
            <cylinderGeometry args={[1.5, 1.1, 1.6, 8]} />
            <meshStandardMaterial color="#0a0f1e" metalness={0.9} roughness={0.25} />
          </mesh>
          <mesh position={[0, -0.82, 0]} rotation={[Math.PI / 2, 0, 0]} material={thrusterRingMat}>
            <torusGeometry args={[1.05, 0.1, 6, 20]} />
          </mesh>
          <mesh position={[0, -3.5, 0]} rotation={[Math.PI, 0, 0]} material={thrusterMaterial}>
            <coneGeometry args={[1.6, 5.4, 16, 1, true]} />
          </mesh>
        </group>
      ))}

      {/* Towering Curved Structural Carbon + Neon Ribs Arching Over Stands */}
      <mesh geometry={archFrameGeo}>
        <meshStandardMaterial color="#0c1222" metalness={0.85} roughness={0.28} />
      </mesh>
      <mesh geometry={archNeonGeo}>
        <meshStandardMaterial
          ref={archNeonMatRef}
          color="#ff00aa"
          emissive="#ff00aa"
          emissiveIntensity={1.0}
          toneMapped={false}
        />
      </mesh>

      {/* Perimeter Animated LED Ribbon Boards */}
      {/* West Stand Front Fascia */}
      <mesh position={[-10.05, 0.62, 0]} rotation={[0, Math.PI / 2, 0]} material={ribbonMaterial}>
        <planeGeometry args={[31.0, 0.72]} />
      </mesh>
      {/* East Stand Front Fascia */}
      <mesh position={[10.05, 0.62, 0]} rotation={[0, -Math.PI / 2, 0]} material={ribbonMaterial}>
        <planeGeometry args={[31.0, 0.72]} />
      </mesh>
      {/* North Stand Front Fascia */}
      <mesh position={[0, 0.62, -16.95]} material={ribbonMaterial}>
        <planeGeometry args={[20.0, 0.72]} />
      </mesh>
      {/* South Stand Front Fascia (behind follow camera) */}
      <mesh position={[0, 0.62, 19.95]} rotation={[0, Math.PI, 0]} material={ribbonMaterial}>
        <planeGeometry args={[20.0, 0.72]} />
      </mesh>

      {/* 4 Corner Floating Holographic Score-Pylons */}
      {pylonCorners.map((pos, idx) => (
        <group
          key={idx}
          ref={(el) => {
            pylonGroupRefs.current[idx] = el;
          }}
          position={pos}
          rotation={[0, Math.atan2(-pos[0], -pos[2]), 0]}
        >
          {/* Outer Metallic Pylon Frame */}
          <mesh>
            <boxGeometry args={[2.5, 1.75, 0.35]} />
            <meshStandardMaterial color="#090e1c" metalness={0.88} roughness={0.25} />
          </mesh>
          {/* Glowing Holographic Telemetry Screen Face */}
          <mesh position={[0, 0, 0.19]} material={pylonScreenMaterial}>
            <planeGeometry args={[2.22, 1.42]} />
          </mesh>
          {/* Hovering Rotating Holographic Crystal Emitter above Pylon */}
          <mesh
            ref={(el) => {
              pylonCoreRefs.current[idx] = el;
            }}
            position={[0, 1.38, 0]}
            material={pylonCrystalMat}
          >
            <octahedronGeometry args={[0.42, 0]} />
          </mesh>
        </group>
      ))}
    </group>
  );
};

// ============================================================================
// 5. Reactive Instanced Stadium Crowd (1,364 Spectators + Light-Sticks)
// ============================================================================
interface SpectatorMeta {
  x: number;
  y: number;
  z: number;
  rotY: number;
  phase: number;
  azimuth: number;
  colorSeed: number;
}

const ReactiveStadiumCrowd: React.FC = () => {
  const bodiesRef = useRef<THREE.InstancedMesh>(null);
  const sticksRef = useRef<THREE.InstancedMesh>(null);

  // Tiered grandstands merged into 1 static draw call
  const standsGeo = useMemo(() => {
    const blocks: THREE.BufferGeometry[] = [];
    const addStep = (x: number, y: number, z: number, w: number, h: number, d: number) => {
      const b = new THREE.BoxGeometry(w, h, d);
      b.translate(x, y, z);
      blocks.push(b);
    };

    // East & West stands (6 tiers)
    for (let r = 0; r < 6; r++) {
      const dist = 10.65 + r * 1.15;
      const y = 0.55 + r * 0.72;
      addStep(-dist, y * 0.5, 0, 1.18, y + 0.4, 31.4);
      addStep(dist, y * 0.5, 0, 1.18, y + 0.4, 31.4);
    }
    // North stand (6 tiers)
    for (let r = 0; r < 6; r++) {
      const dist = 17.55 + r * 1.15;
      const y = 0.55 + r * 0.72;
      addStep(0, y * 0.5, -dist, 20.6, y + 0.4, 1.18);
    }
    // South stand (5 tiers starting at Z = 20.55 so follow/broadcast cameras never clip)
    for (let r = 0; r < 5; r++) {
      const dist = 20.55 + r * 1.15;
      const y = 0.55 + r * 0.68;
      addStep(0, y * 0.5, dist, 21.4, y + 0.4, 1.18);
    }
    return mergeSimpleGeometries(blocks);
  }, []);

  // Stylized spectator silhouette (merged torso + head -> 1 draw call)
  const spectatorGeo = useMemo(() => {
    const torso = new THREE.CylinderGeometry(0.14, 0.19, 0.54, 6);
    torso.translate(0, 0.27, 0);
    const head = new THREE.OctahedronGeometry(0.125, 1);
    head.translate(0, 0.66, 0);
    const merged = mergeSimpleGeometries([torso, head]);
    torso.dispose();
    head.dispose();
    return merged;
  }, []);

  // Pre-compute deterministic spectator placements (1,364 spectators)
  const spectators = useMemo(() => {
    const rand = mulberry32(42069);
    const list: SpectatorMeta[] = [];

    const pushSeat = (x: number, y: number, z: number, rotY: number) => {
      list.push({
        x: x + (rand() - 0.5) * 0.16,
        y,
        z: z + (rand() - 0.5) * 0.16,
        rotY,
        phase: rand() * Math.PI * 2,
        azimuth: Math.atan2(z, x),
        colorSeed: rand(),
      });
    };

    // West & East: 6 rows x 58 seats each = 696
    for (let r = 0; r < 6; r++) {
      const xOff = 10.65 + r * 1.15;
      const y = 0.75 + r * 0.72;
      for (let s = 0; s < 58; s++) {
        const z = -14.8 + (s / 57) * 29.6;
        pushSeat(-xOff, y, z, Math.PI / 2);
        pushSeat(xOff, y, z, -Math.PI / 2);
      }
    }

    // North: 6 rows x 58 seats = 348
    for (let r = 0; r < 6; r++) {
      const zOff = -(17.55 + r * 1.15);
      const y = 0.75 + r * 0.72;
      for (let s = 0; s < 58; s++) {
        const x = -9.6 + (s / 57) * 19.2;
        pushSeat(x, y, zOff, 0);
      }
    }

    // South: 5 rows x 64 seats = 320 (total = 1,364)
    for (let r = 0; r < 5; r++) {
      const zOff = 20.55 + r * 1.15;
      const y = 0.75 + r * 0.68;
      for (let s = 0; s < 64; s++) {
        const x = -10.0 + (s / 63) * 20.0;
        pushSeat(x, y, zOff, Math.PI);
      }
    }

    return list;
  }, []);

  const crowdCount = spectators.length;

  useLayoutEffect(() => {
    const bodies = bodiesRef.current;
    if (bodies) {
      for (let i = 0; i < crowdCount; i++) {
        const v = spectators[i].colorSeed;
        _tmpColor.setRGB(0.05 + v * 0.06, 0.07 + v * 0.08, 0.14 + v * 0.12);
        bodies.setColorAt(i, _tmpColor);
      }
      if (bodies.instanceColor) bodies.instanceColor.needsUpdate = true;
    }
    return () => {
      standsGeo.dispose();
      spectatorGeo.dispose();
    };
  }, [crowdCount, spectators, standsGeo, spectatorGeo]);

  useFrame(({ clock }) => {
    const bodies = bodiesRef.current;
    const sticks = sticksRef.current;
    if (!bodies || !sticks) return;

    const t = clock.getElapsedTime();
    const state = useGameStore.getState();
    const exc = state.crowdExcitement;
    const rallyBoost = Math.min(1, state.rallyCount / 8);
    const isPointWin = state.phase === 'point-over';
    const hype = Math.min(1, exc * 0.85 + rallyBoost * 0.35 + (isPointWin ? 0.35 : 0));

    const cfg = SURFACE_CONFIGS[state.surface];
    _targetPrimary.set(cfg.primaryColor);
    _targetSecondary.set(cfg.secondaryColor);
    _targetAccent.set(cfg.accentColor);

    const waveSpeed = 2.6 + hype * 4.5;
    const jumpFreq = 3.0 + hype * 6.5;

    for (let i = 0; i < crowdCount; i++) {
      const sp = spectators[i];
      const stadiumWave = Math.sin(sp.azimuth * 3.0 - t * waveSpeed);
      const localBounce = Math.abs(Math.sin(t * jumpFreq + sp.phase));

      // Calm ambient sway when excitement is low; energetic wave + jumping when hyped
      const jumpHeight =
        0.025 + hype * (0.14 * localBounce + Math.max(0, stadiumWave) * 0.24);
      const swayZ = Math.sin(t * 1.8 + sp.phase) * 0.035;

      _dummy.position.set(sp.x, sp.y + jumpHeight, sp.z);
      _dummy.rotation.set(swayZ, sp.rotY, 0);
      _dummy.scale.set(1, 1, 1);
      _dummy.updateMatrix();
      bodies.setMatrixAt(i, _dummy.matrix);

      // Light-stick held above right shoulder, waving faster with hype
      const stickArmRaise =
        0.52 + hype * 0.34 + Math.max(0, stadiumWave) * hype * 0.22;
      const stickWaveRot =
        Math.sin(t * (3.2 + hype * 6.0) + sp.phase) * (0.2 + hype * 0.55);
      const sinR = Math.sin(sp.rotY);
      const cosR = Math.cos(sp.rotY);

      _dummy.position.set(
        sp.x + cosR * 0.22,
        sp.y + jumpHeight + stickArmRaise,
        sp.z - sinR * 0.22
      );
      _dummy.rotation.set(stickWaveRot, sp.rotY, stickWaveRot * 0.6);
      _dummy.scale.setScalar(0.85 + hype * 0.35);
      _dummy.updateMatrix();
      sticks.setMatrixAt(i, _dummy.matrix);

      // Dynamic neon light-stick colors cycling across surface palette
      const colorMix = 0.5 + 0.5 * Math.sin(sp.azimuth * 2.0 + t * 2.4 + sp.colorSeed * 4.0);
      _tmpColor.copy(_targetPrimary).lerp(_targetSecondary, colorMix);
      if (isPointWin && stadiumWave > 0.2) {
        _tmpColor.lerp(_targetAccent, 0.65);
      }
      const brightness = 0.45 + hype * 0.78;
      _tmpColor.multiplyScalar(brightness);
      sticks.setColorAt(i, _tmpColor);
    }

    bodies.instanceMatrix.needsUpdate = true;
    sticks.instanceMatrix.needsUpdate = true;
    if (sticks.instanceColor) sticks.instanceColor.needsUpdate = true;
  });

  return (
    <group>
      {/* Tiered Grandstand Concrete/Carbon Bleachers */}
      <mesh geometry={standsGeo} receiveShadow>
        <meshStandardMaterial color="#090e1c" metalness={0.72} roughness={0.48} />
      </mesh>

      {/* Instanced Stylized Spectators */}
      <instancedMesh
        ref={bodiesRef}
        args={[spectatorGeo, undefined, crowdCount]}
        frustumCulled={false}
      >
        <meshStandardMaterial roughness={0.6} metalness={0.35} />
      </instancedMesh>

      {/* Instanced Neon Light-Sticks */}
      <instancedMesh
        ref={sticksRef}
        args={[undefined, undefined, crowdCount]}
        frustumCulled={false}
      >
        <cylinderGeometry args={[0.015, 0.015, 0.28, 5]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
};

// ============================================================================
// 6. Deep Night Cyberpunk City Skyline, Mega-Structures & Flying Traffic
// ============================================================================
interface TrafficItem {
  mode: 'ring' | 'laneX' | 'laneZ';
  radius: number;
  angle: number;
  y: number;
  speed: number;
  laneOffset: number;
  posCoord: number;
  dir: number;
  scaleZ: number;
  color: THREE.Color;
}

const CyberMetropolisSkyline: React.FC = () => {
  const skyMeshRef = useRef<THREE.InstancedMesh>(null);
  const megaShaftRef = useRef<THREE.InstancedMesh>(null);
  const megaCrownRef = useRef<THREE.InstancedMesh>(null);
  const megaBeamRef = useRef<THREE.InstancedMesh>(null);
  const trafficRef = useRef<THREE.InstancedMesh>(null);

  const skyscraperMaterial = useMemo(() => {
    const uniforms = THREE.UniformsUtils.merge([
      THREE.UniformsLib.fog,
      {
        uTime: { value: 0 },
        uExcitement: { value: 0.2 },
      },
    ]);
    return new THREE.ShaderMaterial({
      uniforms,
      vertexShader: SKYSCRAPER_VERTEX_SHADER,
      fragmentShader: SKYSCRAPER_FRAGMENT_SHADER,
      fog: true,
    });
  }, []);

  // Pre-generate skyscraper layouts below and around the floating stadium
  const skyscrapers = useMemo(() => {
    const rand = mulberry32(99881);
    const palette = ['#00d4ff', '#ff2a85', '#00ffa3', '#ff9900', '#6366f1'];
    const items: Array<{
      x: number;
      y: number;
      z: number;
      w: number;
      h: number;
      d: number;
      rotY: number;
      color: THREE.Color;
    }> = [];

    for (let i = 0; i < SKYSCRAPER_COUNT; i++) {
      const angle = rand() * Math.PI * 2;
      // Inner core below stadium (r = 6..42) stays below y = -16; outer ring rises higher
      const isUnderCore = i < 110;
      const r = isUnderCore ? 4 + rand() * 38 : 38 + rand() * 64;
      const x = Math.cos(angle) * r;
      const z = Math.sin(angle) * r;

      const baseFloorY = -82;
      const topY = isUnderCore
        ? -30 + rand() * 13 // -30..-17 safely underneath stadium hull
        : -22 + rand() * 32; // -22..+10 framing horizon
      const h = Math.max(12, topY - baseFloorY);
      const w = 3.2 + rand() * 5.2;
      const d = 3.2 + rand() * 5.2;

      items.push({
        x,
        y: baseFloorY + h * 0.5,
        z,
        w,
        h,
        d,
        rotY: Math.floor(rand() * 4) * (Math.PI / 4) * 0.5,
        color: new THREE.Color(palette[i % palette.length]),
      });
    }
    return items;
  }, []);

  // Pre-generate 12 distant colossal mega-structures & sky-beams
  const megaStructures = useMemo(() => {
    const rand = mulberry32(31415);
    const palette = ['#00d4ff', '#ff00aa', '#00ffa3', '#ff9900'];
    const list: Array<{
      x: number;
      z: number;
      w: number;
      h: number;
      d: number;
      topY: number;
      color: THREE.Color;
    }> = [];
    for (let i = 0; i < MEGA_COUNT; i++) {
      const angle = (i / MEGA_COUNT) * Math.PI * 2 + (rand() - 0.5) * 0.22;
      const r = 84 + rand() * 42;
      const topY = 16 + rand() * 28;
      const h = topY + 82;
      list.push({
        x: Math.cos(angle) * r,
        z: Math.sin(angle) * r,
        w: 9 + rand() * 6,
        h,
        d: 9 + rand() * 6,
        topY,
        color: new THREE.Color(palette[i % palette.length]),
      });
    }
    return list;
  }, []);

  // Pre-generate 260 flying light-traffic streams below stadium
  const trafficItems = useMemo(() => {
    const rand = mulberry32(55123);
    const colors = ['#00e5ff', '#ff2a85', '#ffaa00', '#e6f7ff'];
    const items: TrafficItem[] = [];
    for (let i = 0; i < TRAFFIC_COUNT; i++) {
      const kindRoll = rand();
      const col = new THREE.Color(colors[i % colors.length]).multiplyScalar(1.35);
      if (kindRoll < 0.55) {
        const dir = rand() < 0.5 ? 1 : -1;
        items.push({
          mode: 'ring',
          radius: 22 + rand() * 60,
          angle: rand() * Math.PI * 2,
          y: -7.5 - rand() * 24,
          speed: (0.14 + rand() * 0.24) * dir,
          laneOffset: 0,
          posCoord: 0,
          dir,
          scaleZ: 1.1 + rand() * 1.4,
          color: col,
        });
      } else if (kindRoll < 0.78) {
        const dir = rand() < 0.5 ? 1 : -1;
        items.push({
          mode: 'laneX',
          radius: 0,
          angle: 0,
          y: -9.5 - rand() * 18,
          speed: (14 + rand() * 18) * dir,
          laneOffset: (rand() - 0.5) * 58,
          posCoord: (rand() - 0.5) * 160,
          dir,
          scaleZ: 1.3 + rand() * 1.6,
          color: col,
        });
      } else {
        const dir = rand() < 0.5 ? 1 : -1;
        items.push({
          mode: 'laneZ',
          radius: 0,
          angle: 0,
          y: -9.5 - rand() * 18,
          speed: (14 + rand() * 18) * dir,
          laneOffset: (rand() - 0.5) * 58,
          posCoord: (rand() - 0.5) * 160,
          dir,
          scaleZ: 1.3 + rand() * 1.6,
          color: col,
        });
      }
    }
    return items;
  }, []);

  // Populate static city & mega-structure instance matrices once
  useLayoutEffect(() => {
    const sky = skyMeshRef.current;
    if (sky) {
      for (let i = 0; i < SKYSCRAPER_COUNT; i++) {
        const b = skyscrapers[i];
        _dummy.position.set(b.x, b.y, b.z);
        _dummy.rotation.set(0, b.rotY, 0);
        _dummy.scale.set(b.w, b.h, b.d);
        _dummy.updateMatrix();
        sky.setMatrixAt(i, _dummy.matrix);
        sky.setColorAt(i, b.color);
      }
      sky.instanceMatrix.needsUpdate = true;
      if (sky.instanceColor) sky.instanceColor.needsUpdate = true;
    }

    const shafts = megaShaftRef.current;
    const crowns = megaCrownRef.current;
    const beams = megaBeamRef.current;
    if (shafts && crowns && beams) {
      for (let i = 0; i < MEGA_COUNT; i++) {
        const m = megaStructures[i];
        _dummy.position.set(m.x, m.topY - m.h * 0.5, m.z);
        _dummy.rotation.set(0, i * 0.4, 0);
        _dummy.scale.set(m.w, m.h, m.d);
        _dummy.updateMatrix();
        shafts.setMatrixAt(i, _dummy.matrix);
        shafts.setColorAt(i, m.color);

        _dummy.position.set(m.x, m.topY + 0.5, m.z);
        _dummy.rotation.set(Math.PI / 2, 0, 0);
        _dummy.scale.set(m.w * 0.65, m.w * 0.65, 1);
        _dummy.updateMatrix();
        crowns.setMatrixAt(i, _dummy.matrix);
        crowns.setColorAt(i, m.color);

        _dummy.position.set(m.x, m.topY + 42, m.z);
        _dummy.rotation.set(0, 0, 0);
        _dummy.scale.set(1.2, 84, 1.2);
        _dummy.updateMatrix();
        beams.setMatrixAt(i, _dummy.matrix);
        beams.setColorAt(i, m.color);
      }
      shafts.instanceMatrix.needsUpdate = true;
      crowns.instanceMatrix.needsUpdate = true;
      beams.instanceMatrix.needsUpdate = true;
      if (shafts.instanceColor) shafts.instanceColor.needsUpdate = true;
      if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true;
      if (beams.instanceColor) beams.instanceColor.needsUpdate = true;
    }

    const tr = trafficRef.current;
    if (tr) {
      for (let i = 0; i < TRAFFIC_COUNT; i++) {
        tr.setColorAt(i, trafficItems[i].color);
      }
      if (tr.instanceColor) tr.instanceColor.needsUpdate = true;
    }

    return () => {
      skyscraperMaterial.dispose();
    };
  }, [skyscrapers, megaStructures, trafficItems, skyscraperMaterial]);

  useFrame(({ clock }, rawDelta) => {
    const dt = Math.min(rawDelta, 0.05);
    const t = clock.getElapsedTime();
    const state = useGameStore.getState();

    skyscraperMaterial.uniforms.uTime.value = t;
    skyscraperMaterial.uniforms.uExcitement.value = state.crowdExcitement;

    const tr = trafficRef.current;
    if (!tr) return;

    const timeScale = state.isSlowMo ? state.timeScale : 1.0;
    const step = dt * timeScale;

    for (let i = 0; i < TRAFFIC_COUNT; i++) {
      const item = trafficItems[i];
      if (item.mode === 'ring') {
        item.angle += item.speed * step;
        const x = Math.cos(item.angle) * item.radius;
        const z = Math.sin(item.angle) * item.radius;
        const yaw = -item.angle + (item.dir > 0 ? 0 : Math.PI);
        _dummy.position.set(x, item.y, z);
        _dummy.rotation.set(0, yaw, 0);
      } else if (item.mode === 'laneX') {
        item.posCoord += item.speed * step;
        if (item.posCoord > 85) item.posCoord = -85;
        if (item.posCoord < -85) item.posCoord = 85;
        _dummy.position.set(item.posCoord, item.y, item.laneOffset);
        _dummy.rotation.set(0, item.dir > 0 ? Math.PI / 2 : -Math.PI / 2, 0);
      } else {
        item.posCoord += item.speed * step;
        if (item.posCoord > 85) item.posCoord = -85;
        if (item.posCoord < -85) item.posCoord = 85;
        _dummy.position.set(item.laneOffset, item.y, item.posCoord);
        _dummy.rotation.set(0, item.dir > 0 ? 0 : Math.PI, 0);
      }
      _dummy.scale.set(1, 1, item.scaleZ);
      _dummy.updateMatrix();
      tr.setMatrixAt(i, _dummy.matrix);
    }
    tr.instanceMatrix.needsUpdate = true;
  });

  return (
    <group>
      {/* Distant Dark Urban Ground Abyss Floor */}
      <mesh position={[0, -82, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[180, 32]} />
        <meshBasicMaterial color="#02030a" />
      </mesh>

      {/* 380 Instanced Glowing Skyscrapers */}
      <instancedMesh
        ref={skyMeshRef}
        args={[undefined, skyscraperMaterial, SKYSCRAPER_COUNT]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>

      {/* 12 Colossal Mega-Structures */}
      <instancedMesh
        ref={megaShaftRef}
        args={[undefined, skyscraperMaterial, MEGA_COUNT]}
        frustumCulled={false}
      >
        <boxGeometry args={[1, 1, 1]} />
      </instancedMesh>

      {/* Mega-Structure Crown Halos */}
      <instancedMesh
        ref={megaCrownRef}
        args={[undefined, undefined, MEGA_COUNT]}
        frustumCulled={false}
      >
        <torusGeometry args={[1, 0.08, 6, 16]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>

      {/* Holographic Sky-Beams */}
      <instancedMesh
        ref={megaBeamRef}
        args={[undefined, undefined, MEGA_COUNT]}
        frustumCulled={false}
      >
        <cylinderGeometry args={[0.18, 0.9, 1, 8, 1, true]} />
        <meshBasicMaterial
          transparent
          opacity={0.14}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          side={THREE.DoubleSide}
          toneMapped={false}
        />
      </instancedMesh>

      {/* 260 Flying Light-Traffic Streams */}
      <instancedMesh
        ref={trafficRef}
        args={[undefined, undefined, TRAFFIC_COUNT]}
        frustumCulled={false}
      >
        <boxGeometry args={[0.24, 0.12, 1.35]} />
        <meshBasicMaterial toneMapped={false} />
      </instancedMesh>
    </group>
  );
};

// ============================================================================
// Main Exported Component
// ============================================================================
export const CyberArena: React.FC = () => {
  const surface = useGameStore((s) => s.surface);

  return (
    <group name="cyber-arena">
      <CourtSurface activeSurface={surface} />
      <CourtLinesAndTrim />
      <HolographicNet />
      <FloatingStadiumArchitecture />
      <ReactiveStadiumCrowd />
      <CyberMetropolisSkyline />
    </group>
  );
};

export default CyberArena;
