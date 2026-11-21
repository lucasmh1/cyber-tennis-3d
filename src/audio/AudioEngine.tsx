import React, { useEffect, useRef } from 'react';
import { useGameStore } from '../state/gameStore';
import { ImpactEvent, PointPhase, SpinType, SurfaceType } from '../types/game';

interface AudioGraph {
  ctx: AudioContext;
  masterGain: GainNode;
  compressor: DynamicsCompressorNode;
  sfxBus: GainNode;
  ambientBus: GainNode;
  crowdFilter: BiquadFilterNode;
  crowdGain: GainNode;
  crowdDipGain: GainNode;
  droneFilter: BiquadFilterNode;
  droneGain: GainNode;
  whiteBuffer: AudioBuffer;
  pinkStereoBuffer: AudioBuffer;
  persistentSources: AudioScheduledSourceNode[];
  persistentNodes: AudioNode[];
  activeCleanups: Set<() => void>;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function getAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (typeof AudioContext !== 'undefined') return AudioContext;
  const win = window as Window & { webkitAudioContext?: typeof AudioContext };
  return win.webkitAudioContext ?? null;
}

/** Create a mono white-noise buffer for crisp impact transients. */
function createWhiteNoiseBuffer(ctx: AudioContext, durationSec = 2.0): AudioBuffer {
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
}

/**
 * Create a seamless-looping stereo pink-noise buffer using Paul Kellet's
 * refined filter, with edge crossfade to prevent loop boundary clicks.
 */
function createPinkStereoNoiseBuffer(ctx: AudioContext, durationSec = 4.0): AudioBuffer {
  const length = Math.max(1024, Math.floor(ctx.sampleRate * durationSec));
  const buffer = ctx.createBuffer(2, length, ctx.sampleRate);

  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    let b3 = 0;
    let b4 = 0;
    let b5 = 0;
    let b6 = 0;

    // Pre-warm filter state for smooth start
    for (let i = 0; i < 256; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      b6 = white * 0.115926;
    }

    for (let i = 0; i < length; i++) {
      const white = Math.random() * 2 - 1;
      b0 = 0.99886 * b0 + white * 0.0555179;
      b1 = 0.99332 * b1 + white * 0.0750759;
      b2 = 0.96900 * b2 + white * 0.1538520;
      b3 = 0.86650 * b3 + white * 0.3104856;
      b4 = 0.55000 * b4 + white * 0.5329522;
      b5 = -0.7616 * b5 - white * 0.0168980;
      const pink = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
      b6 = white * 0.115926;
      data[i] = clamp(pink, -0.95, 0.95);
    }

    // Crossfade last 512 samples with start to make loop seamless
    const fadeSamples = Math.min(512, Math.floor(length / 8));
    for (let i = 0; i < fadeSamples; i++) {
      const t = i / fadeSamples;
      const tailIdx = length - fadeSamples + i;
      const blended = data[tailIdx] * (1 - t) + data[i] * t;
      data[tailIdx] = blended;
      data[i] = blended;
    }
  }

  return buffer;
}

/** Register automatic disconnection of a one-shot voice once its tail finishes. */
function registerVoiceCleanup(
  graph: AudioGraph,
  tailNode: AudioScheduledSourceNode,
  nodesToDisconnect: AudioNode[]
): void {
  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    graph.activeCleanups.delete(cleanup);
    for (const node of nodesToDisconnect) {
      try {
        node.disconnect();
      } catch {
        // Ignore already-disconnected node errors during teardown
      }
    }
  };
  graph.activeCleanups.add(cleanup);
  tailNode.onended = cleanup;
}

/** Create a spatialized StereoPannerNode for a court impact at X in [-5.5, +5.5]. */
function createImpactPanner(graph: AudioGraph, posX: number, posZ: number): GainNode {
  const ctx = graph.ctx;
  const pan = clamp(finiteOr(posX, 0) / 5.5, -0.9, 0.9);
  const panner = ctx.createStereoPanner();
  panner.pan.setValueAtTime(pan, ctx.currentTime);

  // Subtle front-to-back distance presence without muffling far-court AI shots
  const z = finiteOr(posZ, 0);
  const depthGain = clamp(1.0 - (12.0 - z) * 0.008, 0.78, 1.04);
  const voiceBus = ctx.createGain();
  voiceBus.gain.setValueAtTime(depthGain, ctx.currentTime);

  voiceBus.connect(panner);
  panner.connect(graph.sfxBus);
  return voiceBus;
}

