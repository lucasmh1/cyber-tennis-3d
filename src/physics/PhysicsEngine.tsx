import React, { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  AIDifficulty,
  PointPhase,
  SpinType,
  SurfaceConfig,
} from '../types/game';
import { gameRefs, SURFACE_CONFIGS, useGameStore } from '../state/gameStore';

// Official tennis court geometry (meters, net at Z=0)
const COURT_HALF_WIDTH_SINGLES = 4.115;
const COURT_HALF_LENGTH = 11.885;
const SERVICE_LINE_Z = 6.4;
const NET_POST_X = 5.94;
const NET_CENTER_H = 0.914;
const NET_POST_RISE = 0.156; // 0.914 + 0.156 = 1.07m at posts

// Ball aerodynamic & collision constants
const BALL_RADIUS = 0.034;
const GRAVITY = -9.81;
const K_DRAG = 0.0145; // Quadratic air drag
const K_MAGNUS = 0.0019; // Magnus lift/dip coefficient
const SUBSTEPS = 6;
const TRAJECTORY_STEPS = 32;
const MAX_REPLAY_FRAMES = 200;

// Scratch vectors for zero-GC physics integration
const _acc1 = new THREE.Vector3();
const _acc2 = new THREE.Vector3();
const _midVel = new THREE.Vector3();
const _prevPos = new THREE.Vector3();
const _simPos = new THREE.Vector3();
const _simVel = new THREE.Vector3();
const _simOmega = new THREE.Vector3();
const _solvePos = new THREE.Vector3();
const _solveVel = new THREE.Vector3();
const _solveOmega = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _rotAxis = new THREE.Vector3();

interface DifficultyProfile {
  moveSpeed: number;
  reactionDelay: number;
  aimError: number;
  shotSpeedScale: number;
  serveSpeedKmh: number;
  mistakeChance: number;
  aggression: number;
}

const AI_PROFILES: Record<AIDifficulty, DifficultyProfile> = {
  rookie: {
    moveSpeed: 6.1,
    reactionDelay: 0.24,
    aimError: 1.05,
    shotSpeedScale: 0.76,
    serveSpeedKmh: 136,
    mistakeChance: 0.08,
    aggression: 0.25,
  },
  pro: {
    moveSpeed: 8.6,
    reactionDelay: 0.09,
    aimError: 0.45,
    shotSpeedScale: 0.93,
    serveSpeedKmh: 174,
    mistakeChance: 0.025,
    aggression: 0.58,
  },
  'cyber-god': {
    moveSpeed: 11.4,
    reactionDelay: 0.015,
    aimError: 0.14,
    shotSpeedScale: 1.07,
    serveSpeedKmh: 214,
    mistakeChance: 0.004,
    aggression: 0.88,
  },
};

type HitterSide = 'player' | 'ai';
type SwingStyle = 'forehand' | 'backhand' | 'serve';

interface RallySnapshot {
  ballPos: THREE.Vector3;
  ballVel: THREE.Vector3;
  ballAngularVel: THREE.Vector3;
  playerPos: THREE.Vector3;
  aiPos: THREE.Vector3;
  lastHitter: HitterSide | null;
  bounceCount: number;
  isServeShot: boolean;
  serveTargetXSign: 1 | -1;
  activeSpin: SpinType;
}

function getNetHeight(x: number): number {
  const ratio = Math.min(Math.abs(x), NET_POST_X) / NET_POST_X;
  return NET_CENTER_H + NET_POST_RISE * ratio * ratio;
}

/**
 * Computes net ball acceleration from gravity, quadratic drag, and Magnus force (omega x v).
 */
function computeBallAcceleration(
  vel: THREE.Vector3,
  omega: THREE.Vector3,
  out: THREE.Vector3
): THREE.Vector3 {
  const speed = vel.length();
  const dragFactor = -K_DRAG * speed;

  // Magnus cross product: omega x vel
  const mx = omega.y * vel.z - omega.z * vel.y;
  const my = omega.z * vel.x - omega.x * vel.z;
  const mz = omega.x * vel.y - omega.y * vel.x;

  out.set(
    vel.x * dragFactor + K_MAGNUS * mx,
    GRAVITY + vel.y * dragFactor + K_MAGNUS * my,
    vel.z * dragFactor + K_MAGNUS * mz
  );
  return out;
}

/**
 * Midpoint (RK2) step using the shared gravity + drag + Magnus acceleration model.
 */
function stepBallRK2(
  pos: THREE.Vector3,
  vel: THREE.Vector3,
  omega: THREE.Vector3,
  dt: number
): void {
  computeBallAcceleration(vel, omega, _acc1);
  _midVel.copy(vel).addScaledVector(_acc1, dt * 0.5);
  computeBallAcceleration(_midVel, omega, _acc2);

  pos.addScaledVector(_midVel, dt);
  vel.addScaledVector(_acc2, dt);
}

/**
 * Builds angular velocity vector (rad/s) for a given horizontal direction, spin type, and shot pace.
 * Topspin rotates top of ball forward along travel (omega x v -> -Y downward dip).
 */
function buildSpinAngularVel(
  dirX: number,
  dirZ: number,
  spin: SpinType,
  power01: number,
  sidespinBias = 0
): THREE.Vector3 {
  const len = Math.hypot(dirX, dirZ) || 1;
  const hx = dirX / len;
  const hz = dirZ / len;

  // Axis perpendicular to horizontal travel so top of ball moves along (hx, 0, hz)
  const axisX = hz;
  const axisZ = -hx;

  let spinMag = 0;
  let sideOmega = sidespinBias;

  if (spin === 'topspin') {
    spinMag = 210 + power01 * 155; // ~2000 - 3500 RPM
    sideOmega += -dirX * 18;
  } else if (spin === 'slice') {
    spinMag = -(175 + power01 * 135); // Backspin -> upward Magnus lift
    sideOmega += (dirX >= 0 ? -1 : 1) * (45 + power01 * 45);
  } else {
    spinMag = 32 + power01 * 28; // Minimal flat topspin
    sideOmega *= 0.35;
  }

  return new THREE.Vector3(axisX * spinMag, sideOmega, axisZ * spinMag);
}

/**
 * Solves initial launch velocity so a shot with the chosen speed and Magnus spin
 * clears the net cleanly and lands at (targetX, targetZ).
 */
function solveBallisticShot(
  origin: THREE.Vector3,
  targetX: number,
  targetZ: number,
  speedMs: number,
  spin: SpinType,
  power01: number,
  isServe: boolean,
  minNetClearance: number
): { velocity: THREE.Vector3; angularVel: THREE.Vector3 } {
  const dx = targetX - origin.x;
  const dz = targetZ - origin.z;
  const horizDist = Math.hypot(dx, dz) || 1;
  const dirX = dx / horizDist;
  const dirZ = dz / horizDist;

  const angularVel = buildSpinAngularVel(
    dirX,
    dirZ,
    spin,
    power01,
    isServe && spin === 'slice' ? (origin.z > 0 ? -75 : 75) : 0
  );

  // Initial pitch estimate based on spin & serve vs groundstroke
  let pitch = isServe
    ? spin === 'topspin'
      ? -0.025
      : -0.055
    : spin === 'topspin'
      ? 0.24
      : spin === 'slice'
        ? 0.085
        : 0.11;

  let yawOffset = 0;
  const simDt = 0.03;

  let bestValidPitch: number | null = null;
  let bestValidYaw = 0;
  let bestValidError = Infinity;

  const simulateCandidate = (candPitch: number, candYaw: number) => {
    const cosP = Math.cos(candPitch);
    const sinP = Math.sin(candPitch);
    const cosY = Math.cos(candYaw);
    const sinY = Math.sin(candYaw);

    const vxDir = dirX * cosY - dirZ * sinY;
    const vzDir = dirX * sinY + dirZ * cosY;

    _solvePos.copy(origin);
    _solveVel.set(vxDir * speedMs * cosP, speedMs * sinP, vzDir * speedMs * cosP);
    _solveOmega.copy(angularVel);

    let landedX = targetX;
    let landedZ = targetZ;
    let netY = 0;
    let netX = 0;
    let crossedNet = false;
    let landed = false;

    for (let step = 0; step < 96; step++) {
      const prevZ = _solvePos.z;
      const prevY = _solvePos.y;
      const prevX = _solvePos.x;

      stepBallRK2(_solvePos, _solveVel, _solveOmega, simDt);

      if (
        !crossedNet &&
        ((prevZ > 0 && _solvePos.z <= 0) || (prevZ < 0 && _solvePos.z >= 0))
      ) {
        const t = prevZ / (prevZ - _solvePos.z || 0.0001);
        netY = THREE.MathUtils.lerp(prevY, _solvePos.y, t);
        netX = THREE.MathUtils.lerp(prevX, _solvePos.x, t);
        crossedNet = true;
      }

      if (_solvePos.y <= BALL_RADIUS && _solveVel.y < 0) {
        const t = (prevY - BALL_RADIUS) / (prevY - _solvePos.y || 0.0001);
        landedX = THREE.MathUtils.lerp(prevX, _solvePos.x, t);
        landedZ = THREE.MathUtils.lerp(prevZ, _solvePos.z, t);
        landed = true;
        break;
      }
    }

    if (!landed) {
      landedX = _solvePos.x;
      landedZ = _solvePos.z;
    }

    return { landedX, landedZ, netY, netX, crossedNet };
  };

  for (let iter = 0; iter < 12; iter++) {
    const res = simulateCandidate(pitch, yawOffset);

    // Distance error along travel axis
    const errorAlong = (res.landedZ - targetZ) * dirZ + (res.landedX - targetX) * dirX;
    const errorCross = (res.landedX - targetX) * -dirZ + (res.landedZ - targetZ) * dirX;

    const requiredNetY = getNetHeight(res.netX) + minNetClearance;
    const clearsNet = res.crossedNet && res.netY >= requiredNetY;

    if (clearsNet && Math.abs(errorAlong) < bestValidError) {
      bestValidError = Math.abs(errorAlong);
      bestValidPitch = pitch;
      bestValidYaw = yawOffset;
    }

    // Adjust pitch to bring landing to targetZ, strictly respecting net clearance
    if (!clearsNet) {
      const deficit = res.crossedNet ? requiredNetY - res.netY : requiredNetY;
      pitch += Math.min(0.07, Math.max(0.012, deficit * 0.045));
    } else {
      pitch -= THREE.MathUtils.clamp(errorAlong * 0.012, -0.09, 0.09);
    }

    // Compensate for lateral Magnus sidespin drift
    yawOffset -= THREE.MathUtils.clamp(errorCross / horizDist, -0.15, 0.15) * 0.78;
    pitch = THREE.MathUtils.clamp(pitch, -0.28, 0.65);
  }

  // Guard final pitch so late errorAlong step cannot drop the shot back into the net
  let finalCheck = simulateCandidate(pitch, yawOffset);
  let requiredFinalNetY = getNetHeight(finalCheck.netX) + minNetClearance;
  if (!finalCheck.crossedNet || finalCheck.netY < requiredFinalNetY) {
    if (bestValidPitch !== null) {
      pitch = bestValidPitch;
      yawOffset = bestValidYaw;
    } else {
      for (let guard = 0; guard < 10; guard++) {
        pitch = Math.min(0.65, pitch + 0.018);
        finalCheck = simulateCandidate(pitch, yawOffset);
        requiredFinalNetY = getNetHeight(finalCheck.netX) + minNetClearance;
        if (finalCheck.crossedNet && finalCheck.netY >= requiredFinalNetY) {
          break;
        }
      }
    }
  }

  const cosP = Math.cos(pitch);
  const sinP = Math.sin(pitch);
  const cosY = Math.cos(yawOffset);
  const sinY = Math.sin(yawOffset);
  const finalDirX = dirX * cosY - dirZ * sinY;
  const finalDirZ = dirX * sinY + dirZ * cosY;

  return {
    velocity: new THREE.Vector3(
      finalDirX * speedMs * cosP,
      speedMs * sinP,
      finalDirZ * speedMs * cosP
    ),
    angularVel,
  };
}

