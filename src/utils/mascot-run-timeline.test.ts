import { describe, expect, it } from 'vitest'
import {
  mascotRunCycleDurationMs,
  mascotRunFrameCount,
  resolveMascotRunFrame
} from './mascot-run-timeline'

describe('mascot run timeline', () => {
  it('uses only the 24 authored poses at the production cadence', () => {
    expect(mascotRunCycleDurationMs).toBe(1440)
    expect(mascotRunFrameCount).toBe(24)
    expect(mascotRunFrameCount / mascotRunCycleDurationMs * 1000).toBeCloseTo(16.67, 1)
  })

  it('never samples beyond the last atlas cell', () => {
    for (let elapsed = -5000; elapsed <= 5000; elapsed += 7) {
      const frame = resolveMascotRunFrame(elapsed)
      expect(frame.frame).toBeGreaterThanOrEqual(0)
      expect(frame.frame).toBeLessThan(mascotRunFrameCount)
    }
  })

  it('closes the loop from frame 23 back to frame 0 without an invalid seam frame', () => {
    const nearSeam = resolveMascotRunFrame(mascotRunCycleDurationMs - 1)
    const atSeam = resolveMascotRunFrame(mascotRunCycleDurationMs)

    expect(nearSeam.frame).toBe(23)
    expect(atSeam.frame).toBe(0)
  })

  it('advances through authored frames without runtime interpolation', () => {
    const frameDuration = mascotRunCycleDurationMs / mascotRunFrameCount
    expect(resolveMascotRunFrame(frameDuration * 0.8).frame).toBe(0)
    expect(resolveMascotRunFrame(frameDuration * 1.2).frame).toBe(1)
  })
})
