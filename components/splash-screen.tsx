'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// Diamond path: 4 sides, total perimeter for stroke-dasharray
// Points: top(128,8) → right(248,128) → bottom(128,248) → left(8,128)
// Each side ≈ 169.7px, total ≈ 678.8
const DIAMOND_PATH = 'M 128 8 L 248 128 L 128 248 L 8 128 Z';
const DIAMOND_PERIMETER = 679;

const SPLASH_DURATION = 3000;

export function SplashScreen({ children }: { children: React.ReactNode }) {
  const [showSplash, setShowSplash] = useState(true);
  const [phase, setPhase] = useState<'draw' | 'fill' | 'text' | 'exit'>('draw');

  useEffect(() => {
    // Phase timeline
    const timers = [
      setTimeout(() => setPhase('fill'), 1000),   // outline done → fill
      setTimeout(() => setPhase('text'), 1300),    // fill done → text reveal
      setTimeout(() => setPhase('exit'), 2200),    // text shown → begin exit
      setTimeout(() => setShowSplash(false), SPLASH_DURATION), // remove splash
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <>
      <AnimatePresence>
        {showSplash && (
          <motion.div
            key="splash"
            className="fixed inset-0 z-[100] flex flex-col items-center justify-center select-none"
            style={{ backgroundColor: '#050510' }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.8, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] }}
          >
            {/* Diamond — stroke draw + fill */}
            <motion.div
              animate={
                phase === 'exit'
                  ? { opacity: 0, scale: 1.08 }
                  : { opacity: 1, scale: 1 }
              }
              transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] }}
            >
              <svg
                width={100}
                height={100}
                viewBox="0 0 256 256"
                xmlns="http://www.w3.org/2000/svg"
                style={{
                  filter:
                    phase === 'fill'
                      ? 'drop-shadow(0 0 24px rgba(124,58,237,0.8)) drop-shadow(0 0 48px rgba(124,58,237,0.4))'
                      : 'drop-shadow(0 0 12px rgba(124,58,237,0.6))',
                  transition: 'filter 0.4s ease',
                }}
              >
                {/* Stroke outline — draws itself */}
                <path
                  d={DIAMOND_PATH}
                  fill="none"
                  stroke="#7c3aed"
                  strokeWidth={4}
                  strokeLinejoin="round"
                  style={{
                    strokeDasharray: DIAMOND_PERIMETER,
                    strokeDashoffset: phase === 'draw' ? 0 : 0,
                    animation: 'diamond-draw 1s cubic-bezier(0.4, 0, 0.2, 1) forwards',
                  }}
                />

                {/* Fill — appears after stroke completes */}
                <path
                  d={DIAMOND_PATH}
                  fill="#7c3aed"
                  style={{
                    opacity: phase === 'fill' || phase === 'text' || phase === 'exit' ? 1 : 0,
                    transition: 'opacity 0.25s ease-out',
                  }}
                />
              </svg>
            </motion.div>

            {/* Brand text — clip-path horizontal reveal */}
            <motion.div
              className="mt-8 overflow-hidden"
              animate={
                phase === 'exit'
                  ? { opacity: 0, scale: 1.05 }
                  : { opacity: 1, scale: 1 }
              }
              transition={{ duration: 0.6, ease: [0.4, 0, 0.2, 1] as [number, number, number, number] }}
            >
              <div
                style={{
                  clipPath:
                    phase === 'text' || phase === 'exit'
                      ? 'inset(0 0% 0 0)'
                      : 'inset(0 100% 0 0)',
                  transition: 'clip-path 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
                  fontSize: 'clamp(24px, 4.5vw, 42px)',
                  fontFamily: "'Geist', sans-serif",
                }}
                className="flex items-baseline gap-[clamp(6px,1.2vw,14px)]"
              >
                <span
                  className="font-semibold tracking-[3px]"
                  style={{ color: 'rgba(255,255,255,0.9)' }}
                >
                  PERMIT
                </span>
                <span
                  className="font-bold tracking-[4px]"
                  style={{ color: '#7c3aed' }}
                >
                  FORGE
                </span>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Keyframe for SVG stroke draw */}
      <style jsx global>{`
        @keyframes diamond-draw {
          from {
            stroke-dashoffset: ${DIAMOND_PERIMETER};
          }
          to {
            stroke-dashoffset: 0;
          }
        }
      `}</style>

      {/* Page content — fades in when splash exits */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: showSplash ? 0 : 1 }}
        transition={{ duration: 0.85, ease: 'easeOut' }}
        style={{ pointerEvents: showSplash ? 'none' : 'auto' }}
      >
        {children}
      </motion.div>
    </>
  );
}
