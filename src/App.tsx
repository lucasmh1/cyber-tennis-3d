import React, { Component, ErrorInfo, ReactNode, Suspense } from 'react';
import * as THREE from 'three';
import { Canvas } from '@react-three/fiber';
import { PhysicsEngine } from './physics/PhysicsEngine';
import { CyberArena } from './arena/CyberArena';
import { LightingAndPostFX } from './lighting/LightingAndPostFX';
import { CinematicCamera } from './camera/CinematicCamera';
import { ParticleAndTrailSystem } from './vfx/ParticleAndTrailSystem';
import { AudioEngine } from './audio/AudioEngine';
import { CyberHUD } from './ui/CyberHUD';

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

class SceneErrorBoundary extends Component<
  { children: ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, message: error.message };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Cyber Tennis 3D render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          style={{
            width: '100vw',
            height: '100vh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: '#04050d',
            color: '#00d4ff',
            fontFamily: 'Orbitron, sans-serif',
            padding: 24,
            textAlign: 'center',
          }}
        >
          <h2 style={{ marginBottom: 8 }}>RENDER PIPELINE INTERRUPTED</h2>
          <p style={{ color: '#ff2a85', fontFamily: 'JetBrains Mono, monospace' }}>
            {this.state.message}
          </p>
        </div>
      );
    }
    return this.props.children;
  }
}

export function App() {
  return (
    <SceneErrorBoundary>
      <div
        className="app-shell"
        onContextMenu={(e) => e.preventDefault()}
      >
        <Canvas
          shadows
          dpr={[1, 2]}
          camera={{ position: [0, 5.2, 18.2], fov: 50, near: 0.1, far: 450 }}
          gl={{
            antialias: true,
            powerPreference: 'high-performance',
            toneMapping: THREE.ACESFilmicToneMapping,
            toneMappingExposure: 1.15,
          }}
        >
          <color attach="background" args={['#04050d']} />
          <fogExp2 attach="fog" args={['#050714', 0.0085]} />
          <Suspense fallback={null}>
            <PhysicsEngine />
            <CyberArena />
            <LightingAndPostFX />
            <ParticleAndTrailSystem />
            <CinematicCamera />
          </Suspense>
        </Canvas>
        <AudioEngine />
        <CyberHUD />
      </div>
    </SceneErrorBoundary>
  );
}

export default App;