function playRacketStrike(graph: AudioGraph, impact: ImpactEvent): void {
  const ctx = graph.ctx;
  const now = ctx.currentTime;
  const speedKmh = clamp(finiteOr(impact.speedKmh, 110), 25, 250);
  const speedNorm = clamp((speedKmh - 35) / 180, 0.28, 1.25);
  const isPlayer = impact.type === 'racket-player';
  const spin: SpinType = impact.spin;

  const voiceBus = createImpactPanner(graph, impact.position[0], impact.position[2]);
  const nodesToClean: AudioNode[] = [voiceBus];

  // 1. Crisp ~40ms noise burst transient (carbon-string snap)
  const burstSrc = ctx.createBufferSource();
  burstSrc.buffer = graph.whiteBuffer;
  const burstOffset = Math.random() * 1.1;

  const burstHP = ctx.createBiquadFilter();
  burstHP.type = 'highpass';
  burstHP.frequency.setValueAtTime(920, now);

  const burstBP = ctx.createBiquadFilter();
  burstBP.type = 'bandpass';
  burstBP.frequency.setValueAtTime(isPlayer ? 2350 : 2850, now);
  burstBP.Q.setValueAtTime(1.5, now);

  const burstGain = ctx.createGain();
  burstGain.gain.setValueAtTime(0.0001, now);
  burstGain.gain.linearRampToValueAtTime(0.34 * speedNorm, now + 0.003);
  burstGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.044);

  burstSrc.connect(burstHP);
  burstHP.connect(burstBP);
  burstBP.connect(burstGain);
  burstGain.connect(voiceBus);
  burstSrc.start(now, burstOffset, 0.055);
  burstSrc.stop(now + 0.055);
  nodesToClean.push(burstHP, burstBP, burstGain);

  // 2. Punchy pitched sine + triangle membrane thump
  const bodySine = ctx.createOscillator();
  bodySine.type = 'sine';
  bodySine.frequency.setValueAtTime(isPlayer ? 195 : 215, now);
  bodySine.frequency.exponentialRampToValueAtTime(isPlayer ? 66 : 76, now + 0.088);

  const bodySineGain = ctx.createGain();
  bodySineGain.gain.setValueAtTime(0.0001, now);
  bodySineGain.gain.linearRampToValueAtTime(0.36 * speedNorm, now + 0.003);
  bodySineGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.145);

  bodySine.connect(bodySineGain);
  bodySineGain.connect(voiceBus);
  bodySine.start(now);
  bodySine.stop(now + 0.155);
  nodesToClean.push(bodySineGain);

  const bodyTri = ctx.createOscillator();
  bodyTri.type = 'triangle';
  bodyTri.frequency.setValueAtTime(isPlayer ? 245 : 295, now);
  bodyTri.frequency.exponentialRampToValueAtTime(92, now + 0.065);

  const bodyTriGain = ctx.createGain();
  bodyTriGain.gain.setValueAtTime(0.0001, now);
  bodyTriGain.gain.linearRampToValueAtTime(0.2 * speedNorm, now + 0.002);
  bodyTriGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.095);

  bodyTri.connect(bodyTriGain);
  bodyTriGain.connect(voiceBus);
  bodyTri.start(now);
  bodyTri.stop(now + 0.105);
  nodesToClean.push(bodyTriGain);

  // 3. Spin-colored harmonic tail
  let tailSource: AudioScheduledSourceNode = bodySine;

  if (spin === 'topspin') {
    // Bright rising frequency whip (220Hz -> 480Hz + harmonic shimmer)
    const whipOsc = ctx.createOscillator();
    whipOsc.type = 'triangle';
    whipOsc.frequency.setValueAtTime(220, now);
    whipOsc.frequency.exponentialRampToValueAtTime(480, now + 0.14);

    const whipGain = ctx.createGain();
    whipGain.gain.setValueAtTime(0.0001, now);
    whipGain.gain.linearRampToValueAtTime(0.21 * speedNorm, now + 0.018);
    whipGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.195);

    const whipHarmonic = ctx.createOscillator();
    whipHarmonic.type = 'sine';
    whipHarmonic.frequency.setValueAtTime(440, now);
    whipHarmonic.frequency.exponentialRampToValueAtTime(960, now + 0.135);

    const whipHarmonicGain = ctx.createGain();
    whipHarmonicGain.gain.setValueAtTime(0.0001, now);
    whipHarmonicGain.gain.linearRampToValueAtTime(0.095 * speedNorm, now + 0.02);
    whipHarmonicGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.175);

    // Subtle rising brush air
    const brushSrc = ctx.createBufferSource();
    brushSrc.buffer = graph.whiteBuffer;
    const brushFilter = ctx.createBiquadFilter();
    brushFilter.type = 'bandpass';
    brushFilter.frequency.setValueAtTime(950, now);
    brushFilter.frequency.exponentialRampToValueAtTime(2500, now + 0.13);
    brushFilter.Q.setValueAtTime(2.2, now);

    const brushGain = ctx.createGain();
    brushGain.gain.setValueAtTime(0.0001, now);
    brushGain.gain.linearRampToValueAtTime(0.09 * speedNorm, now + 0.015);
    brushGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.145);

    whipOsc.connect(whipGain);
    whipGain.connect(voiceBus);
    whipHarmonic.connect(whipHarmonicGain);
    whipHarmonicGain.connect(voiceBus);
    brushSrc.connect(brushFilter);
    brushFilter.connect(brushGain);
    brushGain.connect(voiceBus);

    whipOsc.start(now);
    whipOsc.stop(now + 0.21);
    whipHarmonic.start(now);
    whipHarmonic.stop(now + 0.19);
    brushSrc.start(now, Math.random() * 0.9, 0.16);
    brushSrc.stop(now + 0.16);

    nodesToClean.push(whipGain, whipHarmonicGain, brushFilter, brushGain);
    tailSource = whipOsc;
  } else if (spin === 'slice') {
    // Crisp airy high-shelf hiss + glassy sweep
    const hissSrc = ctx.createBufferSource();
    hissSrc.buffer = graph.whiteBuffer;

    const highShelf = ctx.createBiquadFilter();
    highShelf.type = 'highshelf';
    highShelf.frequency.setValueAtTime(3000, now);
    highShelf.gain.setValueAtTime(9, now);

    const hissBP = ctx.createBiquadFilter();
    hissBP.type = 'bandpass';
    hissBP.frequency.setValueAtTime(5200, now);
    hissBP.frequency.exponentialRampToValueAtTime(1750, now + 0.19);
    hissBP.Q.setValueAtTime(1.7, now);

    const hissGain = ctx.createGain();
    hissGain.gain.setValueAtTime(0.0001, now);
    hissGain.gain.linearRampToValueAtTime(0.24 * speedNorm, now + 0.008);
    hissGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.215);

    const glassOsc = ctx.createOscillator();
    glassOsc.type = 'sine';
    glassOsc.frequency.setValueAtTime(1540, now);
    glassOsc.frequency.exponentialRampToValueAtTime(860, now + 0.165);

    const glassGain = ctx.createGain();
    glassGain.gain.setValueAtTime(0.0001, now);
    glassGain.gain.linearRampToValueAtTime(0.095 * speedNorm, now + 0.006);
    glassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.185);

    hissSrc.connect(highShelf);
    highShelf.connect(hissBP);
    hissBP.connect(hissGain);
    hissGain.connect(voiceBus);

    glassOsc.connect(glassGain);
    glassGain.connect(voiceBus);

    hissSrc.start(now, Math.random() * 0.9, 0.23);
    hissSrc.stop(now + 0.23);
    glassOsc.start(now);
    glassOsc.stop(now + 0.2);

    nodesToClean.push(highShelf, hissBP, hissGain, glassGain);
    tailSource = hissSrc;
  } else {
    // Flat: deep sub-bass cannon punch (180Hz -> 55Hz) scaled by speedKmh
    const speedFactor = clamp((speedKmh - 80) / 145, 0, 1);
    const cannonEndFreq = clamp(58 - speedFactor * 14, 44, 58);

    const subOsc = ctx.createOscillator();
    subOsc.type = 'sine';
    subOsc.frequency.setValueAtTime(180, now);
    subOsc.frequency.exponentialRampToValueAtTime(cannonEndFreq, now + 0.16);

    const subGain = ctx.createGain();
    subGain.gain.setValueAtTime(0.0001, now);
    subGain.gain.linearRampToValueAtTime((0.36 + speedFactor * 0.26) * speedNorm, now + 0.004);
    subGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

    const punchOsc = ctx.createOscillator();
    punchOsc.type = 'triangle';
    punchOsc.frequency.setValueAtTime(220, now);
    punchOsc.frequency.exponentialRampToValueAtTime(72, now + 0.09);

    const punchLP = ctx.createBiquadFilter();
    punchLP.type = 'lowpass';
    punchLP.frequency.setValueAtTime(520, now);

    const punchGain = ctx.createGain();
    punchGain.gain.setValueAtTime(0.0001, now);
    punchGain.gain.linearRampToValueAtTime(0.24 * speedNorm, now + 0.003);
    punchGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.13);

    subOsc.connect(subGain);
    subGain.connect(voiceBus);
    punchOsc.connect(punchLP);
    punchLP.connect(punchGain);
    punchGain.connect(voiceBus);

    subOsc.start(now);
    subOsc.stop(now + 0.27);
    punchOsc.start(now);
    punchOsc.stop(now + 0.14);

    nodesToClean.push(subGain, punchLP, punchGain);
    tailSource = subOsc;
  }

  // Extra supersonic laser-crack shimmer on massive >160 km/h smashes
  if (speedKmh > 160) {
    const crackSrc = ctx.createBufferSource();
    crackSrc.buffer = graph.whiteBuffer;
    const crackBP = ctx.createBiquadFilter();
    crackBP.type = 'bandpass';
    crackBP.frequency.setValueAtTime(3800, now);
    crackBP.Q.setValueAtTime(2.0, now);

    const crackGain = ctx.createGain();
    crackGain.gain.setValueAtTime(0.0001, now);
    crackGain.gain.linearRampToValueAtTime(0.16 * speedNorm, now + 0.002);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);

    crackSrc.connect(crackBP);
    crackBP.connect(crackGain);
    crackGain.connect(voiceBus);
    crackSrc.start(now, Math.random() * 1.1, 0.065);
    crackSrc.stop(now + 0.065);
    nodesToClean.push(crackBP, crackGain);
  }

  registerVoiceCleanup(graph, tailSource, nodesToClean);
}

