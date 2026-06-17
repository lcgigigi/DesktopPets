import { deflateSync, inflateSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'

const sourcePath = 'src/assets/mascot/libao.png'
const outputPath = 'src/assets/mascot/libao-spritesheet.png'
const coolingOfficeOutputPath = 'src/assets/mascot/libao-cooling-office-spritesheet.png'
const columns = 8
const rows = 9
const frameWidth = 180
const frameHeight = 180
const coolingOfficeColumns = 24

const source = decodePng(readFileSync(sourcePath))
const sheetWidth = columns * frameWidth
const sheetHeight = rows * frameHeight
const sheet = {
  width: sheetWidth,
  height: sheetHeight,
  data: new Uint8Array(sheetWidth * sheetHeight * 4)
}

for (let row = 0; row < rows; row += 1) {
  for (let column = 0; column < columns; column += 1) {
    drawFrame(row, column)
  }
}

writeFileSync(outputPath, encodePng(sheet))
console.log(`Wrote ${outputPath} (${sheetWidth}x${sheetHeight})`)

const coolingOfficeSheet = {
  width: coolingOfficeColumns * frameWidth,
  height: frameHeight,
  data: new Uint8Array(coolingOfficeColumns * frameWidth * frameHeight * 4)
}

for (let column = 0; column < coolingOfficeColumns; column += 1) {
  drawCoolingOfficeFrame(column)
}

writeFileSync(coolingOfficeOutputPath, encodePng(coolingOfficeSheet))
console.log(`Wrote ${coolingOfficeOutputPath} (${coolingOfficeSheet.width}x${coolingOfficeSheet.height})`)

function drawFrame(row, column) {
  const frame = {
    x: column * frameWidth,
    y: row * frameHeight,
    width: frameWidth,
    height: frameHeight
  }
  const transform = transformFor(row, column)
  const targetWidth = 110
  const targetHeight = Math.round((targetWidth * source.height) / source.width)
  const shadowWidth = targetWidth * 0.78 * transform.shadowScale

  drawEllipse(
    sheet,
    frame.x + frame.width / 2 - shadowWidth / 2,
    frame.y + frame.height - 32,
    shadowWidth,
    11,
    [0, 0, 0, 42]
  )
  drawTransformedImage(source, sheet, {
    centerX: frame.x + frame.width / 2 + transform.offsetX,
    centerY: frame.y + frame.height / 2 + 1 + transform.offsetY,
    width: targetWidth,
    height: targetHeight,
    scaleX: transform.scaleX,
    scaleY: transform.scaleY,
    rotation: transform.rotation,
    flipX: transform.flipX,
    bounds: frame
  })
  drawMood(transform.mood, frame)
}

function transformFor(row, column) {
  const t = column / columns
  switch (row) {
    case 0: {
      const bob = Math.sin(t * Math.PI * 2) * 3
      return {
        offsetX: 0,
        offsetY: bob,
        scaleX: 1 + Math.abs(bob) * 0.0015,
        scaleY: 1 - Math.abs(bob) * 0.001,
        rotation: 0,
        flipX: false,
        shadowScale: 1,
        mood: { type: 'none' }
      }
    }
    case 1:
      return baseTransform({
        offsetX: column % 2 === 0 ? -2 : 2,
        offsetY: column % 4 < 2 ? -2 : 1,
        scaleX: 1.02,
        scaleY: 0.985,
        rotation: Math.PI / 72,
        shadowScale: 0.94
      })
    case 2:
      return baseTransform({
        offsetX: column % 2 === 0 ? 2 : -2,
        offsetY: column % 4 < 2 ? -2 : 1,
        scaleX: 1.02,
        scaleY: 0.985,
        rotation: -Math.PI / 72,
        flipX: true,
        shadowScale: 0.94
      })
    case 3:
      return baseTransform({
        offsetY: Math.sin(t * Math.PI * 2) * 2,
        rotation: Math.sin(t * Math.PI * 2) * Math.PI / 52,
        mood: { type: 'wave', index: column }
      })
    case 4: {
      const jump = [5, -5, -14, -20, -12, -3, 4, 2]
      const stretch = [0.92, 1.04, 1.06, 1.03, 1.02, 0.96, 0.91, 1]
      return baseTransform({
        offsetY: jump[column],
        scaleX: 2 - stretch[column],
        scaleY: stretch[column],
        shadowScale: clamp(1 - Math.abs(jump[column]) / 44, 0.52, 1)
      })
    }
    case 5: {
      const shake = [-3, 3, -2, 2, -1, 1, 0, 0]
      return baseTransform({
        offsetX: shake[column],
        offsetY: 1,
        rotation: (shake[column] * Math.PI) / 180,
        mood: { type: 'failed', index: column }
      })
    }
    case 6:
      return baseTransform({
        offsetY: Math.sin(t * Math.PI * 2) * 2,
        scaleX: 0.99,
        scaleY: 1.01,
        mood: { type: 'waiting', index: column }
      })
    case 7: {
      const pulse = 1 + Math.sin(t * Math.PI * 2) * 0.015
      return baseTransform({
        offsetY: Math.sin(t * Math.PI * 2) * 2,
        scaleX: pulse,
        scaleY: pulse,
        mood: { type: 'remind', index: column }
      })
    }
    case 8:
      return baseTransform({
        offsetY: (column < 4 ? column : 8 - column) * 0.8,
        rotation: Math.sin(t * Math.PI * 2) * Math.PI / 96,
        mood: { type: 'success', index: column }
      })
    default:
      return baseTransform()
  }
}

function baseTransform(overrides = {}) {
  return {
    offsetX: 0,
    offsetY: 0,
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    flipX: false,
    shadowScale: 1,
    mood: { type: 'none' },
    ...overrides
  }
}

function drawMood(mood, frame) {
  switch (mood.type) {
    case 'wave': {
      const alpha = [50, 115, 190, 255, 190, 115, 50, 25][mood.index]
      const color = [61, 173, 255, alpha]
      const baseX = frame.x + frame.width / 2 + 30
      const baseY = frame.y + frame.height / 2 - 20
      drawLine(sheet, baseX, baseY, baseX + 11, baseY - 12, color, 2)
      drawLine(sheet, baseX + 4, baseY + 8, baseX + 17, baseY - 1, color, 2)
      break
    }
    case 'waiting': {
      const count = Math.min(3, Math.floor(mood.index / 2) + 1)
      for (let dot = 0; dot < count; dot += 1) {
        const x = frame.x + frame.width / 2 + dot * 9 - 9
        const y = frame.y + 18 - (dot % 2) * 3
        drawEllipse(sheet, x, y, 5, 5, [105, 122, 158, 184])
      }
      break
    }
    case 'remind': {
      const alpha = 58 + (mood.index % 4) * 28
      drawRing(sheet, frame.x + 17 - (mood.index % 4), frame.y + 16 - (mood.index % 4), frame.width - 34 + (mood.index % 4) * 2, frame.height - 32 + (mood.index % 4) * 2, [255, 168, 41, alpha], 3)
      break
    }
    case 'success': {
      const x = frame.x + frame.width / 2 + (mood.index % 4) * 7 - 13
      const y = frame.y + 20 + (mood.index % 3) * 7
      drawLine(sheet, x - 3, y, x, y + 4, [54, 199, 130, 220], 2)
      drawLine(sheet, x, y + 4, x + 7, y - 5, [54, 199, 130, 220], 2)
      break
    }
    case 'failed': {
      const x = frame.x + frame.width / 2 + (mood.index % 4) * 6 - 12
      const y = frame.y + 21 + (mood.index % 2) * 5
      drawLine(sheet, x - 4, y - 4, x + 4, y + 4, [255, 71, 87, 166], 2)
      drawLine(sheet, x + 4, y - 4, x - 4, y + 4, [255, 71, 87, 166], 2)
      break
    }
    default:
      break
  }
}

function drawCoolingOfficeFrame(column) {
  const frame = {
    x: column * frameWidth,
    y: 0,
    width: frameWidth,
    height: frameHeight
  }
  const progress = column / coolingOfficeColumns
  const loop = progress * Math.PI * 2
  const cooling = smoothstep(0.32, 0.72, progress)
  const heat = 1 - cooling
  const breeze = 0.35 + cooling * 0.65
  const chairCenterX = frame.x + 112

  drawOfficeScene(coolingOfficeSheet, frame, heat)
  drawAirConditioner(coolingOfficeSheet, frame, progress, breeze)
  drawOfficeChair(coolingOfficeSheet, frame, chairCenterX)
  drawSeatedLap(coolingOfficeSheet, frame, chairCenterX)

  drawTransformedImage(source, coolingOfficeSheet, {
    centerX: chairCenterX,
    centerY: frame.y + 91,
    width: 72,
    height: Math.round((72 * source.height) / source.width),
    scaleX: 1,
    scaleY: 1,
    rotation: 0,
    flipX: false,
    sourceClip: {
      x: 0,
      y: 0,
      width: source.width,
      height: Math.round(source.height * 0.84)
    },
    bounds: {
      x: frame.x,
      y: frame.y,
      width: frame.width,
      height: 128
    }
  })

  drawDesktopComputer(coolingOfficeSheet, frame, cooling)
  drawDeskForeground(coolingOfficeSheet, frame)
  drawCoolingEffects(coolingOfficeSheet, frame, progress, heat, breeze)
}

function drawOfficeScene(image, frame, heat) {
  drawEllipse(image, frame.x + 47, frame.y + 156, 105, 17, [0, 0, 0, 24])
  if (heat > 0.15) {
    for (let i = 0; i < 3; i += 1) {
      const x = frame.x + 23 + i * 11
      const phase = heat * Math.PI + i
      drawSineLine(image, x, frame.y + 77, x + 1, frame.y + 52, 5, phase, [255, 110, 72, Math.round(115 * heat)], 2)
    }
  }
}

function drawAirConditioner(image, frame, progress, breeze) {
  const x = frame.x + 101
  const y = frame.y + 23
  drawRoundedRect(image, x, y, 58, 23, 6, [238, 244, 247, 248])
  drawRoundedRect(image, x + 5, y + 13, 48, 5, 2, [179, 193, 203, 225])
  drawEllipse(image, x + 45, y + 6, 5, 5, [72, 202, 180, 215])

  for (let i = 0; i < 4; i += 1) {
    const offset = (progress * 34 + i * 13) % 46
    const startX = x + 44 - offset * 0.65
    const startY = y + 25 + i * 7
    drawSineLine(
      image,
      startX,
      startY,
      startX - 46,
      startY + 24,
      4,
      progress * Math.PI * 2 + i,
      [102, 196, 232, Math.round(70 + breeze * 120)],
      2
    )
  }
}

function drawOfficeChair(image, frame, centerX) {
  drawRoundedRect(image, centerX - 26, frame.y + 82, 52, 59, 13, [63, 81, 111, 235])
  drawRoundedRect(image, centerX - 24, frame.y + 126, 48, 18, 9, [76, 99, 132, 248])
  drawRect(image, centerX - 2, frame.y + 143, 5, 22, [52, 66, 86, 215])
  drawLine(image, centerX, frame.y + 164, centerX - 31, frame.y + 172, [52, 66, 86, 185], 3)
  drawLine(image, centerX, frame.y + 164, centerX + 31, frame.y + 172, [52, 66, 86, 185], 3)
  drawEllipse(image, centerX - 36, frame.y + 169, 8, 5, [44, 53, 65, 190])
  drawEllipse(image, centerX + 32, frame.y + 169, 8, 5, [44, 53, 65, 190])
}

function drawSeatedLap(image, frame, centerX) {
  drawRoundedRect(image, centerX - 22, frame.y + 121, 44, 20, 10, [236, 240, 238, 245])
  drawLine(image, centerX - 12, frame.y + 134, centerX - 31, frame.y + 150, [236, 240, 238, 232], 7)
  drawLine(image, centerX + 10, frame.y + 134, centerX + 25, frame.y + 150, [236, 240, 238, 232], 7)
  drawEllipse(image, centerX - 39, frame.y + 148, 15, 7, [226, 232, 229, 240])
  drawEllipse(image, centerX + 20, frame.y + 148, 15, 7, [226, 232, 229, 240])
}

function drawDesktopComputer(image, frame, cooling) {
  const glow = 80 + Math.round(cooling * 65)
  drawPolygon(image, [
    { x: frame.x + 40, y: frame.y + 96 },
    { x: frame.x + 78, y: frame.y + 89 },
    { x: frame.x + 85, y: frame.y + 125 },
    { x: frame.x + 44, y: frame.y + 131 }
  ], [25, 39, 57, 248])
  drawPolygon(image, [
    { x: frame.x + 78, y: frame.y + 89 },
    { x: frame.x + 86, y: frame.y + 93 },
    { x: frame.x + 92, y: frame.y + 122 },
    { x: frame.x + 85, y: frame.y + 125 }
  ], [38, 145, 195, glow])
  drawLine(image, frame.x + 47, frame.y + 101, frame.x + 78, frame.y + 95, [61, 77, 99, 210], 2)
  drawLine(image, frame.x + 48, frame.y + 124, frame.x + 82, frame.y + 119, [8, 20, 35, 120], 2)
  drawRect(image, frame.x + 61, frame.y + 130, 5, 10, [25, 39, 57, 225])
  drawPolygon(image, [
    { x: frame.x + 47, y: frame.y + 140 },
    { x: frame.x + 74, y: frame.y + 137 },
    { x: frame.x + 83, y: frame.y + 142 },
    { x: frame.x + 54, y: frame.y + 146 }
  ], [212, 224, 231, 238])
  drawLine(image, frame.x + 54, frame.y + 143, frame.x + 77, frame.y + 140, [144, 161, 174, 165], 1)
}

function drawDeskForeground(image, frame) {
  drawRoundedRect(image, frame.x + 24, frame.y + 136, 132, 18, 6, [139, 93, 48, 250])
  drawRect(image, frame.x + 30, frame.y + 153, 13, 20, [104, 68, 40, 220])
  drawRect(image, frame.x + 137, frame.y + 153, 13, 20, [104, 68, 40, 220])
  drawLine(image, frame.x + 31, frame.y + 142, frame.x + 150, frame.y + 142, [190, 128, 66, 178], 2)
}

function drawCoolingEffects(image, frame, progress, heat, breeze) {
  if (heat > 0.2) {
    for (let i = 0; i < 3; i += 1) {
      const drop = (progress * 16 + i * 6) % 16
      const x = frame.x + 101 + i * 8
      const y = frame.y + 61 + drop
      drawEllipse(image, x, y, 4, 7, [74, 174, 232, Math.round(120 * heat)])
    }
  }

  for (let i = 0; i < 5; i += 1) {
    const phase = progress * Math.PI * 2 + i * 0.8
    const alpha = Math.round((45 + i * 11) * breeze)
    drawSineLine(
      image,
      frame.x + 131 - i * 15,
      frame.y + 56 + i * 9,
      frame.x + 81 - i * 3,
      frame.y + 75 + i * 5,
      3,
      phase,
      [185, 232, 255, alpha],
      2
    )
  }
}

function drawTransformedImage(src, dest, options) {
  const cos = Math.cos(options.rotation)
  const sin = Math.sin(options.rotation)
  const minX = Math.max(0, Math.floor(options.bounds.x))
  const minY = Math.max(0, Math.floor(options.bounds.y))
  const maxX = Math.min(dest.width, Math.ceil(options.bounds.x + options.bounds.width))
  const maxY = Math.min(dest.height, Math.ceil(options.bounds.y + options.bounds.height))

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const dx = x + 0.5 - options.centerX
      const dy = y + 0.5 - options.centerY
      let localX = dx * cos + dy * sin
      let localY = -dx * sin + dy * cos
      if (options.flipX) localX = -localX
      localX /= options.scaleX
      localY /= options.scaleY
      const sourceX = Math.floor(((localX + options.width / 2) / options.width) * src.width)
      const sourceY = Math.floor(((localY + options.height / 2) / options.height) * src.height)
      if (sourceX < 0 || sourceY < 0 || sourceX >= src.width || sourceY >= src.height) continue
      if (
        options.sourceClip &&
        (sourceX < options.sourceClip.x ||
          sourceY < options.sourceClip.y ||
          sourceX >= options.sourceClip.x + options.sourceClip.width ||
          sourceY >= options.sourceClip.y + options.sourceClip.height)
      ) {
        continue
      }
      const srcIndex = (sourceY * src.width + sourceX) * 4
      const alpha = src.data[srcIndex + 3]
      if (alpha === 0) continue
      blendPixel(dest, x, y, [
        src.data[srcIndex],
        src.data[srcIndex + 1],
        src.data[srcIndex + 2],
        alpha
      ])
    }
  }
}

