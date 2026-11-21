import * as THREE from 'three';
import { create } from 'zustand';
import {
  AIDifficulty,
  CameraMode,
  ImpactEvent,
  MutableGameRefs,
  PointPhase,
  ScoreState,
  SpinType,
  SurfaceConfig,
  SurfaceType,
} from '../types/game';

export const SURFACE_CONFIGS: Record<SurfaceType, SurfaceConfig> = {
  'neon-grass': {
    id: 'neon-grass',
    name: 'NEON GRASS',
    subtitle: 'Low Skid // Bioluminescent Turf',
    restitution: 0.68,
    friction: 0.14,
    spinMultiplier: 0.85,
    primaryColor: '#00ffa3',
    secondaryColor: '#00e5ff',
    accentColor: '#a3ff00',
    emissiveIntensity: 1.25,
  },
  'holographic-hard': {
    id: 'holographic-hard',
    name: 'HOLOGRAPHIC HARD',
    subtitle: 'True Bounce // Cyber-Acrylic',
    restitution: 0.78,
    friction: 0.28,
    spinMultiplier: 1.15,
    primaryColor: '#00d4ff',
    secondaryColor: '#ff00aa',
    accentColor: '#3b82f6',
    emissiveIntensity: 1.35,
  },
  'liquid-clay': {
    id: 'liquid-clay',
    name: 'LIQUID CLAY',
    subtitle: 'High Bounce // Max Spin Bite',
    restitution: 0.85,
    friction: 0.48,
    spinMultiplier: 1.65,
    primaryColor: '#ff2a85',
    secondaryColor: '#ff9900',
    accentColor: '#ff0055',
    emissiveIntensity: 1.45,
  },
};

export const gameRefs: MutableGameRefs = {
  ballPos: new THREE.Vector3(0.45, 0.95, 11.4),
  ballVel: new THREE.Vector3(0, 0, 0),
  ballAngularVel: new THREE.Vector3(0, 0, 0),
  playerPos: new THREE.Vector3(0.45, 0, 11.65),
  playerVel: new THREE.Vector3(0, 0, 0),
  aiPos: new THREE.Vector3(-0.45, 0, -11.65),
  aiVel: new THREE.Vector3(0, 0, 0),
  playerTargetX: 0,
  playerSwingProgress: 0,
  aiSwingProgress: 0,
  predictedLanding: new THREE.Vector3(0, 0.034, 0),
  trajectoryPoints: [],
  replayFrames: [],
};

const INITIAL_SCORE: ScoreState = {
  playerPoints: 0,
  aiPoints: 0,
  playerGames: 0,
  aiGames: 0,
  playerSets: 0,
  aiSets: 0,
  server: 'player',
  deuceCount: 0,
  lastPointWinner: null,
  lastPointReason: '',
};

const SPIN_BASE_RPM: Record<SpinType, number> = {
  topspin: 2200,
  slice: 1850,
  flat: 420,
};

export type ImpactInput = Omit<ImpactEvent, 'id' | 'timestamp'> &
  Partial<Pick<ImpactEvent, 'id' | 'timestamp'>>;

export interface GameState {
  surface: SurfaceType;
  cameraMode: CameraMode;
  aiDifficulty: AIDifficulty;
  phase: PointPhase;
  score: ScoreState;
  rallyCount: number;
  maxRallyCount: number;
  lastServeSpeedKmh: number;
  lastShotSpeedKmh: number;
  currentSpin: SpinType;
  spinRpm: number;
  chargePower: number;
  isCharging: boolean;
  isSlowMo: boolean;
  timeScale: number;
  crowdExcitement: number;
  lastImpact: ImpactEvent | null;
  audioMuted: boolean;
  audioVolume: number;
  showControls: boolean;
  isAttractMode: boolean;

  setSurface: (surface: SurfaceType) => void;
  setCameraMode: (mode: CameraMode) => void;
  setAiDifficulty: (difficulty: AIDifficulty) => void;
  setPhase: (phase: PointPhase) => void;
  setCurrentSpin: (spin: SpinType) => void;
  setCharge: (power: number, isCharging: boolean) => void;
  recordImpact: (impact: ImpactInput) => void;
  incrementRally: (shotSpeedKmh?: number) => void;
  awardPoint: (
    winner: 'player' | 'ai',
    reason: string,
    triggerSlowMoReplay?: boolean
  ) => void;
  startReplay: () => void;
  endReplay: () => void;
  resetMatch: () => void;
  toggleAudioMute: () => void;
  setAudioVolume: (volume: number) => void;
  toggleControls: () => void;
  setAttractMode: (enabled: boolean) => void;
}

let impactCounter = 0;
let replayTimeoutId: number | null = null;
let phaseBeforeReplay: PointPhase = 'pre-serve';

function clearPendingReplayTimer() {
  if (replayTimeoutId !== null) {
    window.clearTimeout(replayTimeoutId);
    replayTimeoutId = null;
  }
}

