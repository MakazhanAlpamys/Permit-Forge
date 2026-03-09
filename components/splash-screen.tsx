'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';

// Each diamond side ≈ 170 SVG units
const SIDE = 170;
const GROUND_LEN = 160;
const ease: [number, number, number, number] = [0.4, 0, 0.2, 1];

// Phase timeline (ms):
// 0: ground line draws          (0 → 400)
// 1: beams rise, form diamond   (400 → 1350)
// 2: scan line sweeps, recolor  (1400 → 2000)
// 3: fill + flash               (2050)
// 4: text reveal                (2350)
// 5: exit                       (2900)

export function SplashScreen({ children }: { children: React.ReactNode }) {
  const [showSplash, setShowSplash] = useState(true);
  const [phase, setPhase] = useState(0);

  useEffect(() => {
    const t = [
      setTimeout(() => setPhase(1), 400),
      setTimeout(() => setPhase(2), 1400),
      setTimeout(() => setPhase(3), 2050),
      setTimeout(() => setPhase(4), 2350),
      setTimeout(() => setPhase(5), 2900),
      setTimeout(() => setShowSplash(false), 3500),
    ];
    return () => t.forEach(clearTimeout);
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
            transition={{ duration: 0.7, ease }}
          >
            {/* === DIAMOND CONSTRUCTION === */}
            <motion.div
              animate={phase >= 5 ? { opacity: 0, scale: 1.08 } : { opacity: 1, scale: 1 }}
              transition={{ duration: 0.6, ease }}
              style={{
                filter:
                  phase >= 3 && phase < 5
                    ? 'drop-shadow(0 0 24px rgba(124,58,237,0.7)) drop-shadow(0 0 48px rgba(124,58,237,0.3))'
                    : 'drop-shadow(0 0 6px rgba(255,255,255,0.08))',
                transition: 'filter 0.4s ease',
              }}
            >
              <svg
                width={120}
                height={120}
                viewBox="0 0 256 256"
                xmlns="http://www.w3.org/2000/svg"
                overflow="visible"
              >
                <defs>
                  <filter id="sf-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="2" />
                    <feMerge>
                      <feMergeNode />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="sf-scan-glow" x="-50%" y="-50%" width="200%" height="200%">
                    <feGaussianBlur stdDeviation="6" result="b" />
                    <feFlood floodColor="#7c3aed" floodOpacity="0.5" result="c" />
                    <feComposite in="c" in2="b" operator="in" result="g" />
                    <feMerge>
                      <feMergeNode in="g" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                {/* Ground line — draws from center outward */}
                <line
                  x1={48} y1={248} x2={208} y2={248}
                  stroke="rgba(255,255,255,0.25)"
                  strokeWidth={1}
                  className="sf-ground"
                  style={{
                    opacity: phase >= 3 ? 0 : 1,
                    transition: 'opacity 0.3s ease',
                  }}
                />

                {/* White structural beams — draw bottom-to-top */}
                <g
                  filter="url(#sf-glow)"
                  style={{
                    opacity: phase >= 3 ? 0 : 1,
                    transition: 'opacity 0.3s ease',
                  }}
                >
                  <path d="M 128 248 L 8 128"   className="sf-beam sf-b1" stroke="rgba(255,255,255,0.45)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
                  <path d="M 128 248 L 248 128"  className="sf-beam sf-b2" stroke="rgba(255,255,255,0.45)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
                  <path d="M 8 128 L 128 8"      className="sf-beam sf-b3" stroke="rgba(255,255,255,0.45)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
                  <path d="M 248 128 L 128 8"    className="sf-beam sf-b4" stroke="rgba(255,255,255,0.45)" strokeWidth={1.5} fill="none" strokeLinecap="round" />
                </g>

                {/* Purple beams — revealed top-to-bottom by scan */}
                <g
                  style={{
                    clipPath: phase >= 2 ? 'inset(0 0 0% 0)' : 'inset(0 0 100% 0)',
                    transition: phase >= 2 ? 'clip-path 0.6s cubic-bezier(0.4, 0, 0.2, 1)' : 'none',
                  }}
                >
                  <path d="M 128 248 L 8 128"   className="sf-beam sf-b1" stroke="#7c3aed" strokeWidth={2.5} fill="none" strokeLinecap="round" />
                  <path d="M 128 248 L 248 128"  className="sf-beam sf-b2" stroke="#7c3aed" strokeWidth={2.5} fill="none" strokeLinecap="round" />
                  <path d="M 8 128 L 128 8"      className="sf-beam sf-b3" stroke="#7c3aed" strokeWidth={2.5} fill="none" strokeLinecap="round" />
                  <path d="M 248 128 L 128 8"    className="sf-beam sf-b4" stroke="#7c3aed" strokeWidth={2.5} fill="none" strokeLinecap="round" />
                </g>

                {/* Scan line — sweeps top to bottom */}
                {phase >= 2 && phase < 4 && (
                  <motion.rect
                    x={-10}
                    width={276}
                    height={3}
                    rx={1.5}
                    fill="#7c3aed"
                    filter="url(#sf-scan-glow)"
                    initial={{ y: 8, opacity: 0 }}
                    animate={{ y: 248, opacity: [0, 0.9, 0.9, 0] }}
                    transition={{ duration: 0.6, ease }}
                  />
                )}

                {/* Diamond fill — "approved" */}
                <path
                  d="M 128 8 L 248 128 L 128 248 L 8 128 Z"
                  fill="#7c3aed"
                  style={{
                    opacity: phase >= 3 ? 1 : 0,
                    transition: 'opacity 0.25s ease-out',
                  }}
                />

                {/* Flash on approval */}
                <path
                  d="M 128 8 L 248 128 L 128 248 L 8 128 Z"
                  fill="white"
                  style={{
                    opacity: phase === 3 ? 0.35 : 0,
                    transition: phase === 3 ? 'opacity 0.08s ease-out' : 'opacity 0.4s ease-out',
                  }}
                />
              </svg>
            </motion.div>

            {/* === TEXT — clip-path reveal === */}
            <motion.div
              className="mt-8 overflow-hidden"
              animate={phase >= 5 ? { opacity: 0, y: -8 } : { opacity: 1, y: 0 }}
              transition={{ duration: 0.5, ease }}
            >
              <div
                style={{
                  clipPath: phase >= 4 ? 'inset(0 0% 0 0)' : 'inset(0 100% 0 0)',
                  transition: 'clip-path 0.5s cubic-bezier(0.16, 1, 0.3, 1)',
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

            {/* === SUBTITLE === */}
            <motion.p
              className="mt-3 uppercase font-medium"
              style={{
                fontSize: 'clamp(9px, 1.3vw, 12px)',
                fontFamily: "'Geist', sans-serif",
                letterSpacing: '5px',
                color: 'rgba(255,255,255,0.4)',
              }}
              initial={{ opacity: 0 }}
              animate={
                phase >= 5 ? { opacity: 0 } :
                phase >= 4 ? { opacity: 1 } :
                { opacity: 0 }
              }
              transition={{
                duration: 0.6,
                delay: phase >= 4 && phase < 5 ? 0.3 : 0,
              }}
            >
              AI-Powered Compliance
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Stroke-draw keyframes */}
      <style>{`
        .sf-ground {
          stroke-dasharray: ${GROUND_LEN};
          stroke-dashoffset: ${GROUND_LEN};
          animation: sf-draw-ground 0.4s cubic-bezier(0.4, 0, 0.2, 1) forwards;
        }
        .sf-beam {
          stroke-dasharray: ${SIDE};
          stroke-dashoffset: ${SIDE};
        }
        .sf-b1 { animation: sf-draw-beam 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.40s forwards; }
        .sf-b2 { animation: sf-draw-beam 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.50s forwards; }
        .sf-b3 { animation: sf-draw-beam 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.75s forwards; }
        .sf-b4 { animation: sf-draw-beam 0.5s cubic-bezier(0.4, 0, 0.2, 1) 0.85s forwards; }
        @keyframes sf-draw-ground {
          to { stroke-dashoffset: 0; }
        }
        @keyframes sf-draw-beam {
          to { stroke-dashoffset: 0; }
        }
      `}</style>

      {/* Page content */}
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
