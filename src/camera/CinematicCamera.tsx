import React, { ComponentRef, useEffect, useLayoutEffect, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { CameraMode, ReplayFrame } from '../types/game';
import { gameRefs, useGameStore } from '../state/gameStore';

const CAMERA_MODE_ORDER: readonly CameraMode[] = [
  'follow',
  'broadcast',
  'closeup',
  'orbit',
];

const REPLAY_WINDOW_SECONDS = 2.5;
const REPLAY_PLAYBACK_SPEED = 0.28;
const FOV_EPSILON = 0.02;

interface PreReplaySnapshot {
  ballPos: THREE.Vector3;
  ballVel: THREE.Vector3;
  ballAngularVel: THREE.Vector3;
  playerPos: THREE.Vector3;
  aiPos: THREE.Vector3;
  playerSwingProgress: number;
  aiSwingProgress: number;
}

function isPerspectiveCamera(cam: THREE.Camera): cam is THREE.PerspectiveCamera {
  return 'isPerspectiveCamera' in cam && (cam as THREE.PerspectiveCamera).isPerspectiveCamera === true;
}

function dampVec3(
  current: THREE.Vector3,
  target: THREE.Vector3,
  lambda: number,
  dt: number
): void {
  current.x = THREE.MathUtils.damp(current.x, target.x, lambda, dt);
  current.y = THREE.MathUtils.damp(current.y, target.y, lambda, dt);
  current.z = THREE.MathUtils.damp(current.z, target.z, lambda, dt);
}

function applyInterpolatedFrame(
  f0: ReplayFrame,
  f1: ReplayFrame,
  alpha: number
): void {
  gameRefs.ballPos.set(
    THREE.MathUtils.lerp(f0.ballPos[0], f1.ballPos[0], alpha),
    THREE.MathUtils.lerp(f0.ballPos[1], f1.ballPos[1], alpha),
    THREE.MathUtils.lerp(f0.ballPos[2], f1.ballPos[2], alpha)
  );
  gameRefs.ballVel.set(
    THREE.MathUtils.lerp(f0.ballVel[0], f1.ballVel[0], alpha),
    THREE.MathUtils.lerp(f0.ballVel[1], f1.ballVel[1], alpha),
    THREE.MathUtils.lerp(f0.ballVel[2], f1.ballVel[2], alpha)
  );
  gameRefs.playerPos.set(
    THREE.MathUtils.lerp(f0.playerPos[0], f1.playerPos[0], alpha),
    THREE.MathUtils.lerp(f0.playerPos[1], f1.playerPos[1], alpha),
    THREE.MathUtils.lerp(f0.playerPos[2], f1.playerPos[2], alpha)
  );
  gameRefs.aiPos.set(
    THREE.MathUtils.lerp(f0.aiPos[0], f1.aiPos[0], alpha),
    THREE.MathUtils.lerp(f0.aiPos[1], f1.aiPos[1], alpha),
    THREE.MathUtils.lerp(f0.aiPos[2], f1.aiPos[2], alpha)
  );
  gameRefs.playerSwingProgress = THREE.MathUtils.lerp(
    f0.playerSwing,
    f1.playerSwing,
    alpha
  );
  gameRefs.aiSwingProgress = THREE.MathUtils.lerp(
    f0.aiSwing,
    f1.aiSwing,
    alpha
  );
}

function applySingleFrame(f: ReplayFrame): void {
  gameRefs.ballPos.set(f.ballPos[0], f.ballPos[1], f.ballPos[2]);
  gameRefs.ballVel.set(f.ballVel[0], f.ballVel[1], f.ballVel[2]);
  gameRefs.playerPos.set(f.playerPos[0], f.playerPos[1], f.playerPos[2]);
  gameRefs.aiPos.set(f.aiPos[0], f.aiPos[1], f.aiPos[2]);
  gameRefs.playerSwingProgress = f.playerSwing;
  gameRefs.aiSwingProgress = f.aiSwing;
}

export const CinematicCamera: React.FC = () => {
  const camera = useThree((state) => state.camera);
  const cameraMode = useGameStore((state) => state.cameraMode);
  const phase = useGameStore((state) => state.phase);
  const isAttractMode = useGameStore((state) => state.isAttractMode);

  const orbitRef = useRef<ComponentRef<typeof OrbitControls>>(null);
  const isOrbitEnabled = cameraMode === 'orbit' && phase !== 'replay';

  // Camera smoothing state (kept separate from shake so shake never drifts target)
  const currentPos = useRef(new THREE.Vector3(0, 5.0, 18.95));
  const currentTarget = useRef(new THREE.Vector3(0, 1.1, -1.5));
  const desiredPos = useRef(new THREE.Vector3(0, 5.0, 18.95));
  const desiredTarget = useRef(new THREE.Vector3(0, 1.1, -1.5));
  const lookAtScratch = useRef(new THREE.Vector3());

  // Impact shake state
  const lastImpactId = useRef<number>(-1);
  const shakeTrauma = useRef(0);
  const shakeTime = useRef(0);
  const shakeOffset = useRef(new THREE.Vector3());
  const impactPunch = useRef(new THREE.Vector3());

  // FOV state
  const lastAppliedFov = useRef<number>(50);

  // Mode transition tracking
  const prevOrbitEnabled = useRef<boolean>(false);

  // Slow-motion replay playback state
  const replayInitialized = useRef(false);
  const replayEndedCalled = useRef(false);
  const replaySyntheticTiming = useRef(false);
  const replayWindowStartSec = useRef(0);
  const replayWindowDurationSec = useRef(0);
  const replayPlaybackElapsed = useRef(0);
  const replayCursor = useRef(0);
  const replayStartAngle = useRef(0);
  const savedSnapshot = useRef<PreReplaySnapshot | null>(null);

  // Initialize camera position on mount so frame 0 opens cleanly behind player
  useLayoutEffect(() => {
    camera.position.copy(currentPos.current);
    camera.lookAt(currentTarget.current);
    if (isPerspectiveCamera(camera)) {
      camera.fov = 50;
      camera.updateProjectionMatrix();
      lastAppliedFov.current = camera.fov;
    }
  }, [camera]);

  // Keyboard shortcuts: C (cycle camera), R (replay), Space/Escape (skip replay)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;

      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }

      const state = useGameStore.getState();

      if (e.code === 'KeyC' || e.key === 'c' || e.key === 'C') {
        const idx = CAMERA_MODE_ORDER.indexOf(state.cameraMode);
        const nextMode =
          CAMERA_MODE_ORDER[(idx + 1) % CAMERA_MODE_ORDER.length];
        state.setCameraMode(nextMode);
        return;
      }

      if (e.code === 'KeyR' || e.key === 'r' || e.key === 'R') {
        if (state.phase !== 'replay' && gameRefs.replayFrames.length > 5) {
          state.startReplay();
        }
        return;
      }

      if (
        state.phase === 'replay' &&
        (e.code === 'Space' ||
          e.key === ' ' ||
          e.code === 'Escape' ||
          e.key === 'Escape')
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        state.endReplay();
      }
    };

    window.addEventListener('keydown', handleKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', handleKeyDown, { capture: true });
    };
  }, []);

  // Sync Replay snapshot capture/restore atomically on phase transitions
  useEffect(() => {
    const unsubscribe = useGameStore.subscribe((nextState, prevState) => {
      if (prevState.phase !== 'replay' && nextState.phase === 'replay') {
        savedSnapshot.current = {
          ballPos: gameRefs.ballPos.clone(),
          ballVel: gameRefs.ballVel.clone(),
          ballAngularVel: gameRefs.ballAngularVel.clone(),
          playerPos: gameRefs.playerPos.clone(),
          aiPos: gameRefs.aiPos.clone(),
          playerSwingProgress: gameRefs.playerSwingProgress,
          aiSwingProgress: gameRefs.aiSwingProgress,
        };
        replayInitialized.current = false;
        replayEndedCalled.current = false;
      } else if (prevState.phase === 'replay' && nextState.phase !== 'replay') {
        if (
          savedSnapshot.current &&
          (nextState.phase === 'rally' || nextState.phase === 'serve-toss')
        ) {
          const snap = savedSnapshot.current;
          gameRefs.ballPos.copy(snap.ballPos);
          gameRefs.ballVel.copy(snap.ballVel);
          gameRefs.ballAngularVel.copy(snap.ballAngularVel);
          gameRefs.playerPos.copy(snap.playerPos);
          gameRefs.aiPos.copy(snap.aiPos);
          gameRefs.playerSwingProgress = snap.playerSwingProgress;
          gameRefs.aiSwingProgress = snap.aiSwingProgress;
        }
        savedSnapshot.current = null;
        replayInitialized.current = false;
        replayEndedCalled.current = false;
      }
    });
    return unsubscribe;
  }, []);

  // Sync OrbitControls target when entering/leaving orbit mode
  useEffect(() => {
    if (isOrbitEnabled && !prevOrbitEnabled.current) {
      if (orbitRef.current) {
        orbitRef.current.target.copy(currentTarget.current);
        orbitRef.current.update();
      }
    } else if (!isOrbitEnabled && prevOrbitEnabled.current) {
      currentPos.current.copy(camera.position);
      if (orbitRef.current) {
        currentTarget.current.copy(orbitRef.current.target);
      }
    }
    prevOrbitEnabled.current = isOrbitEnabled;
  }, [isOrbitEnabled, camera]);

  useFrame((state, delta) => {
    const dt = Math.min(Math.max(delta, 0.0001), 0.05);
    const elapsed = state.clock.elapsedTime;
    const store = useGameStore.getState();
    const {
      cameraMode: mode,
      phase: curPhase,
      chargePower,
      isCharging,
      lastImpact,
      score,
      isAttractMode: attract,
    } = store;

    // 1. Impact camera shake impulse detection
    if (lastImpact === null) {
      lastImpactId.current = -1;
    } else if (lastImpact.id !== lastImpactId.current) {
      lastImpactId.current = lastImpact.id;
      const spd = lastImpact.speedKmh;

      let impulse = 0;
      if (lastImpact.type === 'net') {
        impulse = THREE.MathUtils.clamp(spd / 160, 0.45, 0.95) * 0.48;
      } else if (
        lastImpact.type === 'racket-player' ||
        lastImpact.type === 'racket-ai'
      ) {
        const norm = THREE.MathUtils.clamp((spd - 75) / 145, 0, 1);
        const smashBoost = spd >= 170 ? 0.16 : 0;
        impulse = 0.14 + Math.pow(norm, 1.35) * 0.42 + smashBoost;
      } else if (lastImpact.type === 'bounce') {
        const norm = THREE.MathUtils.clamp((spd - 90) / 130, 0, 1);
        impulse = 0.08 + norm * 0.18;
      } else if (lastImpact.type === 'out') {
        impulse = 0.15;
      }

      if (curPhase === 'replay') {
        impulse *= 0.65;
      }

      shakeTrauma.current = Math.min(1, shakeTrauma.current + impulse);

      // Brief directional recoil opposite shot velocity
      const vx = lastImpact.velocity[0];
      const vy = lastImpact.velocity[1];
      const vz = lastImpact.velocity[2];
      const vLen = Math.hypot(vx, vy, vz) || 1;
      const punchScale = impulse * 0.14;
      impactPunch.current.set(
        (-vx / vLen) * punchScale,
        (-vy / vLen) * punchScale * 0.6,
        (-vz / vLen) * punchScale * 0.4
      );
    }

    // Update damped trauma + directional punch
    shakeTrauma.current = THREE.MathUtils.damp(shakeTrauma.current, 0, 9.0, dt);
    impactPunch.current.x = THREE.MathUtils.damp(
      impactPunch.current.x,
      0,
      14.0,
      dt
    );
    impactPunch.current.y = THREE.MathUtils.damp(
      impactPunch.current.y,
      0,
      14.0,
      dt
    );
    impactPunch.current.z = THREE.MathUtils.damp(
      impactPunch.current.z,
      0,
      14.0,
      dt
    );

    if (shakeTrauma.current > 0.002) {
      const freq = curPhase === 'replay' ? 22 : 46;
      shakeTime.current += dt * freq;
      const amp = shakeTrauma.current * shakeTrauma.current * 0.36;
      shakeOffset.current.set(
        Math.sin(shakeTime.current * 1.13) * amp + impactPunch.current.x,
        Math.cos(shakeTime.current * 1.51) * amp * 0.85 + impactPunch.current.y,
        Math.sin(shakeTime.current * 0.87) * amp * 0.45 + impactPunch.current.z
      );
    } else {
      shakeOffset.current.copy(impactPunch.current);
    }

    const ballPos = gameRefs.ballPos;
    const ballVel = gameRefs.ballVel;
    const playerPos = gameRefs.playerPos;
    const aiPos = gameRefs.aiPos;
    const ballSpeedKmh = ballVel.length() * 3.6;
    const speedFactor = THREE.MathUtils.clamp((ballSpeedKmh - 85) / 135, 0, 1);
    const chargeFactor = isCharging ? THREE.MathUtils.clamp(chargePower, 0, 1) : 0;

    let targetFov = 50;
    let posLambda = 6.5;
    let targetLambda = 8.0;

    // 3. Slow-Motion Action Replay System
    if (curPhase === 'replay') {
      const frames = gameRefs.replayFrames;

      if (!replayInitialized.current) {
        replayInitialized.current = true;
        replayEndedCalled.current = false;

        if (!frames || frames.length <= 5) {
          if (!replayEndedCalled.current) {
            replayEndedCalled.current = true;
            store.endReplay();
          }
          return;
        }

        if (!savedSnapshot.current) {
          savedSnapshot.current = {
            ballPos: gameRefs.ballPos.clone(),
            ballVel: gameRefs.ballVel.clone(),
            ballAngularVel: gameRefs.ballAngularVel.clone(),
            playerPos: gameRefs.playerPos.clone(),
            aiPos: gameRefs.aiPos.clone(),
            playerSwingProgress: gameRefs.playerSwingProgress,
            aiSwingProgress: gameRefs.aiSwingProgress,
          };
        }

        const firstRaw = frames[0].time;
        const lastRaw = frames[frames.length - 1].time;
        const rawSpan = lastRaw - firstRaw;

        if (rawSpan <= 0.0005) {
          // Synthetic 60Hz fallback if timestamps are identical/degenerate
          replaySyntheticTiming.current = true;
          const totalSec = (frames.length - 1) / 60;
          const clipDur = Math.min(totalSec, REPLAY_WINDOW_SECONDS);
          replayWindowStartSec.current = Math.max(0, totalSec - clipDur);
          replayWindowDurationSec.current = clipDur;
        } else {
          replaySyntheticTiming.current = false;
          const totalSec = lastRaw - firstRaw;
          const clipDur = Math.min(totalSec, REPLAY_WINDOW_SECONDS);
          replayWindowStartSec.current = lastRaw - clipDur;
          replayWindowDurationSec.current = clipDur;
        }

        replayPlaybackElapsed.current = 0;
        replayCursor.current = 0;

        // Locate starting frame of the replay window for seamless camera entry angle
        let entryFrame = frames[0];
        if (!replaySyntheticTiming.current) {
          for (let i = 0; i < frames.length; i++) {
            if (frames[i].time >= replayWindowStartSec.current) {
              entryFrame = frames[i];
              break;
            }
          }
        } else {
          const entryIdx = Math.min(
            Math.floor(replayWindowStartSec.current * 60),
            frames.length - 1
          );
          entryFrame = frames[entryIdx];
        }
        const dx = camera.position.x - entryFrame.ballPos[0];
        const dz = camera.position.z - entryFrame.ballPos[2];
        replayStartAngle.current = Math.atan2(dx, dz);
      }

      if (!frames || frames.length <= 5 || replayWindowDurationSec.current <= 0.02) {
        if (!replayEndedCalled.current) {
          replayEndedCalled.current = true;
          store.endReplay();
        }
        return;
      }

      // Advance slow-motion playback (~0.3x speed)
      replayPlaybackElapsed.current += dt * REPLAY_PLAYBACK_SPEED;

      if (replayPlaybackElapsed.current >= replayWindowDurationSec.current) {
        applySingleFrame(frames[frames.length - 1]);
        if (!replayEndedCalled.current) {
          replayEndedCalled.current = true;
          store.endReplay();
        }
        return;
      }

      const targetSec =
        replayWindowStartSec.current + replayPlaybackElapsed.current;

      if (replaySyntheticTiming.current) {
        const exactIdx = THREE.MathUtils.clamp(
          targetSec * 60,
          0,
          frames.length - 1
        );
        const i0 = Math.floor(exactIdx);
        const i1 = Math.min(i0 + 1, frames.length - 1);
        const alpha = exactIdx - i0;
        applyInterpolatedFrame(frames[i0], frames[i1], alpha);
      } else {
        let idx = Math.min(replayCursor.current, frames.length - 2);
        while (
          idx < frames.length - 2 &&
          frames[idx + 1].time < targetSec
        ) {
          idx += 1;
        }
        replayCursor.current = idx;

        const f0 = frames[idx];
        const f1 = frames[idx + 1];
        const t0 = f0.time;
        const t1 = f1.time;
        const alpha = THREE.MathUtils.clamp(
          (targetSec - t0) / Math.max(t1 - t0, 1e-6),
          0,
          1
        );
        applyInterpolatedFrame(f0, f1, alpha);
      }

      // Tight low-angle cinematic arc around the winning ball/impact focal point
      const progress = THREE.MathUtils.clamp(
        replayPlaybackElapsed.current / replayWindowDurationSec.current,
        0,
        1
      );
      const focalX = gameRefs.ballPos.x + gameRefs.ballVel.x * 0.02;
      const focalY = THREE.MathUtils.clamp(
        gameRefs.ballPos.y * 0.78 + 0.28,
        0.38,
        3.4
      );
      const focalZ = gameRefs.ballPos.z + gameRefs.ballVel.z * 0.02;

      desiredTarget.current.set(focalX, focalY, focalZ);

      const sweepAngle = replayStartAngle.current + progress * Math.PI * 0.92;
      const radius = 4.65 - Math.sin(progress * Math.PI) * 1.15;
      const camX = THREE.MathUtils.clamp(
        focalX + Math.sin(sweepAngle) * radius,
        -8.4,
        8.4
      );
      const camZ = THREE.MathUtils.clamp(
        focalZ + Math.cos(sweepAngle) * radius,
        -14.8,
        14.8
      );
      const camY = THREE.MathUtils.clamp(
        0.88 + focalY * 0.4 + Math.sin(progress * Math.PI) * 0.42,
        0.78,
        2.75
      );

      desiredPos.current.set(camX, camY, camZ);
      posLambda = 10.5;
      targetLambda = 12.0;
      targetFov = 44 + speedFactor * 3.5;

      dampVec3(currentPos.current, desiredPos.current, posLambda, dt);
      dampVec3(currentTarget.current, desiredTarget.current, targetLambda, dt);

      camera.position.copy(currentPos.current).add(shakeOffset.current);
      lookAtScratch.current
        .copy(currentTarget.current)
        .addScaledVector(shakeOffset.current, 0.3);
      camera.lookAt(lookAtScratch.current);
    } else if (mode === 'orbit') {
      // 4. Orbit Mode: OrbitControls manages position & lookAt directly
      targetFov = 50;
    } else if (mode === 'broadcast') {
      // 5. Broadcast TV Stadium Mode
      desiredPos.current.set(0, 12.8, 24.4);
      desiredTarget.current.set(ballPos.x * 0.12, 0.5, 1.2);
      posLambda = 5.5;
      targetLambda = 6.5;
      targetFov = 46;

      dampVec3(currentPos.current, desiredPos.current, posLambda, dt);
      dampVec3(currentTarget.current, desiredTarget.current, targetLambda, dt);

      camera.position.copy(currentPos.current).add(shakeOffset.current);
      lookAtScratch.current
        .copy(currentTarget.current)
        .addScaledVector(shakeOffset.current, 0.25);
      camera.lookAt(lookAtScratch.current);
    } else if (mode === 'closeup') {
      // 6. Dramatic Trailer-Style Dynamic Low Angle
      const pointParity =
        (score.playerSets +
          score.aiSets +
          score.playerGames +
          score.aiGames +
          score.playerPoints +
          score.aiPoints) %
          2 ===
        0
          ? 1
          : -1;

      if (curPhase === 'pre-serve' || curPhase === 'serve-toss') {
        const isPlayerServer = score.server === 'player';
        const serverPos = isPlayerServer ? playerPos : aiPos;
        const dirSign = isPlayerServer ? 1 : -1;
        const sway = Math.sin(elapsed * 0.85) * 0.35;

        desiredPos.current.set(
          THREE.MathUtils.clamp(
            serverPos.x + pointParity * 2.65 + sway,
            -7.5,
            7.5
          ),
          1.28 + Math.sin(elapsed * 1.1) * 0.1,
          THREE.MathUtils.clamp(serverPos.z + dirSign * 3.4, -15.2, 15.2)
        );
        desiredTarget.current.set(
          ballPos.x * 0.55,
          THREE.MathUtils.clamp(ballPos.y * 0.85 + 0.35, 1.0, 3.2),
          serverPos.z - dirSign * 5.2
        );
      } else {
        // Continuous spline-like court-level sweep tracking active striker, ball flight & net skims
        const u = THREE.MathUtils.clamp((ballPos.z + 12.0) / 24.0, 0, 1);
        const netWeight = Math.exp(-Math.pow((u - 0.5) / 0.24, 2));
        const nearWeight = Math.pow(u, 1.6);
        const farWeight = Math.pow(1 - u, 1.6);
        const weightSum = netWeight + nearWeight + farWeight || 1;

        const nearX = playerPos.x * 0.55 + pointParity * 3.35;
        const nearY = 1.32;
        const nearZ = THREE.MathUtils.clamp(playerPos.z + 3.1, 8.2, 15.0);

        const netX = pointParity * 6.35;
        const netY = 1.02 + Math.sin(elapsed * 1.2) * 0.08;
        const netZ = THREE.MathUtils.clamp(ballPos.z * 0.35 + 2.3, -3.2, 3.8);

        const farX = aiPos.x * 0.5 + pointParity * 4.25;
        const farY = 1.45;
        const farZ = THREE.MathUtils.clamp(aiPos.z + 4.8, -10.5, -2.5);

        const rawX =
          (nearX * nearWeight + netX * netWeight + farX * farWeight) /
          weightSum;
        const rawY =
          (nearY * nearWeight + netY * netWeight + farY * farWeight) /
          weightSum;
        const rawZ =
          (nearZ * nearWeight + netZ * netWeight + farZ * farWeight) /
          weightSum;

        // Keep outside net posts whenever camera Z passes near Z=0
        const safeX =
          Math.abs(rawZ) < 2.2 && Math.abs(rawX) < 6.15
            ? pointParity * 6.25
            : THREE.MathUtils.clamp(rawX, -7.8, 7.8);

        desiredPos.current.set(
          safeX,
          THREE.MathUtils.clamp(rawY, 0.85, 2.2),
          THREE.MathUtils.clamp(rawZ, -15.0, 15.0)
        );

        const strikerZ = ballVel.z >= 0 ? playerPos.z : aiPos.z;
        desiredTarget.current.set(
          ballPos.x * 0.8 + ballVel.x * 0.03,
          THREE.MathUtils.clamp(ballPos.y * 0.72 + 0.38, 0.55, 2.8),
          ballPos.z * 0.82 + strikerZ * 0.14 + ballVel.z * 0.025
        );
      }

      posLambda = 4.5;
      targetLambda = 7.8;
      targetFov = 55 + speedFactor * 4.5 - chargeFactor * 3.5;

      dampVec3(currentPos.current, desiredPos.current, posLambda, dt);
      dampVec3(currentTarget.current, desiredTarget.current, targetLambda, dt);

      camera.position.copy(currentPos.current).add(shakeOffset.current);
      lookAtScratch.current
        .copy(currentTarget.current)
        .addScaledVector(shakeOffset.current, 0.35);
      camera.lookAt(lookAtScratch.current);
    } else {
      // 7. Default Action Cam ('follow')
      const attractSwayX = attract ? Math.sin(elapsed * 0.35) * 0.25 : 0;
      const followY = THREE.MathUtils.clamp(
        4.95 +
          (playerPos.z - 11.65) * 0.08 +
          Math.max(0, ballPos.y - 1.5) * 0.16 -
          chargeFactor * 0.4,
        4.5,
        5.6
      );
      const followZ = 17.2 + playerPos.z * 0.15 - chargeFactor * 1.15;

      desiredPos.current.set(
        playerPos.x * 0.48 + attractSwayX,
        followY,
        followZ
      );
      desiredTarget.current.set(
        ballPos.x * 0.35,
        THREE.MathUtils.clamp(1.1 + (ballPos.y - 1.0) * 0.1, 0.9, 1.85),
        Math.min(ballPos.z * 0.3, -1.5)
      );

      posLambda = 6.5;
      targetLambda = 8.5;
      targetFov =
        50 -
        chargeFactor * 4.8 +
        (curPhase === 'rally' ? speedFactor * 4.0 : 0);

      dampVec3(currentPos.current, desiredPos.current, posLambda, dt);
      dampVec3(currentTarget.current, desiredTarget.current, targetLambda, dt);

      camera.position.copy(currentPos.current).add(shakeOffset.current);
      lookAtScratch.current
        .copy(currentTarget.current)
        .addScaledVector(shakeOffset.current, 0.3);
      camera.lookAt(lookAtScratch.current);
    }

    // 8. Dynamic FOV modulation (only call updateProjectionMatrix when changed significantly)
    if (isPerspectiveCamera(camera)) {
      const nextFov = THREE.MathUtils.damp(camera.fov, targetFov, 5.5, dt);
      if (Math.abs(nextFov - lastAppliedFov.current) > FOV_EPSILON) {
        camera.fov = nextFov;
        camera.updateProjectionMatrix();
        lastAppliedFov.current = nextFov;
      } else {
        camera.fov = nextFov;
      }
    }
  });

  return (
    <OrbitControls
      ref={orbitRef}
      enabled={isOrbitEnabled}
      enableDamping
      dampingFactor={0.06}
      enablePan
      minDistance={5}
      maxDistance={70}
      minPolarAngle={0.12}
      maxPolarAngle={Math.PI * 0.46}
      autoRotate={isOrbitEnabled && isAttractMode}
      autoRotateSpeed={0.65}
    />
  );
};

export default CinematicCamera;
