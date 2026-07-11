import { readFileSync, writeFileSync } from 'node:fs'
import { deflateSync, inflateSync } from 'node:zlib'

const [sourcePath, outputPath = 'src/assets/mascot/libao.png'] = process.argv.slice(2)
const requestedFrameCount = process.env.MASCOT_FRAME_COUNT
  ? Number(process.env.MASCOT_FRAME_COUNT)
  : undefined
const sourceColumns = Number(process.env.MASCOT_SOURCE_COLUMNS || requestedFrameCount || 6)
const sourceRows = Number(process.env.MASCOT_SOURCE_ROWS || 1)
const frameSize = 180
const alphaThreshold = 8

if (!sourcePath) {
  console.error('Usage: npm run mascot:prepare -- /path/to/source.png [output.png]')
  process.exit(1)
}

const source = decodePng(readFileSync(sourcePath))
validatePositiveInteger(sourceColumns, 'MASCOT_SOURCE_COLUMNS')
validatePositiveInteger(sourceRows, 'MASCOT_SOURCE_ROWS')
if (requestedFrameCount !== undefined) validatePositiveInteger(requestedFrameCount, 'MASCOT_FRAME_COUNT')

const sourceFrames = createSourceFrames(source, sourceColumns, sourceRows)
const outputFrames = sourceFrames.slice(0, requestedFrameCount ?? sourceFrames.length)
removeOpaqueBackground(source, sourceFrames)

const output = {
  width: frameSize * outputFrames.length,
  height: frameSize,
  data: new Uint8Array(frameSize * outputFrames.length * frameSize * 4)
}
const padding = 4
const contentBounds = outputFrames.map((frame) => findContentBounds(source, frame))
const drawBounds = contentBounds.map((bounds, index) => expandBounds(bounds, outputFrames[index], 4))
const anchors = contentBounds.map((bounds, index) => ({
  x: findBodyAnchorX(source, outputFrames[index], bounds),
  baselineY: bounds.y + bounds.height
}))
const targetAnchorX = frameSize / 2
const targetBaselineY = frameSize - padding
const scale = computeStableScale(drawBounds, anchors, targetAnchorX, targetBaselineY, padding)

for (let frameIndex = 0; frameIndex < outputFrames.length; frameIndex += 1) {
  const bounds = drawBounds[frameIndex]
  const anchor = anchors[frameIndex]
  const targetWidth = Math.max(1, Math.round(bounds.width * scale))
  const targetHeight = Math.max(1, Math.round(bounds.height * scale))
  const targetX = frameIndex * frameSize + Math.round(targetAnchorX - (anchor.x - bounds.x) * scale)
  const targetY = Math.round(targetBaselineY - (anchor.baselineY - bounds.y) * scale)

  drawScaledRegion(source, output, bounds, targetX, targetY, targetWidth, targetHeight)
}

for (let frameIndex = 0; frameIndex < outputFrames.length; frameIndex += 1) {
  keepLargestFrameComponent(output, frameIndex)
}

writeFileSync(outputPath, encodePng(output))
console.log(`Wrote ${outputPath} (${output.width}x${output.height})`)

function createSourceFrames(image, columns, rows) {
  const frames = []

  for (let row = 0; row < rows; row += 1) {
    const y = Math.round((image.height * row) / rows)
    const height = Math.round((image.height * (row + 1)) / rows) - y

    for (let column = 0; column < columns; column += 1) {
      const x = Math.round((image.width * column) / columns)
      const width = Math.round((image.width * (column + 1)) / columns) - x
      frames.push({ x, y, width, height })
    }
  }

  return frames
}

function removeOpaqueBackground(image, frames) {
  if (hasUsefulAlpha(image)) return

  if (hasMagentaKeyBackground(image, frames)) {
    removeMagentaKeyPixels(image)
  }

  for (const frame of frames) {
    floodFillBackground(image, frame)
  }
}

function hasUsefulAlpha(image) {
  let transparentPixels = 0

  for (let index = 3; index < image.data.length; index += 4) {
    if (image.data[index] <= alphaThreshold) transparentPixels += 1
  }

  return transparentPixels > image.width * image.height * 0.05
}