function resetMutableRefs(server: 'player' | 'ai') {
  const isPlayerServe = server === 'player';
  const zPlayer = isPlayerServe ? 11.65 : 11.85;
  const zAi = isPlayerServe ? -11.85 : -11.65;
  const xServer = isPlayerServe ? 0.55 : -0.55;

  gameRefs.playerPos.set(xServer, 0, zPlayer);
  gameRefs.playerVel.set(0, 0, 0);
  gameRefs.aiPos.set(-xServer, 0, zAi);
  gameRefs.aiVel.set(0, 0, 0);
  gameRefs.ballPos.set(
    isPlayerServe ? xServer - 0.15 : -xServer + 0.15,
    0.95,
    isPlayerServe ? zPlayer - 0.35 : zAi + 0.35
  );
  gameRefs.ballVel.set(0, 0, 0);
  gameRefs.ballAngularVel.set(0, 0, 0);
  gameRefs.playerTargetX = 0;
  gameRefs.playerSwingProgress = 0;
  gameRefs.aiSwingProgress = 0;
  gameRefs.predictedLanding.set(0, 0.034, 0);
  gameRefs.trajectoryPoints = [];
  gameRefs.replayFrames = [];
}

export const useGameStore = create<GameState>((set, get) => ({
  surface: 'holographic-hard',
  cameraMode: 'follow',
  aiDifficulty: 'pro',
  phase: 'pre-serve',
  score: { ...INITIAL_SCORE },
  rallyCount: 0,
  maxRallyCount: 0,
  lastServeSpeedKmh: 0,
  lastShotSpeedKmh: 0,
  currentSpin: 'topspin',
  spinRpm: 2200,
  chargePower: 0,
  isCharging: false,
  isSlowMo: false,
  timeScale: 1.0,
  crowdExcitement: 0.2,
  lastImpact: null,
  audioMuted: false,
  audioVolume: 0.75,
  showControls: false,
  isAttractMode: false,

  setSurface: (surface) => set({ surface }),

  setCameraMode: (cameraMode) => set({ cameraMode }),

  setAiDifficulty: (aiDifficulty) => set({ aiDifficulty }),

  setPhase: (phase) => {
    if (phase !== 'point-over') {
      clearPendingReplayTimer();
    }
    set((state) => {
      if (phase === 'pre-serve') {
        return {
          phase,
          rallyCount: 0,
          chargePower: 0,
          isCharging: false,
          isSlowMo: false,
          timeScale: 1.0,
          crowdExcitement: Math.max(0.2, state.crowdExcitement * 0.75),
        };
      }
      return { phase };
    });
  },

  setCurrentSpin: (currentSpin) =>
    set({
      currentSpin,
      spinRpm: SPIN_BASE_RPM[currentSpin],
    }),

  setCharge: (chargePower, isCharging) =>
    set({
      chargePower: Math.max(0, Math.min(1, chargePower)),
      isCharging,
    }),

  recordImpact: (impact) =>
    set((state) => {
      const id = impact.id ?? ++impactCounter;
      const timestamp = impact.timestamp ?? Date.now();
      const event: ImpactEvent = {
        ...impact,
        id,
        timestamp,
      };

      const isRacketHit =
        impact.type === 'racket-player' || impact.type === 'racket-ai';
      const roundedSpeed = Math.round(impact.speedKmh);

      const spinRpm =
        impact.type === 'racket-player'
          ? Math.round(
              SPIN_BASE_RPM[impact.spin] +
                impact.speedKmh * (impact.spin === 'flat' ? 1.8 : 7.5)
            )
          : state.spinRpm;

      const excitementBoost =
        impact.type === 'net'
          ? 0.08
          : isRacketHit && impact.speedKmh > 155
            ? 0.06
            : 0.015;

      return {
        lastImpact: event,
        lastShotSpeedKmh: isRacketHit ? roundedSpeed : state.lastShotSpeedKmh,
        lastServeSpeedKmh:
          isRacketHit && state.rallyCount === 0
            ? roundedSpeed
            : state.lastServeSpeedKmh,
        spinRpm,
        crowdExcitement: Math.min(1, state.crowdExcitement + excitementBoost),
      };
    }),

  incrementRally: (shotSpeedKmh) =>
    set((state) => {
      const nextRally = state.rallyCount + 1;
      return {
        rallyCount: nextRally,
        maxRallyCount: Math.max(state.maxRallyCount, nextRally),
        lastShotSpeedKmh:
          typeof shotSpeedKmh === 'number'
            ? Math.round(shotSpeedKmh)
            : state.lastShotSpeedKmh,
        crowdExcitement: Math.min(1, state.crowdExcitement + 0.055),
      };
    }),

  awardPoint: (winner, reason, triggerSlowMoReplay = false) => {
    clearPendingReplayTimer();
    const state = get();
    if (state.phase === 'point-over' || state.phase === 'replay') {
      return;
    }

    const prev = state.score;
    let playerPoints = prev.playerPoints;
    let aiPoints = prev.aiPoints;
    let playerGames = prev.playerGames;
    let aiGames = prev.aiGames;
    let playerSets = prev.playerSets;
    let aiSets = prev.aiSets;
    let server = prev.server;
    let deuceCount = prev.deuceCount;

    const winnerIsPlayer = winner === 'player';
    let winnerPts = winnerIsPlayer ? playerPoints : aiPoints;
    let loserPts = winnerIsPlayer ? aiPoints : playerPoints;

    let gameWon = false;
    let setWon = false;

    if (winnerPts === 3 && loserPts === 3) {
      // 40-40 Deuce -> Advantage
      winnerPts = 4;
    } else if (loserPts === 4) {
      // Opponent had AD -> back to Deuce
      loserPts = 3;
      deuceCount += 1;
    } else if (winnerPts >= 3) {
      // Won from 40 (with opponent < 40) or from AD
      gameWon = true;
    } else {
      winnerPts += 1;
    }

    if (winnerIsPlayer) {
      playerPoints = winnerPts;
      aiPoints = loserPts;
    } else {
      aiPoints = winnerPts;
      playerPoints = loserPts;
    }

    if (gameWon) {
      playerPoints = 0;
      aiPoints = 0;
      deuceCount = 0;
      server = prev.server === 'player' ? 'ai' : 'player';

      if (winnerIsPlayer) {
        playerGames += 1;
      } else {
        aiGames += 1;
      }

      const wGames = winnerIsPlayer ? playerGames : aiGames;
      const lGames = winnerIsPlayer ? aiGames : playerGames;

      if ((wGames >= 6 && wGames - lGames >= 2) || wGames >= 7) {
        setWon = true;
        if (winnerIsPlayer) {
          playerSets += 1;
        } else {
          aiSets += 1;
        }
        playerGames = 0;
        aiGames = 0;
      }
    }

    const formattedReason = setWon
      ? `${reason} // SET!`
      : gameWon
        ? `${reason} // GAME!`
        : reason;

    const shouldReplay =
      (triggerSlowMoReplay || state.rallyCount >= 5 || gameWon) &&
      gameRefs.replayFrames.length > 10;

    set({
      phase: 'point-over',
      isCharging: false,
      chargePower: 0,
      crowdExcitement: Math.min(1, state.crowdExcitement + (gameWon ? 0.45 : 0.32)),
      score: {
        playerPoints,
        aiPoints,
        playerGames,
        aiGames,
        playerSets,
        aiSets,
        server,
        deuceCount,
        lastPointWinner: winner,
        lastPointReason: formattedReason,
      },
    });

    if (shouldReplay) {
      replayTimeoutId = window.setTimeout(() => {
        replayTimeoutId = null;
        const current = get();
        if (current.phase === 'point-over' && gameRefs.replayFrames.length > 5) {
          phaseBeforeReplay = 'pre-serve';
          set({
            phase: 'replay',
            isSlowMo: true,
            timeScale: 0.28,
          });
        }
      }, 950);
    }
  },

  startReplay: () => {
    const state = get();
    if (state.phase === 'replay' || gameRefs.replayFrames.length <= 5) {
      return;
    }
    clearPendingReplayTimer();
    phaseBeforeReplay =
      state.phase === 'rally' || state.phase === 'serve-toss'
        ? state.phase
        : 'pre-serve';
    set({
      phase: 'replay',
      isSlowMo: true,
      timeScale: 0.28,
      isCharging: false,
    });
  },

  endReplay: () => {
    clearPendingReplayTimer();
    const state = get();
    if (state.phase !== 'replay') {
      return;
    }
    const targetPhase =
      phaseBeforeReplay === 'rally' || phaseBeforeReplay === 'serve-toss'
        ? phaseBeforeReplay
        : 'pre-serve';
    phaseBeforeReplay = 'pre-serve';

    set({
      phase: targetPhase,
      isSlowMo: false,
      timeScale: 1.0,
      chargePower: 0,
      isCharging: false,
      rallyCount: targetPhase === 'pre-serve' ? 0 : state.rallyCount,
      crowdExcitement:
        targetPhase === 'pre-serve'
          ? Math.max(0.2, state.crowdExcitement * 0.78)
          : state.crowdExcitement,
    });
  },

  resetMatch: () => {
    clearPendingReplayTimer();
    phaseBeforeReplay = 'pre-serve';
    resetMutableRefs('player');
    set({
      phase: 'pre-serve',
      score: { ...INITIAL_SCORE },
      rallyCount: 0,
      maxRallyCount: 0,
      lastServeSpeedKmh: 0,
      lastShotSpeedKmh: 0,
      currentSpin: 'topspin',
      spinRpm: 2200,
      chargePower: 0,
      isCharging: false,
      isSlowMo: false,
      timeScale: 1.0,
      crowdExcitement: 0.2,
      lastImpact: null,
    });
  },

  toggleAudioMute: () => set((state) => ({ audioMuted: !state.audioMuted })),

  setAudioVolume: (audioVolume) =>
    set({ audioVolume: Math.max(0, Math.min(1, audioVolume)) }),

  toggleControls: () => set((state) => ({ showControls: !state.showControls })),

  setAttractMode: (isAttractMode) => set({ isAttractMode }),
}));
