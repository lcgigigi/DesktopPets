#!/usr/bin/env python3
"""Build a stabilized, motion-interpolated runtime atlas for Xiaoli's run loop."""

from pathlib import Path

import cv2
import numpy as np
from PIL import Image


SOURCE = Path("src/assets/mascot/xiaoli-motion-spritesheet.webp")
OUTPUT = Path("src/assets/mascot/xiaoli-running-spritesheet.webp")
SOURCE_CELL = (384, 320)
RUNTIME_CELL = (132, 110)
SOURCE_FRAME_COUNT = 24
INTERPOLATED_PER_PAIR = 2
RIGHT_RUN_SAFE_SHIFT_PX = 8


def source_frame(atlas: Image.Image, row: int, column: int) -> Image.Image:
    width, height = SOURCE_CELL
    return atlas.crop(
        (
            column * width,
            row * height,
            (column + 1) * width,
            (row + 1) * height,
        )
    )


def head_center_x(frame: Image.Image) -> float:
    # The upper 155 source pixels contain the helmet but not the running legs.
    bbox = frame.getchannel("A").crop((0, 0, SOURCE_CELL[0], 155)).getbbox()
    if bbox is None:
        raise ValueError("running frame has no visible head")
    return (bbox[0] + bbox[2]) / 2


def translate_x(frame: Image.Image, offset: int) -> Image.Image:
    translated = Image.new("RGBA", SOURCE_CELL, (0, 0, 0, 0))
    translated.alpha_composite(frame, (offset, 0))
    return translated


def stabilize_row(frames: list[Image.Image]) -> tuple[list[Image.Image], float]:
    centers = [head_center_x(frame) for frame in frames]
    target = float(np.median(centers))
    stabilized = [
        translate_x(frame, round(target - center))
        for frame, center in zip(frames, centers, strict=True)
    ]
    return stabilized, target


def optical_flow_image(rgba: np.ndarray) -> np.ndarray:
    alpha = rgba[..., 3:4].astype(np.float32) / 255
    composite = rgba[..., :3].astype(np.float32) * alpha + 238 * (1 - alpha)
    return cv2.cvtColor(composite.astype(np.uint8), cv2.COLOR_RGB2GRAY)


def premultiply(rgba: np.ndarray) -> np.ndarray:
    result = rgba.astype(np.float32)
    result[..., :3] *= result[..., 3:4] / 255
    return result


def warp(image: np.ndarray, flow: np.ndarray, amount: float) -> np.ndarray:
    height, width = flow.shape[:2]
    grid_x, grid_y = np.meshgrid(
        np.arange(width, dtype=np.float32),
        np.arange(height, dtype=np.float32),
    )
    return cv2.remap(
        image,
        grid_x - flow[..., 0] * amount,
        grid_y - flow[..., 1] * amount,
        interpolation=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=0,
    )


def interpolate(first: Image.Image, second: Image.Image, amount: float) -> Image.Image:
    first_rgba = np.asarray(first, dtype=np.uint8)
    second_rgba = np.asarray(second, dtype=np.uint8)
    first_gray = optical_flow_image(first_rgba)
    second_gray = optical_flow_image(second_rgba)
    flow_forward = cv2.calcOpticalFlowFarneback(
        first_gray, second_gray, None, 0.5, 4, 19, 4, 7, 1.5, 0
    )
    flow_backward = cv2.calcOpticalFlowFarneback(
        second_gray, first_gray, None, 0.5, 4, 19, 4, 7, 1.5, 0
    )
    first_warped = warp(premultiply(first_rgba), flow_forward, amount)
    second_warped = warp(premultiply(second_rgba), flow_backward, 1 - amount)
    blended = first_warped * (1 - amount) + second_warped * amount
    alpha = np.clip(blended[..., 3:4], 0, 255)
    safe_alpha = np.maximum(alpha, 1)
    rgb = np.clip(blended[..., :3] * 255 / safe_alpha, 0, 255)
    rgba = np.concatenate((rgb, alpha), axis=2).astype(np.uint8)
    rgba[alpha[..., 0] < 1] = 0
    return Image.fromarray(rgba, mode="RGBA")


def build_runtime_row(frames: list[Image.Image]) -> list[Image.Image]:
    resized = [frame.resize(RUNTIME_CELL, Image.Resampling.LANCZOS) for frame in frames]
    output: list[Image.Image] = []
    for index, current in enumerate(resized):
        following = resized[(index + 1) % len(resized)]
        output.append(current)
        for step in range(1, INTERPOLATED_PER_PAIR + 1):
            output.append(interpolate(current, following, step / (INTERPOLATED_PER_PAIR + 1)))
    return output


def add_right_run_safety_inset(frames: list[Image.Image]) -> list[Image.Image]:
    """Move right-running poses left so helmet antialiasing never meets the cell edge."""
    shifted: list[Image.Image] = []
    for frame in frames:
        canvas = Image.new("RGBA", RUNTIME_CELL, (0, 0, 0, 0))
        canvas.alpha_composite(frame, (-RIGHT_RUN_SAFE_SHIFT_PX, 0))
        shifted.append(canvas)
    return shifted


def main() -> None:
    atlas = Image.open(SOURCE).convert("RGBA")
    if atlas.size != (SOURCE_CELL[0] * SOURCE_FRAME_COUNT, SOURCE_CELL[1] * 3):
        raise SystemExit(f"unexpected source atlas size: {atlas.size}")

    rows: list[list[Image.Image]] = []
    targets: list[float] = []
    for row in range(2):
        originals = [source_frame(atlas, row, column) for column in range(SOURCE_FRAME_COUNT)]
        stabilized, target = stabilize_row(originals)
        runtime_row = build_runtime_row(stabilized)
        if row == 0:
            runtime_row = add_right_run_safety_inset(runtime_row)
        rows.append(runtime_row)
        targets.append(target)

    frame_count = len(rows[0])
    output = Image.new(
        "RGBA",
        (RUNTIME_CELL[0] * frame_count, RUNTIME_CELL[1] * len(rows)),
        (0, 0, 0, 0),
    )
    for row, frames in enumerate(rows):
        for column, frame in enumerate(frames):
            output.alpha_composite(frame, (column * RUNTIME_CELL[0], row * RUNTIME_CELL[1]))

    output.save(OUTPUT, "WEBP", lossless=True, method=6)
    print(
        f"built {OUTPUT}: {frame_count} frames x {len(rows)} rows, "
        f"head anchors {targets}, {output.size[0]}x{output.size[1]}"
    )


if __name__ == "__main__":
    main()