function drawRect(image, x, y, width, height, color) {
  const minX = Math.max(0, Math.floor(x))
  const minY = Math.max(0, Math.floor(y))
  const maxX = Math.min(image.width, Math.ceil(x + width))
  const maxY = Math.min(image.height, Math.ceil(y + height))
  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      blendPixel(image, px, py, color)
    }
  }
}

function drawRoundedRect(image, x, y, width, height, radius, color) {
  drawRect(image, x + radius, y, width - radius * 2, height, color)
  drawRect(image, x, y + radius, width, height - radius * 2, color)
  drawEllipse(image, x, y, radius * 2, radius * 2, color)
  drawEllipse(image, x + width - radius * 2, y, radius * 2, radius * 2, color)
  drawEllipse(image, x, y + height - radius * 2, radius * 2, radius * 2, color)
  drawEllipse(image, x + width - radius * 2, y + height - radius * 2, radius * 2, radius * 2, color)
}

function drawEllipse(image, x, y, width, height, color) {
  const cx = x + width / 2
  const cy = y + height / 2
  const rx = width / 2
  const ry = height / 2
  const minX = Math.max(0, Math.floor(x))
  const minY = Math.max(0, Math.floor(y))
  const maxX = Math.min(image.width, Math.ceil(x + width))
  const maxY = Math.min(image.height, Math.ceil(y + height))

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const nx = (px + 0.5 - cx) / rx
      const ny = (py + 0.5 - cy) / ry
      if (nx * nx + ny * ny <= 1) blendPixel(image, px, py, color)
    }
  }
}

