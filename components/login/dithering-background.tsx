'use client';

import React, { memo, useEffect, useState } from 'react';
import { Dithering } from '@paper-design/shaders-react';
import { useTheme } from '@/components/theme-provider';

const MemoizedDithering = memo(function MemoizedDithering({
  colorBack,
  colorFront,
  speed,
}: {
  colorBack: string;
  colorFront: string;
  speed: number;
}) {
  return (
    <Dithering
      colorBack={colorBack}
      colorFront={colorFront}
      shape="swirl"
      type="4x4"
      size={2.5}
      speed={speed}
      scale={1}
      fit="contain"
      style={{ width: '100%', height: '100%' }}
    />
  );
});

// Decide once on mount whether this device should run the shader at all.
// Low-end phones / older laptops fall back to a static CSS gradient.
function detectLowEnd(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (typeof nav.deviceMemory === 'number' && nav.deviceMemory > 0 && nav.deviceMemory < 4) return true;
  if (typeof navigator.hardwareConcurrency === 'number' && navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency < 4) return true;
  return false;
}

export function DitheringBackground() {
  const { theme } = useTheme();
  const [lowEnd, setLowEnd] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    setLowEnd(detectLowEnd());
    const onVisibility = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const colorBack = theme === 'dark' ? '#050510' : '#e8e0f0';
  const colorFront = theme === 'dark' ? '#7c3aed' : '#6d28d9';

  // Fallback: cheap static radial gradient, no WebGL.
  if (lowEnd) {
    return (
      <div
        aria-hidden="true"
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 0,
          background: `radial-gradient(circle at 30% 20%, ${colorFront}26 0%, ${colorBack} 60%)`,
        }}
      />
    );
  }

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 0,
        contain: 'layout style paint',
        willChange: 'transform',
        transform: 'translateZ(0)',
      }}
    >
      <MemoizedDithering colorBack={colorBack} colorFront={colorFront} speed={paused ? 0 : 0.6} />
    </div>
  );
}