/**
 * Applies surface-specific bounce restitution, spin kick, and tangential friction.
 */
function applyCourtBounce(
  vel: THREE.Vector3,
  omega: THREE.Vector3,
  spin: SpinType,
  surfaceCfg: SurfaceConfig
): void {
  const horizSpeed = Math.hypot(vel.x, vel.z);
  const dirX = horizSpeed > 0.01 ? vel.x / horizSpeed : 0;
  const dirZ = horizSpeed > 0.01 ? vel.z / horizSpeed : 1;

  // Vertical bounce
  let bounceVy = -vel.y * surfaceCfg.restitution;
  const spinNorm = Math.min(1.2, Math.hypot(omega.x, omega.z) / 280);

  if (spin === 'topspin') {
    bounceVy *= 1 + 0.18 * surfaceCfg.spinMultiplier * spinNorm;
  } else if (spin === 'slice') {
    // Low-friction turf skids very low; clay grips slightly higher
    const skidFactor = Math.max(0.56, 1 - 0.22 * (1.4 - surfaceCfg.friction) * spinNorm);
    bounceVy *= skidFactor;
  }
  vel.y = Math.max(bounceVy, 0.45);

  // Horizontal friction & forward/backward spin kick
  let horizScale = 1 - 0.16 * surfaceCfg.friction;
  if (spin === 'topspin') {
    horizScale = 1 - 0.1 * surfaceCfg.friction + 0.11 * surfaceCfg.spinMultiplier * spinNorm;
  } else if (spin === 'slice') {
    // Grass keeps slice sliding fast; clay checks it noticeably
    horizScale = 1 - 0.34 * surfaceCfg.friction;
  }

  horizScale = THREE.MathUtils.clamp(horizScale, 0.58, 1.06);
  vel.x *= horizScale;
  vel.z *= horizScale;

  // Lateral kick from sidespin (omega.y)
  const lateralKick = omega.y * 0.0065 * surfaceCfg.spinMultiplier;
  vel.x += -dirZ * lateralKick;
  vel.z += dirX * lateralKick;

  // Spin decays after ground contact
  omega.multiplyScalar(0.62);
}

/**
 * Computes live 32-step Magnus trajectory and updates gameRefs.trajectoryPoints & predictedLanding.
 */
function updateTrajectoryPreview(): void {
  _simPos.copy(gameRefs.ballPos);
  _simVel.copy(gameRefs.ballVel);
  _simOmega.copy(gameRefs.ballAngularVel);

  const points = gameRefs.trajectoryPoints;
  points.length = 0;
  points.push(_simPos.clone());

  // Adaptive preview step covers fast drives and high lobs cleanly
  const dt = _simVel.y > 4 ? 0.048 : 0.036;
  let foundLanding = false;

  for (let i = 0; i < TRAJECTORY_STEPS; i++) {
    const prevY = _simPos.y;
    const prevX = _simPos.x;
    const prevZ = _simPos.z;

    stepBallRK2(_simPos, _simVel, _simOmega, dt);

    if (_simPos.y <= BALL_RADIUS && _simVel.y < 0) {
      const t = (prevY - BALL_RADIUS) / (prevY - _simPos.y || 0.0001);
      const landX = THREE.MathUtils.lerp(prevX, _simPos.x, t);
      const landZ = THREE.MathUtils.lerp(prevZ, _simPos.z, t);
      gameRefs.predictedLanding.set(landX, BALL_RADIUS, landZ);
      points.push(new THREE.Vector3(landX, BALL_RADIUS, landZ));
      foundLanding = true;
      break;
    }

    points.push(_simPos.clone());
  }

  // Continue silently past 32 visible points if a high lob hasn't landed yet
  if (!foundLanding) {
    for (let i = 0; i < 48; i++) {
      const prevY = _simPos.y;
      const prevX = _simPos.x;
      const prevZ = _simPos.z;
      stepBallRK2(_simPos, _simVel, _simOmega, dt);
      if (_simPos.y <= BALL_RADIUS && _simVel.y < 0) {
        const t = (prevY - BALL_RADIUS) / (prevY - _simPos.y || 0.0001);
        gameRefs.predictedLanding.set(
          THREE.MathUtils.lerp(prevX, _simPos.x, t),
          BALL_RADIUS,
          THREE.MathUtils.lerp(prevZ, _simPos.z, t)
        );
        foundLanding = true;
        break;
      }
    }
    if (!foundLanding) {
      gameRefs.predictedLanding.set(_simPos.x, BALL_RADIUS, _simPos.z);
    }
  }
}

interface CyberAthleteProps {
  side: HitterSide;
  swingStyleRef: React.MutableRefObject<SwingStyle>;
  chargeRef: React.MutableRefObject<{ power: number; active: boolean }>;
  spinRef: React.MutableRefObject<SpinType>;
}

/**
 * Articulated cyberpunk tennis athlete with visor armor, animated stride, and neon-strung racket.
 */
