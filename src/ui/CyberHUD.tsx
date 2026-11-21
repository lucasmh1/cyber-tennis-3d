import React, { useEffect, useMemo } from 'react';
import {
  Activity,
  Camera,
  Cpu,
  Film,
  Flame,
  HelpCircle,
  Keyboard,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
  Trophy,
  Tv,
  Volume2,
  VolumeX,
  X,
  Zap,
} from 'lucide-react';
import { SURFACE_CONFIGS, useGameStore } from '../state/gameStore';
import { AIDifficulty, CameraMode, SpinType, SurfaceType } from '../types/game';

const SURFACE_ORDER: SurfaceType[] = [
  'neon-grass',
  'holographic-hard',
  'liquid-clay',
];

const SPIN_OPTIONS: {
  id: SpinType;
  keyHint: string;
  label: string;
  color: string;
  glow: string;
  desc: string;
}[] = [
  {
    id: 'topspin',
    keyHint: '1',
    label: 'TOPSPIN',
    color: '#ff4d8d',
    glow: 'rgba(255, 77, 141, 0.45)',
    desc: 'HIGH DIP + KICK',
  },
  {
    id: 'slice',
    keyHint: '2',
    label: 'SLICE',
    color: '#00e5ff',
    glow: 'rgba(0, 229, 255, 0.45)',
    desc: 'FLOAT + LOW SKID',
  },
  {
    id: 'flat',
    keyHint: '3',
    label: 'FLAT',
    color: '#d4ff00',
    glow: 'rgba(212, 255, 0, 0.45)',
    desc: 'MAX VELOCITY',
  },
];

const CAMERA_OPTIONS: { id: CameraMode; label: string }[] = [
  { id: 'follow', label: 'Follow' },
  { id: 'broadcast', label: 'Broadcast' },
  { id: 'closeup', label: 'Close-Up' },
  { id: 'orbit', label: 'Orbit' },
];

const AI_OPTIONS: { id: AIDifficulty; label: string }[] = [
  { id: 'rookie', label: 'Rookie' },
  { id: 'pro', label: 'Pro' },
  { id: 'cyber-god', label: 'Cyber-God' },
];

const EQUALIZER_WEIGHTS = [
  0.42, 0.68, 0.92, 0.56, 0.84, 1.0, 0.74, 0.95, 0.62, 0.88, 0.5, 0.72,
];

function formatTennisPoints(points: number): string {
  if (points <= 0) return '0';
  if (points === 1) return '15';
  if (points === 2) return '30';
  if (points === 3) return '40';
  return 'AD';
}

function getBounceLabel(restitution: number): string {
  if (restitution < 0.72) return 'LOW SKID';
  if (restitution < 0.82) return 'TRUE';
  return 'HIGH POP';
}

function stopNativePropagation(e: React.SyntheticEvent): void {
  e.stopPropagation();
  const native = e.nativeEvent as Event & {
    stopImmediatePropagation?: () => void;
  };
  if (typeof native.stopImmediatePropagation === 'function') {
    native.stopImmediatePropagation();
  }
}

const MagnusTrajectoryDiagram: React.FC<{
  spin: SpinType;
  spinColor: string;
  surfaceAccent: string;
}> = ({ spin, spinColor, surfaceAccent }) => {
  const pathData = useMemo(() => {
    if (spin === 'topspin') {
      return {
        flight: 'M 22 44 Q 112 4 172 60',
        bounce: 'M 172 60 Q 202 36 232 20',
        full: 'M 22 44 Q 112 4 172 60 Q 202 36 232 20',
        forceLabel: 'F_M ↓ MAGNUS DIP',
        forceArrow: 'M 136 20 L 136 37 M 131 32 L 136 38 L 141 32',
        spinDir: 'cw' as const,
      };
    }
    if (spin === 'slice') {
      return {
        flight: 'M 22 36 Q 116 28 182 60',
        bounce: 'M 182 60 L 234 51',
        full: 'M 22 36 Q 116 28 182 60 L 234 51',
        forceLabel: 'F_M ↑ FLOAT LIFT',
        forceArrow: 'M 136 34 L 136 17 M 131 22 L 136 16 L 141 22',
        spinDir: 'ccw' as const,
      };
    }
    return {
      flight: 'M 22 39 L 176 60',
      bounce: 'M 176 60 L 234 36',
      full: 'M 22 39 L 176 60 L 234 36',
      forceLabel: 'V_MAX → LASER DRIVE',
      forceArrow: 'M 124 22 L 148 22 M 143 17 L 149 22 L 143 27',
      spinDir: 'none' as const,
    };
  }, [spin]);

  return (
    <div className="chud-magnus-wrap">
      <svg
        viewBox="0 0 248 76"
        className="chud-magnus-svg"
        aria-label={`Magnus trajectory preview for ${spin}`}
      >
        <defs>
          <linearGradient
            id="chudMagnusGrad"
            x1="0%"
            y1="0%"
            x2="100%"
            y2="0%"
          >
            <stop offset="0%" stopColor={spinColor} stopOpacity="0.95" />
            <stop offset="100%" stopColor={surfaceAccent} stopOpacity="0.95" />
          </linearGradient>
          <filter id="chudSvgGlow" x="-20%" y="-20%" width="140%" height="140%">
            <feGaussianBlur stdDeviation="2.2" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Subtle radar grid */}
        <line
          x1="12"
          y1="20"
          x2="236"
          y2="20"
          stroke="rgba(148, 163, 184, 0.1)"
          strokeDasharray="2 4"
        />
        <line
          x1="12"
          y1="40"
          x2="236"
          y2="40"
          stroke="rgba(148, 163, 184, 0.1)"
          strokeDasharray="2 4"
        />
        <line
          x1="68"
          y1="8"
          x2="68"
          y2="62"
          stroke="rgba(148, 163, 184, 0.08)"
          strokeDasharray="2 4"
        />
        <line
          x1="180"
          y1="8"
          x2="180"
          y2="62"
          stroke="rgba(148, 163, 184, 0.08)"
          strokeDasharray="2 4"
        />

        {/* Court floor */}
        <line
          x1="10"
          y1="61"
          x2="238"
          y2="61"
          stroke={surfaceAccent}
          strokeOpacity="0.55"
          strokeWidth="1.5"
        />

        {/* Center holographic net */}
        <line
          x1="116"
          y1="41"
          x2="116"
          y2="61"
          stroke="rgba(226, 232, 240, 0.7)"
          strokeWidth="2"
        />
        <circle cx="116" cy="41" r="2" fill="#ffffff" />

        {/* Trajectory base glow */}
        <path
          d={pathData.full}
          fill="none"
          stroke={spinColor}
          strokeOpacity="0.22"
          strokeWidth="4.5"
          strokeLinecap="round"
        />

        {/* Animated dashed trajectory */}
        <path
          d={pathData.flight}
          fill="none"
          stroke="url(#chudMagnusGrad)"
          strokeWidth="2.1"
          strokeDasharray="5 4"
          strokeLinecap="round"
          filter="url(#chudSvgGlow)"
          className="chud-svg-dash-flow"
        />
        <path
          d={pathData.bounce}
          fill="none"
          stroke={surfaceAccent}
          strokeWidth="2"
          strokeDasharray="3 3"
          strokeLinecap="round"
          filter="url(#chudSvgGlow)"
          className="chud-svg-dash-flow"
        />

        {/* Bounce impact ripple */}
        <circle
          cx={spin === 'slice' ? 182 : spin === 'flat' ? 176 : 172}
          cy="61"
          r="4.5"
          fill="none"
          stroke={spinColor}
          strokeWidth="1.2"
          opacity="0.85"
        />

        {/* Magnus force indicator arrow */}
        <path
          d={pathData.forceArrow}
          fill="none"
          stroke={spinColor}
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <text
          x="154"
          y="16"
          fill={spinColor}
          fontSize="7.5"
          fontFamily="'JetBrains Mono', monospace"
          fontWeight="700"
          letterSpacing="0.06em"
        >
          {pathData.forceLabel}
        </text>

        {/* Spinning ball icon at launch origin */}
        <g transform="translate(22, 39)">
          <circle
            r="5.5"
            fill={spinColor}
            fillOpacity="0.22"
            stroke={spinColor}
            strokeWidth="1.5"
            filter="url(#chudSvgGlow)"
          />
          <circle r="2.2" fill="#ffffff" />
          {pathData.spinDir !== 'none' && (
            <g
              className={
                pathData.spinDir === 'cw'
                  ? 'chud-spin-orbit-cw'
                  : 'chud-spin-orbit-ccw'
              }
            >
              <path
                d={
                  pathData.spinDir === 'cw'
                    ? 'M -8.5 -2.5 A 9 9 0 0 1 8.5 -2.5 M 6.2 -5.0 L 8.7 -2.1 L 5.4 -1.0 M 8.5 2.5 A 9 9 0 0 1 -8.5 2.5 M -6.2 5.0 L -8.7 2.1 L -5.4 1.0'
                    : 'M 8.5 -2.5 A 9 9 0 0 0 -8.5 -2.5 M -6.2 -5.0 L -8.7 -2.1 L -5.4 -1.0 M -8.5 2.5 A 9 9 0 0 0 8.5 2.5 M 6.2 5.0 L 8.7 2.1 L 5.4 1.0'
                }
                fill="none"
                stroke="#ffffff"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </g>
          )}
        </g>
      </svg>
    </div>
  );
};