function floodFillBackground(image, frame) {
  const { x: startX, y: startY, width, height } = frame
  const endX = startX + width
  const endY = startY + height
  const visited = new Uint8Array(width * height)
  const queue = []

  for (let x = startX; x < endX; x += 1) {
    queueBackgroundPixel(image, frame, visited, queue, x, startY)
    queueBackgroundPixel(image, frame, visited, queue, x, endY - 1)
  }

  for (let y = startY + 1; y < endY - 1; y += 1) {
    queueBackgroundPixel(image, frame, visited, queue, startX, y)
    queueBackgroundPixel(image, frame, visited, queue, endX - 1, y)
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [x, y] = queue[cursor]
    const index = (y * image.width + x) * 4
    image.data[index] = 0
    image.data[index + 1] = 0
    image.data[index + 2] = 0
    image.data[index + 3] = 0

    queueBackgroundPixel(image, frame, visited, queue, x + 1, y)
    queueBackgroundPixel(image, frame, visited, queue, x - 1, y)
    queueBackgroundPixel(image, frame, visited, queue, x, y + 1)
    queueBackgroundPixel(image, frame, visited, queue, x, y - 1)
  }
}

function queueBackgroundPixel(image, frame, visited, queue, x, y) {
  if (x < frame.x || y < frame.y || x >= frame.x + frame.width || y >= frame.y + frame.height) {
    return
  }

  const localIndex = (y - frame.y) * frame.width + (x - frame.x)
  if (visited[localIndex]) return
  visited[localIndex] = 1

  const index = (y * image.width + x) * 4
  if (!isBackgroundLike(image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3])) {
    return
  }

  queue.push([x, y])
}

function isBackgroundLike(red, green, blue, alpha) {
  if (alpha <= alphaThreshold) return true
  if (isMagentaKeyLike(red, green, blue, alpha)) return true
  const maxChannel = Math.max(red, green, blue)
  const minChannel = Math.min(red, green, blue)
  return minChannel >= 215 && maxChannel - minChannel <= 4
}

function hasMagentaKeyBackground(image, frames) {
  let magenta = 0
  let total = 0

  for (const frame of frames) {
    const samplePoints = [
      [frame.x + 2, frame.y + 2],
      [frame.x + frame.width - 3, frame.y + 2],
      [frame.x + 2, frame.y + frame.height - 3],
      [frame.x + frame.width - 3, frame.y + frame.height - 3]
    ]

    for (const [x, y] of samplePoints) {
      const index = (clamp(y, 0, image.height - 1) * image.width + clamp(x, 0, image.width - 1)) * 4
      if (isMagentaKeyLike(image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3])) {
        magenta += 1
      }
      total += 1
    }
  }

  return total > 0 && magenta / total > 0.5
}

function removeMagentaKeyPixels(image) {
  for (let index = 0; index < image.data.length; index += 4) {
    if (!isMagentaKeyLike(image.data[index], image.data[index + 1], image.data[index + 2], image.data[index + 3])) {
      continue
    }

    image.data[index] = 0
    image.data[index + 1] = 0
    image.data[index + 2] = 0
    image.data[index + 3] = 0
  }
}

function isMagentaKeyLike(red, green, blue, alpha) {
  if (alpha <= alphaThreshold) return true
  return red >= 170 && blue >= 165 && green <= 115 && red - green >= 85 && blue - green >= 80
}