function drawPolygon(image, points, color) {
  if (points.length < 3) return
  const minY = Math.max(0, Math.floor(Math.min(...points.map((point) => point.y))))
  const maxY = Math.min(image.height - 1, Math.ceil(Math.max(...points.map((point) => point.y))))

  for (let py = minY; py <= maxY; py += 1) {
    const intersections = []
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i]
      const b = points[(i + 1) % points.length]
      if ((a.y <= py && b.y > py) || (b.y <= py && a.y > py)) {
        const t = (py - a.y) / (b.y - a.y)
        intersections.push(a.x + t * (b.x - a.x))
      }
    }
    intersections.sort((a, b) => a - b)
    for (let i = 0; i < intersections.length; i += 2) {
      const startX = Math.max(0, Math.floor(intersections[i]))
      const endX = Math.min(image.width - 1, Math.ceil(intersections[i + 1]))
      for (let px = startX; px <= endX; px += 1) {
        blendPixel(image, px, py, color)
      }
    }
  }
}

function drawRing(image, x, y, width, height, color, thickness) {
  for (let step = 0; step < thickness; step += 1) {
    drawEllipseOutline(image, x + step, y + step, width - step * 2, height - step * 2, color)
  }
}

function drawRotatedEllipse(image, centerX, centerY, width, height, angle, color) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const rx = width / 2
  const ry = height / 2
  const radius = Math.ceil(Math.max(width, height) / 2) + 2
  const minX = Math.max(0, Math.floor(centerX - radius))
  const minY = Math.max(0, Math.floor(centerY - radius))
  const maxX = Math.min(image.width, Math.ceil(centerX + radius))
  const maxY = Math.min(image.height, Math.ceil(centerY + radius))

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const dx = px + 0.5 - centerX
      const dy = py + 0.5 - centerY
      const localX = dx * cos + dy * sin
      const localY = -dx * sin + dy * cos
      const nx = localX / rx
      const ny = localY / ry
      if (nx * nx + ny * ny <= 1) blendPixel(image, px, py, color)
    }
  }
}