function playCourtBounce(graph: AudioGraph, impact: ImpactEvent): void {
  const ctx = graph.ctx;
  const now = ctx.currentTime;
  const speedKmh = clamp(finiteOr(impact.speedKmh, 90), 15, 240);
  const speedNorm = clamp(speedKmh / 145, 0.28, 1.15);
  const surface: SurfaceType = impact.surface;

  const voiceBus = createImpactPanner(graph, impact.position[0], impact.position[2]);
  const nodesToClean: AudioNode[] = [voiceBus];
  let tailSource: AudioScheduledSourceNode;

  if (surface === 'neon-grass') {
    // Soft organic low-end thud + subtle shimmering bio-ping
    const thudOsc = ctx.createOscillator();
    thudOsc.type = 'sine';
    thudOsc.frequency.setValueAtTime(132, now);
    thudOsc.frequency.exponentialRampToValueAtTime(46, now + 0.085);

    const thudLP = ctx.createBiquadFilter();
    thudLP.type = 'lowpass';
    thudLP.frequency.setValueAtTime(380, now);

    const thudGain = ctx.createGain();
    thudGain.gain.setValueAtTime(0.0001, now);
    thudGain.gain.linearRampToValueAtTime(0.32 * speedNorm, now + 0.004);
    thudGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.135);

    const turfSrc = ctx.createBufferSource();
    turfSrc.buffer = graph.whiteBuffer;
    const turfBP = ctx.createBiquadFilter();
    turfBP.type = 'bandpass';
    turfBP.frequency.setValueAtTime(440, now);
    turfBP.Q.setValueAtTime(1.1, now);
    const turfGain = ctx.createGain();
    turfGain.gain.setValueAtTime(0.0001, now);
    turfGain.gain.linearRampToValueAtTime(0.11 * speedNorm, now + 0.004);
    turfGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.055);

    const bioPing1 = ctx.createOscillator();
    bioPing1.type = 'sine';
    bioPing1.frequency.setValueAtTime(1180, now);
    const bioPing2 = ctx.createOscillator();
    bioPing2.type = 'sine';
    bioPing2.frequency.setValueAtTime(1775, now);

    const bioGain = ctx.createGain();
    bioGain.gain.setValueAtTime(0.0001, now);
    bioGain.gain.linearRampToValueAtTime(0.05 * speedNorm, now + 0.009);
    bioGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);

    thudOsc.connect(thudLP);
    thudLP.connect(thudGain);
    thudGain.connect(voiceBus);
    turfSrc.connect(turfBP);
    turfBP.connect(turfGain);
    turfGain.connect(voiceBus);
    bioPing1.connect(bioGain);
    bioPing2.connect(bioGain);
    bioGain.connect(voiceBus);

    thudOsc.start(now);
    thudOsc.stop(now + 0.145);
    turfSrc.start(now, Math.random() * 0.9, 0.065);
    turfSrc.stop(now + 0.065);
    bioPing1.start(now);
    bioPing1.stop(now + 0.23);
    bioPing2.start(now);
    bioPing2.stop(now + 0.23);

    nodesToClean.push(thudLP, thudGain, turfBP, turfGain, bioGain);
    tailSource = bioPing1;
  } else if (surface === 'holographic-hard') {
    // Sharp crisp crystalline acrylic pop + glassy transient
    const popOsc = ctx.createOscillator();
    popOsc.type = 'triangle';
    popOsc.frequency.setValueAtTime(355, now);
    popOsc.frequency.exponentialRampToValueAtTime(124, now + 0.048);

    const popGain = ctx.createGain();
    popGain.gain.setValueAtTime(0.0001, now);
    popGain.gain.linearRampToValueAtTime(0.31 * speedNorm, now + 0.002);
    popGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.088);

    const acrylicSrc = ctx.createBufferSource();
    acrylicSrc.buffer = graph.whiteBuffer;
    const acrylicBP = ctx.createBiquadFilter();
    acrylicBP.type = 'bandpass';
    acrylicBP.frequency.setValueAtTime(2650, now);
    acrylicBP.Q.setValueAtTime(2.3, now);

    const acrylicGain = ctx.createGain();
    acrylicGain.gain.setValueAtTime(0.0001, now);
    acrylicGain.gain.linearRampToValueAtTime(0.24 * speedNorm, now + 0.002);
    acrylicGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.036);

    const glassOsc = ctx.createOscillator();
    glassOsc.type = 'sine';
    glassOsc.frequency.setValueAtTime(1920, now);
    glassOsc.frequency.exponentialRampToValueAtTime(1340, now + 0.065);

    const glassGain = ctx.createGain();
    glassGain.gain.setValueAtTime(0.0001, now);
    glassGain.gain.linearRampToValueAtTime(0.085 * speedNorm, now + 0.002);
    glassGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.085);

    popOsc.connect(popGain);
    popGain.connect(voiceBus);
    acrylicSrc.connect(acrylicBP);
    acrylicBP.connect(acrylicGain);
    acrylicGain.connect(voiceBus);
    glassOsc.connect(glassGain);
    glassGain.connect(voiceBus);

    popOsc.start(now);
    popOsc.stop(now + 0.105);
    acrylicSrc.start(now, Math.random() * 0.9, 0.045);
    acrylicSrc.stop(now + 0.045);
    glassOsc.start(now);
    glassOsc.stop(now + 0.092);

    nodesToClean.push(popGain, acrylicBP, acrylicGain, glassGain);
    tailSource = popOsc;
  } else {
    // Liquid Clay: resonant wet ferrofluid thump with subtle pitch bend down
    const ferroOsc = ctx.createOscillator();
    ferroOsc.type = 'sine';
    ferroOsc.frequency.setValueAtTime(215, now);
    ferroOsc.frequency.exponentialRampToValueAtTime(72, now + 0.145);

    const ferroGain = ctx.createGain();
    ferroGain.gain.setValueAtTime(0.0001, now);
    ferroGain.gain.linearRampToValueAtTime(0.35 * speedNorm, now + 0.004);
    ferroGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.185);

    const wetSrc = ctx.createBufferSource();
    wetSrc.buffer = graph.whiteBuffer;
    const wetBP = ctx.createBiquadFilter();
    wetBP.type = 'bandpass';
    wetBP.frequency.setValueAtTime(980, now);
    wetBP.frequency.exponentialRampToValueAtTime(230, now + 0.135);
    wetBP.Q.setValueAtTime(5.5, now);

    const wetGain = ctx.createGain();
    wetGain.gain.setValueAtTime(0.0001, now);
    wetGain.gain.linearRampToValueAtTime(0.24 * speedNorm, now + 0.005);
    wetGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.145);

    const dropOsc = ctx.createOscillator();
    dropOsc.type = 'triangle';
    dropOsc.frequency.setValueAtTime(420, now);
    dropOsc.frequency.exponentialRampToValueAtTime(165, now + 0.105);

    const dropGain = ctx.createGain();
    dropGain.gain.setValueAtTime(0.0001, now);
    dropGain.gain.linearRampToValueAtTime(0.08 * speedNorm, now + 0.005);
    dropGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.115);

    ferroOsc.connect(ferroGain);
    ferroGain.connect(voiceBus);
    wetSrc.connect(wetBP);
    wetBP.connect(wetGain);
    wetGain.connect(voiceBus);
    dropOsc.connect(dropGain);
    dropGain.connect(voiceBus);

    ferroOsc.start(now);
    ferroOsc.stop(now + 0.195);
    wetSrc.start(now, Math.random() * 0.9, 0.155);
    wetSrc.stop(now + 0.155);
    dropOsc.start(now);
    dropOsc.stop(now + 0.125);

    nodesToClean.push(ferroGain, wetBP, wetGain, dropGain);
    tailSource = ferroOsc;
  }

  registerVoiceCleanup(graph, tailSource, nodesToClean);
}

