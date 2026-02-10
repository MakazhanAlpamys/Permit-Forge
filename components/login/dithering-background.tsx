'use client';

import React, { memo } from 'react';
import { Dithering } from '@paper-design/shaders-react';
import { useTheme } from '@/components/theme-provider';

const MemoizedDithering = memo(function MemoizedDithering({
  colorBack,
  colorFront,
}: {
  colorBack: string;
  colorFront: string;
}) {
  return (
    <Dithering
      colorBack={colorBack}
      colorFront={colorFront}
      shape="warp"
      type="4x4"
      size={2.5}
      speed={0.6}
      scale={1}
      fit="contain"
      style={{ width: '100%', height: '100%' }}
    />
  );
});

export function DitheringBackground() {
  const { theme } = useTheme();

  const colorBack = theme === 'dark' ? '#050510' : '#e8e0f0';
  const colorFront = theme === 'dark' ? '#7c3aed' : '#6d28d9';

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
      <MemoizedDithering colorBack={colorBack} colorFront={colorFront} />
    </div>
  );
}
