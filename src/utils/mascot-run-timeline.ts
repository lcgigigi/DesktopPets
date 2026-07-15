export const mascotRunFrameCount = 72
export const mascotRunCycleDurationMs = 1584

export type MascotRunFrame = {
  frame: number
}

/**
 * Resolves one exact, bounded source frame for the stabilized running loop.
 * Every visible in-between pose is baked into the atlas, so runtime playback
 * never cross-fades two silhouettes or samples beyond the final column.
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
