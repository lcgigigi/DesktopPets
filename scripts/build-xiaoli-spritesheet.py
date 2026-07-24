#!/usr/bin/env python3
"""Build the production Xiaoli animation atlas from generated source sheets.

The source images are intentionally kept outside the runtime bundle. This script
removes layout differences between the generated sheets, packs every event into
equal cells, mirrors the right-running cycle for the left-running cycle, and
writes a lossless WebP atlas for the Vue component.
"""

from __future__ import annotations

import argparse
import math
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw, ImageFilter, ImageOps


CELL_WIDTH = 384
CELL_HEIGHT = 320
ATLAS_COLUMNS = 12
MOTION_ATLAS_COLUMNS = 24
CONTENT_SCALE = 1.04
HEIGHT_COMPRESSION = 0.96
SAFE_BASELINE = 296


@dataclass(frozen=True)
class Sequence:
    name: str
    frames: list[Image.Image]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source-dir",
        type=Path,
        default=Path("tmp/imagegen/xiaoli-v4"),
        help="Directory containing the transparent generated source sheets.",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path("src/assets/mascot/xiaoli-spritesheet.webp"),
        help="Lossless WebP atlas output path.",
    )
    parser.add_argument(
        "--motion-source-dir",
        type=Path,
        default=Path("tmp/imagegen/xiaoli-v5"),
        help="Directory containing the 24-frame run cycle and peeking sheet.",
    )
    parser.add_argument(
        "--motion-out",
        type=Path,
        default=Path("src/assets/mascot/xiaoli-motion-spritesheet.webp"),
        help="Lossless WebP atlas containing high-frame-rate directional motion.",
    )
    parser.add_argument(
        "--logo",
        type=Path,
        default=Path("src/assets/brand/huali-logo-mark.png"),
        help="Transparent corporate mark composited into every chest badge.",
    )
    return parser.parse_args()


