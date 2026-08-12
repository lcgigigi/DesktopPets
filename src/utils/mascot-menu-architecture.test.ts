import { describe, expect, it } from 'vitest'
import appSource from '../App.vue?raw'
import contextMenuSource from '../components/MascotContextMenu.vue?raw'
import windowServiceSource from '../services/window.service.ts?raw'
import mascotMenuWindowSource from '../views/MascotMenuWindow.vue?raw'
import mascotWindowSource from '../views/MascotWindow.vue?raw'
import capabilitiesSource from '../../src-tauri/capabilities/default.json?raw'
import rustSource from '../../src-tauri/src/main.rs?raw'
import tauriConfigSource from '../../src-tauri/tauri.conf.json?raw'

function sourceBetween(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker)
  const end = source.indexOf(endMarker, start + startMarker.length)

  expect(start, `missing source marker: ${startMarker}`).toBeGreaterThanOrEqual(0)
  expect(end, `missing source marker: ${endMarker}`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('mascot context menu architecture', () => {
  it('routes the menu through its own transparent native window', () => {
    const tauriConfig = JSON.parse(tauriConfigSource) as {
      app: { windows: Array<Record<string, unknown>> }
    }
    const capabilities = JSON.parse(capabilitiesSource) as { windows: string[] }
    const menuWindow = tauriConfig.app.windows.find((window) => window.label === 'mascot-menu')

    expect(menuWindow).toMatchObject({
      label: 'mascot-menu',
      url: 'index.html?window=mascot-menu',
      width: 192,
      height: 64,
      decorations: false,
      transparent: true,
      backgroundColor: '#00000000',
      shadow: false,
      alwaysOnTop: true,
      visible: false,
      skipTaskbar: true
    })
    expect(capabilities.windows).toContain('mascot-menu')
    expect(appSource).toContain("import MascotMenuWindow from './views/MascotMenuWindow.vue'")
    expect(appSource).toContain("windowMode === 'mascot-menu'")
  })

  it('keeps the placement payload restricted to above or below end to end', () => {
    expect(windowServiceSource).toMatch(
      /interface MascotContextMenuPlacement\s*\{[\s\S]*?placement: 'above' \| 'below'[\s\S]*?tailX: number[\s\S]*?\}/
    )
    expect(mascotMenuWindowSource).toMatch(
      /const placement = ref<'above' \| 'below'>\(/
    )
    expect(mascotMenuWindowSource).toContain(
      "previewPlacement === 'below' ? 'below' : 'above'"
    )
    expect(mascotMenuWindowSource).toMatch(
      /listen<MascotContextMenuPlacement>\(\s*'mascot-context-menu-placement'/
    )
    expect(mascotMenuWindowSource).toContain('placement.value = event.payload.placement')
    expect(mascotMenuWindowSource).toContain('tailX.value = event.payload.tailX')
    expect(contextMenuSource).toContain("placement?: 'above' | 'below'")
    expect(contextMenuSource).toContain('tailX?: number')
    expect(contextMenuSource).toContain("placement === 'below' ? 'is-below' : 'is-above'")
    expect(rustSource).toMatch(
      /enum MascotContextMenuPlacement\s*\{\s*Above,\s*Below,\s*\}/
    )
    expect(rustSource).toMatch(
      /struct MascotContextMenuPlacementPayload\s*\{[\s\S]*?placement: MascotContextMenuPlacement,[\s\S]*?tail_x: f64,[\s\S]*?\}/
    )
    expect(rustSource).toMatch(
      /emit_to\(\s*"mascot-menu",\s*"mascot-context-menu-placement",\s*geometry\.payload/
    )
  })

  it('does not reintroduce the old inline menu resize state', () => {
    expect(mascotWindowSource).not.toMatch(/import\s+MascotContextMenu\b/)
    expect(mascotWindowSource).not.toContain('<MascotContextMenu')
    expect(mascotWindowSource).not.toContain('getMascotContextMenuLayout')
    expect(mascotWindowSource).not.toContain('isContextMenuPreparing')
    expect(mascotWindowSource).not.toContain('isContextMenuDismissing')
    expect(mascotWindowSource).not.toContain('contextMenu.value')

    const handler = sourceBetween(
      mascotWindowSource,
      'async function handleContextMenu',
      '\n\nconst hasBubbleMessage'
    )
    expect(handler).toContain('await showMascotContextMenu()')
    expect(handler).not.toContain('syncNativeNotificationLayout')
    expect(handler).not.toContain('setMascotNotificationVisible')
  })

  it('positions the detached menu from the avatar using physical window bounds', () => {
    const nativeHandler = sourceBetween(
      rustSource,
      'fn show_mascot_context_menu',
      '\n\n#[tauri::command]\nfn hide_mascot_context_menu'
    )

    expect(nativeHandler).toContain('mascot_client_origin_physical(')
    expect(nativeHandler).toContain('mascot_avatar_physical_rect(')
    expect(nativeHandler).toContain('mascot_context_menu_physical_geometry(')
    expect(nativeHandler).toContain('set_window_physical_bounds(')
    expect(nativeHandler).toContain('PhysicalSize')
    expect(nativeHandler).toContain('work_area.position.x')
    expect(nativeHandler).toContain('work_area.size.width')
  })

  it('closes the detached menu from native focus loss and app lifecycle paths', () => {
    expect(rustSource).toMatch(
      /get_webview_window\("mascot-menu"\)[\s\S]*?WindowEvent::Focused\(false\)[\s\S]*?hide_mascot_context_menu_window/
    )
    expect(mascotMenuWindowSource).toContain("if (event.key === 'Escape') closeMenu()")
    expect(windowServiceSource).toContain("invoke('hide_mascot_context_menu')")

    for (const command of [
      'hide_main_window',
      'show_main_window',
      'show_notification_window',
      'peek_mascot_window',
      'reveal_mascot_window',
      'start_mascot_drag',
      'toggle_panel_window',
      'show_panel_window'
    ]) {
      expect(rustSource).toMatch(
        new RegExp(`fn ${command}\\b[\\s\\S]{0,900}?hide_mascot_context_menu_window\\(&app\\)`)
      )
    }
  })
})