function drawEllipseOutline(image, x, y, width, height, color) {
  const cx = x + width / 2
  const cy = y + height / 2
  const rx = width / 2
  const ry = height / 2
  const minX = Math.max(0, Math.floor(x))
  const minY = Math.max(0, Math.floor(y))
  const maxX = Math.min(image.width, Math.ceil(x + width))
  const maxY = Math.min(image.height, Math.ceil(y + height))

  for (let py = minY; py < maxY; py += 1) {
    for (let px = minX; px < maxX; px += 1) {
      const nx = (px + 0.5 - cx) / rx
      const ny = (py + 0.5 - cy) / ry
      const distance = nx * nx + ny * ny
      if (distance > 0.94 && distance <= 1.02) blendPixel(image, px, py, color)
    }
  }
}

function drawLine(image, x1, y1, x2, y2, color, width) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 2)
  for (let i = 0; i <= steps; i += 1) {
    const t = i / Math.max(1, steps)
    const x = x1 + (x2 - x1) * t
    const y = y1 + (y2 - y1) * t
    drawEllipse(image, x - width / 2, y - width / 2, width, width, color)
  }
}

function drawSineLine(image, x1, y1, x2, y2, amplitude, phase, color, width) {
  const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1) * 1.4)
  let previous = null
  const dx = x2 - x1
  const dy = y2 - y1
  const length = Math.max(1, Math.hypot(dx, dy))
  const normalX = -dy / length
  const normalY = dx / length

  for (let i = 0; i <= steps; i += 1) {
    const t = i / Math.max(1, steps)
    const wave = Math.sin(t * Math.PI * 2 + phase) * amplitude
    const point = {
      x: x1 + dx * t + normalX * wave,
      y: y1 + dy * t + normalY * wave
    }
    if (previous) drawLine(image, previous.x, previous.y, point.x, point.y, color, width)
    previous = point
  }
}