function playNetHit(graph: AudioGraph, impact: ImpactEvent): void {
  const ctx = graph.ctx;
  const now = ctx.currentTime;
  const voiceBus = createImpactPanner(graph, impact.position[0], impact.position[2]);
  const nodesToClean: AudioNode[] = [voiceBus];

  // 1. Detuned sawtooth electric laser-cord buzz
  const sawA = ctx.createOscillator();
  sawA.type = 'sawtooth';
  sawA.frequency.setValueAtTime(112, now);
  sawA.frequency.exponentialRampToValueAtTime(84, now + 0.24);

  const sawB = ctx.createOscillator();
  sawB.type = 'sawtooth';
  sawB.frequency.setValueAtTime(119.5, now);
  sawB.frequency.exponentialRampToValueAtTime(88, now + 0.24);

  const buzzBP = ctx.createBiquadFilter();
  buzzBP.type = 'bandpass';
  buzzBP.frequency.setValueAtTime(1350, now);
  buzzBP.frequency.exponentialRampToValueAtTime(420, now + 0.24);
  buzzBP.Q.setValueAtTime(3.0, now);

  const buzzGain = ctx.createGain();
  buzzGain.gain.setValueAtTime(0.0001, now);
  buzzGain.gain.linearRampToValueAtTime(0.26, now + 0.004);
  buzzGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.26);

  sawA.connect(buzzBP);
  sawB.connect(buzzBP);
  buzzBP.connect(buzzGain);
  buzzGain.connect(voiceBus);

  sawA.start(now);
  sawA.stop(now + 0.27);
  sawB.start(now);
  sawB.stop(now + 0.27);
  nodesToClean.push(buzzBP, buzzGain);

  // 2. Metallic FM laser zap layer
  const fmMod = ctx.createOscillator();
  fmMod.type = 'sine';
  fmMod.frequency.setValueAtTime(68, now);

  const fmDepth = ctx.createGain();
  fmDepth.gain.setValueAtTime(240, now);
  fmDepth.gain.exponentialRampToValueAtTime(8, now + 0.22);

  const fmCarrier = ctx.createOscillator();
  fmCarrier.type = 'sawtooth';
  fmCarrier.frequency.setValueAtTime(360, now);
  fmCarrier.frequency.exponentialRampToValueAtTime(175, now + 0.22);

  const fmGain = ctx.createGain();
  fmGain.gain.setValueAtTime(0.0001, now);
  fmGain.gain.linearRampToValueAtTime(0.18, now + 0.003);
  fmGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.23);

  fmMod.connect(fmDepth);
  fmDepth.connect(fmCarrier.frequency);
  fmCarrier.connect(fmGain);
  fmGain.connect(voiceBus);

  fmMod.start(now);
  fmMod.stop(now + 0.24);
  fmCarrier.start(now);
  fmCarrier.stop(now + 0.24);
  nodesToClean.push(fmDepth, fmGain);

  // 3. Audible gasp dip from crowd + vocal "ooh" gasp swell
  const dipGain = graph.crowdDipGain.gain;
  dipGain.cancelScheduledValues(now);
  dipGain.setValueAtTime(clamp(dipGain.value, 0.1, 2.0), now);
  dipGain.linearRampToValueAtTime(0.22, now + 0.055);
  dipGain.linearRampToValueAtTime(1.32, now + 0.32);
  dipGain.linearRampToValueAtTime(1.0, now + 0.95);

  const gaspSrc = ctx.createBufferSource();
  gaspSrc.buffer = graph.pinkStereoBuffer;
  const gaspBP = ctx.createBiquadFilter();
  gaspBP.type = 'bandpass';
  gaspBP.frequency.setValueAtTime(760, now + 0.04);
  gaspBP.frequency.exponentialRampToValueAtTime(420, now + 0.48);
  gaspBP.Q.setValueAtTime(2.6, now);

  const gaspGain = ctx.createGain();
  gaspGain.gain.setValueAtTime(0.0001, now);
  gaspGain.gain.linearRampToValueAtTime(0.0001, now + 0.035);
  gaspGain.gain.linearRampToValueAtTime(0.16, now + 0.11);
  gaspGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.54);

  gaspSrc.connect(gaspBP);
  gaspBP.connect(gaspGain);
  gaspGain.connect(graph.ambientBus);
  gaspSrc.start(now, Math.random() * 1.5, 0.58);
  gaspSrc.stop(now + 0.58);
  nodesToClean.push(gaspBP, gaspGain);

  registerVoiceCleanup(graph, gaspSrc, nodesToClean);
}

