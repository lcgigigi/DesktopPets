#!/usr/bin/env python3
"""Audit every runtime mascot frame and its production playback relationships."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from statistics import median
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter, ImageFont, ImageStat


VISIBLE_ALPHA_THRESHOLD = 12
CONTACT_COLUMNS = 24
SUPPORTED_WINDOWS_SCALES = (1.25, 1.5, 1.75, 2.0)
RUN_MIN_SHARPNESS_RATIO = 0.94
RUN_MAX_ADJACENT_RMS = 45.0
RUN_MAX_ANCHOR_STEP_PX = 1.0
RUN_MAX_DIRECTION_ANCHOR_DELTA_PX = 3.0
PEEK_MAX_ADJACENT_RMS = 60.0
PEEK_MAX_ANCHOR_STEP_PX = 1.0
MAX_BASELINE_VARIATION_PX = 1


@dataclass(frozen=True)
class SequenceSpec:
    name: str
    row: int
    frames: int
    duration_ms: int
    loops: bool


@dataclass(frozen=True)
class AtlasSpec:
    atlas_id: str
    relative_path: Path
    source_cell: tuple[int, int]
    columns: int
    rows: int
    display_cell: tuple[int, int]
    sequences: tuple[SequenceSpec, ...]
    require_all_unique: bool = False

    @property
    def frame_count(self) -> int:
        return self.columns * self.rows

    @property
    def expected_size(self) -> tuple[int, int]:
        return self.source_cell[0] * self.columns, self.source_cell[1] * self.rows


ATLAS_SPECS = (
    AtlasSpec(
        atlas_id="main",
        relative_path=Path("src/assets/mascot/xiaoli-spritesheet.webp"),
        source_cell=(384, 320),
        columns=12,
        rows=10,
        display_cell=(92, 76),
        sequences=(
            SequenceSpec("idle", 0, 12, 3000, True),
            SequenceSpec("thinking", 2, 12, 1000, True),
            SequenceSpec("waiting", 3, 6, 500, True),
            SequenceSpec("remind", 4, 12, 1000, True),
            SequenceSpec("success", 5, 6, 500, True),
            SequenceSpec("error", 6, 6, 500, True),
            SequenceSpec("cooling-office", 9, 6, 500, True),
        ),
    ),
    AtlasSpec(
        atlas_id="running",
        relative_path=Path("src/assets/mascot/xiaoli-running-spritesheet.webp"),
        source_cell=(184, 168),
        columns=24,
        rows=2,
        display_cell=(92, 84),
        sequences=(
            SequenceSpec("running-right", 0, 24, 1440, True),
            SequenceSpec("running-left", 1, 24, 1440, True),
        ),
        require_all_unique=True,
    ),
    AtlasSpec(
        atlas_id="peek",
        relative_path=Path("src/assets/mascot/xiaoli-peek-spritesheet.webp"),
        source_cell=(184, 152),
        columns=12,
        rows=2,
        display_cell=(92, 76),
        sequences=(
            SequenceSpec("peeking-right", 0, 12, 560, False),
            SequenceSpec("peeking-left", 1, 12, 560, False),
        ),
        require_all_unique=True,
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Directory for the JSON report, contact sheets and acceptance GIFs.",
    )
    return parser.parse_args()


def visible_mask(alpha: Image.Image) -> Image.Image:
    return alpha.point(
        lambda value: 255 if value > VISIBLE_ALPHA_THRESHOLD else 0,
        mode="L",
    )


def visible_bbox(alpha: Image.Image) -> tuple[int, int, int, int] | None:
    return visible_mask(alpha).getbbox()


def visible_pixel_count(alpha: Image.Image) -> int:
    return visible_mask(alpha).histogram()[255]


def alpha_centroid(alpha: Image.Image) -> tuple[float, float] | None:
    pixels = alpha.load()
    total = 0
    weighted_x = 0
    weighted_y = 0
    for y in range(alpha.height):
        for x in range(alpha.width):
            value = pixels[x, y]
            if value <= VISIBLE_ALPHA_THRESHOLD:
                continue
            total += value
            weighted_x += x * value
            weighted_y += y * value
    if total == 0:
        return None
    return weighted_x / total, weighted_y / total


def matte(frame: Image.Image, background: tuple[int, int, int, int]) -> Image.Image:
    output = Image.new("RGBA", frame.size, background)
    output.alpha_composite(frame)
    return output.convert("RGB")


def rms_delta(first: Image.Image, second: Image.Image) -> float:
    difference = ImageChops.difference(
        matte(first, (238, 238, 238, 255)),
        matte(second, (238, 238, 238, 255)),
    )
    channel_rms = ImageStat.Stat(difference).rms
    return math.sqrt(sum(value * value for value in channel_rms) / len(channel_rms))


def sharpness_score(frame: Image.Image) -> float:
    grayscale = matte(frame, (238, 238, 238, 255)).convert("L")
    blurred = grayscale.filter(ImageFilter.GaussianBlur(1))
    high_frequency = ImageChops.difference(grayscale, blurred)
    stats = ImageStat.Stat(high_frequency)
    return math.sqrt(stats.mean[0] ** 2 + stats.var[0])


def bbox_report(
    bbox: tuple[int, int, int, int] | None,
    cell_size: tuple[int, int],
) -> tuple[dict[str, int] | None, dict[str, int] | None]:
    if bbox is None:
        return None, None
    left, top, right, bottom = bbox
    width, height = cell_size
    return (
        {
            "x": left,
            "y": top,
            "width": right - left,
            "height": bottom - top,
            "right": right,
            "bottom": bottom,
        },
        {
            "left": left,
            "top": top,
            "right": width - right,
            "bottom": height - bottom,
        },
    )


def frame_id(spec: AtlasSpec, row: int, column: int) -> str:
    return f"{spec.atlas_id}:r{row:02d}:c{column:02d}"


def audit_atlas(
    project_root: Path,
    spec: AtlasSpec,
) -> tuple[dict[str, Any], dict[tuple[int, int], Image.Image], list[str]]:
    atlas_path = project_root / spec.relative_path
    errors: list[str] = []
    frame_images: dict[tuple[int, int], Image.Image] = {}
    frame_reports: list[dict[str, Any]] = []
    hashes: dict[str, list[str]] = {}

    if not atlas_path.is_file():
        errors.append(f"{spec.atlas_id}: missing atlas: {atlas_path}")
        actual_size: tuple[int, int] | None = None
    else:
        with Image.open(atlas_path) as opened:
            atlas = opened.convert("RGBA")
        actual_size = atlas.size
        if actual_size != spec.expected_size:
            errors.append(
                f"{spec.atlas_id}: atlas size {actual_size} does not match "
                f"expected {spec.expected_size}"
            )
        else:
            source_width, source_height = spec.source_cell
            for row in range(spec.rows):
                for column in range(spec.columns):
                    identity = frame_id(spec, row, column)
                    source = atlas.crop(
                        (
                            column * source_width,
                            row * source_height,
                            (column + 1) * source_width,
                            (row + 1) * source_height,
                        )
                    )
                    source_bbox = visible_bbox(source.getchannel("A"))
                    target = source.resize(spec.display_cell, Image.Resampling.LANCZOS)
                    target_alpha = target.getchannel("A")
                    target_bbox = visible_bbox(target_alpha)
                    target_bbox_json, margins = bbox_report(target_bbox, spec.display_cell)
                    source_bbox_json, _ = bbox_report(source_bbox, spec.source_cell)
                    centroid = alpha_centroid(target_alpha)
                    frame_errors: list[str] = []

                    if source_bbox is None:
                        frame_errors.append("source frame is empty")
                    if target_bbox is None:
                        frame_errors.append("target-size frame is empty")
                    elif margins is not None and min(margins.values()) <= 0:
                        frame_errors.append(
                            "target-size visible pixels touch a cell edge "
                            f"(margins={margins})"
                        )

                    digest = hashlib.sha256(target.tobytes()).hexdigest()
                    hashes.setdefault(digest, []).append(identity)
                    frame_images[(row, column)] = target
                    frame_reports.append(
                        {
                            "id": identity,
                            "row": row,
                            "column": column,
                            "status": "pass" if not frame_errors else "fail",
                            "source_bbox": source_bbox_json,
                            "target_bbox": target_bbox_json,
                            "target_edge_margins": margins,
                            "target_visible_pixels": visible_pixel_count(target_alpha),
                            "target_centroid": (
                                {"x": round(centroid[0], 4), "y": round(centroid[1], 4)}
                                if centroid is not None else None
                            ),
                            "target_sharpness": round(sharpness_score(target), 4),
                            "target_rgba_sha256": digest,
                            "errors": frame_errors,
                        }
                    )
                    errors.extend(f"{identity}: {error}" for error in frame_errors)

    duplicate_groups = [identities for identities in hashes.values() if len(identities) > 1]
    duplicate_groups.sort(key=lambda identities: identities[0])
    duplicate_frame_count = sum(len(group) - 1 for group in duplicate_groups)
    if spec.require_all_unique and duplicate_frame_count:
        errors.append(
            f"{spec.atlas_id}: runtime atlas contains {duplicate_frame_count} duplicate frames"
        )

    report: dict[str, Any] = {
        "id": spec.atlas_id,
        "path": str(spec.relative_path),
        "actual_size": list(actual_size) if actual_size is not None else None,
        "expected_size": list(spec.expected_size),
        "source_cell": list(spec.source_cell),
        "display_cell": list(spec.display_cell),
        "source_density": [
            spec.source_cell[0] / spec.display_cell[0],
            spec.source_cell[1] / spec.display_cell[1],
        ],
        "grid": {"columns": spec.columns, "rows": spec.rows},
        "expected_frames": spec.frame_count,
        "checked_frames": len(frame_reports),
        "passed_frames": sum(frame["status"] == "pass" for frame in frame_reports),
        "failed_frames": sum(frame["status"] == "fail" for frame in frame_reports),
        "unique_target_frames": len(hashes),
        "duplicate_target_frames": duplicate_frame_count,
        "duplicates_are_informational": not spec.require_all_unique,
        "duplicate_groups": duplicate_groups,
        "frames": frame_reports,
    }
    return report, frame_images, errors


def sequence_metrics(
    spec: AtlasSpec,
    sequence: SequenceSpec,
    frames: dict[tuple[int, int], Image.Image],
) -> dict[str, Any]:
    images = [frames[(sequence.row, column)] for column in range(sequence.frames)]
    centroids = [alpha_centroid(image.getchannel("A")) for image in images]
    if any(centroid is None for centroid in centroids):
        raise ValueError(f"{sequence.name}: empty frame reached sequence metrics")
    resolved_centroids = [centroid for centroid in centroids if centroid is not None]
    bboxes = [visible_bbox(image.getchannel("A")) for image in images]
    if any(bbox is None for bbox in bboxes):
        raise ValueError(f"{sequence.name}: empty frame reached baseline metrics")
    resolved_bboxes = [bbox for bbox in bboxes if bbox is not None]
    adjacent_rms = [rms_delta(images[index], images[index + 1]) for index in range(len(images) - 1)]
    horizontal_anchor_steps = [
        abs(resolved_centroids[index][0] - resolved_centroids[index + 1][0])
        for index in range(len(resolved_centroids) - 1)
    ]
    sharpness = [sharpness_score(image) for image in images]
    seam_rms = rms_delta(images[-1], images[0]) if sequence.loops else None
    return {
        "name": sequence.name,
        "row": sequence.row,
        "frames": sequence.frames,
        "duration_ms": sequence.duration_ms,
        "authored_pose_rate_fps": round(sequence.frames / sequence.duration_ms * 1000, 4),
        "adjacent_rms": [round(value, 4) for value in adjacent_rms],
        "max_adjacent_rms": round(max(adjacent_rms, default=0), 4),
        "median_adjacent_rms": round(median(adjacent_rms), 4) if adjacent_rms else 0,
        "seam_rms": round(seam_rms, 4) if seam_rms is not None else None,
        "max_anchor_step_px": round(max(horizontal_anchor_steps, default=0), 4),
        "baseline_range": [
            min(bbox[3] for bbox in resolved_bboxes),
            max(bbox[3] for bbox in resolved_bboxes),
        ],
        "sharpness": [round(value, 4) for value in sharpness],
        "min_to_median_sharpness_ratio": round(min(sharpness) / median(sharpness), 4),
        "centroids": [
            {"x": round(centroid[0], 4), "y": round(centroid[1], 4)}
            for centroid in resolved_centroids
        ],
    }


def smootherstep(progress: float) -> float:
    return progress ** 3 * (progress * (progress * 6 - 15) + 10)


def ease_out_quart(progress: float) -> float:
    return 1 - (1 - progress) ** 4


def native_peek_travel(project_root: Path) -> float:
    source = (project_root / "src-tauri/src/main.rs").read_text(encoding="utf-8")

    def constant(name: str) -> float:
        match = re.search(rf"const {name}: f64 = ([0-9.]+);", source)
        if match is None:
            raise ValueError(f"missing Rust geometry constant {name}")
        return float(match.group(1))

    return constant("MASCOT_WIDTH") + constant("MASCOT_REST_RIGHT_MARGIN") - constant(
        "MASCOT_PEEK_VISIBLE_WIDTH"
    )


def world_trajectory(
    centroids: list[dict[str, float]],
    travel: float,
    side: str,
    reveal: bool,
) -> list[float]:
    ordered = list(reversed(centroids)) if reveal else centroids
    direction = 1 if side == "right" else -1
    if reveal:
        direction *= -1
    easing = ease_out_quart if reveal else smootherstep
    count = len(ordered)
    return [
        direction * travel * easing((index + 0.5) / count) + centroid["x"]
        for index, centroid in enumerate(ordered)
    ]


def validate_temporal_quality(
    project_root: Path,
    reports: list[dict[str, Any]],
    all_frames: dict[str, dict[tuple[int, int], Image.Image]],
) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    report_by_id = {report["id"]: report for report in reports}
    spec_by_id = {spec.atlas_id: spec for spec in ATLAS_SPECS}
    metrics: dict[str, list[dict[str, Any]]] = {}
    for atlas_id, spec in spec_by_id.items():
        if len(all_frames.get(atlas_id, {})) != spec.frame_count:
            continue
        metrics[atlas_id] = [
            sequence_metrics(spec, sequence, all_frames[atlas_id])
            for sequence in spec.sequences
        ]

    for scale in SUPPORTED_WINDOWS_SCALES:
        for logical_dimension in (92, 76, 84):
            physical = logical_dimension * scale
            if not physical.is_integer():
                errors.append(
                    f"DPI contract: {logical_dimension}px at {scale:.2f}x is fractional ({physical})"
                )

    running_metrics = metrics.get("running", [])
    for sequence in running_metrics:
        if sequence["min_to_median_sharpness_ratio"] < RUN_MIN_SHARPNESS_RATIO:
            errors.append(
                f"{sequence['name']}: sharpness ratio "
                f"{sequence['min_to_median_sharpness_ratio']} < {RUN_MIN_SHARPNESS_RATIO}"
            )
        if sequence["max_adjacent_rms"] > RUN_MAX_ADJACENT_RMS:
            errors.append(
                f"{sequence['name']}: adjacent RMS {sequence['max_adjacent_rms']} "
                f"> {RUN_MAX_ADJACENT_RMS}"
            )
        if sequence["max_anchor_step_px"] > RUN_MAX_ANCHOR_STEP_PX:
            errors.append(
                f"{sequence['name']}: anchor step {sequence['max_anchor_step_px']}px "
                f"> {RUN_MAX_ANCHOR_STEP_PX}px"
            )
        baseline_range = sequence["baseline_range"]
        if baseline_range[1] - baseline_range[0] > MAX_BASELINE_VARIATION_PX:
            errors.append(f"{sequence['name']}: baseline varies by more than 1px")

    direction_anchor_deltas: list[float] = []
    if len(running_metrics) == 2:
        direction_anchor_deltas = [
            abs(right["x"] - left["x"])
            for right, left in zip(
                running_metrics[0]["centroids"],
                running_metrics[1]["centroids"],
                strict=True,
            )
        ]
        if max(direction_anchor_deltas) > RUN_MAX_DIRECTION_ANCHOR_DELTA_PX:
            errors.append(
                f"running directions: same-phase anchor delta "
                f"{max(direction_anchor_deltas):.4f}px > {RUN_MAX_DIRECTION_ANCHOR_DELTA_PX}px"
            )

    peek_metrics = metrics.get("peek", [])
    for sequence in peek_metrics:
        if sequence["max_adjacent_rms"] > PEEK_MAX_ADJACENT_RMS:
            errors.append(
                f"{sequence['name']}: adjacent RMS {sequence['max_adjacent_rms']} "
                f"> {PEEK_MAX_ADJACENT_RMS}"
            )
        if sequence["max_anchor_step_px"] > PEEK_MAX_ANCHOR_STEP_PX:
            errors.append(
                f"{sequence['name']}: anchor step {sequence['max_anchor_step_px']}px "
                f"> {PEEK_MAX_ANCHOR_STEP_PX}px"
            )
        baseline_range = sequence["baseline_range"]
        if baseline_range[1] - baseline_range[0] > MAX_BASELINE_VARIATION_PX:
            errors.append(f"{sequence['name']}: baseline varies by more than 1px")

    travel = native_peek_travel(project_root)
    trajectories: dict[str, list[float]] = {}
    if len(peek_metrics) == 2:
        for index, side in enumerate(("right", "left")):
            for reveal in (False, True):
                name = f"{'reveal' if reveal else 'peek'}-{side}"
                trajectory = world_trajectory(peek_metrics[index]["centroids"], travel, side, reveal)
                trajectories[name] = [round(value, 4) for value in trajectory]
                deltas = [trajectory[i + 1] - trajectory[i] for i in range(len(trajectory) - 1)]
                expected_sign = -1 if (side == "left") ^ reveal else 1
                if any(delta * expected_sign < -0.05 for delta in deltas):
                    errors.append(f"{name}: world-space trajectory reverses direction")

    for atlas_id in ("running", "peek"):
        density = report_by_id.get(atlas_id, {}).get("source_density")
        if density != [2.0, 2.0]:
            errors.append(f"{atlas_id}: runtime atlas is not exact 2x density ({density})")

    return (
        {
            "thresholds": {
                "run_min_sharpness_ratio": RUN_MIN_SHARPNESS_RATIO,
                "run_max_adjacent_rms": RUN_MAX_ADJACENT_RMS,
                "run_max_anchor_step_px": RUN_MAX_ANCHOR_STEP_PX,
                "run_max_direction_anchor_delta_px": RUN_MAX_DIRECTION_ANCHOR_DELTA_PX,
                "peek_max_adjacent_rms": PEEK_MAX_ADJACENT_RMS,
                "peek_max_anchor_step_px": PEEK_MAX_ANCHOR_STEP_PX,
                "max_baseline_variation_px": MAX_BASELINE_VARIATION_PX,
            },
            "supported_windows_scales": list(SUPPORTED_WINDOWS_SCALES),
            "native_peek_travel_logical_px": travel,
            "same_phase_running_anchor_deltas": [
                round(value, 4) for value in direction_anchor_deltas
            ],
            "world_trajectories": trajectories,
            "sequences": metrics,
            "errors": errors,
        },
        errors,
    )


def load_contact_font(size: int) -> ImageFont.ImageFont | ImageFont.FreeTypeFont:
    candidates = (
        Path("/System/Library/Fonts/Supplemental/Arial.ttf"),
        Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
        Path("C:/Windows/Fonts/arial.ttf"),
        Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
    )
    for candidate in candidates:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


def contact_sheet_height() -> int:
    height = 62
    for spec in ATLAS_SPECS:
        lane_count = spec.rows * math.ceil(spec.columns / CONTACT_COLUMNS)
        height += 32 + lane_count * (spec.display_cell[1] + 28)
    return height + 18


def render_contact_sheet(
    output_path: Path,
    theme: str,
    all_frames: dict[str, dict[tuple[int, int], Image.Image]],
    ok: bool,
) -> None:
    if theme == "light":
        background = (244, 247, 252, 255)
        cell_background = (255, 255, 255, 255)
        primary = (24, 35, 56, 255)
        secondary = (91, 105, 128, 255)
        grid = (203, 211, 225, 255)
        section = (226, 233, 245, 255)
    else:
        background = (19, 24, 34, 255)
        cell_background = (33, 40, 53, 255)
        primary = (239, 244, 252, 255)
        secondary = (169, 183, 205, 255)
        grid = (67, 78, 96, 255)
        section = (29, 36, 49, 255)

    padding = 18
    label_width = 176
    cell_gap = 2
    max_cell_width = max(spec.display_cell[0] for spec in ATLAS_SPECS)
    width = padding * 2 + label_width + CONTACT_COLUMNS * max_cell_width + 23 * cell_gap
    sheet = Image.new("RGBA", (width, contact_sheet_height()), background)
    draw = ImageDraw.Draw(sheet)
    title_font = load_contact_font(22)
    section_font = load_contact_font(15)
    label_font = load_contact_font(12)
    frame_font = load_contact_font(10)

    status = "PASS" if ok else "FAIL"
    checked = sum(spec.frame_count for spec in ATLAS_SPECS)
    draw.text(
        (padding, 14),
        f"Mascot production frame audit - {checked} cells - {status} - {theme}",
        fill=primary,
        font=title_font,
    )
    draw.text(
        (padding, 42),
        "Final logical sizes: main/peek 92x76, running 92x84; runtime motion atlases 2x",
        fill=secondary,
        font=label_font,
    )
    y = 62

    for spec in ATLAS_SPECS:
        draw.rounded_rectangle((padding, y, width - padding, y + 25), radius=7, fill=section)
        draw.text(
            (padding + 9, y + 4),
            (
                f"{spec.atlas_id} | {spec.frame_count} cells | "
                f"source {spec.source_cell[0]}x{spec.source_cell[1]} | "
                f"display {spec.display_cell[0]}x{spec.display_cell[1]}"
            ),
            fill=primary,
            font=section_font,
        )
        y += 32
        frames = all_frames.get(spec.atlas_id, {})
        for row in range(spec.rows):
            for segment_start in range(0, spec.columns, CONTACT_COLUMNS):
                segment_end = min(segment_start + CONTACT_COLUMNS, spec.columns)
                draw.text(
                    (padding, y + 22),
                    f"row {row:02d}\nframes {segment_start:02d}-{segment_end - 1:02d}",
                    fill=secondary,
                    font=label_font,
                    spacing=3,
                )
                for lane_column, column in enumerate(range(segment_start, segment_end)):
                    x = padding + label_width + lane_column * (max_cell_width + cell_gap)
                    draw.text((x + 2, y), f"{column:02d}", fill=secondary, font=frame_font)
                    cell_top = y + 17
                    cell_right = x + spec.display_cell[0]
                    cell_bottom = cell_top + spec.display_cell[1]
                    draw.rectangle(
                        (x, cell_top, cell_right - 1, cell_bottom - 1),
                        fill=cell_background,
                        outline=grid,
                        width=1,
                    )
                    frame = frames.get((row, column))
                    if frame is not None:
                        sheet.alpha_composite(frame, (x, cell_top))
                y += spec.display_cell[1] + 28

    sheet.convert("RGB").save(output_path, format="PNG", optimize=True)


def render_gif(
    output_path: Path,
    frames: list[Image.Image],
    durations: int | list[int],
    theme: str,
) -> None:
    background = (247, 249, 252, 255) if theme == "light" else (24, 29, 38, 255)
    rendered: list[Image.Image] = []
    for frame in frames:
        canvas = Image.new("RGBA", frame.size, background)
        canvas.alpha_composite(frame)
        rendered.append(canvas.resize((frame.width * 2, frame.height * 2), Image.Resampling.LANCZOS))
    rendered[0].save(
        output_path,
        format="GIF",
        save_all=True,
        append_images=rendered[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=False,
    )


def render_acceptance_gifs(
    output_dir: Path,
    all_frames: dict[str, dict[tuple[int, int], Image.Image]],
) -> dict[str, str]:
    outputs: dict[str, str] = {}
    for row, direction in ((0, "right"), (1, "left")):
        running = [all_frames["running"][(row, column)] for column in range(24)]
        peeking = [all_frames["peek"][(row, column)] for column in range(12)]
        peek_reveal = peeking + [peeking[-1]] + list(reversed(peeking))
        peek_durations = [47] * 12 + [320] + [40] * 12
        for theme in ("light", "dark"):
            run_name = f"running-{direction}-{theme}.gif"
            peek_name = f"peek-reveal-{direction}-{theme}.gif"
            render_gif(output_dir / run_name, running, 60, theme)
            render_gif(output_dir / peek_name, peek_reveal, peek_durations, theme)
            outputs[f"running_{direction}_{theme}"] = run_name
            outputs[f"peek_reveal_{direction}_{theme}"] = peek_name
    return outputs


def main() -> int:
    args = parse_args()
    project_root = Path(__file__).resolve().parents[1]
    output_dir = args.output.expanduser()
    if not output_dir.is_absolute():
        output_dir = (Path.cwd() / output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    atlas_reports: list[dict[str, Any]] = []
    all_frames: dict[str, dict[tuple[int, int], Image.Image]] = {}
    errors: list[str] = []
    for spec in ATLAS_SPECS:
        report, images, atlas_errors = audit_atlas(project_root, spec)
        atlas_reports.append(report)
        all_frames[spec.atlas_id] = images
        errors.extend(atlas_errors)

    temporal_quality, temporal_errors = validate_temporal_quality(
        project_root,
        atlas_reports,
        all_frames,
    )
    errors.extend(temporal_errors)
    expected_frames = sum(spec.frame_count for spec in ATLAS_SPECS)
    checked_frames = sum(atlas["checked_frames"] for atlas in atlas_reports)
    passed_frames = sum(atlas["passed_frames"] for atlas in atlas_reports)
    failed_frames = sum(atlas["failed_frames"] for atlas in atlas_reports)
    ok = not errors and checked_frames == expected_frames and passed_frames == expected_frames

    light_sheet = output_dir / "contact-sheet-light.png"
    dark_sheet = output_dir / "contact-sheet-dark.png"
    render_contact_sheet(light_sheet, "light", all_frames, ok)
    render_contact_sheet(dark_sheet, "dark", all_frames, ok)
    gifs = render_acceptance_gifs(output_dir, all_frames) if checked_frames == expected_frames else {}

    report = {
        "schema_version": 2,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ok": ok,
        "project_root": str(project_root),
        "output_directory": str(output_dir),
        "thresholds": {
            "visible_alpha_greater_than": VISIBLE_ALPHA_THRESHOLD,
            "minimum_target_edge_margin_px": 1,
        },
        "summary": {
            "atlas_count": len(ATLAS_SPECS),
            "expected_frames": expected_frames,
            "checked_frames": checked_frames,
            "passed_frames": passed_frames,
            "failed_frames": failed_frames,
            "temporal_quality_passed": not temporal_errors,
        },
        "contact_sheets": {"light": light_sheet.name, "dark": dark_sheet.name},
        "acceptance_gifs": gifs,
        "temporal_quality": temporal_quality,
        "atlases": atlas_reports,
        "errors": errors,
    }
    report_path = output_dir / "report.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(
        f"{'PASS' if ok else 'FAIL'}: {passed_frames}/{expected_frames} runtime mascot frames; "
        f"temporal={'PASS' if not temporal_errors else 'FAIL'}; report={report_path}"
    )
    print(f"light_contact_sheet={light_sheet}")
    print(f"dark_contact_sheet={dark_sheet}")
    for name, path in gifs.items():
        print(f"{name}={output_dir / path}")
    if errors:
        for error in errors:
            print(error)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
