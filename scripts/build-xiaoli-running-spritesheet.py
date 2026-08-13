#!/usr/bin/env python3
"""Build production, 2x-density runtime atlases from Xiaoli's authored frames.

The motion source atlas contains real, high-resolution poses. Runtime atlases
must preserve those poses rather than manufacture in-betweens: optical-flow
frames soften hands, feet and the chest mark, producing a visible sharp/blur
pulse. This builder only translates and resamples authored source cells.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
from pathlib import Path
from statistics import median

from PIL import Image


SOURCE_CELL = (384, 320)
SOURCE_ANCHOR_X = SOURCE_CELL[0] / 2
VISIBLE_ALPHA_THRESHOLD = 12

RUN_FRAME_COUNT = 24
RUN_CONTENT_SIZE = (184, 152)
RUN_BOTTOM_GUTTER_PX = 16
RUN_CELL = (RUN_CONTENT_SIZE[0], RUN_CONTENT_SIZE[1] + RUN_BOTTOM_GUTTER_PX)

PEEK_FRAME_COUNT = 12
PEEK_CELL = (184, 152)
PEEK_SOURCE_ANCHOR_STEP_PX = 2


@dataclass(frozen=True)
class RuntimeSequence:
    name: str
    frames: list[Image.Image]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        type=Path,
        default=Path("src/assets/mascot/xiaoli-motion-spritesheet.webp"),
        help="High-resolution motion source atlas.",
    )
    parser.add_argument(
        "--running-out",
        type=Path,
        default=Path("src/assets/mascot/xiaoli-running-spritesheet.webp"),
        help="2x runtime running atlas.",
    )
    parser.add_argument(
        "--peek-out",
        type=Path,
        default=Path("src/assets/mascot/xiaoli-peek-spritesheet.webp"),
        help="2x runtime peek/reveal atlas.",
    )
    return parser.parse_args()


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


def visible_alpha(frame: Image.Image) -> Image.Image:
    return frame.getchannel("A").point(
        lambda value: 255 if value > VISIBLE_ALPHA_THRESHOLD else 0,
        mode="L",
    )


def visible_bbox(frame: Image.Image) -> tuple[int, int, int, int]:
    bbox = visible_alpha(frame).getbbox()
    if bbox is None:
        raise ValueError("runtime source contains an empty frame")
    return bbox


def visible_pixel_count(frame: Image.Image) -> int:
    return sum(visible_alpha(frame).histogram()[255:])


def alpha_centroid_x(frame: Image.Image) -> float:
    alpha = frame.getchannel("A")
    pixels = alpha.load()
    weighted_x = 0
    total = 0
    for y in range(frame.height):
        for x in range(frame.width):
            value = pixels[x, y]
            if value <= VISIBLE_ALPHA_THRESHOLD:
                continue
            total += value
            weighted_x += x * value
    if total == 0:
        raise ValueError("runtime source contains no visible alpha")
    return weighted_x / total


def head_anchor_x(frame: Image.Image) -> float:
    """Use the helmet as a stable gait anchor, independent of moving limbs."""

    helmet = visible_alpha(frame).crop((0, 0, SOURCE_CELL[0], 155))
    bbox = helmet.getbbox()
    if bbox is None:
        raise ValueError("running frame has no visible helmet")
    return (bbox[0] + bbox[2]) / 2


def translate(frame: Image.Image, offset_x: int, offset_y: int) -> Image.Image:
    before = visible_pixel_count(frame)
    translated = Image.new("RGBA", SOURCE_CELL, (0, 0, 0, 0))
    translated.alpha_composite(frame, (offset_x, offset_y))
    after = visible_pixel_count(translated)
    if after < before:
        raise ValueError(
            f"stabilization clipped {before - after} visible source pixels "
            f"at offset ({offset_x}, {offset_y})"
        )
    return translated


def common_baseline(frames: list[Image.Image]) -> int:
    return round(median(visible_bbox(frame)[3] for frame in frames))


def stabilize_running(frames: list[Image.Image], baseline: int) -> list[Image.Image]:
    stabilized: list[Image.Image] = []
    for frame in frames:
        bbox = visible_bbox(frame)
        helmet_stabilized = translate(
            frame,
            round(SOURCE_ANCHOR_X - head_anchor_x(frame)),
            baseline - bbox[3],
        )
        # The helmet anchor removes gait wobble; a second, small whole-silhouette
        # correction puts both directions on the exact same visual center. This
        # prevents an internal sprite jump when drag direction changes.
        stabilized.append(
            translate(
                helmet_stabilized,
                round(SOURCE_ANCHOR_X - alpha_centroid_x(helmet_stabilized)),
                0,
            )
        )
    return stabilized


def stabilize_peek(
    frames: list[Image.Image],
    baseline: int,
    direction: int,
) -> list[Image.Image]:
    """Use a quiet monotonic local path while the native window supplies travel."""

    stabilized: list[Image.Image] = []
    for index, frame in enumerate(frames):
        bbox = visible_bbox(frame)
        target_x = SOURCE_ANCHOR_X + direction * index * PEEK_SOURCE_ANCHOR_STEP_PX
        stabilized.append(
            translate(
                frame,
                round(target_x - alpha_centroid_x(frame)),
                baseline - bbox[3],
            )
        )
    return stabilized


def build_runtime_frame(
    source: Image.Image,
    content_size: tuple[int, int],
    cell_size: tuple[int, int],
) -> Image.Image:
    resized = source.resize(content_size, Image.Resampling.LANCZOS)
    cell = Image.new("RGBA", cell_size, (0, 0, 0, 0))
    cell.alpha_composite(resized, (0, 0))
    bbox = visible_bbox(cell)
    if min(bbox[0], bbox[1], cell.width - bbox[2], cell.height - bbox[3]) <= 0:
        raise ValueError(f"runtime pose touches cell edge: bbox={bbox}, cell={cell_size}")
    return cell


def pack_rows(
    sequences: list[RuntimeSequence],
    cell_size: tuple[int, int],
) -> Image.Image:
    frame_count = len(sequences[0].frames)
    if any(len(sequence.frames) != frame_count for sequence in sequences):
        raise ValueError("runtime atlas rows must use the same frame count")
    atlas = Image.new(
        "RGBA",
        (cell_size[0] * frame_count, cell_size[1] * len(sequences)),
        (0, 0, 0, 0),
    )
    for row, sequence in enumerate(sequences):
        for column, frame in enumerate(sequence.frames):
            atlas.alpha_composite(frame, (column * cell_size[0], row * cell_size[1]))
    return atlas


def save_lossless(atlas: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(path, "WEBP", lossless=True, quality=100, method=6, exact=True)


def main() -> None:
    args = parse_args()
    atlas = Image.open(args.source).convert("RGBA")
    expected_size = (SOURCE_CELL[0] * RUN_FRAME_COUNT, SOURCE_CELL[1] * 4)
    if atlas.size != expected_size:
        raise SystemExit(f"unexpected source atlas size {atlas.size}; expected {expected_size}")

    running_source_rows = [
        [source_frame(atlas, row, column) for column in range(RUN_FRAME_COUNT)]
        for row in range(2)
    ]
    running_baseline = common_baseline(running_source_rows[0] + running_source_rows[1])
    running_rows = [
        RuntimeSequence(
            "running-right" if row == 0 else "running-left",
            [
                build_runtime_frame(frame, RUN_CONTENT_SIZE, RUN_CELL)
                for frame in stabilize_running(source_frames, running_baseline)
            ],
        )
        for row, source_frames in enumerate(running_source_rows)
    ]
    running_atlas = pack_rows(running_rows, RUN_CELL)
    save_lossless(running_atlas, args.running_out)

    peek_source_rows = [
        [source_frame(atlas, row, column) for column in range(PEEK_FRAME_COUNT)]
        for row in (2, 3)
    ]
    peek_baseline = common_baseline(peek_source_rows[0] + peek_source_rows[1])
    peek_rows = [
        RuntimeSequence(
            "peeking-right" if row == 0 else "peeking-left",
            [
                build_runtime_frame(frame, PEEK_CELL, PEEK_CELL)
                for frame in stabilize_peek(
                    source_frames,
                    peek_baseline,
                    1 if row == 0 else -1,
                )
            ],
        )
        for row, source_frames in enumerate(peek_source_rows)
    ]
    peek_atlas = pack_rows(peek_rows, PEEK_CELL)
    save_lossless(peek_atlas, args.peek_out)

    print(
        f"built {args.running_out}: {running_atlas.width}x{running_atlas.height}, "
        f"{RUN_FRAME_COUNT} authored frames x 2, 2x logical 92x84"
    )
    print(
        f"built {args.peek_out}: {peek_atlas.width}x{peek_atlas.height}, "
        f"{PEEK_FRAME_COUNT} authored frames x 2, 2x logical 92x76"
    )


if __name__ == "__main__":
    main()
