import { describe, expect, it } from 'vitest'
import rustSource from '../../src-tauri/src/main.rs?raw'
import mascotWindowSource from '../views/MascotWindow.vue?raw'

function sourceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)

  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0)
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('Windows mascot panel native geometry', () => {
  it('uses the mascot target monitor and physical bounds instead of hidden panel DPI', () => {
    const placement = sourceBetween(
      rustSource,
      'fn place_panel_near_mascot',
      'fn panel_position_near_mascot'
    )
    const targetMonitorGeometry = sourceBetween(
      rustSource,
      'fn panel_physical_geometry_near_mascot',
      'fn sync_visible_panel_to_mascot'
    )

    expect(placement).toContain('panel_physical_geometry_near_mascot(mascot, requested_height)')
    expect(placement).toContain('set_window_physical_bounds(panel, geometry.position, geometry.size)')
    expect(placement).not.toContain('panel.scale_factor()')
    expect(rustSource).not.toContain('fn current_panel_height')
    expect(targetMonitorGeometry).toContain('mascot_client_origin_physical(mascot)')
    expect(targetMonitorGeometry).toContain('mascot_avatar_physical_rect(')
    expect(targetMonitorGeometry).toContain('available_monitors()')
    expect(targetMonitorGeometry).toContain('monitor.work_area()')
    expect(targetMonitorGeometry).toContain('monitor.scale_factor()')
  })

  it('remembers logical panel height and reanchors a visible panel after bubble shrink', () => {
    const notificationCommand = sourceBetween(
      rustSource,
      'fn set_mascot_notification_visible',
      'fn set_panel_height'
    )
    const panelHeightCommand = sourceBetween(
      rustSource,
      'fn set_panel_height',
      'fn set_panel_activity'
    )

    expect(rustSource).toContain('.manage(PanelLayoutState::default())')
    expect(panelHeightCommand).toContain('panel_layout.set_height(height)')
    expect(notificationCommand).toMatch(/if !visible \{[\s\S]*?sync_panel_if_visible\(&app\)/)
  })

  it('re-fits the notification and visible panel after WM_DPICHANGED settles', () => {
    const scaleSync = sourceBetween(
      mascotWindowSource,
      'function scheduleScaleChangedLayoutSync()',
      'function scheduleIdleHide()'
    )
    const lifecycle = sourceBetween(mascotWindowSource, 'onMounted(async () =>', '</script>')

    expect(scaleSync).toContain('requestAnimationFrame(() => requestAnimationFrame(')
    expect(scaleSync).toContain('syncNativeNotificationLayout(visible, compact, { force: true })')
    expect(scaleSync).toContain('if (synced && panelVisible.value) void syncPanelWindow()')
    expect(lifecycle).toContain('getCurrentWindow().onScaleChanged')
    expect(lifecycle).toContain('scheduleScaleChangedLayoutSync()')
    expect(lifecycle).toContain('removeWindowScaleChangedListener?.()')
  })
})
