import { mascotAnimationTiming } from './mascot-animation-timing'

export const mascotRunFrameCount = mascotAnimationTiming.running.frames
export const mascotRunCycleDurationMs = mascotAnimationTiming.running.durationMs

export type MascotRunFrame = {
  frame: number
}

/**
 * Resolves one exact, bounded authored frame for the stabilized running loop.
 * Runtime playback never blends silhouettes or samples beyond the final cell.
 */
export function resolveMascotRunFrame(elapsedMs: number): MascotRunFrame {
  const wrappedElapsed = (
    (elapsedMs % mascotRunCycleDurationMs) + mascotRunCycleDurationMs
  ) % mascotRunCycleDurationMs
  return {
    frame: Math.floor(
      wrappedElapsed / mascotRunCycleDurationMs * mascotRunFrameCount
    ) % mascotRunFrameCount
  }
}