const CyberAthlete: React.FC<CyberAthleteProps> = ({
  side,
  swingStyleRef,
  chargeRef,
  spinRef,
}) => {
  const isPlayer = side === 'player';
  const rootRef = useRef<THREE.Group>(null);
  const hipsRef = useRef<THREE.Group>(null);
  const torsoRef = useRef<THREE.Group>(null);
  const leftLegRef = useRef<THREE.Group>(null);
  const rightLegRef = useRef<THREE.Group>(null);
  const leftArmRef = useRef<THREE.Group>(null);
  const rightShoulderRef = useRef<THREE.Group>(null);
  const forearmRef = useRef<THREE.Group>(null);
  const stringMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const auraMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const stridePhaseRef = useRef(0);

  const palette = useMemo(() => {
    if (isPlayer) {
      return {
        armor: '#0c1324',
        accent: '#00f0ff',
        visor: '#00ffff',
        secondary: '#a3ff00',
      };
    }
    return {
      armor: '#14091c',
      accent: '#ff006e',
      visor: '#ff2a85',
      secondary: '#b829ff',
    };
  }, [isPlayer]);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const pos = isPlayer ? gameRefs.playerPos : gameRefs.aiPos;
    const vel = isPlayer ? gameRefs.playerVel : gameRefs.aiVel;
    const swing = isPlayer
      ? gameRefs.playerSwingProgress
      : gameRefs.aiSwingProgress;

    if (!rootRef.current) return;

    // Root placement and lean into running direction
    rootRef.current.position.copy(pos);
    const baseYaw = isPlayer ? 0 : Math.PI;
    const localVx = isPlayer ? vel.x : -vel.x;
    const localVz = isPlayer ? vel.z : -vel.z;

    rootRef.current.rotation.y = baseYaw - THREE.MathUtils.clamp(localVx * 0.035, -0.25, 0.25);
    rootRef.current.rotation.z = THREE.MathUtils.clamp(-localVx * 0.025, -0.22, 0.22);
    rootRef.current.rotation.x = THREE.MathUtils.clamp(localVz * 0.02, -0.15, 0.15);

    // Running stride animation
    const speed = Math.hypot(vel.x, vel.z);
    if (speed > 0.35) {
      stridePhaseRef.current += dt * (4.2 + speed * 1.15);
    }
    const strideAmp = THREE.MathUtils.clamp(speed / 7.5, 0, 1) * 0.68;
    const sSin = Math.sin(stridePhaseRef.current);

    if (leftLegRef.current && rightLegRef.current && hipsRef.current) {
      leftLegRef.current.rotation.x = sSin * strideAmp;
      rightLegRef.current.rotation.x = -sSin * strideAmp;
      hipsRef.current.position.y =
        0.92 + Math.abs(sSin) * strideAmp * 0.08 - (chargeRef.current.active ? 0.06 : 0);
    }

    // Swing & charge kinematics
    const style = swingStyleRef.current;
    const charge = chargeRef.current.active ? chargeRef.current.power : 0;

    if (hipsRef.current && swing > 0.001 && style === 'serve') {
      hipsRef.current.position.y += Math.sin(swing * Math.PI) * 0.28;
    }

    let torsoYaw = 0;
    let torsoPitch = 0.08;
    let shoulderX = 0.35;
    let shoulderY = 0;
    let shoulderZ = 0.18;
    let elbowX = 1.05;
    let offArmX = 0.45;

    if (swing > 0.001) {
      // Smooth ease curve through contact at ~0.45
      const p = swing;
      if (style === 'serve') {
        torsoPitch = THREE.MathUtils.lerp(-0.24, 0.32, p);
        torsoYaw = THREE.MathUtils.lerp(-0.55, 0.45, p);
        shoulderX = THREE.MathUtils.lerp(2.85, 0.35, Math.min(1, p * 1.25));
        shoulderY = THREE.MathUtils.lerp(-0.15, 0.35, p);
        shoulderZ = THREE.MathUtils.lerp(0.35, -0.35, p);
        elbowX = THREE.MathUtils.lerp(0.45, 0.15, p);
        offArmX = THREE.MathUtils.lerp(2.1, 0.25, p);
      } else if (style === 'backhand') {
        torsoYaw = THREE.MathUtils.lerp(0.75, -0.75, p);
        torsoPitch = 0.14;
        shoulderX = THREE.MathUtils.lerp(0.25, 1.35, p);
        shoulderY = THREE.MathUtils.lerp(0.35, -0.45, p);
        shoulderZ = THREE.MathUtils.lerp(-0.75, 0.85, p);
        elbowX = THREE.MathUtils.lerp(0.85, 0.25, p);
      } else {
        // Forehand whip low-to-high
        torsoYaw = THREE.MathUtils.lerp(-0.75, 0.85, p);
        torsoPitch = 0.12;
        shoulderX = THREE.MathUtils.lerp(-0.35, 1.35, p);
        shoulderY = THREE.MathUtils.lerp(-0.4, 0.75, p);
        shoulderZ = THREE.MathUtils.lerp(0.75, -0.55, p);
        elbowX = THREE.MathUtils.lerp(0.75, 0.45, p);
      }
    } else if (charge > 0.01) {
      // Coil backswing while charging shot
      torsoYaw = -0.68 * charge;
      shoulderX = THREE.MathUtils.lerp(0.35, -0.35, charge);
      shoulderY = -0.35 * charge;
      shoulderZ = THREE.MathUtils.lerp(0.2, 0.78, charge);
      elbowX = 0.85;
    } else {
      // Athletic ready stance
      const readyBob = Math.sin(performance.now() * 0.005 + (isPlayer ? 0 : 2)) * 0.04;
      shoulderX = 0.35 + readyBob;
    }

    if (torsoRef.current) {
      torsoRef.current.rotation.y = THREE.MathUtils.lerp(
        torsoRef.current.rotation.y,
        torsoYaw,
        0.38
      );
      torsoRef.current.rotation.x = THREE.MathUtils.lerp(
        torsoRef.current.rotation.x,
        torsoPitch,
        0.35
      );
    }

    if (rightShoulderRef.current && forearmRef.current) {
      rightShoulderRef.current.rotation.set(shoulderX, shoulderY, shoulderZ);
      forearmRef.current.rotation.x = elbowX;
    }

    if (leftArmRef.current) {
      leftArmRef.current.rotation.x = offArmX;
    }

    // Racket string glow pulse by spin & swing intensity
    if (stringMatRef.current) {
      const spin = spinRef.current;
      const targetColor =
        isPlayer
          ? spin === 'topspin'
            ? '#ff3399'
            : spin === 'slice'
              ? '#00f0ff'
              : '#ccff00'
          : palette.accent;
      stringMatRef.current.color.set(targetColor);
      stringMatRef.current.emissive.set(targetColor);
      stringMatRef.current.emissiveIntensity =
        1.5 + (swing > 0 ? 2.4 : 0) + charge * 1.8;
    }

    if (auraMatRef.current) {
      auraMatRef.current.opacity = 0.28 + charge * 0.45 + (swing > 0 ? 0.35 : 0);
    }
  });

  return (
    <group ref={rootRef}>
      {/* Ground Holo-Foot Ring */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.015, 0]}>
        <ringGeometry args={[0.42, 0.52, 32]} />
        <meshBasicMaterial
          ref={auraMatRef}
          color={palette.accent}
          transparent
          opacity={0.3}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>

      <group ref={hipsRef} position={[0, 0.92, 0]}>
        {/* Pelvis */}
        <mesh castShadow>
          <boxGeometry args={[0.36, 0.16, 0.22]} />
          <meshStandardMaterial color={palette.armor} metalness={0.8} roughness={0.25} />
        </mesh>

        {/* Left Leg */}
        <group ref={leftLegRef} position={[-0.12, -0.05, 0]}>
          <mesh position={[0, -0.22, 0]} castShadow>
            <capsuleGeometry args={[0.075, 0.3, 6, 12]} />
            <meshStandardMaterial color={palette.armor} metalness={0.75} roughness={0.3} />
          </mesh>
          <mesh position={[0, -0.58, 0]} castShadow>
            <capsuleGeometry args={[0.06, 0.34, 6, 12]} />
            <meshStandardMaterial color="#182238" metalness={0.8} roughness={0.25} />
          </mesh>
          {/* Neon Knee Strip */}
          <mesh position={[0, -0.4, 0.055]}>
            <boxGeometry args={[0.07, 0.05, 0.03]} />
            <meshStandardMaterial
              color={palette.accent}
              emissive={palette.accent}
              emissiveIntensity={2.2}
              toneMapped={false}
            />
          </mesh>
          {/* Cyber Boot */}
          <mesh position={[0, -0.82, -0.04]} castShadow>
            <boxGeometry args={[0.12, 0.1, 0.24]} />
            <meshStandardMaterial color="#090d18" metalness={0.9} roughness={0.2} />
          </mesh>
          <mesh position={[0, -0.865, -0.04]}>
            <boxGeometry args={[0.13, 0.025, 0.25]} />
            <meshStandardMaterial
              color={palette.secondary}
              emissive={palette.secondary}
              emissiveIntensity={2.0}
              toneMapped={false}
            />
          </mesh>
        </group>

        {/* Right Leg */}
        <group ref={rightLegRef} position={[0.12, -0.05, 0]}>
          <mesh position={[0, -0.22, 0]} castShadow>
            <capsuleGeometry args={[0.075, 0.3, 6, 12]} />
            <meshStandardMaterial color={palette.armor} metalness={0.75} roughness={0.3} />
          </mesh>
          <mesh position={[0, -0.58, 0]} castShadow>
            <capsuleGeometry args={[0.06, 0.34, 6, 12]} />
            <meshStandardMaterial color="#182238" metalness={0.8} roughness={0.25} />
          </mesh>
          <mesh position={[0, -0.4, 0.055]}>
            <boxGeometry args={[0.07, 0.05, 0.03]} />
            <meshStandardMaterial
              color={palette.accent}
              emissive={palette.accent}
              emissiveIntensity={2.2}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, -0.82, -0.04]} castShadow>
            <boxGeometry args={[0.12, 0.1, 0.24]} />
            <meshStandardMaterial color="#090d18" metalness={0.9} roughness={0.2} />
          </mesh>
          <mesh position={[0, -0.865, -0.04]}>
            <boxGeometry args={[0.13, 0.025, 0.25]} />
            <meshStandardMaterial
              color={palette.secondary}
              emissive={palette.secondary}
              emissiveIntensity={2.0}
              toneMapped={false}
            />
          </mesh>
        </group>

        {/* Upper Torso */}
        <group ref={torsoRef} position={[0, 0.1, 0]}>
          <mesh position={[0, 0.26, 0]} castShadow>
            <boxGeometry args={[0.42, 0.48, 0.24]} />
            <meshStandardMaterial color={palette.armor} metalness={0.82} roughness={0.22} />
          </mesh>
          {/* Glowing Spine & Chest Reactor */}
          <mesh position={[0, 0.3, -0.125]}>
            <boxGeometry args={[0.12, 0.22, 0.03]} />
            <meshStandardMaterial
              color={palette.accent}
              emissive={palette.accent}
              emissiveIntensity={2.6}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0, 0.28, 0.128]}>
            <boxGeometry args={[0.06, 0.36, 0.025]} />
            <meshStandardMaterial
              color={palette.secondary}
              emissive={palette.secondary}
              emissiveIntensity={2.3}
              toneMapped={false}
            />
          </mesh>

          {/* Shoulder Pauldrons */}
          <mesh position={[-0.27, 0.45, 0]} rotation={[0, 0, 0.25]} castShadow>
            <boxGeometry args={[0.16, 0.1, 0.26]} />
            <meshStandardMaterial color="#182236" metalness={0.85} roughness={0.2} />
          </mesh>
          <mesh position={[0.27, 0.45, 0]} rotation={[0, 0, -0.25]} castShadow>
            <boxGeometry args={[0.16, 0.1, 0.26]} />
            <meshStandardMaterial color="#182236" metalness={0.85} roughness={0.2} />
          </mesh>
          <mesh position={[-0.28, 0.49, 0]} rotation={[0, 0, 0.25]}>
            <boxGeometry args={[0.14, 0.025, 0.27]} />
            <meshStandardMaterial
              color={palette.accent}
              emissive={palette.accent}
              emissiveIntensity={2.4}
              toneMapped={false}
            />
          </mesh>
          <mesh position={[0.28, 0.49, 0]} rotation={[0, 0, -0.25]}>
            <boxGeometry args={[0.14, 0.025, 0.27]} />
            <meshStandardMaterial
              color={palette.accent}
              emissive={palette.accent}
              emissiveIntensity={2.4}
              toneMapped={false}
            />
          </mesh>

          {/* Head & Cyber Visor */}
          <group position={[0, 0.64, 0]}>
            <mesh castShadow>
              <sphereGeometry args={[0.135, 16, 16]} />
              <meshStandardMaterial color={palette.armor} metalness={0.85} roughness={0.18} />
            </mesh>
            {/* Glowing Visor Wrap */}
            <mesh position={[0, 0.02, -0.075]} rotation={[0.08, 0, 0]}>
              <boxGeometry args={[0.23, 0.065, 0.14]} />
              <meshStandardMaterial
                color={palette.visor}
                emissive={palette.visor}
                emissiveIntensity={3.0}
                toneMapped={false}
              />
            </mesh>
          </group>

          {/* Left Arm (Balance / Toss Arm) */}
          <group ref={leftArmRef} position={[-0.28, 0.42, 0]}>
            <mesh position={[0, -0.14, 0]} castShadow>
              <capsuleGeometry args={[0.05, 0.22, 6, 10]} />
              <meshStandardMaterial color={palette.armor} metalness={0.78} roughness={0.28} />
            </mesh>
            <mesh position={[0, -0.38, -0.06]} rotation={[-0.45, 0, 0]} castShadow>
              <capsuleGeometry args={[0.042, 0.22, 6, 10]} />
              <meshStandardMaterial color="#182238" metalness={0.82} roughness={0.22} />
            </mesh>
          </group>

          {/* Right Swinging Racket Arm */}
          <group ref={rightShoulderRef} position={[0.28, 0.42, 0]}>
            <mesh position={[0, -0.14, 0]} castShadow>
              <capsuleGeometry args={[0.052, 0.22, 6, 10]} />
              <meshStandardMaterial color={palette.armor} metalness={0.78} roughness={0.28} />
            </mesh>
            <group ref={forearmRef} position={[0, -0.28, 0]}>
              <mesh position={[0, -0.13, 0]} castShadow>
                <capsuleGeometry args={[0.044, 0.22, 6, 10]} />
                <meshStandardMaterial color="#1b263d" metalness={0.85} roughness={0.2} />
              </mesh>

              {/* Futuristic Holographic Tennis Racket */}
              <group position={[0, -0.28, -0.04]} rotation={[-Math.PI * 0.55, 0, 0]}>
                {/* Handle */}
                <mesh position={[0, 0.12, 0]} castShadow>
                  <cylinderGeometry args={[0.018, 0.022, 0.24, 10]} />
                  <meshStandardMaterial color="#090c14" metalness={0.9} roughness={0.2} />
                </mesh>
                {/* Throat */}
                <mesh position={[-0.04, 0.28, 0]} rotation={[0, 0, -0.32]}>
                  <cylinderGeometry args={[0.011, 0.013, 0.14, 8]} />
                  <meshStandardMaterial color="#1d2b44" metalness={0.9} roughness={0.2} />
                </mesh>
                <mesh position={[0.04, 0.28, 0]} rotation={[0, 0, 0.32]}>
                  <cylinderGeometry args={[0.011, 0.013, 0.14, 8]} />
                  <meshStandardMaterial color="#1d2b44" metalness={0.9} roughness={0.2} />
                </mesh>
                {/* Outer Glowing Rim Hoop */}
                <mesh position={[0, 0.49, 0]} scale={[0.85, 1.12, 1]}>
                  <torusGeometry args={[0.175, 0.014, 10, 28]} />
                  <meshStandardMaterial
                    color={palette.accent}
                    emissive={palette.accent}
                    emissiveIntensity={2.0}
                    metalness={0.7}
                    roughness={0.2}
                    toneMapped={false}
                  />
                </mesh>
                {/* Neon Strung Mesh Plane */}
                <mesh position={[0, 0.49, 0]} scale={[0.82, 1.08, 1]}>
                  <circleGeometry args={[0.165, 24]} />
                  <meshStandardMaterial
                    ref={stringMatRef}
                    color={palette.accent}
                    emissive={palette.accent}
                    emissiveIntensity={1.6}
                    transparent
                    opacity={0.42}
                    wireframe
                    side={THREE.DoubleSide}
                    toneMapped={false}
                  />
                </mesh>
              </group>
            </group>
          </group>
        </group>
      </group>
    </group>
  );
};