function drawRotatedLine(image, x1, y1, x2, y2, angle, color, width) {
  const centerX = (x1 + x2) / 2
  const centerY = (y1 + y2) / 2
  const start = rotatePoint(x1, y1, centerX, centerY, angle)
  const end = rotatePoint(x2, y2, centerX, centerY, angle)
  drawLine(image, start.x, start.y, end.x, end.y, color, width)
}

function rotatePoint(x, y, centerX, centerY, angle) {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = x - centerX
  const dy = y - centerY
  return {
    x: centerX + dx * cos - dy * sin,
    y: centerY + dx * sin + dy * cos
  }
}

function blendPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  const index = (y * image.width + x) * 4
  const srcA = color[3] / 255
  const dstA = image.data[index + 3] / 255
  const outA = srcA + dstA * (1 - srcA)
  if (outA <= 0) return

  image.data[index] = Math.round((color[0] * srcA + image.data[index] * dstA * (1 - srcA)) / outA)
  image.data[index + 1] = Math.round((color[1] * srcA + image.data[index + 1] * dstA * (1 - srcA)) / outA)
  image.data[index + 2] = Math.round((color[2] * srcA + image.data[index + 2] * dstA * (1 - srcA)) / outA)
  image.data[index + 3] = Math.round(outA * 255)
}

