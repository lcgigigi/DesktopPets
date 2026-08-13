export const mascotAnimationTiming = {
  idle: { frames: 12, durationMs: 3000 },
  thinking: { frames: 12, durationMs: 1000 },
  waiting: { frames: 6, durationMs: 500 },
  remind: { frames: 12, durationMs: 1000 },
  waving: { frames: 12, durationMs: 1000 },
  success: { frames: 6, durationMs: 500 },
  error: { frames: 6, durationMs: 500 },
  coolingOffice: { frames: 6, durationMs: 500 },
  peeking: { frames: 12, durationMs: 560 },
  revealing: { frames: 12, durationMs: 480 },
  running: { frames: 24, durationMs: 1440 }
} as const

// Idle deliberately rests at each end. Its authored motion occupies 30% of
// the loop (45%-75%), so 11 pose changes finish in 900ms instead of crawling.
export const mascotIdleMotionDurationMs = 900

// Every auto-reset status completes an integral number of its runtime cycles:
// thinking/remind = 2 x 1000ms; success/error = 4 x 500ms.
export const mascotMessageAutoResetMs = 2000

// A click feedback animation is exactly one complete waiting cycle.
export const mascotWaitingInteractionMs = mascotAnimationTiming.waiting.durationMs