function playOutCall(graph: AudioGraph, impact: ImpactEvent): void {
  const ctx = graph.ctx;
  const now = ctx.currentTime;
  const voiceBus = createImpactPanner(graph, impact.position[0] * 0.6, impact.position[2]);
  const nodesToClean: AudioNode[] = [voiceBus];

  // Crisp futuristic cyber-umpire dual-tone alert chime (880Hz -> 620Hz)
  const tones: Array<{ freq: number; start: number; dur: number; peak: number }> = [
    { freq: 880, start: 0, dur: 0.115, peak: 0.22 },
    { freq: 620, start: 0.095, dur: 0.25, peak: 0.24 },
  ];

  let lastOsc: AudioScheduledSourceNode | null = null;

  for (const t of tones) {
    const start = now + t.start;
    const end = start + t.dur;

    const mainOsc = ctx.createOscillator();
    mainOsc.type = 'sine';
    mainOsc.frequency.setValueAtTime(t.freq, start);

    const shimmerOsc = ctx.createOscillator();
    shimmerOsc.type = 'triangle';
    shimmerOsc.frequency.setValueAtTime(t.freq * 2, start);

    const shimmerGain = ctx.createGain();
    shimmerGain.gain.setValueAtTime(0.16, start);

    const toneGain = ctx.createGain();
    toneGain.gain.setValueAtTime(0.0001, now);
    toneGain.gain.setValueAtTime(0.0001, start);
    toneGain.gain.linearRampToValueAtTime(t.peak, start + 0.005);
    toneGain.gain.exponentialRampToValueAtTime(0.0001, end);

    mainOsc.connect(toneGain);
    shimmerOsc.connect(shimmerGain);
    shimmerGain.connect(toneGain);
    toneGain.connect(voiceBus);

    mainOsc.start(start);
    mainOsc.stop(end + 0.01);
    shimmerOsc.start(start);
    shimmerOsc.stop(end + 0.01);

    nodesToClean.push(shimmerGain, toneGain);
    lastOsc = mainOsc;
  }

  if (lastOsc) {
    registerVoiceCleanup(graph, lastOsc, nodesToClean);
  }
}

function playPointOverFanfare(graph: AudioGraph, winner: 'player' | 'ai' | null): void {
  const ctx = graph.ctx;
  const now = ctx.currentTime;
  const nodesToClean: AudioNode[] = [];

  // 1. Energetic stadium crowd roar swell
  const roarSrc = ctx.createBufferSource();
  roarSrc.buffer = graph.pinkStereoBuffer;

  const roarBP = ctx.createBiquadFilter();
  roarBP.type = 'bandpass';
  roarBP.frequency.setValueAtTime(520, now);
  roarBP.frequency.exponentialRampToValueAtTime(1800, now + 0.28);
  roarBP.frequency.exponentialRampToValueAtTime(780, now + 1.8);
  roarBP.Q.setValueAtTime(0.85, now);

  const roarGain = ctx.createGain();
  roarGain.gain.setValueAtTime(0.0001, now);
  roarGain.gain.linearRampToValueAtTime(winner === 'player' ? 0.26 : 0.19, now + 0.16);
  roarGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.85);

  roarSrc.connect(roarBP);
  roarBP.connect(roarGain);
  roarGain.connect(graph.ambientBus);
  roarSrc.start(now, Math.random() * 1.2, 1.9);
  roarSrc.stop(now + 1.9);
  nodesToClean.push(roarBP, roarGain);

  // Boost continuous crowd bed transiently
  const dipGain = graph.crowdDipGain.gain;
  dipGain.cancelScheduledValues(now);
  dipGain.setValueAtTime(clamp(dipGain.value, 0.1, 2.0), now);
  dipGain.linearRampToValueAtTime(1.42, now + 0.2);
  dipGain.linearRampToValueAtTime(1.0, now + 1.6);

  // 2. Futuristic stadium synth chord fanfare
  const fanfareBus = ctx.createGain();
  fanfareBus.gain.setValueAtTime(1.0, now);
  fanfareBus.connect(graph.sfxBus);
  nodesToClean.push(fanfareBus);

  const fanfareFilter = ctx.createBiquadFilter();
  fanfareFilter.type = 'lowpass';
  fanfareFilter.Q.setValueAtTime(1.6, now);
  fanfareFilter.connect(fanfareBus);
  nodesToClean.push(fanfareFilter);

  const playerWins = winner === 'player';
  const notes = playerWins
    ? [261.63, 329.63, 392.0, 493.88, 587.33] // Triumphant ascending Cmaj9
    : [110.0, 220.0, 261.63, 311.13, 415.3]; // Tense cyber minor-maj7/dim chord

  if (playerWins) {
    fanfareFilter.frequency.setValueAtTime(680, now);
    fanfareFilter.frequency.exponentialRampToValueAtTime(3800, now + 0.25);
    fanfareFilter.frequency.exponentialRampToValueAtTime(1350, now + 1.35);
  } else {
    fanfareFilter.frequency.setValueAtTime(2400, now);
    fanfareFilter.frequency.exponentialRampToValueAtTime(460, now + 1.15);
  }

  const stagger = playerWins ? 0.048 : 0.03;

  notes.forEach((freq, idx) => {
    const start = now + idx * stagger;
    const dur = playerWins ? 1.15 : 1.05;
    const end = start + dur;

    const oscA = ctx.createOscillator();
    oscA.type = 'sawtooth';
    oscA.frequency.setValueAtTime(freq, start);

    const oscB = ctx.createOscillator();
    oscB.type = 'triangle';
    oscB.frequency.setValueAtTime(freq * 1.003, start);

    const panner = ctx.createStereoPanner();
    const spread = ((idx / Math.max(1, notes.length - 1)) - 0.5) * 0.85;
    panner.pan.setValueAtTime(spread, start);

    const noteGain = ctx.createGain();
    noteGain.gain.setValueAtTime(0.0001, now);
    noteGain.gain.setValueAtTime(0.0001, start);
    noteGain.gain.linearRampToValueAtTime(playerWins ? 0.068 : 0.062, start + 0.035);
    noteGain.gain.exponentialRampToValueAtTime(0.0001, end);

    oscA.connect(noteGain);
    oscB.connect(noteGain);
    noteGain.connect(panner);
    panner.connect(fanfareFilter);

    oscA.start(start);
    oscA.stop(end + 0.02);
    oscB.start(start);
    oscB.stop(end + 0.02);

    nodesToClean.push(noteGain, panner);
  });

  // roarSrc ends at now + 1.9s, outlasting all fanfare chord notes
  registerVoiceCleanup(graph, roarSrc, nodesToClean);
}