/**
 * Spinning neon tennis ball with inner radiant core and rotating seam shell.
 */
const CyberBall: React.FC<{ activeSpinRef: React.MutableRefObject<SpinType> }> = ({
  activeSpinRef,
}) => {
  const groupRef = useRef<THREE.Group>(null);
  const seamRef = useRef<THREE.Mesh>(null);
  const coreMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const seamMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame((_, delta) => {
    const dt = Math.min(delta, 0.05);
    const timeScale = useGameStore.getState().timeScale;
    const phase = useGameStore.getState().phase;

    if (!groupRef.current) return;
    groupRef.current.position.copy(gameRefs.ballPos);

    // Rotate seam shell by live ballAngularVel (scaled by timeScale during replay/slow-mo)
    if (seamRef.current) {
      const spinSpeed = gameRefs.ballAngularVel.length();
      if (spinSpeed > 0.1) {
        _rotAxis.copy(gameRefs.ballAngularVel).normalize();
        const stepAngle = spinSpeed * dt * (phase === 'replay' ? 0.28 : timeScale);
        _tmpQuat.setFromAxisAngle(_rotAxis, stepAngle);
        seamRef.current.quaternion.premultiply(_tmpQuat);
      } else if (gameRefs.ballVel.lengthSq() > 0.2) {
        seamRef.current.rotation.x += dt * 4;
        seamRef.current.rotation.y += dt * 3;
      }
    }

    const spin =
      phase === 'pre-serve'
        ? useGameStore.getState().currentSpin
        : activeSpinRef.current;
    const color =
      spin === 'topspin'
        ? '#ff4d00'
        : spin === 'slice'
          ? '#00f6ff'
          : '#d9ff00';

    if (coreMatRef.current) {
      coreMatRef.current.color.set(color);
      coreMatRef.current.emissive.set(color);
    }
    if (seamMatRef.current) {
      seamMatRef.current.color.set('#ffffff');
    }
  });

  return (
    <group ref={groupRef}>
      <mesh castShadow>
        <sphereGeometry args={[0.048, 18, 18]} />
        <meshStandardMaterial
          ref={coreMatRef}
          color="#ff4d00"
          emissive="#ff4d00"
          emissiveIntensity={3.2}
          roughness={0.25}
          toneMapped={false}
        />
      </mesh>
      <mesh ref={seamRef}>
        <icosahedronGeometry args={[0.062, 1]} />
        <meshBasicMaterial
          ref={seamMatRef}
          color="#ffffff"
          wireframe
          transparent
          opacity={0.72}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
};

/**
 * Glowing holographic target reticle on AI side responding to player mouse/stick aim.
 */
const AimTargetChevron: React.FC<{
  aimTargetRef: React.MutableRefObject<THREE.Vector3>;
}> = ({ aimTargetRef }) => {
  const groupRef = useRef<THREE.Group>(null);
  const ringMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const chevronMatRef = useRef<THREE.MeshBasicMaterial>(null);

  useFrame((state) => {
    const store = useGameStore.getState();
    if (!groupRef.current) return;

    const visible =
      !store.isAttractMode &&
      store.phase !== 'replay' &&
      store.phase !== 'point-over';
    groupRef.current.visible = visible;
    if (!visible) return;

    groupRef.current.position.set(
      aimTargetRef.current.x,
      0.025,
      aimTargetRef.current.z
    );
    const pulse = 1 + Math.sin(state.clock.elapsedTime * 6) * 0.1;
    groupRef.current.scale.set(pulse, 1, pulse);

    const col =
      store.currentSpin === 'topspin'
        ? '#ff2a85'
        : store.currentSpin === 'slice'
          ? '#00f0ff'
          : '#ccff00';
    if (ringMatRef.current) ringMatRef.current.color.set(col);
    if (chevronMatRef.current) chevronMatRef.current.color.set(col);
  });

  return (
    <group ref={groupRef} rotation={[-Math.PI / 2, 0, 0]}>
      <mesh>
        <ringGeometry args={[0.32, 0.42, 24]} />
        <meshBasicMaterial
          ref={ringMatRef}
          color="#ff2a85"
          transparent
          opacity={0.68}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
      <mesh position={[0, 0.56, 0]}>
        <circleGeometry args={[0.16, 3]} />
        <meshBasicMaterial
          ref={chevronMatRef}
          color="#ff2a85"
          transparent
          opacity={0.85}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
          toneMapped={false}
        />
      </mesh>
    </group>
  );
};

export const PhysicsEngine: React.FC = () => {
  const { gl, pointer } = useThree();

  // Internal mutable simulation state refs (never trigger React re-renders)
  const keysRef = useRef<Record<string, boolean>>({});
  const lastManualMoveTimeRef = useRef(0);
  const chargeActiveRef = useRef(false);
  const chargePowerRef = useRef(0);
  const chargeStartTimeRef = useRef(0);
  const activeSwingWindowRef = useRef(0); // Buffered hit window when player triggers swing
  const playerSwingTriggerRef = useRef(false);
  const aiSwingTriggerRef = useRef(false);

  const playerSwingStyleRef = useRef<SwingStyle>('forehand');
  const aiSwingStyleRef = useRef<SwingStyle>('forehand');
  const playerChargeStateRef = useRef({ power: 0, active: false });
  const aiChargeStateRef = useRef({ power: 0, active: false });

  const lastHitterRef = useRef<HitterSide | null>(null);
  const bounceCountRef = useRef(0);
  const isServeShotRef = useRef(false);
  const serveTargetXSignRef = useRef<1 | -1>(-1);
  const activeBallSpinRef = useRef<SpinType>('topspin');
  const aiSpinRef = useRef<SpinType>('topspin');
  const playerSpinDisplayRef = useRef<SpinType>('topspin');

  const serveTossTimerRef = useRef(0);
  const serveTapReleasedRef = useRef(false);
  const aiServeDelayRef = useRef(0);
  const pointOverTimerRef = useRef(0);
  const rallyTimeRef = useRef(0);
  const aiReactionTimerRef = useRef(0);
  const netCooldownRef = useRef(0);
  const gamepadPrevButtonsRef = useRef<boolean[]>([false, false, false, false]);

  const aimTargetRef = useRef(new THREE.Vector3(0, 0.025, -9.5));
  const pointerRef = useRef(new THREE.Vector2(0, 0));
  const prevPhaseRef = useRef<PointPhase | null>(null);
  const prevMatchResetCheckRef = useRef<number | null>(null);
  const replaySnapshotRef = useRef<RallySnapshot | null>(null);

  // Shared helper: initialize positions cleanly at start of any point
  const setupPreServe = () => {
    const { score } = useGameStore.getState();
    const isDeuceCourt = (score.playerPoints + score.aiPoints) % 2 === 0;
    const isPlayerServe = score.server === 'player';

    // Deuce court: server stands right from their own POV (+X for player, -X for AI)
    const playerServeX = isDeuceCourt ? 1.45 : -1.45;
    const aiServeX = isDeuceCourt ? -1.45 : 1.45;

    if (isPlayerServe) {
      gameRefs.playerPos.set(playerServeX, 0, 11.95);
      gameRefs.aiPos.set(isDeuceCourt ? -2.25 : 2.25, 0, -11.65);
      gameRefs.ballPos.set(playerServeX - 0.15, 1.05, 11.6);
      serveTargetXSignRef.current = isDeuceCourt ? -1 : 1;
    } else {
      gameRefs.aiPos.set(aiServeX, 0, -11.95);
      gameRefs.playerPos.set(isDeuceCourt ? 2.25 : -2.25, 0, 11.65);
      gameRefs.ballPos.set(aiServeX + 0.15, 1.05, -11.6);
      serveTargetXSignRef.current = isDeuceCourt ? 1 : -1;
    }

    gameRefs.playerVel.set(0, 0, 0);
    gameRefs.aiVel.set(0, 0, 0);
    gameRefs.ballVel.set(0, 0, 0);
    gameRefs.ballAngularVel.set(0, 0, 0);
    gameRefs.playerSwingProgress = 0;
    gameRefs.aiSwingProgress = 0;
    gameRefs.trajectoryPoints.length = 0;
    gameRefs.predictedLanding.set(0, BALL_RADIUS, 0);
    gameRefs.replayFrames = [];

    lastHitterRef.current = null;
    bounceCountRef.current = 0;
    isServeShotRef.current = false;
    serveTossTimerRef.current = 0;
    serveTapReleasedRef.current = false;
    aiServeDelayRef.current = 0;
    pointOverTimerRef.current = 0;
    rallyTimeRef.current = 0;
    aiReactionTimerRef.current = 0;
    netCooldownRef.current = 0;
    activeSwingWindowRef.current = 0;
    chargeActiveRef.current = false;
    chargePowerRef.current = 0;
    playerChargeStateRef.current = { power: 0, active: false };
    aiChargeStateRef.current = { power: 0, active: false };
    playerSwingTriggerRef.current = false;
    aiSwingTriggerRef.current = false;
  };

  // Initial setup on mount
  useEffect(() => {
    setupPreServe();
    prevPhaseRef.current = useGameStore.getState().phase;
  }, []);

  // Input listeners: Keyboard & Canvas Pointer
  useEffect(() => {
    const startCharge = (spinOverride?: SpinType) => {
      const store = useGameStore.getState();
      if (store.isAttractMode) return;
      if (store.phase === 'replay' || store.phase === 'point-over') return;

      if (spinOverride) {
        store.setCurrentSpin(spinOverride);
      }

      if (store.phase === 'pre-serve') {
        if (store.score.server !== 'player') return;
        // Initiate player serve ball toss
        store.setPhase('serve-toss');
        serveTossTimerRef.current = 0;
        serveTapReleasedRef.current = false;
        gameRefs.ballPos.set(
          gameRefs.playerPos.x - 0.12,
          1.25,
          gameRefs.playerPos.z - 0.32
        );
        gameRefs.ballVel.set(0, 5.95, 0);
        gameRefs.ballAngularVel.set(0, 0, 0);
        playerSwingStyleRef.current = 'serve';
        chargeActiveRef.current = true;
        chargePowerRef.current = 0.08;
        chargeStartTimeRef.current = performance.now();
        store.setCharge(0.08, true);
        return;
      }

      if (store.phase === 'serve-toss') {
        if (store.score.server === 'player' && serveTossTimerRef.current > 0.12) {
          // Second tap during toss triggers instant smash
          executePlayerServe();
        }
        return;
      }

      // Rally charge
      chargeActiveRef.current = true;
      chargePowerRef.current = Math.max(chargePowerRef.current, 0.12);
      chargeStartTimeRef.current = performance.now();
      store.setCharge(chargePowerRef.current, true);
    };

    const releaseCharge = () => {
      const store = useGameStore.getState();
      if (store.isAttractMode) return;
      if (!chargeActiveRef.current) return;

      const heldSec = (performance.now() - chargeStartTimeRef.current) / 1000;
      chargeActiveRef.current = false;

      if (store.phase === 'serve-toss' && store.score.server === 'player') {
        if (heldSec < 0.17 && gameRefs.ballPos.y < 1.85) {
          // Quick tap-to-toss: wait for second tap or peak auto-smash
          serveTapReleasedRef.current = true;
          store.setCharge(chargePowerRef.current, false);
        } else {
          executePlayerServe();
        }
        return;
      }

      if (store.phase === 'rally') {
        activeSwingWindowRef.current = 0.24;
        playerSwingTriggerRef.current = true;
        gameRefs.playerSwingProgress = 0.02;
        playerSwingStyleRef.current =
          gameRefs.ballPos.x >= gameRefs.playerPos.x - 0.1 ? 'forehand' : 'backhand';
        store.setCharge(chargePowerRef.current, false);
      } else {
        store.setCharge(0, false);
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        return;
      }

      if (
        e.code === 'Space' ||
        e.code === 'ArrowUp' ||
        e.code === 'ArrowDown' ||
        e.code === 'ArrowLeft' ||
        e.code === 'ArrowRight'
      ) {
        e.preventDefault();
      }

      if (e.repeat) return;
      keysRef.current[e.code] = true;

      const store = useGameStore.getState();
      if (e.code === 'Digit1' || e.code === 'KeyJ') {
        store.setCurrentSpin('topspin');
      } else if (e.code === 'Digit2' || e.code === 'KeyK') {
        store.setCurrentSpin('slice');
      } else if (e.code === 'Digit3' || e.code === 'KeyL') {
        store.setCurrentSpin('flat');
      } else if (e.code === 'Space') {
        startCharge();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      keysRef.current[e.code] = false;
      if (e.code === 'Space') {
        releaseCharge();
      }
    };

    const dom = gl.domElement;
    const onMouseDown = (e: MouseEvent) => {
      const store = useGameStore.getState();
      if (store.cameraMode === 'orbit') return;

      if (e.button === 1) e.preventDefault();

      if (e.button === 0) {
        startCharge('topspin');
      } else if (e.button === 2) {
        startCharge('slice');
      } else if (e.button === 1) {
        startCharge('flat');
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      const store = useGameStore.getState();
      if (store.cameraMode === 'orbit') return;
      if (e.button === 0 || e.button === 1 || e.button === 2) {
        releaseCharge();
      }
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    dom.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    dom.addEventListener('contextmenu', onContextMenu);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      dom.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      dom.removeEventListener('contextmenu', onContextMenu);
    };
  }, [gl]);

  // Execute serve from either player or autopilot
  const executeServeShot = (
    serverSide: HitterSide,
    spin: SpinType,
    power01: number,
    targetX: number,
    targetZ: number,
    speedKmh: number
  ) => {
    const store = useGameStore.getState();
    const origin = gameRefs.ballPos.clone();
    origin.y = Math.max(origin.y, 2.58);
    gameRefs.ballPos.copy(origin);

    const solved = solveBallisticShot(
      origin,
      targetX,
      targetZ,
      speedKmh / 3.6,
      spin,
      power01,
      true,
      0.1
    );

    gameRefs.ballVel.copy(solved.velocity);
    gameRefs.ballAngularVel.copy(solved.angularVel);

    activeBallSpinRef.current = spin;
    lastHitterRef.current = serverSide;
    bounceCountRef.current = 0;
    isServeShotRef.current = true;
    netCooldownRef.current = 0.08;
    aiReactionTimerRef.current = 0;

    if (serverSide === 'player') {
      playerSwingStyleRef.current = 'serve';
      gameRefs.playerSwingProgress = 0.25;
      playerSwingTriggerRef.current = true;
    } else {
      aiSwingStyleRef.current = 'serve';
      gameRefs.aiSwingProgress = 0.25;
      aiSwingTriggerRef.current = true;
    }

    // recordImpact MUST run before incrementRally so store.rallyCount === 0 records serve speed
    store.recordImpact({
      position: [origin.x, origin.y, origin.z],
      velocity: [solved.velocity.x, solved.velocity.y, solved.velocity.z],
      speedKmh,
      spin,
      type: serverSide === 'player' ? 'racket-player' : 'racket-ai',
      surface: store.surface,
    });
    store.incrementRally(speedKmh);
    store.setCharge(0, false);
    chargeActiveRef.current = false;
    chargePowerRef.current = 0;
    store.setPhase('rally');
  };

  const executePlayerServe = () => {
    const store = useGameStore.getState();
    if (store.phase !== 'serve-toss' || store.score.server !== 'player') return;

    const power = THREE.MathUtils.clamp(chargePowerRef.current, 0.2, 1);
    const spin = store.currentSpin;

    // Height timing bonus around optimal apex (~2.78m)
    const heightDelta = Math.abs(gameRefs.ballPos.y - 2.78);
    const timingQuality = THREE.MathUtils.clamp(1 - heightDelta * 0.45, 0.4, 1);

    const baseSpeed =
      spin === 'flat' ? 172 : spin === 'topspin' ? 148 : 140;
    const maxBonus = spin === 'flat' ? 53 : 46;
    const speedKmh = Math.min(225, baseSpeed + maxBonus * power * timingQuality);

    // Aim cleanly inside the diagonal service box
    const boxSign = serveTargetXSignRef.current;
    const wideBias = THREE.MathUtils.clamp(pointerRef.current.x * boxSign, -1, 1);
    const targetX = boxSign * THREE.MathUtils.lerp(0.65, 3.65, (wideBias + 1) * 0.5);
    const depthAlpha = THREE.MathUtils.clamp((pointerRef.current.y + 1) * 0.5, 0, 1);
    const targetZ = -THREE.MathUtils.lerp(4.95, 6.12, depthAlpha);

    executeServeShot('player', spin, power, targetX, targetZ, speedKmh);
  };

  const strikeBall = (
    hitter: HitterSide,
    spin: SpinType,
    power01: number,
    targetX: number,
    targetZ: number,
    speedKmh: number
  ) => {
    const store = useGameStore.getState();
    const isPlayer = hitter === 'player';
    const actorPos = isPlayer ? gameRefs.playerPos : gameRefs.aiPos;
    const origin = gameRefs.ballPos.clone();
    origin.y = Math.max(origin.y, 0.42);
    gameRefs.ballPos.copy(origin);

    const clearance =
      spin === 'topspin' ? 0.54 : spin === 'slice' ? 0.24 : 0.2;

    const solved = solveBallisticShot(
      origin,
      targetX,
      targetZ,
      speedKmh / 3.6,
      spin,
      power01,
      false,
      clearance
    );

    gameRefs.ballVel.copy(solved.velocity);
    gameRefs.ballAngularVel.copy(solved.angularVel);

    activeBallSpinRef.current = spin;
    lastHitterRef.current = hitter;
    bounceCountRef.current = 0;
    isServeShotRef.current = false;
    netCooldownRef.current = 0.08;
    aiReactionTimerRef.current = 0;
    activeSwingWindowRef.current = 0;

    const forehand = isPlayer
      ? origin.x >= actorPos.x - 0.1
      : origin.x <= actorPos.x + 0.1;

    if (isPlayer) {
      playerSwingStyleRef.current = forehand ? 'forehand' : 'backhand';
      gameRefs.playerSwingProgress = 0.22;
      playerSwingTriggerRef.current = true;
    } else {
      aiSwingStyleRef.current = forehand ? 'forehand' : 'backhand';
      gameRefs.aiSwingProgress = 0.22;
      aiSwingTriggerRef.current = true;
      aiSpinRef.current = spin;
    }

    store.recordImpact({
      position: [origin.x, origin.y, origin.z],
      velocity: [solved.velocity.x, solved.velocity.y, solved.velocity.z],
      speedKmh,
      spin,
      type: isPlayer ? 'racket-player' : 'racket-ai',
      surface: store.surface,
    });
    store.incrementRally(speedKmh);
  };

  // Choose an intelligent shot target for AI or Attract-Mode player autopilot
  const chooseTacticalShot = (
    attackerSide: HitterSide,
    profile: DifficultyProfile
  ): { spin: SpinType; power: number; targetX: number; targetZ: number; speedKmh: number } => {
    const isPlayerSide = attackerSide === 'player';
    const defenderPos = isPlayerSide ? gameRefs.aiPos : gameRefs.playerPos;
    const attackerPos = isPlayerSide ? gameRefs.playerPos : gameRefs.aiPos;
    const zSign = isPlayerSide ? -1 : 1; // Ball goes to opposite Z half

    const stretchDist = Math.abs(attackerPos.x - gameRefs.ballPos.x);
    const isStretched = Math.abs(attackerPos.x) > 3.55 || stretchDist > 1.5;
    const isShortBall = Math.abs(attackerPos.z) < 8.4;

    // Pick spin dynamically based on tactical context
    const roll = Math.random();
    let spin: SpinType = 'topspin';
    if (isStretched && roll < 0.65) {
      spin = 'slice';
    } else if (isShortBall && roll < profile.aggression * 0.72) {
      spin = 'flat';
    } else if (roll < 0.24) {
      spin = 'slice';
    }

    // Target open corner away from defender
    const openSideX = defenderPos.x >= 0 ? -1 : 1;
    const downTheLine = Math.random() < 0.34;
    const targetCornerX = downTheLine
      ? THREE.MathUtils.clamp(attackerPos.x * 0.85, -3.55, 3.55)
      : openSideX * THREE.MathUtils.lerp(2.1, 3.68, profile.aggression);

    const errorX = (Math.random() - 0.5) * 2 * profile.aimError * (isStretched ? 1.35 : 0.85);
    const errorZ = (Math.random() - 0.5) * 2 * profile.aimError;

    // Occasional unforced error scaled by difficulty
    const willMiss = Math.random() < profile.mistakeChance * (isStretched ? 1.8 : 1);
    const targetX = willMiss
      ? Math.sign(targetCornerX || 1) * (4.35 + Math.random() * 0.6)
      : THREE.MathUtils.clamp(targetCornerX + errorX, -3.88, 3.88);

    const baseDepth = spin === 'slice' ? 9.6 : spin === 'flat' ? 9.8 : 10.2;
    const targetZ =
      zSign * THREE.MathUtils.clamp(baseDepth + errorZ, 5.2, willMiss ? 12.6 : 11.35);

    const power = THREE.MathUtils.clamp(
      (spin === 'flat' ? 0.82 : 0.65) * profile.shotSpeedScale + Math.random() * 0.2,
      0.35,
      1
    );

    const baseKmh = spin === 'flat' ? 154 : spin === 'topspin' ? 132 : 116;
    const speedKmh = Math.min(
      224,
      (baseKmh + power * 66) * profile.shotSpeedScale
    );

    return { spin, power, targetX, targetZ, speedKmh };
  };

  useFrame((_, delta) => {
    const rawDt = Math.min(delta, 0.05);
    pointerRef.current.copy(pointer);
    const store = useGameStore.getState();
    const { phase, timeScale, surface, aiDifficulty, score, isAttractMode } = store;
    const surfaceCfg = SURFACE_CONFIGS[surface];

    playerSpinDisplayRef.current = store.currentSpin;

    // Detect match reset while already in pre-serve (e.g. clicking Reset Match button)
    const lastImpactId = store.lastImpact?.id ?? null;
    if (
      prevMatchResetCheckRef.current !== null &&
      lastImpactId === null &&
      phase === 'pre-serve' &&
      score.playerPoints === 0 &&
      score.aiPoints === 0 &&
      score.playerGames === 0 &&
      score.aiGames === 0 &&
      score.playerSets === 0 &&
      score.aiSets === 0
    ) {
      setupPreServe();
    }
    prevMatchResetCheckRef.current = lastImpactId;

    // Detect phase transitions cleanly
    const prevPhase = prevPhaseRef.current;
    if (prevPhase !== phase) {
      if (phase === 'replay') {
        if (prevPhase === 'rally' || prevPhase === 'serve-toss') {
          replaySnapshotRef.current = {
            ballPos: gameRefs.ballPos.clone(),
            ballVel: gameRefs.ballVel.clone(),
            ballAngularVel: gameRefs.ballAngularVel.clone(),
            playerPos: gameRefs.playerPos.clone(),
            aiPos: gameRefs.aiPos.clone(),
            lastHitter: lastHitterRef.current,
            bounceCount: bounceCountRef.current,
            isServeShot: isServeShotRef.current,
            serveTargetXSign: serveTargetXSignRef.current,
            activeSpin: activeBallSpinRef.current,
          };
        } else {
          replaySnapshotRef.current = null;
        }
      } else if (prevPhase === 'replay' && (phase === 'rally' || phase === 'serve-toss')) {
        const snap = replaySnapshotRef.current;
        if (snap) {
          gameRefs.ballPos.copy(snap.ballPos);
          gameRefs.ballVel.copy(snap.ballVel);
          gameRefs.ballAngularVel.copy(snap.ballAngularVel);
          gameRefs.playerPos.copy(snap.playerPos);
          gameRefs.aiPos.copy(snap.aiPos);
          lastHitterRef.current = snap.lastHitter;
          bounceCountRef.current = snap.bounceCount;
          isServeShotRef.current = snap.isServeShot;
          serveTargetXSignRef.current = snap.serveTargetXSign;
          activeBallSpinRef.current = snap.activeSpin;
          replaySnapshotRef.current = null;
        }
      } else if (phase === 'pre-serve') {
        setupPreServe();
      }
      prevPhaseRef.current = phase;
    }

    // IMPORTANT: Never integrate forward physics during slow-mo replay playback
    if (phase === 'replay') {
      gameRefs.trajectoryPoints.length = 0;
      return;
    }

    // Advance swing animations smoothly
    if (gameRefs.playerSwingProgress > 0) {
      gameRefs.playerSwingProgress += rawDt * 4.4;
      if (gameRefs.playerSwingProgress >= 1) {
        gameRefs.playerSwingProgress = 0;
        playerSwingTriggerRef.current = false;
      }
    }
    if (gameRefs.aiSwingProgress > 0) {
      gameRefs.aiSwingProgress += rawDt * 4.4;
      if (gameRefs.aiSwingProgress >= 1) {
        gameRefs.aiSwingProgress = 0;
        aiSwingTriggerRef.current = false;
      }
    }

    // Poll Gamepad API safely
    let gpMoveX = 0;
    let gpMoveZ = 0;
    let gpAimActive = false;
    let gpAimX = 0;
    let gpAimY = 0;
    try {
      const pads = navigator.getGamepads?.();
      const pad = pads?.[0];
      if (pad) {
        const ax0 = Math.abs(pad.axes[0] ?? 0) > 0.18 ? pad.axes[0] : 0;
        const ax1 = Math.abs(pad.axes[1] ?? 0) > 0.18 ? pad.axes[1] : 0;
        gpMoveX = ax0;
        gpMoveZ = ax1;

        const ax2 = Math.abs(pad.axes[2] ?? 0) > 0.2 ? pad.axes[2] : 0;
        const ax3 = Math.abs(pad.axes[3] ?? 0) > 0.2 ? pad.axes[3] : 0;
        if (ax2 !== 0 || ax3 !== 0) {
          gpAimActive = true;
          gpAimX = ax2;
          gpAimY = -ax3;
        }

        if (!isAttractMode) {
          const b0 = !!pad.buttons[0]?.pressed; // Topspin
          const b1 = !!pad.buttons[1]?.pressed; // Slice
          const b2 = !!pad.buttons[2]?.pressed; // Flat
          const b7 = !!pad.buttons[7]?.pressed; // RT Serve / Swing
          const prev = gamepadPrevButtonsRef.current;

          if (b0 && !prev[0]) store.setCurrentSpin('topspin');
          if (b1 && !prev[1]) store.setCurrentSpin('slice');
          if (b2 && !prev[2]) store.setCurrentSpin('flat');

          const anySwingDown = b0 || b1 || b2 || b7;
          const anySwingPrev = prev[0] || prev[1] || prev[2] || prev[3];

          if (anySwingDown && !anySwingPrev) {
            if (phase === 'pre-serve' && score.server === 'player') {
              store.setPhase('serve-toss');
              serveTossTimerRef.current = 0;
              gameRefs.ballPos.set(
                gameRefs.playerPos.x - 0.12,
                1.25,
                gameRefs.playerPos.z - 0.32
              );
              gameRefs.ballVel.set(0, 5.95, 0);
              chargeActiveRef.current = true;
              chargePowerRef.current = 0.1;
              store.setCharge(0.1, true);
            } else if (phase === 'serve-toss' && score.server === 'player') {
              executePlayerServe();
            } else if (phase === 'rally') {
              chargeActiveRef.current = true;
              chargePowerRef.current = 0.15;
              store.setCharge(0.15, true);
            }
          } else if (!anySwingDown && anySwingPrev && chargeActiveRef.current) {
            chargeActiveRef.current = false;
            if (phase === 'serve-toss' && score.server === 'player') {
              executePlayerServe();
            } else if (phase === 'rally') {
              activeSwingWindowRef.current = 0.24;
              playerSwingTriggerRef.current = true;
              gameRefs.playerSwingProgress = 0.02;
              store.setCharge(chargePowerRef.current, false);
            }
          }

          gamepadPrevButtonsRef.current = [b0, b1, b2, b7];
        }
      }
    } catch {
      // Ignore restricted Gamepad access in headless contexts
    }

    // Update aiming target from pointer or gamepad
    const aimXNorm = gpAimActive ? gpAimX : pointer.x;
    const aimYNorm = gpAimActive ? gpAimY : pointer.y;

    if (
      (phase === 'pre-serve' || phase === 'serve-toss') &&
      score.server === 'player'
    ) {
      const boxSign = serveTargetXSignRef.current;
      const wideAlpha = THREE.MathUtils.clamp((aimXNorm * boxSign + 1) * 0.5, 0, 1);
      const depthAlpha = THREE.MathUtils.clamp((aimYNorm + 1) * 0.5, 0, 1);
      aimTargetRef.current.set(
        boxSign * THREE.MathUtils.lerp(0.65, 3.65, wideAlpha),
        0.025,
        -THREE.MathUtils.lerp(4.95, 6.12, depthAlpha)
      );
    } else {
      const targetX = THREE.MathUtils.clamp(aimXNorm * 3.85, -3.85, 3.85);
      const depthAlpha = THREE.MathUtils.clamp((aimYNorm + 1) * 0.5, 0, 1);
      const targetZ = -THREE.MathUtils.lerp(4.6, 11.2, depthAlpha);
      aimTargetRef.current.set(targetX, 0.025, targetZ);
    }
    gameRefs.playerTargetX = aimTargetRef.current.x;

    // Charge ramp while holding Space / Mouse / Gamepad
    if (chargeActiveRef.current && !isAttractMode) {
      chargePowerRef.current = Math.min(1, chargePowerRef.current + rawDt * 1.5);
      store.setCharge(chargePowerRef.current, true);
    }
    playerChargeStateRef.current = {
      power: chargePowerRef.current,
      active: chargeActiveRef.current,
    };

    // -------------------
    // 1. PLAYER MOVEMENT
    // -------------------
    const keys = keysRef.current;
    let moveX = gpMoveX;
    let moveZ = gpMoveZ;
    if (keys['KeyA'] || keys['ArrowLeft']) moveX -= 1;
    if (keys['KeyD'] || keys['ArrowRight']) moveX += 1;
    if (keys['KeyW'] || keys['ArrowUp']) moveZ -= 1;
    if (keys['KeyS'] || keys['ArrowDown']) moveZ += 1;

    const hasManualInput = Math.hypot(moveX, moveZ) > 0.05;
    if (hasManualInput) {
      lastManualMoveTimeRef.current = performance.now();
    }

    if (isAttractMode) {
      // Skilled autopilot controls near-side Cyber-Striker during trailer mode
      const attractProfile = AI_PROFILES['pro'];
      let desiredX = 0;
      let desiredZ = 11.5;

      if (phase === 'rally' && lastHitterRef.current === 'ai') {
        desiredX = THREE.MathUtils.clamp(
          gameRefs.predictedLanding.x + (gameRefs.predictedLanding.x >= 0 ? -0.35 : 0.35),
          -5.2,
          5.2
        );
        desiredZ = THREE.MathUtils.clamp(gameRefs.predictedLanding.z + 1.0, 2.2, 13.6);
      } else if (phase === 'rally') {
        desiredX = THREE.MathUtils.clamp(-gameRefs.aiPos.x * 0.18, -1.1, 1.1);
        desiredZ = 11.4;
      } else {
        desiredX = gameRefs.playerPos.x;
        desiredZ = gameRefs.playerPos.z;
      }

      const dx = desiredX - gameRefs.playerPos.x;
      const dz = desiredZ - gameRefs.playerPos.z;
      const dist = Math.hypot(dx, dz);
      const speedCap = attractProfile.moveSpeed * 1.05;
      if (dist > 0.08) {
        const vx = (dx / dist) * Math.min(speedCap, dist * 9);
        const vz = (dz / dist) * Math.min(speedCap, dist * 9);
        gameRefs.playerVel.x = THREE.MathUtils.lerp(gameRefs.playerVel.x, vx, 0.25);
        gameRefs.playerVel.z = THREE.MathUtils.lerp(gameRefs.playerVel.z, vz, 0.25);
      } else {
        gameRefs.playerVel.multiplyScalar(0.8);
      }
    } else if (hasManualInput) {
      const len = Math.hypot(moveX, moveZ) || 1;
      const maxSpeed = 8.9;
      const targetVx = (moveX / len) * maxSpeed;
      const targetVz = (moveZ / len) * maxSpeed;
      gameRefs.playerVel.x = THREE.MathUtils.lerp(
        gameRefs.playerVel.x,
        targetVx,
        Math.min(1, rawDt * 14)
      );
      gameRefs.playerVel.z = THREE.MathUtils.lerp(
        gameRefs.playerVel.z,
        targetVz,
        Math.min(1, rawDt * 14)
      );
    } else {
      // Subtle smart auto-step assist toward incoming ball when player is idle
      const idleSec = (performance.now() - lastManualMoveTimeRef.current) / 1000;
      if (
        phase === 'rally' &&
        lastHitterRef.current === 'ai' &&
        idleSec > 0.14
      ) {
        const targetX = THREE.MathUtils.clamp(
          gameRefs.predictedLanding.x - 0.28,
          -4.9,
          4.9
        );
        const targetZ = THREE.MathUtils.clamp(
          gameRefs.predictedLanding.z + 1.05,
          3.2,
          13.4
        );
        const dx = targetX - gameRefs.playerPos.x;
        const dz = targetZ - gameRefs.playerPos.z;
        const dist = Math.hypot(dx, dz);
        if (dist > 0.35) {
          const assistSpeed = 5.4;
          gameRefs.playerVel.x = THREE.MathUtils.lerp(
            gameRefs.playerVel.x,
            (dx / dist) * assistSpeed,
            Math.min(1, rawDt * 8)
          );
          gameRefs.playerVel.z = THREE.MathUtils.lerp(
            gameRefs.playerVel.z,
            (dz / dist) * assistSpeed,
            Math.min(1, rawDt * 8)
          );
        } else {
          gameRefs.playerVel.multiplyScalar(Math.max(0, 1 - rawDt * 12));
        }
      } else {
        gameRefs.playerVel.multiplyScalar(Math.max(0, 1 - rawDt * 12));
      }
    }

    gameRefs.playerPos.addScaledVector(gameRefs.playerVel, rawDt);
    // Clamp player within court boundaries
    if (phase === 'pre-serve' && score.server === 'player') {
      const isDeuce = (score.playerPoints + score.aiPoints) % 2 === 0;
      gameRefs.playerPos.x = THREE.MathUtils.clamp(
        gameRefs.playerPos.x,
        isDeuce ? 0.35 : -3.85,
        isDeuce ? 3.85 : -0.35
      );
      gameRefs.playerPos.z = THREE.MathUtils.clamp(gameRefs.playerPos.z, 11.9, 13.1);
    } else {
      gameRefs.playerPos.x = THREE.MathUtils.clamp(gameRefs.playerPos.x, -6.2, 6.2);
      gameRefs.playerPos.z = THREE.MathUtils.clamp(gameRefs.playerPos.z, 1.35, 14.4);
    }

    // -------------------
    // 2. AI MOVEMENT
    // -------------------
    const profile = AI_PROFILES[aiDifficulty];
    let aiDesiredX = gameRefs.aiPos.x;
    let aiDesiredZ = gameRefs.aiPos.z;

    if (phase === 'rally') {
      if (lastHitterRef.current === 'player') {
        aiReactionTimerRef.current += rawDt * timeScale;
        if (aiReactionTimerRef.current >= profile.reactionDelay) {
          aiDesiredX = THREE.MathUtils.clamp(
            gameRefs.predictedLanding.x + (gameRefs.predictedLanding.x <= 0 ? 0.35 : -0.35),
            -5.6,
            5.6
          );
          // Step in for short balls or retreat deep on topspin kicks
          aiDesiredZ = THREE.MathUtils.clamp(
            gameRefs.predictedLanding.z - 1.15,
            -13.8,
            -2.1
          );
        }
      } else {
        // Recover cleanly to tactical center
        aiDesiredX = THREE.MathUtils.clamp(-gameRefs.playerPos.x * 0.16, -1.1, 1.1);
        aiDesiredZ = -11.2;
      }
    }

    const aiDx = aiDesiredX - gameRefs.aiPos.x;
    const aiDz = aiDesiredZ - gameRefs.aiPos.z;
    const aiDist = Math.hypot(aiDx, aiDz);
    if (aiDist > 0.08 && phase === 'rally') {
      const speed = Math.min(profile.moveSpeed, aiDist * 8.5);
      gameRefs.aiVel.x = THREE.MathUtils.lerp(
        gameRefs.aiVel.x,
        (aiDx / aiDist) * speed,
        Math.min(1, rawDt * 12)
      );
      gameRefs.aiVel.z = THREE.MathUtils.lerp(
        gameRefs.aiVel.z,
        (aiDz / aiDist) * speed,
        Math.min(1, rawDt * 12)
      );
    } else {
      gameRefs.aiVel.multiplyScalar(Math.max(0, 1 - rawDt * 10));
    }
    gameRefs.aiPos.addScaledVector(gameRefs.aiVel, rawDt);
    gameRefs.aiPos.x = THREE.MathUtils.clamp(gameRefs.aiPos.x, -6.2, 6.2);
    gameRefs.aiPos.z = THREE.MathUtils.clamp(gameRefs.aiPos.z, -14.4, -1.35);

    // -------------------
    // 3. PHASE LOGIC
    // -------------------
    if (phase === 'pre-serve') {
      gameRefs.trajectoryPoints.length = 0;

      if (score.server === 'player') {
        gameRefs.ballPos.set(
          gameRefs.playerPos.x - 0.15,
          1.05,
          gameRefs.playerPos.z - 0.34
        );
        if (isAttractMode) {
          aiServeDelayRef.current += rawDt;
          if (aiServeDelayRef.current >= 0.95) {
            store.setPhase('serve-toss');
            serveTossTimerRef.current = 0;
            gameRefs.ballPos.set(
              gameRefs.playerPos.x - 0.12,
              1.25,
              gameRefs.playerPos.z - 0.32
            );
            gameRefs.ballVel.set(0, 5.95, 0);
            playerSwingStyleRef.current = 'serve';
          }
        }
      } else {
        gameRefs.ballPos.set(
          gameRefs.aiPos.x + 0.15,
          1.05,
          gameRefs.aiPos.z + 0.34
        );
        aiServeDelayRef.current += rawDt;
        if (aiServeDelayRef.current >= 1.15) {
          store.setPhase('serve-toss');
          serveTossTimerRef.current = 0;
          gameRefs.ballPos.set(
            gameRefs.aiPos.x + 0.12,
            1.25,
            gameRefs.aiPos.z + 0.32
          );
          gameRefs.ballVel.set(0, 5.95, 0);
          aiSwingStyleRef.current = 'serve';
        }
      }
      return;
    }

    if (phase === 'serve-toss') {
      const scaledDt = rawDt * timeScale;
      serveTossTimerRef.current += scaledDt;
      gameRefs.ballVel.y += GRAVITY * scaledDt;
      gameRefs.ballPos.addScaledVector(gameRefs.ballVel, scaledDt);

      // Record toss frames for replay continuity
      rallyTimeRef.current += scaledDt;
      if (gameRefs.replayFrames.length >= MAX_REPLAY_FRAMES) {
        gameRefs.replayFrames.shift();
      }
      gameRefs.replayFrames.push({
        time: rallyTimeRef.current,
        ballPos: [gameRefs.ballPos.x, gameRefs.ballPos.y, gameRefs.ballPos.z],
        ballVel: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
        ballSpin: store.currentSpin,
        playerPos: [gameRefs.playerPos.x, gameRefs.playerPos.y, gameRefs.playerPos.z],
        aiPos: [gameRefs.aiPos.x, gameRefs.aiPos.y, gameRefs.aiPos.z],
        playerSwing: gameRefs.playerSwingProgress,
        aiSwing: gameRefs.aiSwingProgress,
      });

      const isPlayerServer = score.server === 'player';

      if (isPlayerServer) {
        if (isAttractMode) {
          if (
            (serveTossTimerRef.current > 0.5 && gameRefs.ballVel.y <= 0.45) ||
            (gameRefs.ballVel.y < -1.5 && gameRefs.ballPos.y <= 2.4)
          ) {
            const boxSign = serveTargetXSignRef.current;
            const spin: SpinType = Math.random() < 0.55 ? 'flat' : 'topspin';
            const speed = spin === 'flat' ? 204 : 178;
            store.setCurrentSpin(spin);
            executeServeShot(
              'player',
              spin,
              0.85,
              boxSign * (1.2 + Math.random() * 2.1),
              -(5.1 + Math.random() * 0.95),
              speed
            );
          }
        } else {
          // Single-tap assist or automatic apex fallback so toss never gets stuck
          if (
            (serveTapReleasedRef.current &&
              serveTossTimerRef.current > 0.52 &&
              gameRefs.ballVel.y <= 0.4) ||
            (gameRefs.ballVel.y < -2.2 && gameRefs.ballPos.y <= 2.35) ||
            serveTossTimerRef.current > 1.85
          ) {
            executePlayerServe();
          }
        }
      } else {
        // AI serve smash near apex
        if (serveTossTimerRef.current > 0.5 && gameRefs.ballVel.y <= 0.45) {
          const boxSign = serveTargetXSignRef.current;
          const spins: SpinType[] = ['flat', 'topspin', 'slice'];
          const aiSpin = spins[Math.floor(Math.random() * spins.length)];
          const wideSpread =
            aiDifficulty === 'rookie'
              ? 1.1 + Math.random() * 1.4
              : 0.65 + Math.random() * 2.85;
          const targetZ = 5.05 + Math.random() * 1.05;
          const speed =
            profile.serveSpeedKmh * (aiSpin === 'flat' ? 1.03 : 0.9);
          executeServeShot(
            'ai',
            aiSpin,
            0.8,
            boxSign * wideSpread,
            targetZ,
            Math.min(224, speed)
          );
        }
      }
      return;
    }

    if (phase === 'point-over') {
      // Gently let the ball settle with physics while keeping point-over timer ticking
      pointOverTimerRef.current += rawDt;
      const scaledDt = rawDt * timeScale;
      const subDt = scaledDt / 4;
      for (let s = 0; s < 4; s++) {
        stepBallRK2(gameRefs.ballPos, gameRefs.ballVel, gameRefs.ballAngularVel, subDt);
        if (gameRefs.ballPos.y <= BALL_RADIUS && gameRefs.ballVel.y < 0) {
          gameRefs.ballPos.y = BALL_RADIUS;
          if (Math.abs(gameRefs.ballVel.y) > 0.7) {
            gameRefs.ballVel.y = -gameRefs.ballVel.y * surfaceCfg.restitution * 0.75;
          } else {
            gameRefs.ballVel.y = 0;
          }
          gameRefs.ballVel.x *= 0.84;
          gameRefs.ballVel.z *= 0.84;
        }
      }

      gameRefs.trajectoryPoints.length = 0;
      if (pointOverTimerRef.current >= 2.2) {
        store.setPhase('pre-serve');
      }
      return;
    }

    // -------------------
    // 4. RALLY SUB-STEPPED BALL PHYSICS
    // -------------------
    const scaledDt = rawDt * timeScale;
    const subDt = scaledDt / SUBSTEPS;
    netCooldownRef.current = Math.max(0, netCooldownRef.current - scaledDt);
    activeSwingWindowRef.current = Math.max(
      0,
      activeSwingWindowRef.current - rawDt
    );

    let pointEndedThisFrame = false;

    for (let s = 0; s < SUBSTEPS; s++) {
      if (pointEndedThisFrame) break;

      _prevPos.copy(gameRefs.ballPos);
      stepBallRK2(gameRefs.ballPos, gameRefs.ballVel, gameRefs.ballAngularVel, subDt);

      // A. Net Collision Check (Z crossing 0)
      if (
        netCooldownRef.current <= 0 &&
        ((_prevPos.z > 0 && gameRefs.ballPos.z <= 0) ||
          (_prevPos.z < 0 && gameRefs.ballPos.z >= 0))
      ) {
        const t = _prevPos.z / (_prevPos.z - gameRefs.ballPos.z || 0.0001);
        const crossX = THREE.MathUtils.lerp(_prevPos.x, gameRefs.ballPos.x, t);
        const crossY = THREE.MathUtils.lerp(_prevPos.y, gameRefs.ballPos.y, t);

        if (Math.abs(crossX) <= NET_POST_X + BALL_RADIUS) {
          const netH = getNetHeight(crossX);
          const diff = crossY - netH;

          if (Math.abs(diff) < 0.08) {
            // Dramatic net-cord clip deflection!
            netCooldownRef.current = 0.25;
            const speedKmh = gameRefs.ballVel.length() * 3.6;
            store.recordImpact({
              position: [crossX, netH, 0],
              velocity: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
              speedKmh,
              spin: activeBallSpinRef.current,
              type: 'net',
              surface,
            });
            gameRefs.ballPos.y = netH + 0.06;
            gameRefs.ballVel.y = Math.max(Math.abs(gameRefs.ballVel.y) * 0.4, 2.1) + 1.1;
            gameRefs.ballVel.x = gameRefs.ballVel.x * 0.52 + (Math.random() - 0.5) * 1.3;
            gameRefs.ballVel.z *= 0.54;
            gameRefs.ballAngularVel.multiplyScalar(0.45);
          } else if (diff <= -0.08) {
            // Well below tape: ball hits net mesh & ends point
            netCooldownRef.current = 0.5;
            const speedKmh = gameRefs.ballVel.length() * 3.6;
            store.recordImpact({
              position: [crossX, Math.max(crossY, 0.12), 0],
              velocity: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
              speedKmh,
              spin: activeBallSpinRef.current,
              type: 'net',
              surface,
            });
            gameRefs.ballPos.z = _prevPos.z > 0 ? 0.07 : -0.07;
            gameRefs.ballVel.z = -gameRefs.ballVel.z * 0.22;
            gameRefs.ballVel.x *= 0.35;
            gameRefs.ballVel.y = Math.min(gameRefs.ballVel.y * 0.2, 0.45);

            const winner: HitterSide =
              lastHitterRef.current === 'player' ? 'ai' : 'player';
            store.awardPoint(
              winner,
              isServeShotRef.current ? 'NET FAULT!' : 'NET!',
              false
            );
            pointEndedThisFrame = true;
            break;
          }
        }
      }

      // B. Court Floor Bounce Check
      if (gameRefs.ballPos.y <= BALL_RADIUS && gameRefs.ballVel.y < 0) {
        const t =
          (_prevPos.y - BALL_RADIUS) / (_prevPos.y - gameRefs.ballPos.y || 0.0001);
        gameRefs.ballPos.x = THREE.MathUtils.lerp(_prevPos.x, gameRefs.ballPos.x, t);
        gameRefs.ballPos.z = THREE.MathUtils.lerp(_prevPos.z, gameRefs.ballPos.z, t);
        gameRefs.ballPos.y = BALL_RADIUS;

        applyCourtBounce(
          gameRefs.ballVel,
          gameRefs.ballAngularVel,
          activeBallSpinRef.current,
          surfaceCfg
        );

        const speedKmh = gameRefs.ballVel.length() * 3.6;
        store.recordImpact({
          position: [gameRefs.ballPos.x, BALL_RADIUS, gameRefs.ballPos.z],
          velocity: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
          speedKmh,
          spin: activeBallSpinRef.current,
          type: 'bounce',
          surface,
        });

        const bouncedSide: HitterSide = gameRefs.ballPos.z >= 0 ? 'player' : 'ai';

        if (lastHitterRef.current === bouncedSide) {
          // Bounced on hitter's own side before crossing net
          const winner: HitterSide = bouncedSide === 'player' ? 'ai' : 'player';
          store.awardPoint(winner, 'FAULT!', false);
          pointEndedThisFrame = true;
          break;
        }

        bounceCountRef.current += 1;

        if (bounceCountRef.current === 1) {
          const bx = gameRefs.ballPos.x;
          const bz = gameRefs.ballPos.z;

          if (isServeShotRef.current) {
            const inDepth = Math.abs(bz) <= SERVICE_LINE_Z + BALL_RADIUS;
            const inWidth = Math.abs(bx) <= COURT_HALF_WIDTH_SINGLES + BALL_RADIUS;
            const inDiagBox =
              bx * serveTargetXSignRef.current >= -BALL_RADIUS - 0.08;

            if (!inDepth || !inWidth || !inDiagBox) {
              store.recordImpact({
                position: [bx, BALL_RADIUS, bz],
                velocity: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
                speedKmh,
                spin: activeBallSpinRef.current,
                type: 'out',
                surface,
              });
              const winner: HitterSide =
                lastHitterRef.current === 'player' ? 'ai' : 'player';
              store.awardPoint(winner, 'SERVE OUT!', false);
              pointEndedThisFrame = true;
              break;
            }
            isServeShotRef.current = false;
          } else {
            const inX = Math.abs(bx) <= COURT_HALF_WIDTH_SINGLES + BALL_RADIUS;
            const inZ = Math.abs(bz) <= COURT_HALF_LENGTH + BALL_RADIUS;

            if (!inX || !inZ) {
              store.recordImpact({
                position: [bx, BALL_RADIUS, bz],
                velocity: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
                speedKmh,
                spin: activeBallSpinRef.current,
                type: 'out',
                surface,
              });
              const winner: HitterSide =
                lastHitterRef.current === 'player' ? 'ai' : 'player';
              store.awardPoint(
                winner,
                'OUT!',
                store.rallyCount >= 5
              );
              pointEndedThisFrame = true;
              break;
            }
          }
        } else if (bounceCountRef.current >= 2) {
          // Double bounce -> hitter wins!
          const winner: HitterSide = lastHitterRef.current ?? 'player';
          const isAce = store.rallyCount <= 1;
          store.awardPoint(
            winner,
            isAce ? 'ACE!' : 'WINNER!',
            isAce || speedKmh > 135 || store.rallyCount >= 4
          );
          pointEndedThisFrame = true;
          break;
        }
      }

      // C. Backstop / Wide Boundary Safety
      if (
        Math.abs(gameRefs.ballPos.z) > 18.5 ||
        Math.abs(gameRefs.ballPos.x) > 11.5
      ) {
        if (bounceCountRef.current === 0) {
          store.recordImpact({
            position: [gameRefs.ballPos.x, gameRefs.ballPos.y, gameRefs.ballPos.z],
            velocity: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
            speedKmh: gameRefs.ballVel.length() * 3.6,
            spin: activeBallSpinRef.current,
            type: 'out',
            surface,
          });
          const winner: HitterSide =
            lastHitterRef.current === 'player' ? 'ai' : 'player';
          store.awardPoint(
            winner,
            isServeShotRef.current ? 'SERVE OUT!' : 'OUT!',
            false
          );
        } else {
          const winner: HitterSide = lastHitterRef.current ?? 'player';
          const isAce = store.rallyCount <= 1;
          store.awardPoint(
            winner,
            isAce ? 'ACE!' : 'WINNER!',
            true
          );
        }
        pointEndedThisFrame = true;
        break;
      }
    }

    if (pointEndedThisFrame) {
      gameRefs.trajectoryPoints.length = 0;
      return;
    }

    // -------------------
    // 5. RACKET HIT DETECTION (PLAYER & AI)
    // -------------------
    // Player or Attract Autopilot Strike
    if (
      lastHitterRef.current === 'ai' &&
      gameRefs.ballPos.z >= 0.22 &&
      bounceCountRef.current <= 1 &&
      gameRefs.ballPos.y <= 3.15
    ) {
      const dist = Math.hypot(
        gameRefs.ballPos.x - gameRefs.playerPos.x,
        gameRefs.ballPos.z - gameRefs.playerPos.z
      );

      if (isAttractMode) {
        if (dist <= 2.15 && gameRefs.ballPos.z > 2.2) {
          const shot = chooseTacticalShot('player', AI_PROFILES['pro']);
          store.setCurrentSpin(shot.spin);
          strikeBall(
            'player',
            shot.spin,
            shot.power,
            shot.targetX,
            shot.targetZ,
            shot.speedKmh
          );
        }
      } else {
        const withinReach = dist <= 2.45;
        // Player swings during buffered swing window OR on clean release
        if (withinReach && activeSwingWindowRef.current > 0) {
          const p = THREE.MathUtils.clamp(chargePowerRef.current, 0.25, 1);
          const timingSweetSpot = dist < 1.5 ? 1.0 : 0.88;
          const spin = store.currentSpin;
          const baseKmh = spin === 'flat' ? 152 : spin === 'topspin' ? 128 : 114;
          const maxExtra = spin === 'flat' ? 73 : spin === 'topspin' ? 66 : 58;
          const speedKmh = Math.min(225, (baseKmh + maxExtra * p) * timingSweetSpot);

          strikeBall(
            'player',
            spin,
            p,
            aimTargetRef.current.x,
            aimTargetRef.current.z,
            speedKmh
          );
          chargePowerRef.current = 0;
        }
      }
    }

    // AI Strike Detection
    if (
      lastHitterRef.current === 'player' &&
      gameRefs.ballPos.z <= -0.22 &&
      bounceCountRef.current <= 1 &&
      gameRefs.ballPos.y <= 3.2
    ) {
      const aiReach = aiDifficulty === 'rookie' ? 1.85 : aiDifficulty === 'pro' ? 2.15 : 2.38;
      const dist = Math.hypot(
        gameRefs.ballPos.x - gameRefs.aiPos.x,
        gameRefs.ballPos.z - gameRefs.aiPos.z
      );
      if (dist <= aiReach && (gameRefs.ballPos.z < -2.4 || bounceCountRef.current === 1)) {
        const shot = chooseTacticalShot('ai', profile);
        strikeBall(
          'ai',
          shot.spin,
          shot.power,
          shot.targetX,
          shot.targetZ,
          shot.speedKmh
        );
      }
    }

    // -------------------
    // 6. TRAJECTORY PREVIEW & REPLAY CAPTURE
    // -------------------
    updateTrajectoryPreview();

    rallyTimeRef.current += scaledDt;
    if (gameRefs.replayFrames.length >= MAX_REPLAY_FRAMES) {
      gameRefs.replayFrames.shift();
    }
    gameRefs.replayFrames.push({
      time: rallyTimeRef.current,
      ballPos: [gameRefs.ballPos.x, gameRefs.ballPos.y, gameRefs.ballPos.z],
      ballVel: [gameRefs.ballVel.x, gameRefs.ballVel.y, gameRefs.ballVel.z],
      ballSpin: activeBallSpinRef.current,
      playerPos: [gameRefs.playerPos.x, gameRefs.playerPos.y, gameRefs.playerPos.z],
      aiPos: [gameRefs.aiPos.x, gameRefs.aiPos.y, gameRefs.aiPos.z],
      playerSwing: gameRefs.playerSwingProgress,
      aiSwing: gameRefs.aiSwingProgress,
    });
  });

  return (
    <group name="physics-actors">
      <CyberAthlete
        side="player"
        swingStyleRef={playerSwingStyleRef}
        chargeRef={playerChargeStateRef}
        spinRef={playerSpinDisplayRef}
      />
      <CyberAthlete
        side="ai"
        swingStyleRef={aiSwingStyleRef}
        chargeRef={aiChargeStateRef}
        spinRef={aiSpinRef}
      />
      <CyberBall activeSpinRef={activeBallSpinRef} />
      <AimTargetChevron aimTargetRef={aimTargetRef} />
    </group>
  );
};
