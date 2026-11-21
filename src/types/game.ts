import * as THREE from 'three';

export type SurfaceType = 'neon-grass' | 'holographic-hard' | 'liquid-clay';
export type SpinType = 'flat' | 'topspin' | 'slice';
export type CameraMode = 'follow' | 'broadcast' | 'closeup' | 'orbit';
export type AIDifficulty = 'rookie' | 'pro' | 'cyber-god';
export type PointPhase = 'pre-serve' | 'serve-toss' | 'rally' | 'point-over' | 'replay';

export interface SurfaceConfig {
  id: SurfaceType;
  name: string;
  subtitle: string;
  restitution: number;
  friction: number;
  spinMultiplier: number;
  primaryColor: string;
  secondaryColor: string;
  accentColor: string;
  emissiveIntensity: number;
}

export interface ImpactEvent {
  id: number;
  position: [number, number, number];
  velocity: [number, number, number];
  speedKmh: number;
  spin: SpinType;
  type: 'bounce' | 'racket-player' | 'racket-ai' | 'net' | 'out';
  surface: SurfaceType;
  timestamp: number;
}

export interface ReplayFrame {
  time: number;
  ballPos: [number, number, number];
  ballVel: [number, number, number];
  ballSpin: SpinType;
  playerPos: [number, number, number];
  aiPos: [number, number, number];
  playerSwing: number;
  aiSwing: number;
}

export interface ScoreState {
  playerPoints: number; // 0=0, 1=15, 2=30, 3=40, 4=AD
  aiPoints: number;
  playerGames: number;
  aiGames: number;
  playerSets: number;
  aiSets: number;
  server: 'player' | 'ai';
  deuceCount: number;
  lastPointWinner: 'player' | 'ai' | null;
  lastPointReason: string;
}

export interface MutableGameRefs {
  ballPos: THREE.Vector3;
  ballVel: THREE.Vector3;
  ballAngularVel: THREE.Vector3;
  playerPos: THREE.Vector3;
  playerVel: THREE.Vector3;
  aiPos: THREE.Vector3;
  aiVel: THREE.Vector3;
  playerTargetX: number;
  playerSwingProgress: number;
  aiSwingProgress: number;
  predictedLanding: THREE.Vector3;
  trajectoryPoints: THREE.Vector3[];
  replayFrames: ReplayFrame[];
}