function playSurfaceMorphSweep(graph: AudioGraph, surface: SurfaceType): void {
  const ctx = graph.ctx;
  const now = ctx.currentTime;
  const nodesToClean: AudioNode[] = [];

  const morphBus = ctx.createGain();
  morphBus.gain.setValueAtTime(1.0, now);
  morphBus.connect(graph.sfxBus);
  nodesToClean.push(morphBus);

  // Resonant filtered holographic sweep
  const sweepSrc = ctx.createBufferSource();
  sweepSrc.buffer = graph.pinkStereoBuffer;

  const sweepBP = ctx.createBiquadFilter();
  sweepBP.type = 'bandpass';
  sweepBP.frequency.setValueAtTime(220, now);
  sweepBP.frequency.exponentialRampToValueAtTime(2900, now + 0.3);
  sweepBP.frequency.exponentialRampToValueAtTime(380, now + 0.72);
  sweepBP.Q.setValueAtTime(5.2, now);

  const sweepGain = ctx.createGain();
  sweepGain.gain.setValueAtTime(0.0001, now);
  sweepGain.gain.linearRampToValueAtTime(0.28, now + 0.14);
  sweepGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.76);

  sweepSrc.connect(sweepBP);
  sweepBP.connect(sweepGain);
  sweepGain.connect(morphBus);
  sweepSrc.start(now, Math.random() * 1.4, 0.82);
  sweepSrc.stop(now + 0.82);
  nodesToClean.push(sweepBP, sweepGain);

  // Harmonic shimmer tones tailored to target surface
  const chimes =
    surface === 'neon-grass'
      ? [1046.5, 1318.5, 1568.0]
      : surface === 'holographic-hard'
        ? [1174.66, 1760.0, 2349.32]
        : [880.0, 1318.5, 1975.53];

  chimes.forEach((freq, idx) => {
    const start = now + 0.08 + idx * 0.065;
    const end = start + 0.55;

    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, start);

    const pan = ctx.createStereoPanner();
    pan.pan.setValueAtTime((idx - 1) * 0.45, start);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.linearRampToValueAtTime(0.055, start + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);

    osc.connect(gain);
    gain.connect(pan);
    pan.connect(morphBus);

    osc.start(start);
    osc.stop(end + 0.01);
    nodesToClean.push(gain, pan);
  });

  // sweepSrc stops at now + 0.82s, outlasting all shimmer chimes (max ~0.77s)
  registerVoiceCleanup(graph, sweepSrc, nodesToClean);
}

function playSlowMoTimeWarp(graph: AudioGraph): void {
  const ctx = graph.ctx;
  const now = ctx.currentTime;
  const nodesToClean: AudioNode[] = [];

  const warpBus = ctx.createGain();
  warpBus.gain.setValueAtTime(1.0, now);
  warpBus.connect(graph.sfxBus);
  nodesToClean.push(warpBus);

  // 1. Dramatic cinematic sub-bass drop (145Hz -> 34Hz)
  const dropOsc = ctx.createOscillator();
  dropOsc.type = 'sine';
  dropOsc.frequency.setValueAtTime(145, now);
  dropOsc.frequency.exponentialRampToValueAtTime(34, now + 1.05);

  const dropGain = ctx.createGain();
  dropGain.gain.setValueAtTime(0.0001, now);
  dropGain.gain.linearRampToValueAtTime(0.42, now + 0.025);
  dropGain.gain.exponentialRampToValueAtTime(0.0001, now + 1.15);

  dropOsc.connect(dropGain);
  dropGain.connect(warpBus);
  dropOsc.start(now);
  dropOsc.stop(now + 1.18);
  nodesToClean.push(dropGain);

  // 2. Time-dilation downward pitch-bend shimmer
  const shimmerOsc = ctx.createOscillator();
  shimmerOsc.type = 'triangle';
  shimmerOsc.frequency.setValueAtTime(640, now);
  shimmerOsc.frequency.exponentialRampToValueAtTime(180, now + 0.85);

  const shimmerLP = ctx.createBiquadFilter();
  shimmerLP.type = 'lowpass';
  shimmerLP.frequency.setValueAtTime(1800, now);
  shimmerLP.frequency.exponentialRampToValueAtTime(240, now + 0.85);

  const shimmerGain = ctx.createGain();
  shimmerGain.gain.setValueAtTime(0.0001, now);
  shimmerGain.gain.linearRampToValueAtTime(0.14, now + 0.03);
  shimmerGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.92);

  shimmerOsc.connect(shimmerLP);
  shimmerLP.connect(shimmerGain);
  shimmerGain.connect(warpBus);
  shimmerOsc.start(now);
  shimmerOsc.stop(now + 0.95);
  nodesToClean.push(shimmerLP, shimmerGain);

  // 3. Time-dilation noise whoosh
  const whooshSrc = ctx.createBufferSource();
  whooshSrc.buffer = graph.pinkStereoBuffer;
  const whooshLP = ctx.createBiquadFilter();
  whooshLP.type = 'lowpass';
  whooshLP.frequency.setValueAtTime(4200, now);
  whooshLP.frequency.exponentialRampToValueAtTime(160, now + 0.9);
  whooshLP.Q.setValueAtTime(2.5, now);

  const whooshGain = ctx.createGain();
  whooshGain.gain.setValueAtTime(0.0001, now);
  whooshGain.gain.linearRampToValueAtTime(0.24, now + 0.045);
  whooshGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.98);

  whooshSrc.connect(whooshLP);
  whooshLP.connect(whooshGain);
  whooshGain.connect(warpBus);
  whooshSrc.start(now, Math.random() * 1.2, 1.02);
  whooshSrc.stop(now + 1.02);
  nodesToClean.push(whooshLP, whooshGain);

  registerVoiceCleanup(graph, dropOsc, nodesToClean);
}