function findContentBounds(image, frame) {
  const startX = frame.x
  const startY = frame.y
  const endX = Math.min(image.width, startX + frame.width)
  const endY = Math.min(image.height, startY + frame.height)
  const width = endX - startX
  const height = endY - startY
  const total = Math.max(1, (endX - startX) * (endY - startY))
  let transparentPixels = 0

  for (let y = startY; y < endY; y += 1) {
    for (let x = startX; x < endX; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] <= alphaThreshold) transparentPixels += 1
    }
  }

  const hasUsefulAlpha = transparentPixels > total * 0.05
  const visited = new Uint8Array(width * height)
  let largestComponent = {
    count: 0,
    minX: endX,
    minY: endY,
    maxX: startX,
    maxY: startY
  }

  // Use the largest component so sheet labels or detached shadows do not shrink every frame.
  for (let localY = 0; localY < height; localY += 1) {
    for (let localX = 0; localX < width; localX += 1) {
      const localIndex = localY * width + localX
      if (visited[localIndex]) continue
      visited[localIndex] = 1

      if (!isSourceVisibleForBounds(image, startX + localX, startY + localY, hasUsefulAlpha)) continue

      const queue = [[localX, localY]]
      const component = {
        count: 0,
        minX: startX + localX,
        minY: startY + localY,
        maxX: startX + localX + 1,
        maxY: startY + localY + 1
      }

      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const [x, y] = queue[cursor]
        const sourceX = startX + x
        const sourceY = startY + y
        component.count += 1
        component.minX = Math.min(component.minX, sourceX)
        component.minY = Math.min(component.minY, sourceY)
        component.maxX = Math.max(component.maxX, sourceX + 1)
        component.maxY = Math.max(component.maxY, sourceY + 1)

        queueSourceNeighbor(image, frame, visited, queue, x + 1, y, width, height, hasUsefulAlpha)
        queueSourceNeighbor(image, frame, visited, queue, x - 1, y, width, height, hasUsefulAlpha)
        queueSourceNeighbor(image, frame, visited, queue, x, y + 1, width, height, hasUsefulAlpha)
        queueSourceNeighbor(image, frame, visited, queue, x, y - 1, width, height, hasUsefulAlpha)
      }

      if (component.count > largestComponent.count) largestComponent = component
    }
  }

  if (largestComponent.count <= 0) {
    return { x: startX, y: startY, width: endX - startX, height: endY - startY }
  }

  return {
    x: largestComponent.minX,
    y: largestComponent.minY,
    width: largestComponent.maxX - largestComponent.minX,
    height: largestComponent.maxY - largestComponent.minY
  }
}

function queueSourceNeighbor(image, frame, visited, queue, localX, localY, width, height, hasUsefulAlpha) {
  if (localX < 0 || localY < 0 || localX >= width || localY >= height) return
  const localIndex = localY * width + localX
  if (visited[localIndex]) return
  visited[localIndex] = 1

  const sourceX = frame.x + localX
  const sourceY = frame.y + localY
  if (!isSourceVisibleForBounds(image, sourceX, sourceY, hasUsefulAlpha)) return

  queue.push([localX, localY])
}

function isSourceVisibleForBounds(image, x, y, hasUsefulAlpha) {
  const index = (y * image.width + x) * 4
  const alpha = image.data[index + 3]
  if (hasUsefulAlpha) return alpha > alphaThreshold

  return alpha > alphaThreshold && (image.data[index] > 10 || image.data[index + 1] > 10 || image.data[index + 2] > 10)
}

function expandBounds(bounds, frame, margin) {
  const x = Math.max(frame.x, bounds.x - margin)
  const y = Math.max(frame.y, bounds.y - margin)
  const right = Math.min(frame.x + frame.width, bounds.x + bounds.width + margin)
  const bottom = Math.min(frame.y + frame.height, bounds.y + bounds.height + margin)

  return {
    x,
    y,
    width: Math.max(1, right - x),
    height: Math.max(1, bottom - y)
  }
}

function findBodyAnchorX(image, frame, bounds) {
  const chestAnchor = findChestAnchorX(image, frame, bounds)
  if (chestAnchor !== undefined) return chestAnchor

  const bandTop = Math.round(bounds.y + bounds.height * 0.42)
  const bandBottom = Math.round(bounds.y + bounds.height * 0.86)
  let minX = frame.x + frame.width
  let maxX = frame.x

  for (let y = bandTop; y < bandBottom; y += 1) {
    for (let x = frame.x; x < frame.x + frame.width; x += 1) {
      if (image.data[(y * image.width + x) * 4 + 3] <= alphaThreshold) continue
      minX = Math.min(minX, x)
      maxX = Math.max(maxX, x + 1)
    }
  }

  if (minX < maxX) return (minX + maxX) / 2
  return bounds.x + bounds.width / 2
}