function decodePng(buffer) {
  const signature = '89504e470d0a1a0a'
  if (buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('Invalid PNG signature')

  let offset = 8
  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  const idatParts = []

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii')
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    offset += 12 + length

    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      bitDepth = data[8]
      colorType = data[9]
      if (data[12] !== 0) throw new Error('Interlaced PNG is not supported')
    } else if (type === 'IDAT') {
      idatParts.push(data)
    } else if (type === 'IEND') {
      break
    }
  }

  if (bitDepth !== 8 || colorType !== 6) throw new Error('Only 8-bit RGBA PNG is supported')

  const bytesPerPixel = 4
  const stride = width * bytesPerPixel
  const inflated = inflateSync(Buffer.concat(idatParts))
  const data = new Uint8Array(width * height * 4)
  let inputOffset = 0
  let outputOffset = 0
  let previous = new Uint8Array(stride)

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset]
    inputOffset += 1
    const row = new Uint8Array(inflated.subarray(inputOffset, inputOffset + stride))
    inputOffset += stride
    unfilter(row, previous, filter, bytesPerPixel)
    data.set(row, outputOffset)
    previous = row
    outputOffset += stride
  }

  return { width, height, data }
}

function unfilter(row, previous, filter, bytesPerPixel) {
  for (let i = 0; i < row.length; i += 1) {
    const left = i >= bytesPerPixel ? row[i - bytesPerPixel] : 0
    const up = previous[i] ?? 0
    const upLeft = i >= bytesPerPixel ? previous[i - bytesPerPixel] : 0
    switch (filter) {
      case 0:
        break
      case 1:
        row[i] = (row[i] + left) & 255
        break
      case 2:
        row[i] = (row[i] + up) & 255
        break
      case 3:
        row[i] = (row[i] + Math.floor((left + up) / 2)) & 255
        break
      case 4:
        row[i] = (row[i] + paeth(left, up, upLeft)) & 255
        break
      default:
        throw new Error(`Unsupported PNG filter ${filter}`)
    }
  }
}

function encodePng(image) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(image.width, 0)
  header.writeUInt32BE(image.height, 4)
  header[8] = 8
  header[9] = 6
  header[10] = 0
  header[11] = 0
  header[12] = 0

  const stride = image.width * 4
  const raw = Buffer.alloc((stride + 1) * image.height)
  let rawOffset = 0
  for (let y = 0; y < image.height; y += 1) {
    raw[rawOffset] = 0
    rawOffset += 1
    raw.set(image.data.subarray(y * stride, (y + 1) * stride), rawOffset)
    rawOffset += stride
  }

  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    createChunk('IHDR', header),
    createChunk('IDAT', deflateSync(raw, { level: 9 })),
    createChunk('IEND', Buffer.alloc(0))
  ])
}

function createChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii')
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0)
  return Buffer.concat([length, typeBuffer, data, crc])
}

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