/** Initialize the Web Audio graph, buffers, ambient city drone, and crowd noise bed. */
function buildAudioGraph(): AudioGraph | null {
  const Ctx = getAudioContextConstructor();
  if (!Ctx) return null;

  const ctx = new Ctx();
  const now = ctx.currentTime;
  const initialState = useGameStore.getState();

  const masterGain = ctx.createGain();
  const initVol = initialState.audioMuted ? 0 : clamp(initialState.audioVolume, 0, 1);
  masterGain.gain.setValueAtTime(initVol, now);
  masterGain.connect(ctx.destination);

  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.setValueAtTime(-14, now);
  compressor.knee.setValueAtTime(12, now);
  compressor.ratio.setValueAtTime(4, now);
  compressor.attack.setValueAtTime(0.003, now);
  compressor.release.setValueAtTime(0.15, now);
  compressor.connect(masterGain);

  const sfxBus = ctx.createGain();
  sfxBus.gain.setValueAtTime(0.95, now);
  sfxBus.connect(compressor);

  const ambientBus = ctx.createGain();
  ambientBus.gain.setValueAtTime(1.0, now);
  ambientBus.connect(compressor);

  const whiteBuffer = createWhiteNoiseBuffer(ctx, 2.0);
  const pinkStereoBuffer = createPinkStereoNoiseBuffer(ctx, 4.0);

  const persistentSources: AudioScheduledSourceNode[] = [];
  const persistentNodes: AudioNode[] = [masterGain, compressor, sfxBus, ambientBus];

  const initExcitement = clamp(finiteOr(initialState.crowdExcitement, 0.2), 0, 1);
  const initRallyNorm = clamp(finiteOr(initialState.rallyCount, 0) / 14, 0, 1);
  const initCombined = clamp(initExcitement * 0.72 + initRallyNorm * 0.28, 0, 1);
  const initSlowMo = initialState.isSlowMo || initialState.phase === 'replay';
  const initCutoff = initSlowMo ? 380 + initCombined * 420 : 480 + initCombined * 2400;
  const initCrowdGain = initSlowMo ? 0.026 + initCombined * 0.04 : 0.028 + initCombined * 0.165;

  // --- Ambient Cyberpunk City Hum (55Hz + 82.4Hz fifth warm low-pass analog pad) ---
  const droneFilter = ctx.createBiquadFilter();
  droneFilter.type = 'lowpass';
  droneFilter.frequency.setValueAtTime(165, now);
  droneFilter.Q.setValueAtTime(0.8, now);

  const droneGain = ctx.createGain();
  droneGain.gain.setValueAtTime(0.0001, now);
  droneGain.gain.linearRampToValueAtTime(initSlowMo ? 0.032 : 0.055, now + 0.8);

  const droneOsc1 = ctx.createOscillator();
  droneOsc1.type = 'sawtooth';
  droneOsc1.frequency.setValueAtTime(55.0, now);
  const droneMix1 = ctx.createGain();
  droneMix1.gain.setValueAtTime(0.32, now);

  const droneOsc2 = ctx.createOscillator();
  droneOsc2.type = 'triangle';
  droneOsc2.frequency.setValueAtTime(55.16, now);
  const droneMix2 = ctx.createGain();
  droneMix2.gain.setValueAtTime(0.45, now);

  const droneOsc3 = ctx.createOscillator();
  droneOsc3.type = 'triangle';
  droneOsc3.frequency.setValueAtTime(82.41, now); // Perfect fifth
  const droneMix3 = ctx.createGain();
  droneMix3.gain.setValueAtTime(0.28, now);

  const droneLfo = ctx.createOscillator();
  droneLfo.type = 'sine';
  droneLfo.frequency.setValueAtTime(0.09, now);
  const droneLfoGain = ctx.createGain();
  droneLfoGain.gain.setValueAtTime(32, now);

  droneOsc1.connect(droneMix1);
  droneOsc2.connect(droneMix2);
  droneOsc3.connect(droneMix3);
  droneMix1.connect(droneFilter);
  droneMix2.connect(droneFilter);
  droneMix3.connect(droneFilter);
  droneFilter.connect(droneGain);
  droneGain.connect(ambientBus);

  droneLfo.connect(droneLfoGain);
  droneLfoGain.connect(droneFilter.frequency);

  droneOsc1.start(now);
  droneOsc2.start(now);
  droneOsc3.start(now);
  droneLfo.start(now);

  persistentSources.push(droneOsc1, droneOsc2, droneOsc3, droneLfo);
  persistentNodes.push(
    droneFilter,
    droneGain,
    droneMix1,
    droneMix2,
    droneMix3,
    droneLfoGain
  );

  // --- Reactive Stadium Crowd Bed (continuous stereo pink noise) ---
  const crowdSource = ctx.createBufferSource();
  crowdSource.buffer = pinkStereoBuffer;
  crowdSource.loop = true;

  const crowdHP = ctx.createBiquadFilter();
  crowdHP.type = 'highpass';
  crowdHP.frequency.setValueAtTime(150, now);
  crowdHP.Q.setValueAtTime(0.7, now);

  const crowdFilter = ctx.createBiquadFilter();
  crowdFilter.type = 'lowpass';
  crowdFilter.frequency.setValueAtTime(540, now);
  crowdFilter.Q.setValueAtTime(0.9, now);

  const crowdFormant = ctx.createBiquadFilter();
  crowdFormant.type = 'peaking';
  crowdFormant.frequency.setValueAtTime(950, now);
  crowdFormant.Q.setValueAtTime(1.1, now);
  crowdFormant.gain.setValueAtTime(3.2, now);

  crowdFilter.frequency.setValueAtTime(initCutoff, now);

  const crowdGain = ctx.createGain();
  crowdGain.gain.setValueAtTime(0.0001, now);
  crowdGain.gain.linearRampToValueAtTime(initCrowdGain, now + 0.6);

  const crowdDipGain = ctx.createGain();
  crowdDipGain.gain.setValueAtTime(1.0, now);

  const crowdLfo = ctx.createOscillator();
  crowdLfo.type = 'sine';
  crowdLfo.frequency.setValueAtTime(0.16, now);
  const crowdLfoGain = ctx.createGain();
  crowdLfoGain.gain.setValueAtTime(85, now);

  crowdSource.connect(crowdHP);
  crowdHP.connect(crowdFilter);
  crowdFilter.connect(crowdFormant);
  crowdFormant.connect(crowdGain);
  crowdGain.connect(crowdDipGain);
  crowdDipGain.connect(ambientBus);

  crowdLfo.connect(crowdLfoGain);
  crowdLfoGain.connect(crowdFilter.frequency);

  crowdSource.start(now);
  crowdLfo.start(now);

  persistentSources.push(crowdSource, crowdLfo);
  persistentNodes.push(
    crowdHP,
    crowdFilter,
    crowdFormant,
    crowdGain,
    crowdDipGain,
    crowdLfoGain
  );

  return {
    ctx,
    masterGain,
    compressor,
    sfxBus,
    ambientBus,
    crowdFilter,
    crowdGain,
    crowdDipGain,
    droneFilter,
    droneGain,
    whiteBuffer,
    pinkStereoBuffer,
    persistentSources,
    persistentNodes,
    activeCleanups: new Set(),
  };
}