function findChestAnchorX(image, frame, bounds) {
  const minX = Math.round(bounds.x + bounds.width * 0.28)
  const maxX = Math.round(bounds.x + bounds.width * 0.72)
  const minY = Math.round(bounds.y + bounds.height * 0.35)
  const maxY = Math.round(bounds.y + bounds.height * 0.72)
  let weightedX = 0
  let totalWeight = 0

  for (let y = minY; y < maxY; y += 1) {
    for (let x = minX; x < maxX; x += 1) {
      const index = (y * image.width + x) * 4
      const alpha = image.data[index + 3]
      if (alpha <= alphaThreshold) continue

      const red = image.data[index]
      const green = image.data[index + 1]
      const blue = image.data[index + 2]
      if (blue < 135 || green < 80 || blue < red + 28 || green < red + 6) continue

      const weight = alpha * (blue - red)
      weightedX += x * weight
      totalWeight += weight
    }
  }

  if (totalWeight <= 0) return undefined
  return weightedX / totalWeight
}

function computeStableScale(boundsList, anchors, targetAnchorX, targetBaselineY, padding) {
  let scale = Number.POSITIVE_INFINITY

  for (let index = 0; index < boundsList.length; index += 1) {
    const bounds = boundsList[index]
    const anchor = anchors[index]
    const leftSpace = anchor.x - bounds.x
    const rightSpace = bounds.x + bounds.width - anchor.x
    const topSpace = anchor.baselineY - bounds.y
    const bottomSpace = bounds.y + bounds.height - anchor.baselineY

    if (leftSpace > 0) scale = Math.min(scale, (targetAnchorX - padding) / leftSpace)
    if (rightSpace > 0) scale = Math.min(scale, (frameSize - padding - targetAnchorX) / rightSpace)
    if (topSpace > 0) scale = Math.min(scale, (targetBaselineY - padding) / topSpace)
    if (bottomSpace > 0) scale = Math.min(scale, (frameSize - targetBaselineY) / bottomSpace)
  }

  if (!Number.isFinite(scale) || scale <= 0) return 1
  return scale
}

function drawScaledRegion(source, output, bounds, targetX, targetY, targetWidth, targetHeight) {
  for (let y = 0; y < targetHeight; y += 1) {
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX = bounds.x + ((x + 0.5) / targetWidth) * bounds.width
      const sourceY = bounds.y + ((y + 0.5) / targetHeight) * bounds.height
      const color = sampleBilinear(source, sourceX, sourceY)
      if (color[3] <= alphaThreshold) continue
      blendPixel(output, targetX + x, targetY + y, color)
    }
  }
}

function sampleBilinear(image, x, y) {
  const x0 = clamp(Math.floor(x), 0, image.width - 1)
  const y0 = clamp(Math.floor(y), 0, image.height - 1)
  const x1 = clamp(x0 + 1, 0, image.width - 1)
  const y1 = clamp(y0 + 1, 0, image.height - 1)
  const tx = x - x0
  const ty = y - y0
  const samples = [
    [x0, y0, (1 - tx) * (1 - ty)],
    [x1, y0, tx * (1 - ty)],
    [x0, y1, (1 - tx) * ty],
    [x1, y1, tx * ty]
  ]

  let r = 0
  let g = 0
  let b = 0
  let a = 0

  for (const [sampleX, sampleY, weight] of samples) {
    const index = (sampleY * image.width + sampleX) * 4
    const alpha = (image.data[index + 3] / 255) * weight
    r += image.data[index] * alpha
    g += image.data[index + 1] * alpha
    b += image.data[index + 2] * alpha
    a += alpha
  }

  if (a <= 0) return [0, 0, 0, 0]
  return [
    Math.round(r / a),
    Math.round(g / a),
    Math.round(b / a),
    Math.round(a * 255)
  ]
}

