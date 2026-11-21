# CYBER TENNIS 3D // NEO-SKYLINE OPEN

A 3D cyberpunk tennis prototype built with **React Three Fiber**, **Three.js**, **Zustand**, **Postprocessing**, and **Procedural Web Audio** — set inside a floating neon stadium suspended above a futuristic night metropolis.

## Features

- **Real-Time Magnus Effect & Sub-Stepped Ball Physics**
  - Aerodynamic quadratic drag, true `omega × v` Magnus curve/dip/lift, and live 3D predictive trajectory arc with holographic landing reticle.
  - Authentic tennis rules: official singles/doubles lines, net-cord deflection physics, service box validation, deuce/advantage scoring, and set tracking.
- **Three Morphing Court Surfaces**
  - **Neon Grass**: Low, fast skid bounce with bioluminescent emerald/cyan cyber-turf.
  - **Holographic Hard**: Balanced true bounce on obsidian-sapphire reflective circuit acrylic.
  - **Liquid Clay**: High bouncy grip and massive topspin/slice bite on reactive ferrofluid ripples.
- **Cinematic Cameras & Slow-Motion Action Replay**
  - Seamless damping across **Follow**, **Broadcast**, **Close-Up**, and **Orbit** cameras.
  - Automatic 0.28x slow-motion replay on long rallies, game points, and big winners (or press `R` anytime).
- **Trailer / Auto-Showcase Mode**
  - Toggle **TRAILER** in the HUD to watch AI-vs-AI cyberpunk rallies from any camera angle.
- **100% Procedural Spatial Web Audio**
  - Stereo-panned racket strikes, surface-tailored bounces, laser net buzz, reactive crowd swells, and surface-morph audio sweeps.

## Controls

| Action | Input |
| :--- | :--- |
| **Move** | `W A S D` or `Arrow Keys` |
| **Aim Shot** | `Mouse Cursor` |
| **Serve / Quick Swing** | `Space` or `Mouse Click` (hold to charge power) |
| **Topspin** | `1` / `J` / `Left Click` |
| **Slice / Backspin** | `2` / `K` / `Right Click` |
| **Flat Cannon** | `3` / `L` / `Middle Click` |
| **Cycle Camera** | `C` |
| **Instant Replay** | `R` (`Space` or `Esc` to skip) |
| **Gamepad** | Left Stick (Move/Aim) + Face Buttons |

## Launch Instructions

*(On Windows PowerShell where `npm.ps1` execution policy may block bare `npm`, use `npm.cmd`.)*

```bash
npm.cmd install
npm.cmd run dev
```

Then open the local URL printed by Vite (typically `http://localhost:5173`).

### Production Build Check

```bash
npm.cmd run build
```