export const AudioEngine: React.FC = () => {
  const lastImpact = useGameStore((s) => s.lastImpact);
  const phase = useGameStore((s) => s.phase);
  const surface = useGameStore((s) => s.surface);
  const rallyCount = useGameStore((s) => s.rallyCount);
  const crowdExcitement = useGameStore((s) => s.crowdExcitement);
  const isSlowMo = useGameStore((s) => s.isSlowMo);
  const audioMuted = useGameStore((s) => s.audioMuted);
  const audioVolume = useGameStore((s) => s.audioVolume);

  const graphRef = useRef<AudioGraph | null>(null);
  const prevImpactIdRef = useRef<number>(lastImpact?.id ?? -1);
  const prevSurfaceRef = useRef<SurfaceType>(surface);
  const prevPhaseRef = useRef<PointPhase>(phase);
  const prevInSlowMoRef = useRef<boolean>(isSlowMo || phase === 'replay');

  // Initialize AudioContext lazily on first pointerdown or keydown & clean up on unmount
  useEffect(() => {
    let disposed = false;

    const unlock = () => {
      if (disposed) return;
      if (!graphRef.current) {
        const built = buildAudioGraph();
        if (!built) return;
        graphRef.current = built;
      }
      const { ctx } = graphRef.current;
      if (ctx.state === 'suspended') {
        void ctx.resume().catch(() => {});
      }
    };

    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });

    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', unlock, { capture: true });
      window.removeEventListener('keydown', unlock, { capture: true });

      const graph = graphRef.current;
      graphRef.current = null;
      if (!graph) return;

      for (const cleanup of Array.from(graph.activeCleanups)) {
        cleanup();
      }
      graph.activeCleanups.clear();

      for (const src of graph.persistentSources) {
        try {
          src.stop();
        } catch {
          // Ignore if source already stopped
        }
        try {
          src.disconnect();
        } catch {
          // Ignore already-disconnected errors
        }
      }

      for (const node of graph.persistentNodes) {
        try {
          node.disconnect();
        } catch {
          // Ignore already-disconnected errors
        }
      }

      if (graph.ctx.state !== 'closed') {
        void graph.ctx.close().catch(() => {});
      }
    };
  }, []);

  // Master volume & mute control
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || graph.ctx.state === 'closed') return;
    const targetGain = audioMuted ? 0 : clamp(finiteOr(audioVolume, 0.75), 0, 1);
    graph.masterGain.gain.setTargetAtTime(targetGain, graph.ctx.currentTime, 0.025);
  }, [audioMuted, audioVolume]);

  // Dynamic crowd bed filter cutoff & gain + slow-mo ambient attenuation
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph || graph.ctx.state === 'closed') return;
    const now = graph.ctx.currentTime;
    const excitement = clamp(finiteOr(crowdExcitement, 0.2), 0, 1);
    const rallyNorm = clamp(finiteOr(rallyCount, 0) / 14, 0, 1);
    const combined = clamp(excitement * 0.72 + rallyNorm * 0.28, 0, 1);
    const slowMoActive = isSlowMo || phase === 'replay';

    const targetCutoff = slowMoActive
      ? 380 + combined * 420
      : 480 + combined * 2400;
    const targetCrowdGain = slowMoActive
      ? 0.026 + combined * 0.04
      : 0.028 + combined * 0.165;

    graph.crowdFilter.frequency.setTargetAtTime(targetCutoff, now, 0.18);
    graph.crowdGain.gain.setTargetAtTime(targetCrowdGain, now, 0.18);
    graph.droneGain.gain.setTargetAtTime(slowMoActive ? 0.032 : 0.055, now, 0.25);
  }, [crowdExcitement, rallyCount, isSlowMo, phase]);

  // Spatialized 3D impact sound synthesis
  useEffect(() => {
    if (!lastImpact || lastImpact.id === prevImpactIdRef.current) return;
    prevImpactIdRef.current = lastImpact.id;

    const graph = graphRef.current;
    if (!graph || graph.ctx.state === 'closed') return;
    if (graph.ctx.state === 'suspended') {
      void graph.ctx.resume().catch(() => {});
    }

    switch (lastImpact.type) {
      case 'racket-player':
      case 'racket-ai':
        playRacketStrike(graph, lastImpact);
        break;
      case 'bounce':
        playCourtBounce(graph, lastImpact);
        break;
      case 'net':
        playNetHit(graph, lastImpact);
        break;
      case 'out':
        playOutCall(graph, lastImpact);
        break;
    }
  }, [lastImpact]);

  // Point-over crowd roar + stadium synth chord fanfare
  useEffect(() => {
    const prevPhase = prevPhaseRef.current;
    prevPhaseRef.current = phase;

    if (phase === 'point-over' && prevPhase !== 'point-over') {
      const graph = graphRef.current;
      if (!graph || graph.ctx.state === 'closed') return;
      if (graph.ctx.state === 'suspended') {
        void graph.ctx.resume().catch(() => {});
      }
      const winner = useGameStore.getState().score.lastPointWinner;
      playPointOverFanfare(graph, winner);
    }
  }, [phase]);

  // Surface morph sci-fi sweep
  useEffect(() => {
    const prevSurface = prevSurfaceRef.current;
    prevSurfaceRef.current = surface;

    if (surface !== prevSurface) {
      const graph = graphRef.current;
      if (!graph || graph.ctx.state === 'closed') return;
      if (graph.ctx.state === 'suspended') {
        void graph.ctx.resume().catch(() => {});
      }
      playSurfaceMorphSweep(graph, surface);
    }
  }, [surface]);

  // Slow-motion replay time-warp bass-drop & whoosh
  useEffect(() => {
    const inSlowMo = isSlowMo || phase === 'replay';
    const wasInSlowMo = prevInSlowMoRef.current;
    prevInSlowMoRef.current = inSlowMo;

    if (inSlowMo && !wasInSlowMo) {
      const graph = graphRef.current;
      if (!graph || graph.ctx.state === 'closed') return;
      if (graph.ctx.state === 'suspended') {
        void graph.ctx.resume().catch(() => {});
      }
      playSlowMoTimeWarp(graph);
    }
  }, [isSlowMo, phase]);

  return null;
};