def extract_subject_frames(
    image: Image.Image, expected_count: int, columns: int
) -> list[Image.Image]:
    """Extract complete robots by alpha component instead of brittle grid cuts.

    Image generation can place a head a few pixels across an ideal grid line.
    Connected-component extraction keeps that head with its body and prevents
    neighbouring rows from being packed into one animation cell.
    """

    alpha = image.getchannel("A")
    pixels = alpha.load()
    width, height = image.size
    visited = bytearray(width * height)
    components: list[tuple[int, tuple[int, int, int, int]]] = []

    for y in range(height):
        for x in range(width):
            start = y * width + x
            if visited[start] or pixels[x, y] <= 8:
                visited[start] = 1
                continue

            visited[start] = 1
            queue: deque[tuple[int, int]] = deque([(x, y)])
            size = 0
            left = right = x
            top = bottom = y
            while queue:
                current_x, current_y = queue.popleft()
                size += 1
                left = min(left, current_x)
                right = max(right, current_x)
                top = min(top, current_y)
                bottom = max(bottom, current_y)
                for next_x, next_y in (
                    (current_x + 1, current_y),
                    (current_x - 1, current_y),
                    (current_x, current_y + 1),
                    (current_x, current_y - 1),
                ):
                    if next_x < 0 or next_y < 0 or next_x >= width or next_y >= height:
                        continue
                    index = next_y * width + next_x
                    if visited[index]:
                        continue
                    visited[index] = 1
                    if pixels[next_x, next_y] > 8:
                        queue.append((next_x, next_y))

            if size > 20:
                components.append((size, (left, top, right + 1, bottom + 1)))

    if len(components) < expected_count:
        raise ValueError(
            f"Generated sheet contains {len(components)} subjects; expected {expected_count}"
        )

    selected = sorted(components, reverse=True)[:expected_count]
    rows = math.ceil(expected_count / columns)
    selected.sort(key=lambda item: (item[1][1] + item[1][3]) / 2)
    ordered: list[tuple[int, tuple[int, int, int, int]]] = []
    for row in range(rows):
        row_items = selected[row * columns : min(expected_count, (row + 1) * columns)]
        row_items.sort(key=lambda item: (item[1][0] + item[1][2]) / 2)
        ordered.extend(row_items)

    frames: list[Image.Image] = []
    for _, (left, top, right, bottom) in ordered:
        subject = image.crop((left, top, right, bottom))
        subject_size = max(subject.width, subject.height)
        padding = max(8, round(subject_size * 0.08))
        canvas_size = subject_size + padding * 2
        canvas = Image.new("RGBA", (canvas_size, canvas_size), (0, 0, 0, 0))
        canvas.alpha_composite(
            subject,
            ((canvas_size - subject.width) // 2, (canvas_size - subject.height) // 2),
        )
        frames.append(canvas)

    return frames


def extract_grid_frames(
    image: Image.Image, expected_count: int, columns: int
) -> list[Image.Image]:
    """Cut an exact generated grid without recentering its internal staging.

    The hide sequence deliberately moves the body behind an implied screen
    edge. Component extraction would recenter that pose and destroy the peek,
    so those frames retain their authored cell-space coordinates.
    """

    rows = math.ceil(expected_count / columns)
    if image.width % columns or image.height % rows:
        raise ValueError(
            f"Generated grid {image.size} is not divisible by {columns}x{rows}"
        )
    cell_width = image.width // columns
    cell_height = image.height // rows
    return [
        image.crop(
            (
                (index % columns) * cell_width,
                (index // columns) * cell_height,
                (index % columns + 1) * cell_width,
                (index // columns + 1) * cell_height,
            )
        )
        for index in range(expected_count)
    ]


def alpha_bbox(frame: Image.Image) -> tuple[int, int, int, int]:
    bbox = frame.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("Generated source contains an empty animation frame")
    return bbox


def resize_cell(frame: Image.Image) -> Image.Image:
    return frame.resize((CELL_HEIGHT, CELL_HEIGHT), Image.Resampling.LANCZOS)


def remove_small_alpha_components(frame: Image.Image) -> Image.Image:
    """Remove isolated keying debris while preserving real articulated parts."""

    alpha = frame.getchannel("A")
    pixels = alpha.load()
    width, height = frame.size
    visited = bytearray(width * height)
    components: list[list[int]] = []

    for y in range(height):
        for x in range(width):
            start = y * width + x
            if visited[start] or pixels[x, y] <= 8:
                visited[start] = 1
                continue

            visited[start] = 1
            queue: deque[tuple[int, int]] = deque([(x, y)])
            component: list[int] = []
            while queue:
                current_x, current_y = queue.popleft()
                component.append(current_y * width + current_x)
                for next_x, next_y in (
                    (current_x + 1, current_y),
                    (current_x - 1, current_y),
                    (current_x, current_y + 1),
                    (current_x, current_y - 1),
                ):
                    if next_x < 0 or next_y < 0 or next_x >= width or next_y >= height:
                        continue
                    index = next_y * width + next_x
                    if visited[index]:
                        continue
                    visited[index] = 1
                    if pixels[next_x, next_y] > 8:
                        queue.append((next_x, next_y))
            components.append(component)

    if not components:
        raise ValueError("Generated source contains an empty animation frame")

    largest_component = max(components, key=len)
    keep = bytearray(width * height)
    for index in largest_component:
        keep[index] = 1

    cleaned = frame.copy()
    output = cleaned.load()
    for y in range(height):
        for x in range(width):
            if keep[y * width + x]:
                continue
            output[x, y] = (0, 0, 0, 0)
    return cleaned


def body_anchor_x(frame: Image.Image) -> float:
    """Use the blue chest details as a stable horizontal body anchor."""

    pixels = frame.load()
    candidates: list[int] = []
    center_x = frame.width / 2
    for y in range(round(frame.height * 0.46), round(frame.height * 0.82)):
        for x in range(
            max(0, round(center_x - frame.height * 0.32)),
            min(frame.width, round(center_x + frame.height * 0.32)),
        ):
            red, green, blue, alpha = pixels[x, y]
            if alpha > 96 and blue >= 165 and blue - red >= 28 and blue - green >= 8:
                candidates.append(x)

    if candidates:
        return float(median(candidates))

    left, _, right, _ = alpha_bbox(frame)
    return (left + right) / 2


def visible_baseline(frame: Image.Image) -> int:
    alpha = frame.getchannel("A")
    pixels = alpha.load()
    for y in range(frame.height - 1, -1, -1):
        if any(pixels[x, y] > 8 for x in range(frame.width)):
            return y + 1
    raise ValueError("Generated source contains an empty animation frame")


def stabilize_frame(frame: Image.Image, target_baseline: int = SAFE_BASELINE) -> Image.Image:
    """Lock the body center and feet so source-grid placement cannot cause jumps."""

    cleaned = remove_small_alpha_components(frame)
    offset_x = round(CELL_WIDTH / 2 - body_anchor_x(cleaned))
    offset_y = target_baseline - visible_baseline(cleaned)
    stabilized = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    stabilized.alpha_composite(cleaned, (offset_x, offset_y))

    scaled_width = round(CELL_WIDTH * CONTENT_SCALE)
    scaled_height = round(CELL_HEIGHT * CONTENT_SCALE)
    scaled = stabilized.resize((scaled_width, scaled_height), Image.Resampling.LANCZOS)
    output = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    scaled_x = round(CELL_WIDTH / 2 - CELL_WIDTH / 2 * CONTENT_SCALE)
    scaled_y = round(target_baseline - target_baseline * CONTENT_SCALE)
    output.alpha_composite(scaled, (scaled_x, scaled_y))
    return output


def stabilize_sequence(frames: list[Image.Image]) -> list[Image.Image]:
    return [compress_frame_height(stabilize_frame(frame)) for frame in frames]


def compress_frame_height(frame: Image.Image, target_baseline: int = SAFE_BASELINE) -> Image.Image:
    """Make the mascot subtly shorter without clipping the head or either foot."""

    compressed_height = round(CELL_HEIGHT * HEIGHT_COMPRESSION)
    compressed = frame.resize((CELL_WIDTH, compressed_height), Image.Resampling.LANCZOS)
    output = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    output.alpha_composite(compressed, (0, target_baseline - visible_baseline(compressed)))
    return output


def preserve_grid_staging(frame: Image.Image) -> Image.Image:
    """Scale a staged peek frame while preserving its horizontal hiding arc."""

    cleaned = remove_small_alpha_components(frame)
    scale = 1.10 * CELL_HEIGHT / cleaned.height
    resized = cleaned.resize(
        (round(cleaned.width * scale), round(cleaned.height * scale)),
        Image.Resampling.LANCZOS,
    )
    output = Image.new("RGBA", (CELL_WIDTH, CELL_HEIGHT), (0, 0, 0, 0))
    output.alpha_composite(
        resized,
        (
            round((CELL_WIDTH - resized.width) / 2),
            SAFE_BASELINE - visible_baseline(resized),
        ),
    )
    return output


def brand_mark_candidates(frame: Image.Image) -> list[tuple[int, int]]:
    """Locate saturated-red pixels belonging to the Huali chest mark."""

    left, top, right, bottom = alpha_bbox(frame)
    # Three-quarter running poses move the chest module well away from the
    # canvas centre. Search the full torso width; the corporate mark is the
    # only saturated red detail on the robot and is therefore a safer anchor
    # than assuming a front-facing chest.
    search_left = left
    search_right = right
    search_top = max(top, SAFE_BASELINE - 132)
    search_bottom = min(bottom, SAFE_BASELINE - 42)
    pixels = frame.load()
    red_candidates: list[tuple[int, int]] = []

    for y in range(search_top, search_bottom):
        for x in range(search_left, search_right):
            red, green, blue, alpha = pixels[x, y]
            if (
                alpha > 96
                and red > 145
                and red - green > 55
                and red - blue > 25
            ):
                red_candidates.append((x, y))

    return red_candidates


def chest_badge_center(frame: Image.Image) -> tuple[int, int, int]:
    """Lock the exact badge to the red mark already rendered in the chest armor.

    Blue-part tracking is easily pulled toward a raised arm or ear. Every
    approved source frame already has a red Huali mark embedded in its chest,
    so that mark is the most reliable pose-aware anchor for the final exact
    logo overlay.
    """

    left, top, right, bottom = alpha_bbox(frame)
    body_height = bottom - top
    anchor_x = body_anchor_x(frame)
    red_candidates = brand_mark_candidates(frame)

    if len(red_candidates) >= 24:
        center_x = round(median(x for x, _ in red_candidates))
        center_y = round(median(y for _, y in red_candidates))
    else:
        center_x = round(anchor_x)
        center_y = round(top + body_height * 0.68)

    return center_x, center_y, 46


def correct_brand_mark(frame: Image.Image, logo: Image.Image) -> Image.Image:
    """Replace only the red mark while preserving the authored 3D badge.

    Repainting the entire badge would flatten its shell foreshortening, rim
    shadow, highlight and body occlusion into a front-facing sticker. The
    detected glyph bounds naturally retain each frame's side-on width, while a
    feathered glyph-only cleanup leaves the surrounding material untouched.
    """

    candidates = brand_mark_candidates(frame)
    if len(candidates) < 24:
        return frame

    xs = [x for x, _ in candidates]
    ys = [y for _, y in candidates]
    mark_left, mark_top = min(xs), min(ys)
    mark_right, mark_bottom = max(xs) + 1, max(ys) + 1
    mark_width = mark_right - mark_left
    mark_height = mark_bottom - mark_top
    center_x = round(median(xs))
    center_y = round(median(ys))

    # Sample the pearl-white face immediately around the mark. Restricting the
    # sample to bright, low-saturation pixels avoids borrowing the navy rim or
    # blue torso when the module becomes strongly foreshortened.
    pixels = frame.load()
    sample_padding = max(4, round(mark_height * 0.22))
    pearl_samples: list[tuple[int, int, int, int]] = []
    sample_left = max(0, mark_left - sample_padding)
    sample_top = max(0, mark_top - sample_padding)
    sample_right = min(frame.width, mark_right + sample_padding)
    sample_bottom = min(frame.height, mark_bottom + sample_padding)

    for y in range(sample_top, sample_bottom):
        for x in range(sample_left, sample_right):
            if mark_left <= x < mark_right and mark_top <= y < mark_bottom:
                continue
            red, green, blue, alpha = pixels[x, y]
            if alpha > 200 and min(red, green, blue) > 178 and max(red, green, blue) - min(red, green, blue) < 34:
                pearl_samples.append((red, green, blue, alpha))

    if pearl_samples:
        pearl = tuple(round(median(channel)) for channel in zip(*pearl_samples))
    else:
        pearl = (243, 246, 250, 255)

    # Feather only the old red pixels (plus a two-pixel antialias margin) back
    # into the pearl face. This preserves the original face gradient around the
    # glyph far better than covering its rectangular bounds.
    old_mark_mask = Image.new("L", frame.size, 0)
    mask_pixels = old_mark_mask.load()
    for x, y in candidates:
        mask_pixels[x, y] = 255
    old_mark_mask = old_mark_mask.filter(ImageFilter.MaxFilter(5))
    old_mark_mask = old_mark_mask.filter(ImageFilter.GaussianBlur(0.72))

    cleaned = frame.copy()
    pearl_layer = Image.new("RGBA", frame.size, pearl)
    cleaned = Image.composite(pearl_layer, cleaned, old_mark_mask)

    # Downsampling the high-resolution official mark directly to the detected
    # bounds keeps its edges clean. Matching both dimensions is intentional:
    # the changing width/height ratio is the badge's authored foreshortening.
    logo_copy = logo.copy()
    target_height = max(2, round(mark_height * 0.98))
    target_width = max(2, round(mark_width * 0.98))
    logo_copy = logo_copy.resize(
        (target_width, target_height), Image.Resampling.LANCZOS
    )
    cleaned.alpha_composite(
        logo_copy,
        (center_x - logo_copy.width // 2, center_y - logo_copy.height // 2),
    )
    return cleaned


def build_badge_layer(
    diameter: int, logo: Image.Image, perspective_scale_x: float = 1.0
) -> Image.Image:
    """Render the pearl-white branded module at 4x for clean antialiased edges."""

    supersampling = 4
    canvas_size = diameter + 16
    high_size = canvas_size * supersampling
    center = high_size // 2
    radius = diameter * supersampling // 2

    shadow = Image.new("RGBA", (high_size, high_size), (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    shadow_draw.ellipse(
        (center - radius, center - radius + 5 * supersampling, center + radius, center + radius + 5 * supersampling),
        fill=(6, 18, 42, 105),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(4 * supersampling))

    badge = Image.new("RGBA", (high_size, high_size), (0, 0, 0, 0))
    badge.alpha_composite(shadow)
    draw = ImageDraw.Draw(badge)

    def ellipse(inset: int, fill: tuple[int, int, int, int]) -> None:
        amount = inset * supersampling
        draw.ellipse(
            (center - radius + amount, center - radius + amount, center + radius - amount, center + radius - amount),
            fill=fill,
        )

    ellipse(0, (15, 34, 67, 245))
    ellipse(1, (201, 211, 227, 255))
    ellipse(2, (36, 86, 161, 255))
    ellipse(4, (231, 236, 245, 255))
    ellipse(6, (255, 255, 255, 255))
    # A restrained top highlight preserves the glossy 3D material of the shell.
    highlight_inset = 7 * supersampling
    draw.arc(
        (
            center - radius + highlight_inset,
            center - radius + highlight_inset,
            center + radius - highlight_inset,
            center + radius - highlight_inset,
        ),
        205,
        335,
        fill=(255, 255, 255, 210),
        width=2 * supersampling,
    )

    logo_copy = logo.copy()
    logo_copy.thumbnail(
        (round(diameter * 0.45 * supersampling), round(diameter * 0.56 * supersampling)),
        Image.Resampling.LANCZOS,
    )
    if logo_copy.width < logo.width:
        # `thumbnail` above operates on the source resolution. Upscale explicitly
        # when the supplied transparent mark is smaller than the 4x badge target.
        target_height = round(diameter * 0.56 * supersampling)
        target_width = round(logo.width * target_height / logo.height)
        logo_copy = logo.resize((target_width, target_height), Image.Resampling.LANCZOS)
    badge.alpha_composite(
        logo_copy,
        ((high_size - logo_copy.width) // 2, (high_size - logo_copy.height) // 2 + supersampling),
    )
    badge = badge.resize((canvas_size, canvas_size), Image.Resampling.LANCZOS)
    if perspective_scale_x < 0.999:
        badge = badge.resize(
            (max(1, round(canvas_size * perspective_scale_x)), canvas_size),
            Image.Resampling.LANCZOS,
        )
    return badge


def apply_brand_badge(
    frame: Image.Image, logo: Image.Image, perspective_scale_x: float = 1.0
) -> Image.Image:
    center_x, center_y, diameter = chest_badge_center(frame)
    badge = build_badge_layer(diameter, logo, perspective_scale_x)
    branded = frame.copy()
    branded.alpha_composite(
        badge,
        (center_x - badge.width // 2, center_y - badge.height // 2),
    )
    return branded


def load_rgba(path: Path) -> Image.Image:
    if not path.exists():
        raise FileNotFoundError(f"Missing generated source: {path}")
    return Image.open(path).convert("RGBA")


def repeat_to_row(frames: list[Image.Image]) -> list[Image.Image]:
    if not frames:
        raise ValueError("Animation sequence has no frames")
    return [frames[index % len(frames)] for index in range(ATLAS_COLUMNS)]


def validate_sequence(sequence: Sequence) -> None:
    if len(sequence.frames) not in {6, 12, 24}:
        raise ValueError(
            f"{sequence.name}: expected 6, 12 or 24 frames, got {len(sequence.frames)}"
        )

    for index, frame in enumerate(sequence.frames):
        if frame.size != (CELL_WIDTH, CELL_HEIGHT):
            raise ValueError(f"{sequence.name}[{index}]: invalid frame size {frame.size}")
        bbox = alpha_bbox(frame)
        visible_area = (bbox[2] - bbox[0]) * (bbox[3] - bbox[1])
        if visible_area < CELL_WIDTH * CELL_HEIGHT * 0.1:
            raise ValueError(f"{sequence.name}[{index}]: suspiciously small or empty frame")
        left, top, right, bottom = bbox
        if left < 10 or right > CELL_WIDTH - 10:
            raise ValueError(
                f"{sequence.name}[{index}]: ear, hand or body violates the side margin"
            )
        if top < 6 or bottom > CELL_HEIGHT - 4:
            raise ValueError(
                f"{sequence.name}[{index}]: head or feet violate the safe vertical margin"
            )

        pixels = frame.load()
        height = bottom - top
        accent_bottom = min(bottom, top + max(18, round(height * 0.16)))
        top_accent_pixels = 0
        for y in range(top, accent_bottom):
            for x in range(left, right):
                red, green, blue, alpha = pixels[x, y]
                if alpha > 80 and blue > 135 and blue - red > 18 and blue - green > 2:
                    top_accent_pixels += 1
        if top_accent_pixels < 120:
            raise ValueError(f"{sequence.name}[{index}]: top blue accent is missing or damaged")

        feet_top = top + round(height * 0.68)
        left_foot_pixels = sum(
            1
            for y in range(feet_top, bottom)
            for x in range(left, CELL_WIDTH // 2)
            if pixels[x, y][3] > 32
        )
        right_foot_pixels = sum(
            1
            for y in range(feet_top, bottom)
            for x in range(CELL_WIDTH // 2, right)
            if pixels[x, y][3] > 32
        )
        if min(left_foot_pixels, right_foot_pixels) < 300:
            raise ValueError(f"{sequence.name}[{index}]: one foot is missing or clipped")

        brand_pixels = sum(
            1
            for y in range(top + round(height * 0.52), top + round(height * 0.82))
            for x in range(left, right)
            if (
                pixels[x, y][3] > 96
                and pixels[x, y][0] > 150
                and pixels[x, y][0] - pixels[x, y][1] > 70
                and pixels[x, y][0] - pixels[x, y][2] > 35
            )
        )
        if brand_pixels < 40:
            raise ValueError(f"{sequence.name}[{index}]: red chest logo is missing or damaged")


def build_sequences(source_dir: Path) -> list[Sequence]:
    idle_cells = [
        resize_cell(frame)
        for frame in extract_subject_frames(load_rgba(source_dir / "idle.png"), 12, 4)
    ]
    idle = stabilize_sequence(idle_cells)

    attention = stabilize_sequence(
        [
            resize_cell(frame)
            for frame in extract_subject_frames(
                load_rgba(source_dir / "attention.png"), 12, 6
            )
        ]
    )

    reactions = stabilize_sequence(
        [
            resize_cell(frame)
            for frame in extract_subject_frames(
                load_rgba(source_dir / "reactions.png"), 12, 6
            )
        ]
    )
    remind = stabilize_sequence(
        [
            resize_cell(frame)
            for frame in extract_subject_frames(load_rgba(source_dir / "remind.png"), 12, 4)
        ]
    )
    thinking = stabilize_sequence(
        [
            resize_cell(frame)
            for frame in extract_subject_frames(load_rgba(source_dir / "thinking.png"), 12, 4)
        ]
    )
    running_right = stabilize_sequence(
        [
            resize_cell(frame)
            for frame in extract_subject_frames(
                load_rgba(source_dir / "running-right.png"), 12, 4
            )
        ]
    )
    running_left = [ImageOps.mirror(frame) for frame in running_right]
    cooling_office = stabilize_sequence(
        [
            resize_cell(frame)
            for frame in extract_subject_frames(
                load_rgba(source_dir / "cooling-office.png"), 6, 6
            )
        ]
    )

    return [
        Sequence("idle", idle),
        Sequence("hover", attention[:6]),
        Sequence("thinking", thinking),
        Sequence("waiting", attention[6:]),
        Sequence("remind", remind),
        Sequence("success", reactions[:6]),
        Sequence("error", reactions[6:]),
        Sequence("running-right", running_right),
        Sequence("running-left", running_left),
        Sequence("cooling-office", cooling_office),
    ]


def build_atlas(sequences: list[Sequence], logo: Image.Image) -> Image.Image:
    atlas = Image.new(
        "RGBA",
        (ATLAS_COLUMNS * CELL_WIDTH, len(sequences) * CELL_HEIGHT),
        (0, 0, 0, 0),
    )

    for row, sequence in enumerate(sequences):
        branded_sequence = Sequence(
            sequence.name,
            [apply_brand_badge(frame, logo) for frame in sequence.frames],
        )
        validate_sequence(branded_sequence)
        for column, frame in enumerate(repeat_to_row(branded_sequence.frames)):
            atlas.alpha_composite(frame, (column * CELL_WIDTH, row * CELL_HEIGHT))

    return atlas


def build_motion_atlas(source_dir: Path, logo: Image.Image) -> Image.Image:
    running_right = stabilize_sequence(
        [
            resize_cell(frame)
            for frame in extract_subject_frames(
                load_rgba(source_dir / "running-right-24.png"), 24, 6
            )
        ]
    )
    running_left = [ImageOps.mirror(frame) for frame in running_right]
    # The source intentionally ends with a partially occluded head/body. Keep
    # its authored horizontal staging instead of centering each component.
    peeking = [
        preserve_grid_staging(frame)
        for frame in extract_grid_frames(load_rgba(source_dir / "peeking.png"), 12, 4)
    ]
    # Use the official mark on both directional rows, but preserve the source
    # badge shell. The left row mirrors the authored body turn and staging;
    # correcting only its mark prevents the corporate symbol reading backward.
    # Late, head-only frames intentionally need no mark correction.
    peeking_right = [correct_brand_mark(frame, logo) for frame in peeking]
    peeking_left = [
        correct_brand_mark(ImageOps.mirror(frame), logo) for frame in peeking
    ]

    # A side-facing torso needs a foreshortened badge and mark. Apply the exact
    # corporate mark after mirroring so the left cycle never mirrors the logo.
    sequences = [
        Sequence(
            "running-right-24",
            [apply_brand_badge(frame, logo, 0.68) for frame in running_right],
        ),
        Sequence(
            "running-left-24",
            [apply_brand_badge(frame, logo, 0.68) for frame in running_left],
        ),
        Sequence("peeking-right", peeking_right),
        Sequence("peeking-left", peeking_left),
    ]

    for sequence in sequences[:2]:
        validate_sequence(sequence)
    for sequence in sequences[2:]:
        for index, frame in enumerate(sequence.frames):
            bbox = alpha_bbox(frame)
            if bbox[0] < 8 or bbox[1] < 4 or bbox[2] > CELL_WIDTH - 8:
                raise ValueError(
                    f"{sequence.name}[{index}]: staged pose violates the safe canvas"
                )
            if (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) < CELL_WIDTH * CELL_HEIGHT * 0.045:
                raise ValueError(f"{sequence.name}[{index}]: staged pose is unexpectedly empty")

    # Rebranding must not disturb the mirrored motion silhouette. This guards
    # against a future badge edit accidentally changing the left edge timing.
    for index, (right_frame, left_frame) in enumerate(
        zip(peeking_right, peeking_left)
    ):
        right_bbox = alpha_bbox(right_frame)
        left_bbox = alpha_bbox(left_frame)
        expected_left_bbox = (
            CELL_WIDTH - right_bbox[2],
            right_bbox[1],
            CELL_WIDTH - right_bbox[0],
            right_bbox[3],
        )
        if left_bbox != expected_left_bbox:
            raise ValueError(
                f"peeking-left[{index}]: silhouette no longer mirrors peeking-right"
            )

    atlas = Image.new(
        "RGBA",
        (MOTION_ATLAS_COLUMNS * CELL_WIDTH, len(sequences) * CELL_HEIGHT),
        (0, 0, 0, 0),
    )
    for row, sequence in enumerate(sequences):
        frames = [
            sequence.frames[index % len(sequence.frames)]
            for index in range(MOTION_ATLAS_COLUMNS)
        ]
        for column, frame in enumerate(frames):
            atlas.alpha_composite(frame, (column * CELL_WIDTH, row * CELL_HEIGHT))
    return atlas


def main() -> None:
    args = parse_args()
    sequences = build_sequences(args.source_dir)
    logo = load_rgba(args.logo)
    atlas = build_atlas(sequences, logo)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.out, format="WEBP", lossless=True, quality=100, method=6, exact=True)
    print(
        f"Wrote {args.out} ({atlas.width}x{atlas.height}, "
        f"{len(sequences)} rows, {CELL_WIDTH}x{CELL_HEIGHT}px cells)"
    )
    motion_atlas = build_motion_atlas(args.motion_source_dir, logo)
    args.motion_out.parent.mkdir(parents=True, exist_ok=True)
    motion_atlas.save(
        args.motion_out, format="WEBP", lossless=True, quality=100, method=6, exact=True
    )
    print(
        f"Wrote {args.motion_out} ({motion_atlas.width}x{motion_atlas.height}, "
        f"4 rows, {CELL_WIDTH}x{CELL_HEIGHT}px cells)"
    )


if __name__ == "__main__":
    main()