export const CyberHUD: React.FC = () => {
  const surface = useGameStore((s) => s.surface);
  const cameraMode = useGameStore((s) => s.cameraMode);
  const aiDifficulty = useGameStore((s) => s.aiDifficulty);
  const phase = useGameStore((s) => s.phase);
  const score = useGameStore((s) => s.score);
  const rallyCount = useGameStore((s) => s.rallyCount);
  const maxRallyCount = useGameStore((s) => s.maxRallyCount);
  const lastServeSpeedKmh = useGameStore((s) => s.lastServeSpeedKmh);
  const lastShotSpeedKmh = useGameStore((s) => s.lastShotSpeedKmh);
  const currentSpin = useGameStore((s) => s.currentSpin);
  const spinRpm = useGameStore((s) => s.spinRpm);
  const chargePower = useGameStore((s) => s.chargePower);
  const isCharging = useGameStore((s) => s.isCharging);
  const crowdExcitement = useGameStore((s) => s.crowdExcitement);
  const audioMuted = useGameStore((s) => s.audioMuted);
  const audioVolume = useGameStore((s) => s.audioVolume);
  const showControls = useGameStore((s) => s.showControls);
  const isAttractMode = useGameStore((s) => s.isAttractMode);

  const setSurface = useGameStore((s) => s.setSurface);
  const setCameraMode = useGameStore((s) => s.setCameraMode);
  const setAiDifficulty = useGameStore((s) => s.setAiDifficulty);
  const setCurrentSpin = useGameStore((s) => s.setCurrentSpin);
  const startReplay = useGameStore((s) => s.startReplay);
  const endReplay = useGameStore((s) => s.endReplay);
  const resetMatch = useGameStore((s) => s.resetMatch);
  const toggleAudioMute = useGameStore((s) => s.toggleAudioMute);
  const setAudioVolume = useGameStore((s) => s.setAudioVolume);
  const toggleControls = useGameStore((s) => s.toggleControls);
  const setAttractMode = useGameStore((s) => s.setAttractMode);

  const surfaceCfg = SURFACE_CONFIGS[surface];
  const activeSpinMeta =
    SPIN_OPTIONS.find((item) => item.id === currentSpin) ?? SPIN_OPTIONS[0];

  const isDeuce =
    score.playerPoints >= 3 &&
    score.aiPoints >= 3 &&
    score.playerPoints === score.aiPoints;
  const hasAdvantage =
    (score.playerPoints >= 4 || score.aiPoints >= 4) &&
    score.playerPoints !== score.aiPoints;

  const chargePct = Math.round(Math.max(0, Math.min(1, chargePower)) * 100);
  const hypePct = Math.round(Math.max(0, Math.min(1, crowdExcitement)) * 100);
  const serveSpeedPct = Math.min(100, Math.round((lastServeSpeedKmh / 230) * 100));
  const shotSpeedPct = Math.min(100, Math.round((lastShotSpeedKmh / 230) * 100));
  const isReplay = phase === 'replay';

  // Keyboard shortcut for Controls Modal [?] and [Escape]
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.key === '?') {
        e.preventDefault();
        toggleControls();
      } else if (e.key === 'Escape' && showControls && phase !== 'replay') {
        e.preventDefault();
        toggleControls();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleControls, showControls, phase]);

  const blurOnClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.currentTarget.blur();
  };

  return (
    <div
      className="chud-root"
      style={
        {
          '--hud-primary': surfaceCfg.primaryColor,
          '--hud-primary-border': `${surfaceCfg.primaryColor}59`,
          '--hud-primary-mid': `${surfaceCfg.primaryColor}70`,
          '--hud-primary-glow': `${surfaceCfg.primaryColor}26`,
          '--hud-primary-tint': `${surfaceCfg.primaryColor}33`,
          '--hud-secondary': surfaceCfg.secondaryColor,
          '--hud-accent': surfaceCfg.accentColor,
          '--spin-color': activeSpinMeta.color,
        } as React.CSSProperties
      }
    >
      <style>{CYBER_HUD_CSS}</style>

      {/* Main HUD Corners & Margins — Fades cleanly during 2.39:1 Replay */}
      <div className={`chud-main-layer ${isReplay ? 'chud-hidden-replay' : ''}`}>
        {/* 1. TOP-LEFT BROADCAST SCOREBOARD */}
        <section
          className="chud-interactive chud-panel chud-scoreboard"
          onPointerDown={stopNativePropagation}
          onMouseDown={stopNativePropagation}
          aria-label="Match Scoreboard"
        >
          <div className="chud-score-topbar">
            <div className="chud-live-tag">
              <span className="chud-live-dot" />
              <span>NEO-SKYLINE // CT-01</span>
            </div>
            <div className="chud-score-badges">
              {isDeuce && (
                <span className="chud-status-pill chud-pill-deuce">
                  DEUCE{score.deuceCount > 0 ? ` x${score.deuceCount + 1}` : ''}
                </span>
              )}
              {hasAdvantage && (
                <span className="chud-status-pill chud-pill-ad">ADVANTAGE</span>
              )}
              {isAttractMode && (
                <span className="chud-status-pill chud-pill-auto">AUTO</span>
              )}
              <button
                type="button"
                className="chud-icon-btn"
                title="Reset Match"
                aria-label="Reset Match"
                onClick={(e) => {
                  blurOnClick(e);
                  resetMatch();
                }}
              >
                <RotateCcw size={13} />
              </button>
            </div>
          </div>

          <div className="chud-score-grid">
            <div className="chud-score-head">COMPETITOR</div>
            <div className="chud-score-head chud-center">SET</div>
            <div className="chud-score-head chud-center">GM</div>
            <div className="chud-score-head chud-center">PTS</div>

            {/* Player Row */}
            <div
              className={`chud-score-player ${
                phase === 'point-over' && score.lastPointWinner === 'player'
                  ? 'chud-row-winner-player'
                  : ''
              }`}
            >
              <span
                className="chud-team-bar"
                style={{ background: '#00e5ff', boxShadow: '0 0 10px #00e5ff' }}
              />
              <span
                className={`chud-serve-orb ${
                  score.server === 'player' ? 'chud-serve-active-cyan' : ''
                }`}
                title={score.server === 'player' ? 'Serving' : ''}
              />
              <span className="chud-player-name">CYBER STRIKER</span>
              <span className="chud-you-tag">
                {isAttractMode ? 'BOT' : 'YOU'}
              </span>
            </div>
            <div className="chud-score-cell chud-num">
              {score.playerSets}
            </div>
            <div className="chud-score-cell chud-num">
              {score.playerGames}
            </div>
            <div
              className={`chud-score-cell chud-pts ${
                score.playerPoints === 4 ? 'chud-pts-ad' : ''
              }`}
            >
              {formatTennisPoints(score.playerPoints)}
            </div>

            {/* AI Row */}
            <div
              className={`chud-score-player ${
                phase === 'point-over' && score.lastPointWinner === 'ai'
                  ? 'chud-row-winner-ai'
                  : ''
              }`}
            >
              <span
                className="chud-team-bar"
                style={{ background: '#ff2a85', boxShadow: '0 0 10px #ff2a85' }}
              />
              <span
                className={`chud-serve-orb ${
                  score.server === 'ai' ? 'chud-serve-active-pink' : ''
                }`}
                title={score.server === 'ai' ? 'Serving' : ''}
              />
              <span className="chud-player-name">NEXUS AI</span>
              <span className="chud-ai-tag">{aiDifficulty.toUpperCase()}</span>
            </div>
            <div className="chud-score-cell chud-num">{score.aiSets}</div>
            <div className="chud-score-cell chud-num">{score.aiGames}</div>
            <div
              className={`chud-score-cell chud-pts ${
                score.aiPoints === 4 ? 'chud-pts-ad' : ''
              }`}
            >
              {formatTennisPoints(score.aiPoints)}
            </div>
          </div>
        </section>

        {/* 2. TOP-CENTER DYNAMIC BROADCAST CALLOUT BANNER */}
        <div className="chud-top-center-slot" aria-live="polite">
          {phase === 'point-over' && (
            <div
              className={`chud-callout-banner ${
                score.lastPointWinner === 'ai'
                  ? 'chud-callout-ai'
                  : 'chud-callout-player'
              }`}
            >
              <div className="chud-callout-eyebrow">
                {score.lastPointWinner === 'player'
                  ? 'CYBER STRIKER POINT'
                  : score.lastPointWinner === 'ai'
                    ? 'NEXUS AI POINT'
                    : 'POINT CALL'}
                {lastShotSpeedKmh > 0 ? ` // ${lastShotSpeedKmh} KM/H` : ''}
              </div>
              <div className="chud-callout-title">
                {score.lastPointReason || 'POINT!'}
              </div>
            </div>
          )}

          {phase === 'rally' && rallyCount >= 5 && (
            <div className="chud-rally-streak-pill">
              <Flame size={15} className="chud-flame-icon" />
              <span>
                RALLY x{rallyCount} //{' '}
                {rallyCount >= 15 ? 'HYPER OVERDRIVE' : 'ON FIRE'}
              </span>
            </div>
          )}

          {phase === 'pre-serve' &&
            !isAttractMode &&
            score.server === 'player' && (
              <div className="chud-serve-prompt">
                <Zap size={14} />
                <span>PRESS SPACE TO SERVE</span>
                <span className="chud-serve-sub">HOLD FOR POWER</span>
              </div>
            )}

          {phase === 'pre-serve' &&
            !isAttractMode &&
            score.server === 'ai' && (
              <div className="chud-ai-serve-tag">
                <span>NEXUS AI PREPARING SERVE...</span>
              </div>
            )}

          {isAttractMode && phase !== 'point-over' && (
            <div
              className="chud-interactive chud-trailer-banner"
              onPointerDown={stopNativePropagation}
              onMouseDown={stopNativePropagation}
            >
              <span className="chud-live-dot" />
              <span>TRAILER // AI-VS-AI SHOWCASE</span>
              <button
                type="button"
                className="chud-trailer-takeover-btn"
                onClick={(e) => {
                  blurOnClick(e);
                  setAttractMode(false);
                }}
              >
                TAKE CONTROL
              </button>
            </div>
          )}
        </div>

        {/* 3. TOP-RIGHT RALLY, SERVE SPEED & CROWD HYPE TELEMETRY */}
        <section
          className="chud-panel chud-telemetry"
          aria-label="Match Telemetry"
        >
          <div className="chud-telemetry-top">
            <div className="chud-rally-block">
              <span className="chud-micro-label">RALLY</span>
              <span
                className={`chud-rally-value ${
                  rallyCount >= 5 ? 'chud-rally-hot' : ''
                }`}
              >
                {rallyCount}
              </span>
            </div>
            <div className="chud-best-rally">
              <Trophy size={12} />
              <span>BEST {maxRallyCount}</span>
            </div>
          </div>

          <div className="chud-radar-list">
            <div className="chud-radar-item">
              <div className="chud-radar-row">
                <span className="chud-micro-label">SERVE SPEED</span>
                <span className="chud-mono-val">
                  {lastServeSpeedKmh}{' '}
                  <span className="chud-unit">KM/H</span>
                </span>
              </div>
              <div className="chud-bar-track">
                <div
                  className="chud-bar-fill chud-bar-serve"
                  style={{ width: `${serveSpeedPct}%` }}
                />
              </div>
            </div>

            <div className="chud-radar-item">
              <div className="chud-radar-row">
                <span className="chud-micro-label">SHOT SPEED</span>
                <span
                  className={`chud-mono-val ${
                    lastShotSpeedKmh >= 170 ? 'chud-speed-hot' : ''
                  }`}
                >
                  {lastShotSpeedKmh}{' '}
                  <span className="chud-unit">KM/H</span>
                </span>
              </div>
              <div className="chud-bar-track">
                <div
                  className="chud-bar-fill chud-bar-shot"
                  style={{
                    width: `${shotSpeedPct}%`,
                    background:
                      lastShotSpeedKmh >= 170
                        ? 'linear-gradient(90deg, #ff9900, #ff2a85)'
                        : undefined,
                  }}
                />
              </div>
            </div>

            <div className="chud-radar-item">
              <div className="chud-radar-row">
                <span className="chud-micro-label chud-hype-label">
                  <Activity size={11} />
                  <span>CROWD HYPE</span>
                </span>
                <span className="chud-mono-val">{hypePct}%</span>
              </div>
              <div className="chud-hype-eq">
                {EQUALIZER_WEIGHTS.map((weight, idx) => {
                  const barHeightPct = Math.max(
                    18,
                    Math.min(100, Math.round(hypePct * weight + 14))
                  );
                  return (
                    <span
                      key={idx}
                      className="chud-eq-bar"
                      style={{
                        height: `${barHeightPct}%`,
                        animationDelay: `${idx * 0.08}s`,
                        animationDuration: `${Math.max(
                          0.35,
                          1.15 - crowdExcitement * 0.72
                        )}s`,
                      }}
                    />
                  );
                })}
              </div>
              <div className="chud-bar-track chud-bar-track-thin">
                <div
                  className="chud-bar-fill chud-bar-hype"
                  style={{ width: `${hypePct}%` }}
                />
              </div>
            </div>
          </div>
        </section>

        {/* 4. BOTTOM-LEFT SPIN & POWER CHARGE INDICATOR */}
        <section
          className="chud-interactive chud-panel chud-spin-panel"
          onPointerDown={stopNativePropagation}
          onMouseDown={stopNativePropagation}
          aria-label="Spin and Power Charge"
        >
          <div className="chud-panel-header">
            <span className="chud-micro-label">MAGNUS SPIN CONTROL</span>
            <span
              className="chud-rpm-badge"
              style={{
                color: activeSpinMeta.color,
                borderColor: activeSpinMeta.glow,
              }}
            >
              {spinRpm.toLocaleString()} RPM
            </span>
          </div>

          <div className="chud-spin-pills">
            {SPIN_OPTIONS.map((opt) => {
              const active = currentSpin === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  className={`chud-spin-pill ${active ? 'is-active' : ''}`}
                  style={
                    active
                      ? {
                          borderColor: opt.color,
                          boxShadow: `0 0 14px ${opt.glow}, inset 0 0 10px ${opt.glow}`,
                          color: '#ffffff',
                        }
                      : undefined
                  }
                  onClick={(e) => {
                    blurOnClick(e);
                    setCurrentSpin(opt.id);
                  }}
                >
                  <span className="chud-keycap-mini">{opt.keyHint}</span>
                  <span>{opt.label}</span>
                </button>
              );
            })}
          </div>

          <MagnusTrajectoryDiagram
            spin={currentSpin}
            spinColor={activeSpinMeta.color}
            surfaceAccent={surfaceCfg.primaryColor}
          />

          <div className="chud-charge-wrap">
            <div className="chud-radar-row">
              <span className="chud-micro-label chud-hype-label">
                <Zap
                  size={11}
                  color={isCharging ? '#ffe600' : surfaceCfg.primaryColor}
                />
                <span>
                  {isCharging ? 'POWER CHARGE // LIVE' : 'POWER CHARGE'}
                </span>
              </span>
              <span
                className={`chud-mono-val ${
                  isCharging ? 'chud-charge-hot' : ''
                }`}
              >
                {chargePct}%
              </span>
            </div>
            <div
              className={`chud-charge-track ${
                isCharging ? 'is-charging' : ''
              }`}
            >
              <div
                className="chud-charge-fill"
                style={{ width: `${chargePct}%` }}
              />
              <div className="chud-charge-ticks" />
            </div>
          </div>
        </section>

        {/* 5. BOTTOM-CENTER SURFACE MORPH SELECTOR */}
        <section
          className="chud-interactive chud-surface-dock"
          onPointerDown={stopNativePropagation}
          onMouseDown={stopNativePropagation}
          aria-label="Court Surface Selector"
        >
          <div className="chud-surface-label">
            <Sparkles size={11} />
            <span>ARENA SURFACE MORPH</span>
          </div>
          <div className="chud-surface-cards">
            {SURFACE_ORDER.map((id) => {
              const cfg = SURFACE_CONFIGS[id];
              const active = surface === id;
              const bouncePct = Math.round(cfg.restitution * 100);
              const spinPct = Math.min(
                100,
                Math.round((cfg.spinMultiplier / 1.75) * 100)
              );
              return (
                <button
                  key={id}
                  type="button"
                  className={`chud-surface-card ${active ? 'is-active' : ''}`}
                  style={
                    {
                      '--card-primary': cfg.primaryColor,
                      '--card-secondary': cfg.secondaryColor,
                      borderColor: active
                        ? cfg.primaryColor
                        : 'rgba(148, 163, 184, 0.22)',
                      boxShadow: active
                        ? `0 0 18px ${cfg.primaryColor}40, inset 0 0 16px ${cfg.primaryColor}22`
                        : undefined,
                    } as React.CSSProperties
                  }
                  onClick={(e) => {
                    blurOnClick(e);
                    setSurface(id);
                  }}
                >
                  <div className="chud-surface-card-top">
                    <span
                      className="chud-surface-dot"
                      style={{
                        background: cfg.primaryColor,
                        boxShadow: active
                          ? `0 0 8px ${cfg.primaryColor}`
                          : 'none',
                      }}
                    />
                    <span className="chud-surface-name">{cfg.name}</span>
                  </div>
                  <div className="chud-surface-traits">
                    <div className="chud-trait">
                      <span>BOUNCE</span>
                      <span className="chud-trait-tag">
                        {getBounceLabel(cfg.restitution)}
                      </span>
                      <div className="chud-trait-bar">
                        <div
                          style={{
                            width: `${bouncePct}%`,
                            background: cfg.primaryColor,
                          }}
                        />
                      </div>
                    </div>
                    <div className="chud-trait">
                      <span>SPIN GRIP</span>
                      <span className="chud-trait-tag">
                        {cfg.spinMultiplier.toFixed(2)}x
                      </span>
                      <div className="chud-trait-bar">
                        <div
                          style={{
                            width: `${spinPct}%`,
                            background: cfg.secondaryColor,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        </section>

        {/* 6. BOTTOM-RIGHT CAMERA, AI, TRAILER MODE & AUDIO CONTROLS */}
        <section
          className="chud-interactive chud-panel chud-controls-deck"
          onPointerDown={stopNativePropagation}
          onMouseDown={stopNativePropagation}
          aria-label="Camera, AI, Trailer and Audio Controls"
        >
          {/* Camera Modes */}
          <div className="chud-deck-group">
            <div className="chud-deck-head">
              <span className="chud-micro-label chud-hype-label">
                <Camera size={11} />
                <span>CAMERA</span>
              </span>
              <span className="chud-shortcut-chip">[C]</span>
            </div>
            <div className="chud-pill-grid-4">
              {CAMERA_OPTIONS.map((opt) => {
                const active = cameraMode === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`chud-deck-btn ${active ? 'is-active' : ''}`}
                    onClick={(e) => {
                      blurOnClick(e);
                      setCameraMode(opt.id);
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* AI Difficulty */}
          <div className="chud-deck-group">
            <div className="chud-deck-head">
              <span className="chud-micro-label chud-hype-label">
                <Cpu size={11} />
                <span>AI DIFFICULTY</span>
              </span>
            </div>
            <div className="chud-pill-grid-3">
              {AI_OPTIONS.map((opt) => {
                const active = aiDifficulty === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    className={`chud-deck-btn ${active ? 'is-active' : ''}`}
                    onClick={(e) => {
                      blurOnClick(e);
                      setAiDifficulty(opt.id);
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Trailer / Auto-Play + Replay + Audio + Controls */}
          <div className="chud-deck-footer">
            <button
              type="button"
              className={`chud-trailer-btn ${
                isAttractMode ? 'is-active' : ''
              }`}
              title="Toggle Hands-Free Cinematic AI-vs-AI Showcase"
              onClick={(e) => {
                blurOnClick(e);
                setAttractMode(!isAttractMode);
              }}
            >
              {isAttractMode ? <Tv size={13} /> : <Play size={13} />}
              <span>{isAttractMode ? 'TRAILER ON' : 'TRAILER'}</span>
            </button>

            <button
              type="button"
              className="chud-util-btn"
              title="Instant Replay [R]"
              onClick={(e) => {
                blurOnClick(e);
                startReplay();
              }}
            >
              <Film size={13} />
              <span>[R]</span>
            </button>

            <div className="chud-audio-box">
              <button
                type="button"
                className="chud-icon-btn"
                title={audioMuted ? 'Unmute Audio' : 'Mute Audio'}
                aria-label={audioMuted ? 'Unmute Audio' : 'Mute Audio'}
                onClick={(e) => {
                  blurOnClick(e);
                  toggleAudioMute();
                }}
              >
                {audioMuted || audioVolume === 0 ? (
                  <VolumeX size={14} color="#ff4d8d" />
                ) : (
                  <Volume2 size={14} />
                )}
              </button>
              <input
                type="range"
                min={0}
                max={1}
                step={0.02}
                value={audioMuted ? 0 : audioVolume}
                aria-label="Audio Volume"
                className="chud-volume-slider"
                onChange={(e) => {
                  const val = parseFloat(e.target.value);
                  if (audioMuted && val > 0) {
                    toggleAudioMute();
                  }
                  setAudioVolume(val);
                }}
              />
            </div>

            <button
              type="button"
              className={`chud-util-btn ${showControls ? 'is-active' : ''}`}
              title="Controls Guide [?]"
              aria-label="Controls Guide"
              onClick={(e) => {
                blurOnClick(e);
                toggleControls();
              }}
            >
              <HelpCircle size={13} />
              <span>[?]</span>
            </button>
          </div>
        </section>
      </div>

      {/* 7. SLOW-MOTION ACTION REPLAY BROADCAST OVERLAY (2.39:1 Letterbox) */}
      {isReplay && (
        <div
          className="chud-replay-overlay"
          aria-label="Slow-Motion Replay Overlay"
        >
          <div className="chud-letterbox chud-letterbox-top">
            <div className="chud-replay-badge">
              <span className="chud-replay-rec-dot" />
              <span>● SLOW-MO REPLAY // MAGNUS TRACKING 0.28x</span>
            </div>
            <div className="chud-replay-telemetry">
              <span>{currentSpin.toUpperCase()}</span>
              <span>//</span>
              <span>{spinRpm.toLocaleString()} RPM</span>
              {lastShotSpeedKmh > 0 && (
                <>
                  <span>//</span>
                  <span>{lastShotSpeedKmh} KM/H</span>
                </>
              )}
            </div>
          </div>

          <div className="chud-replay-frame-corners">
            <span className="chud-corner chud-tl" />
            <span className="chud-corner chud-tr" />
            <span className="chud-corner chud-bl" />
            <span className="chud-corner chud-br" />
          </div>

          <div className="chud-letterbox chud-letterbox-bottom">
            <div className="chud-replay-sub">
              <span>HAWK-EYE TELEMETRY FEED</span>
              <span className="chud-replay-sep">//</span>
              <span>{surfaceCfg.name}</span>
            </div>
            <button
              type="button"
              className="chud-interactive chud-skip-btn"
              onPointerDown={stopNativePropagation}
              onMouseDown={stopNativePropagation}
              onClick={(e) => {
                blurOnClick(e);
                endReplay();
              }}
            >
              <SkipForward size={14} />
              <span>SKIP REPLAY [SPACE]</span>
            </button>
          </div>
        </div>
      )}

      {/* 8. CONTROLS QUICK-GUIDE MODAL */}
      {showControls && (
        <div
          className="chud-interactive chud-modal-backdrop"
          onPointerDown={stopNativePropagation}
          onMouseDown={stopNativePropagation}
          onClick={() => toggleControls()}
          role="dialog"
          aria-modal="true"
          aria-label="Controls Quick Guide"
        >
          <div
            className="chud-modal-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="chud-modal-header">
              <div className="chud-modal-title-wrap">
                <Keyboard size={18} color={surfaceCfg.primaryColor} />
                <div>
                  <div className="chud-modal-eyebrow">
                    NEURAL RACKET INTERFACE
                  </div>
                  <h2 className="chud-modal-title">CONTROLS QUICK-GUIDE</h2>
                </div>
              </div>
              <button
                type="button"
                className="chud-icon-btn chud-modal-close"
                aria-label="Close Controls Guide"
                onClick={(e) => {
                  blurOnClick(e);
                  toggleControls();
                }}
              >
                <X size={16} />
              </button>
            </div>

            <div className="chud-controls-list">
              <div className="chud-control-row">
                <span className="chud-control-action">Move Player</span>
                <span className="chud-control-keys">
                  <kbd>WASD</kbd> <span className="chud-or">/</span>{' '}
                  <kbd>Arrows</kbd>
                </span>
              </div>
              <div className="chud-control-row">
                <span className="chud-control-action">Aim Shot Placement</span>
                <span className="chud-control-keys">
                  <kbd>Mouse</kbd>
                </span>
              </div>
              <div className="chud-control-row">
                <span className="chud-control-action">
                  Serve, Swing &amp; Charge
                </span>
                <span className="chud-control-keys">
                  <kbd>Click</kbd> <span className="chud-or">or</span>{' '}
                  <kbd>Space</kbd>
                </span>
              </div>
              <div className="chud-control-row">
                <span className="chud-control-action">
                  Spin (Topspin / Slice / Flat)
                </span>
                <span className="chud-control-keys">
                  <kbd>1 / 2 / 3</kbd> <span className="chud-or">or</span>{' '}
                  <kbd>L / R / Mid Click</kbd>
                </span>
              </div>
              <div className="chud-control-row">
                <span className="chud-control-action">Cycle Camera Mode</span>
                <span className="chud-control-keys">
                  <kbd>C</kbd>
                </span>
              </div>
              <div className="chud-control-row">
                <span className="chud-control-action">Instant Replay</span>
                <span className="chud-control-keys">
                  <kbd>R</kbd> <span className="chud-or">(Skip: Space)</span>
                </span>
              </div>
              <div className="chud-control-row">
                <span className="chud-control-action">Auto-Showcase Mode</span>
                <span className="chud-control-keys">
                  <button
                    type="button"
                    className={`chud-modal-trailer-pill ${
                      isAttractMode ? 'is-active' : ''
                    }`}
                    onClick={(e) => {
                      blurOnClick(e);
                      setAttractMode(!isAttractMode);
                    }}
                  >
                    <Tv size={12} />
                    <span>
                      {isAttractMode ? 'TRAILER ACTIVE' : 'TRAILER button'}
                    </span>
                  </button>
                </span>
              </div>
            </div>

            <div className="chud-modal-footer">
              <span className="chud-modal-tip">
                TIP: Switch surfaces at the bottom dock to alter bounce height
                and Magnus spin bite live.
              </span>
              <button
                type="button"
                className="chud-modal-done-btn"
                onClick={(e) => {
                  blurOnClick(e);
                  toggleControls();
                }}
              >
                RETURN TO COURT
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default CyberHUD;

const CYBER_HUD_CSS = `
.chud-root {
  position: fixed;
  inset: 0;
  z-index: 25;
  pointer-events: none;
  overflow: hidden;
  user-select: none;
  font-family: 'Rajdhani', system-ui, -apple-system, sans-serif;
  color: #e8f4ff;
}

.chud-root *,
.chud-root *::before,
.chud-root *::after {
  box-sizing: border-box;
}

.chud-interactive {
  pointer-events: auto;
}

.chud-main-layer {
  position: absolute;
  inset: 0;
  pointer-events: none;
  transition: opacity 0.28s ease, transform 0.28s ease;
}

.chud-main-layer.chud-hidden-replay {
  opacity: 0;
  pointer-events: none !important;
}

.chud-main-layer.chud-hidden-replay .chud-interactive {
  pointer-events: none !important;
}

.chud-panel {
  background: linear-gradient(145deg, rgba(8, 13, 28, 0.84), rgba(4, 8, 19, 0.88));
  border: 1px solid var(--hud-primary-border);
  box-shadow:
    0 12px 34px rgba(0, 0, 0, 0.56),
    0 0 18px var(--hud-primary-glow),
    inset 0 1px 0 rgba(255, 255, 255, 0.08);
  backdrop-filter: blur(14px) saturate(135%);
  -webkit-backdrop-filter: blur(14px) saturate(135%);
  transition: border-color 0.35s ease, box-shadow 0.35s ease;
}

.chud-micro-label {
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: rgba(186, 214, 240, 0.72);
  text-transform: uppercase;
}

.chud-mono-val {
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
  font-weight: 700;
  color: #f0f9ff;
}

.chud-unit {
  font-size: 9px;
  color: rgba(148, 184, 218, 0.65);
}

.chud-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border-radius: 5px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(15, 23, 42, 0.72);
  color: #cbd5e1;
  cursor: pointer;
  transition: all 0.18s ease;
}

.chud-icon-btn:hover {
  border-color: var(--hud-primary);
  color: #ffffff;
  box-shadow: 0 0 10px var(--hud-primary-border);
}

.chud-live-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: #00ffa3;
  box-shadow: 0 0 8px #00ffa3;
  animation: chudPulse 1.4s ease-in-out infinite;
}

/* 1. TOP-LEFT SCOREBOARD */
.chud-scoreboard {
  position: absolute;
  top: 14px;
  left: 16px;
  width: clamp(304px, 24vw, 344px);
  padding: 9px 11px 10px;
  border-radius: 8px 14px 8px 8px;
  clip-path: polygon(0 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%);
}

.chud-score-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 7px;
  padding-bottom: 6px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
}

.chud-live-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--hud-primary);
}

.chud-score-badges {
  display: inline-flex;
  align-items: center;
  gap: 5px;
}

.chud-status-pill {
  padding: 2px 6px;
  border-radius: 4px;
  font-family: 'Orbitron', sans-serif;
  font-size: 8.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
}

.chud-pill-deuce {
  background: rgba(255, 153, 0, 0.18);
  border: 1px solid rgba(255, 153, 0, 0.65);
  color: #ffcc66;
}

.chud-pill-ad {
  background: rgba(255, 42, 133, 0.22);
  border: 1px solid rgba(255, 42, 133, 0.72);
  color: #ff7ab8;
}

.chud-pill-auto {
  background: rgba(0, 229, 255, 0.16);
  border: 1px solid rgba(0, 229, 255, 0.55);
  color: #67e8f9;
}

.chud-score-grid {
  display: grid;
  grid-template-columns: 1fr 28px 28px 36px;
  gap: 4px 5px;
  align-items: center;
}

.chud-score-head {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: rgba(148, 163, 184, 0.72);
}

.chud-center {
  text-align: center;
}

.chud-score-player {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  padding: 5px 6px;
  border-radius: 5px;
  background: rgba(15, 23, 42, 0.55);
  border: 1px solid rgba(148, 163, 184, 0.1);
}

.chud-row-winner-player {
  border-color: rgba(0, 229, 255, 0.65);
  background: rgba(0, 229, 255, 0.14);
}

.chud-row-winner-ai {
  border-color: rgba(255, 42, 133, 0.65);
  background: rgba(255, 42, 133, 0.14);
}

.chud-team-bar {
  width: 3px;
  height: 15px;
  border-radius: 2px;
  flex-shrink: 0;
}

.chud-serve-orb {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: rgba(148, 163, 184, 0.16);
  flex-shrink: 0;
  transition: all 0.25s ease;
}

.chud-serve-active-cyan {
  background: #00e5ff;
  box-shadow: 0 0 8px #00e5ff, 0 0 14px #00e5ff;
  animation: chudPulse 1.1s ease-in-out infinite;
}

.chud-serve-active-pink {
  background: #ff2a85;
  box-shadow: 0 0 8px #ff2a85, 0 0 14px #ff2a85;
  animation: chudPulse 1.1s ease-in-out infinite;
}

.chud-player-name {
  font-family: 'Orbitron', sans-serif;
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.03em;
  color: #f8fafc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chud-you-tag,
.chud-ai-tag {
  margin-left: auto;
  padding: 1px 4px;
  border-radius: 3px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 7.5px;
  font-weight: 700;
  flex-shrink: 0;
}

.chud-you-tag {
  background: rgba(0, 229, 255, 0.16);
  color: #5eead4;
}

.chud-ai-tag {
  background: rgba(255, 42, 133, 0.16);
  color: #f9a8d4;
}

.chud-score-cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  border-radius: 5px;
  font-family: 'Orbitron', sans-serif;
}

.chud-num {
  font-size: 13px;
  font-weight: 700;
  background: rgba(15, 23, 42, 0.55);
  color: #cbd5e1;
}

.chud-pts {
  font-size: 14px;
  font-weight: 800;
  background: rgba(2, 6, 23, 0.8);
  border: 1px solid var(--hud-primary-mid);
  color: #ffffff;
  text-shadow: 0 0 10px var(--hud-primary-mid);
}

.chud-pts-ad {
  border-color: #ff9900;
  color: #ffd166;
  text-shadow: 0 0 10px rgba(255, 153, 0, 0.7);
}

/* 2. TOP-CENTER DYNAMIC CALLOUT BANNER */
.chud-top-center-slot {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: min(460px, 42vw);
  z-index: 4;
}

.chud-callout-banner {
  padding: 9px 26px 10px;
  text-align: center;
  background: linear-gradient(135deg, rgba(6, 11, 26, 0.92), rgba(14, 22, 46, 0.88));
  border: 1.5px solid #00e5ff;
  box-shadow:
    0 0 28px rgba(0, 229, 255, 0.35),
    0 12px 30px rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(14px);
  clip-path: polygon(14px 0, 100% 0, calc(100% - 14px) 100%, 0 100%);
  animation: chudCalloutPop 0.34s cubic-bezier(0.16, 1, 0.3, 1);
}

.chud-callout-banner.chud-callout-ai {
  border-color: #ff2a85;
  box-shadow:
    0 0 28px rgba(255, 42, 133, 0.38),
    0 12px 30px rgba(0, 0, 0, 0.6);
}

.chud-callout-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.16em;
  color: rgba(226, 232, 240, 0.8);
}

.chud-callout-title {
  font-family: 'Orbitron', sans-serif;
  font-size: clamp(18px, 2.2vw, 26px);
  font-weight: 900;
  letter-spacing: 0.08em;
  color: #ffffff;
  text-shadow: 0 0 16px var(--hud-primary);
  white-space: nowrap;
}

.chud-rally-streak-pill {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 18px;
  border-radius: 999px;
  background: linear-gradient(90deg, rgba(255, 68, 0, 0.25), rgba(255, 0, 136, 0.25));
  border: 1px solid #ff7b00;
  box-shadow: 0 0 22px rgba(255, 115, 0, 0.45);
  backdrop-filter: blur(10px);
  font-family: 'Orbitron', sans-serif;
  font-size: 12.5px;
  font-weight: 800;
  letter-spacing: 0.1em;
  color: #fff3d6;
  animation: chudPulse 0.9s ease-in-out infinite;
}

.chud-flame-icon {
  color: #ff9900;
  filter: drop-shadow(0 0 6px #ff5500);
}

.chud-serve-prompt {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 7px 18px;
  border-radius: 999px;
  background: rgba(6, 12, 28, 0.82);
  border: 1px solid var(--hud-primary);
  box-shadow: 0 0 18px var(--hud-primary-border);
  backdrop-filter: blur(10px);
  font-family: 'Orbitron', sans-serif;
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.11em;
  color: #ffffff;
  animation: chudPulse 1.5s ease-in-out infinite;
}

.chud-serve-sub {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  color: var(--hud-primary);
  padding-left: 6px;
  border-left: 1px solid rgba(148, 163, 184, 0.35);
}

.chud-ai-serve-tag {
  padding: 5px 14px;
  border-radius: 999px;
  background: rgba(15, 10, 28, 0.78);
  border: 1px solid rgba(255, 42, 133, 0.45);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  color: #f9a8d4;
}

.chud-trailer-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 5px 10px 5px 12px;
  border-radius: 999px;
  background: rgba(7, 13, 28, 0.84);
  border: 1px solid rgba(0, 229, 255, 0.45);
  backdrop-filter: blur(10px);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #a5f3fc;
}

.chud-trailer-takeover-btn {
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid #00ffa3;
  background: rgba(0, 255, 163, 0.16);
  color: #00ffa3;
  font-family: 'Orbitron', sans-serif;
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;
  transition: all 0.18s ease;
}

.chud-trailer-takeover-btn:hover {
  background: #00ffa3;
  color: #041016;
}

/* 3. TOP-RIGHT TELEMETRY */
.chud-telemetry {
  position: absolute;
  top: 14px;
  right: 16px;
  width: min(252px, 24vw);
  min-width: 224px;
  padding: 10px 12px;
  border-radius: 14px 8px 8px 8px;
  clip-path: polygon(0 0, 100% 0, 100% 100%, 10px 100%, 0 calc(100% - 10px));
}

.chud-telemetry-top {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 8px;
  padding-bottom: 7px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.16);
}

.chud-rally-block {
  display: flex;
  flex-direction: column;
  line-height: 1;
}

.chud-rally-value {
  font-family: 'Orbitron', sans-serif;
  font-size: 28px;
  font-weight: 900;
  line-height: 1.05;
  color: var(--hud-primary);
  text-shadow: 0 0 16px var(--hud-primary-mid);
}

.chud-rally-value.chud-rally-hot {
  color: #ff9900;
  text-shadow: 0 0 18px rgba(255, 115, 0, 0.78);
}

.chud-best-rally {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  border-radius: 5px;
  background: rgba(255, 196, 0, 0.12);
  border: 1px solid rgba(255, 196, 0, 0.35);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10px;
  font-weight: 700;
  color: #fde047;
}

.chud-radar-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.chud-radar-item {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.chud-radar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chud-speed-hot {
  color: #ff9e00;
  text-shadow: 0 0 10px rgba(255, 153, 0, 0.65);
}

.chud-bar-track {
  position: relative;
  height: 6px;
  border-radius: 3px;
  background: rgba(15, 23, 42, 0.85);
  border: 1px solid rgba(148, 163, 184, 0.14);
  overflow: hidden;
}

.chud-bar-track-thin {
  height: 4px;
}

.chud-bar-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.22s ease;
}

.chud-bar-serve {
  background: linear-gradient(90deg, var(--hud-secondary), var(--hud-primary));
  box-shadow: 0 0 10px var(--hud-primary);
}

.chud-bar-shot {
  background: linear-gradient(90deg, #00e5ff, #00ffa3);
  box-shadow: 0 0 10px rgba(0, 229, 255, 0.55);
}

.chud-bar-hype {
  background: linear-gradient(90deg, #00d4ff, #ff00aa, #ff9900);
}

.chud-hype-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.chud-hype-eq {
  display: grid;
  grid-template-columns: repeat(12, 1fr);
  align-items: end;
  gap: 3px;
  height: 18px;
  padding: 1px 0;
}

.chud-eq-bar {
  display: block;
  width: 100%;
  border-radius: 2px 2px 0 0;
  background: linear-gradient(to top, var(--hud-primary), var(--hud-secondary));
  transform-origin: bottom center;
  animation: chudEqDance 0.8s ease-in-out infinite alternate;
}

/* 4. BOTTOM-LEFT SPIN & CHARGE */
.chud-spin-panel {
  position: absolute;
  bottom: 14px;
  left: 16px;
  width: clamp(256px, 23vw, 276px);
  padding: 10px 12px;
  border-radius: 8px 12px 8px 8px;
  clip-path: polygon(0 0, calc(100% - 10px) 0, 100% 10px, 100% 100%, 0 100%);
}

.chud-panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
}

.chud-rpm-badge {
  padding: 1px 7px;
  border-radius: 4px;
  border: 1px solid;
  background: rgba(2, 6, 23, 0.72);
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 700;
}

.chud-spin-pills {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 5px;
  margin-bottom: 7px;
}

.chud-spin-pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  padding: 5px 4px;
  border-radius: 5px;
  border: 1px solid rgba(148, 163, 184, 0.24);
  background: rgba(15, 23, 42, 0.65);
  color: rgba(203, 213, 225, 0.86);
  font-family: 'Orbitron', sans-serif;
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: all 0.16s ease;
}

.chud-spin-pill:hover {
  border-color: rgba(255, 255, 255, 0.45);
  color: #ffffff;
}

.chud-keycap-mini {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
  font-family: 'JetBrains Mono', monospace;
  font-size: 8.5px;
  color: rgba(226, 232, 240, 0.85);
}

.chud-magnus-wrap {
  border-radius: 6px;
  background: rgba(3, 7, 18, 0.74);
  border: 1px solid rgba(148, 163, 184, 0.16);
  padding: 3px 4px;
  margin-bottom: 8px;
}

.chud-magnus-svg {
  display: block;
  width: 100%;
  height: 66px;
}

.chud-svg-dash-flow {
  animation: chudDashFlow 1.1s linear infinite;
}

.chud-spin-orbit-cw {
  transform-box: fill-box;
  transform-origin: center;
  animation: chudSpinCW 1.15s linear infinite;
}

.chud-spin-orbit-ccw {
  transform-box: fill-box;
  transform-origin: center;
  animation: chudSpinCCW 1.15s linear infinite;
}

.chud-charge-wrap {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chud-charge-hot {
  color: #fde047;
  text-shadow: 0 0 10px rgba(250, 204, 21, 0.8);
}

.chud-charge-track {
  position: relative;
  height: 10px;
  border-radius: 4px;
  background: rgba(10, 15, 30, 0.9);
  border: 1px solid rgba(148, 163, 184, 0.24);
  overflow: hidden;
  transition: box-shadow 0.15s ease, border-color 0.15s ease;
}

.chud-charge-track.is-charging {
  border-color: #fde047;
  box-shadow: 0 0 16px rgba(250, 204, 21, 0.55);
}

.chud-charge-fill {
  height: 100%;
  background: linear-gradient(90deg, #00e5ff 0%, #00ffa3 45%, #fde047 78%, #ff2a85 100%);
  transition: width 0.05s linear;
}

.chud-charge-ticks {
  position: absolute;
  inset: 0;
  background-image: repeating-linear-gradient(
    to right,
    transparent 0,
    transparent 18px,
    rgba(4, 7, 17, 0.55) 18px,
    rgba(4, 7, 17, 0.55) 20px
  );
  pointer-events: none;
}

/* 5. BOTTOM-CENTER SURFACE MORPH SELECTOR */
.chud-surface-dock {
  position: absolute;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 5px;
  max-width: calc(100vw - 615px);
}

.chud-surface-label {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 10px;
  border-radius: 999px;
  background: rgba(6, 11, 24, 0.72);
  border: 1px solid rgba(148, 163, 184, 0.22);
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.14em;
  color: rgba(203, 213, 225, 0.8);
}

.chud-surface-cards {
  display: flex;
  align-items: stretch;
  gap: 8px;
}

.chud-surface-card {
  width: clamp(146px, 12.2vw, 178px);
  padding: 8px 9px;
  border-radius: 7px;
  border: 1px solid;
  background: linear-gradient(155deg, rgba(8, 13, 28, 0.86), rgba(4, 7, 17, 0.9));
  backdrop-filter: blur(12px);
  text-align: left;
  cursor: pointer;
  transition: transform 0.16s ease, border-color 0.22s ease, box-shadow 0.22s ease;
}

.chud-surface-card:hover {
  transform: translateY(-2px);
}

.chud-surface-card.is-active {
  transform: translateY(-2px);
}

.chud-surface-card-top {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}

.chud-surface-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  flex-shrink: 0;
}

.chud-surface-name {
  font-family: 'Orbitron', sans-serif;
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 0.03em;
  color: #f8fafc;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chud-surface-traits {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chud-trait {
  display: grid;
  grid-template-columns: auto 1fr;
  align-items: center;
  gap: 2px 6px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 8.5px;
  color: rgba(186, 214, 240, 0.72);
}

.chud-trait-tag {
  text-align: right;
  font-weight: 700;
  color: #e2e8f0;
}

.chud-trait-bar {
  grid-column: 1 / -1;
  height: 3px;
  border-radius: 2px;
  background: rgba(15, 23, 42, 0.9);
  overflow: hidden;
}

.chud-trait-bar > div {
  height: 100%;
  border-radius: 2px;
}

/* 6. BOTTOM-RIGHT CONTROLS DECK */
.chud-controls-deck {
  position: absolute;
  bottom: 14px;
  right: 16px;
  width: clamp(276px, 22vw, 314px);
  padding: 10px 11px;
  border-radius: 12px 8px 8px 8px;
  clip-path: polygon(10px 0, 100% 0, 100% 100%, 0 100%, 0 10px);
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.chud-deck-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.chud-deck-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chud-shortcut-chip {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  color: var(--hud-primary);
}

.chud-pill-grid-4 {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 4px;
}

.chud-pill-grid-3 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 4px;
}

.chud-deck-btn {
  padding: 5px 4px;
  border-radius: 5px;
  border: 1px solid rgba(148, 163, 184, 0.22);
  background: rgba(15, 23, 42, 0.65);
  color: rgba(203, 213, 225, 0.85);
  font-family: 'Rajdhani', sans-serif;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.03em;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.16s ease;
}

.chud-deck-btn:hover {
  border-color: var(--hud-primary);
  color: #ffffff;
}

.chud-deck-btn.is-active {
  border-color: var(--hud-primary);
  background: var(--hud-primary-tint);
  color: #ffffff;
  box-shadow: 0 0 12px var(--hud-primary-border);
}

.chud-deck-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  width: 100%;
  padding-top: 6px;
  border-top: 1px solid rgba(148, 163, 184, 0.16);
}

.chud-trailer-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: 5px;
  border: 1px solid rgba(0, 229, 255, 0.45);
  background: rgba(0, 229, 255, 0.12);
  color: #7dd3fc;
  font-family: 'Orbitron', sans-serif;
  font-size: 8.5px;
  font-weight: 800;
  letter-spacing: 0.03em;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.18s ease;
}

.chud-trailer-btn:hover {
  border-color: #00e5ff;
  color: #ffffff;
}

.chud-trailer-btn.is-active {
  border-color: #00ffa3;
  background: rgba(0, 255, 163, 0.2);
  color: #00ffa3;
  box-shadow: 0 0 14px rgba(0, 255, 163, 0.4);
  animation: chudPulse 1.4s ease-in-out infinite;
}

.chud-util-btn {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  height: 24px;
  padding: 0 5px;
  border-radius: 5px;
  border: 1px solid rgba(148, 163, 184, 0.25);
  background: rgba(15, 23, 42, 0.72);
  color: #cbd5e1;
  font-family: 'JetBrains Mono', monospace;
  font-size: 9px;
  font-weight: 700;
  cursor: pointer;
  flex-shrink: 0;
  transition: all 0.16s ease;
}

.chud-util-btn:hover,
.chud-util-btn.is-active {
  border-color: var(--hud-primary);
  color: #ffffff;
  box-shadow: 0 0 10px var(--hud-primary-border);
}

.chud-audio-box {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
}

.chud-audio-box .chud-icon-btn {
  width: 22px;
  height: 22px;
}

.chud-volume-slider {
  width: clamp(34px, 3vw, 48px);
  height: 4px;
  accent-color: var(--hud-primary);
  cursor: pointer;
}

/* 7. SLOW-MOTION REPLAY BROADCAST OVERLAY */
.chud-replay-overlay {
  position: fixed;
  inset: 0;
  z-index: 32;
  pointer-events: none;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  animation: chudFadeIn 0.25s ease;
}

.chud-letterbox {
  height: clamp(54px, 11.5vh, 108px);
  background: linear-gradient(to bottom, rgba(2, 4, 10, 0.96), rgba(4, 7, 16, 0.92));
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
}

.chud-letterbox-top {
  border-bottom: 1px solid var(--hud-primary-mid);
  box-shadow: 0 8px 30px rgba(0, 0, 0, 0.65);
}

.chud-letterbox-bottom {
  border-top: 1px solid var(--hud-primary-mid);
  box-shadow: 0 -8px 30px rgba(0, 0, 0, 0.65);
}

.chud-replay-badge {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  font-family: 'Orbitron', sans-serif;
  font-size: clamp(11px, 1.3vw, 15px);
  font-weight: 800;
  letter-spacing: 0.14em;
  color: #ffffff;
  text-shadow: 0 0 12px rgba(0, 229, 255, 0.6);
  animation: chudReplayBlink 1.1s ease-in-out infinite;
}

.chud-replay-rec-dot {
  width: 9px;
  height: 9px;
  border-radius: 999px;
  background: #ff2a55;
  box-shadow: 0 0 12px #ff2a55;
}

.chud-replay-telemetry {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: var(--hud-primary);
}

.chud-replay-frame-corners {
  position: relative;
  flex: 1;
  margin: 16px 26px;
  pointer-events: none;
}

.chud-corner {
  position: absolute;
  width: 22px;
  height: 22px;
  border-color: var(--hud-primary-mid);
  border-style: solid;
}

.chud-tl {
  top: 0;
  left: 0;
  border-width: 2px 0 0 2px;
}

.chud-tr {
  top: 0;
  right: 0;
  border-width: 2px 2px 0 0;
}

.chud-bl {
  bottom: 0;
  left: 0;
  border-width: 0 0 2px 2px;
}

.chud-br {
  bottom: 0;
  right: 0;
  border-width: 0 2px 2px 0;
}

.chud-replay-sub {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  letter-spacing: 0.14em;
  color: rgba(186, 214, 240, 0.72);
}

.chud-replay-sep {
  color: var(--hud-primary);
}

.chud-skip-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 8px 16px;
  border-radius: 6px;
  border: 1px solid var(--hud-primary);
  background: var(--hud-primary-tint);
  color: #ffffff;
  font-family: 'Orbitron', sans-serif;
  font-size: 11px;
  font-weight: 800;
  letter-spacing: 0.1em;
  cursor: pointer;
  box-shadow: 0 0 18px var(--hud-primary-border);
  transition: all 0.18s ease;
}

.chud-skip-btn:hover {
  background: var(--hud-primary);
  color: #040814;
}

/* 8. CONTROLS QUICK-GUIDE MODAL */
.chud-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 45;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(2, 5, 14, 0.74);
  backdrop-filter: blur(8px);
  animation: chudFadeIn 0.2s ease;
}

.chud-modal-card {
  width: min(500px, 94vw);
  padding: 18px 20px;
  border-radius: 12px;
  background: linear-gradient(155deg, rgba(10, 16, 36, 0.95), rgba(5, 8, 20, 0.97));
  border: 1px solid var(--hud-primary);
  box-shadow:
    0 24px 60px rgba(0, 0, 0, 0.75),
    0 0 32px var(--hud-primary-glow);
}

.chud-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
  padding-bottom: 10px;
  border-bottom: 1px solid rgba(148, 163, 184, 0.18);
}

.chud-modal-title-wrap {
  display: flex;
  align-items: center;
  gap: 10px;
}

.chud-modal-eyebrow {
  font-family: 'JetBrains Mono', monospace;
  font-size: 9.5px;
  letter-spacing: 0.14em;
  color: var(--hud-primary);
}

.chud-modal-title {
  margin: 0;
  font-family: 'Orbitron', sans-serif;
  font-size: 16px;
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #ffffff;
}

.chud-modal-close {
  width: 28px;
  height: 28px;
}

.chud-controls-list {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 14px;
}

.chud-control-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 10px;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.62);
  border: 1px solid rgba(148, 163, 184, 0.12);
}

.chud-control-action {
  font-size: 13.5px;
  font-weight: 600;
  color: #e2e8f0;
}

.chud-control-keys {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 11px;
}

.chud-control-keys kbd {
  padding: 2px 7px;
  border-radius: 4px;
  background: rgba(2, 6, 23, 0.9);
  border: 1px solid var(--hud-primary-mid);
  color: #f8fafc;
  font-family: 'JetBrains Mono', monospace;
  font-size: 10.5px;
  font-weight: 700;
}

.chud-or {
  color: rgba(148, 163, 184, 0.72);
  font-size: 10px;
}

.chud-modal-trailer-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 9px;
  border-radius: 5px;
  border: 1px solid rgba(0, 229, 255, 0.5);
  background: rgba(0, 229, 255, 0.14);
  color: #7dd3fc;
  font-family: 'Orbitron', sans-serif;
  font-size: 10px;
  font-weight: 700;
  cursor: pointer;
}

.chud-modal-trailer-pill.is-active {
  border-color: #00ffa3;
  background: rgba(0, 255, 163, 0.22);
  color: #00ffa3;
}

.chud-modal-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 10px;
  border-top: 1px solid rgba(148, 163, 184, 0.18);
}

.chud-modal-tip {
  font-size: 11.5px;
  color: rgba(186, 214, 240, 0.78);
  line-height: 1.3;
}

.chud-modal-done-btn {
  padding: 7px 14px;
  border-radius: 6px;
  border: 1px solid var(--hud-primary);
  background: var(--hud-primary-tint);
  color: #ffffff;
  font-family: 'Orbitron', sans-serif;
  font-size: 10.5px;
  font-weight: 800;
  letter-spacing: 0.08em;
  white-space: nowrap;
  cursor: pointer;
  transition: all 0.16s ease;
}

.chud-modal-done-btn:hover {
  background: var(--hud-primary);
  color: #040814;
}

@keyframes chudPulse {
  0%,
  100% {
    opacity: 0.78;
  }
  50% {
    opacity: 1;
  }
}

@keyframes chudReplayBlink {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.48;
  }
}

@keyframes chudCalloutPop {
  0% {
    opacity: 0;
    transform: scale(0.88) translateY(-8px);
  }
  100% {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

@keyframes chudEqDance {
  0% {
    transform: scaleY(0.32);
  }
  100% {
    transform: scaleY(1);
  }
}

@keyframes chudDashFlow {
  0% {
    stroke-dashoffset: 18;
  }
  100% {
    stroke-dashoffset: 0;
  }
}

@keyframes chudSpinCW {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

@keyframes chudSpinCCW {
  from {
    transform: rotate(360deg);
  }
  to {
    transform: rotate(0deg);
  }
}

@keyframes chudFadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@media (max-width: 1120px) {
  .chud-scoreboard {
    top: 12px;
    left: 12px;
    width: 304px;
    padding: 8px 10px 9px;
  }
  .chud-player-name {
    font-size: 10px;
    letter-spacing: 0.02em;
  }
  .chud-spin-panel {
    bottom: 12px;
    left: 12px;
    width: 242px;
    padding: 9px 10px;
  }
  .chud-spin-pill {
    font-size: 8.5px;
    gap: 3px;
  }
  .chud-controls-deck {
    bottom: 12px;
    right: 12px;
    width: 274px;
    padding: 9px 10px;
  }
  .chud-surface-dock {
    bottom: 12px;
    max-width: none;
  }
  .chud-surface-cards {
    gap: 5px;
  }
  .chud-surface-card {
    width: 138px;
    padding: 6px 6px;
  }
  .chud-surface-card-top {
    gap: 4px;
    margin-bottom: 5px;
  }
  .chud-surface-dot {
    width: 5px;
    height: 5px;
  }
  .chud-surface-name {
    font-size: 7.5px;
    letter-spacing: 0.01em;
  }
  .chud-trait {
    font-size: 8px;
  }
}
`;