function blendPixel(image, x, y, color) {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return
  const index = (y * image.width + x) * 4
  const sourceAlpha = color[3] / 255
  const targetAlpha = image.data[index + 3] / 255
  const outputAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
  if (outputAlpha <= 0) return

  image.data[index] = Math.round(
    (color[0] * sourceAlpha + image.data[index] * targetAlpha * (1 - sourceAlpha)) / outputAlpha
  )
  image.data[index + 1] = Math.round(
    (color[1] * sourceAlpha + image.data[index + 1] * targetAlpha * (1 - sourceAlpha)) / outputAlpha
  )
  image.data[index + 2] = Math.round(
    (color[2] * sourceAlpha + image.data[index + 2] * targetAlpha * (1 - sourceAlpha)) / outputAlpha
  )
  image.data[index + 3] = Math.round(outputAlpha * 255)
}

function keepLargestFrameComponent(image, frameIndex) {
  const startX = frameIndex * frameSize
  const visited = new Uint8Array(frameSize * frameSize)
  let largestComponent = []

  for (let localY = 0; localY < frameSize; localY += 1) {
    for (let localX = 0; localX < frameSize; localX += 1) {
      const localIndex = localY * frameSize + localX
      if (visited[localIndex] || !isOutputVisible(image, startX + localX, localY)) continue

      const component = collectFrameComponent(image, startX, localX, localY, visited)
      if (component.length > largestComponent.length) largestComponent = component
    }
  }

  const keep = new Uint8Array(frameSize * frameSize)
  for (const localIndex of largestComponent) {
    keep[localIndex] = 1
  }

  for (let localY = 0; localY < frameSize; localY += 1) {
    for (let localX = 0; localX < frameSize; localX += 1) {
      const localIndex = localY * frameSize + localX
      if (keep[localIndex]) continue

      const index = (localY * image.width + startX + localX) * 4
      image.data[index] = 0
      image.data[index + 1] = 0
      image.data[index + 2] = 0
      image.data[index + 3] = 0
    }
  }
}

function collectFrameComponent(image, frameStartX, startLocalX, startLocalY, visited) {
  const queue = [[startLocalX, startLocalY]]
  const component = []
  visited[startLocalY * frameSize + startLocalX] = 1

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const [localX, localY] = queue[cursor]
    component.push(localY * frameSize + localX)

    queueOutputNeighbor(image, frameStartX, localX + 1, localY, visited, queue)
    queueOutputNeighbor(image, frameStartX, localX - 1, localY, visited, queue)
    queueOutputNeighbor(image, frameStartX, localX, localY + 1, visited, queue)
    queueOutputNeighbor(image, frameStartX, localX, localY - 1, visited, queue)
  }

  return component
}

function queueOutputNeighbor(image, frameStartX, localX, localY, visited, queue) {
  if (localX < 0 || localY < 0 || localX >= frameSize || localY >= frameSize) return

  const localIndex = localY * frameSize + localX
  if (visited[localIndex]) return
  visited[localIndex] = 1

  if (!isOutputVisible(image, frameStartX + localX, localY)) return
  queue.push([localX, localY])
}

function isOutputVisible(image, x, y) {
  return image.data[(y * image.width + x) * 4 + 3] > alphaThreshold
}

function decodePng(buffer) {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('Invalid PNG signature')
  }

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

  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error('Only 8-bit RGB and RGBA PNG files are supported')
  }

  const bytesPerPixel = colorType === 6 ? 4 : 3
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
    if (colorType === 6) {
      data.set(row, outputOffset)
    } else {
      for (let x = 0; x < width; x += 1) {
        const inputIndex = x * 3
        const outputIndex = outputOffset + x * 4
        data[outputIndex] = row[inputIndex]
        data[outputIndex + 1] = row[inputIndex + 1]
        data[outputIndex + 2] = row[inputIndex + 2]
        data[outputIndex + 3] = 255
      }
    }
    previous = row
    outputOffset += width * 4
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

function validatePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
}
