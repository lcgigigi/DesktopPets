#!/usr/bin/env python3
"""Audit every runtime mascot frame at its final on-screen display size."""

from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont


VISIBLE_ALPHA_THRESHOLD = 12
CONTACT_COLUMNS = 24


@dataclass(frozen=True)
class AtlasSpec:
    atlas_id: str
    relative_path: Path
    source_cell: tuple[int, int]
    columns: int
    rows: int
    display_cell: tuple[int, int]

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
        display_cell=(90, 75),
    ),
    AtlasSpec(
        atlas_id="motion",
        relative_path=Path("src/assets/mascot/xiaoli-motion-spritesheet.webp"),
        source_cell=(384, 320),
        columns=24,
        rows=4,
        display_cell=(90, 75),
    ),
    AtlasSpec(
        atlas_id="running",
        relative_path=Path("src/assets/mascot/xiaoli-running-spritesheet.webp"),
        source_cell=(132, 122),
        columns=72,
        rows=2,
        display_cell=(90, 84),
    ),
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--output",
        required=True,
        type=Path,
        help="Directory for report.json and the light/dark contact sheets.",
    )
    return parser.parse_args()


def visible_bbox(alpha: Image.Image) -> tuple[int, int, int, int] | None:
    mask = alpha.point(
        lambda value: 255 if value > VISIBLE_ALPHA_THRESHOLD else 0,
        mode="L",
    )
    return mask.getbbox()


def visible_pixel_count(alpha: Image.Image) -> int:
    return sum(alpha.histogram()[VISIBLE_ALPHA_THRESHOLD + 1 :])


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
                            "target_rgba_sha256": digest,
                            "errors": frame_errors,
                        }
                    )
                    errors.extend(f"{identity}: {error}" for error in frame_errors)

    duplicate_groups = [
        identities
        for identities in hashes.values()
        if len(identities) > 1
    ]
    duplicate_groups.sort(key=lambda identities: identities[0])
    duplicate_frame_count = sum(len(group) - 1 for group in duplicate_groups)

    report: dict[str, Any] = {
        "id": spec.atlas_id,
        "path": str(spec.relative_path),
        "actual_size": list(actual_size) if actual_size is not None else None,
        "expected_size": list(spec.expected_size),
        "source_cell": list(spec.source_cell),
        "display_cell": list(spec.display_cell),
        "grid": {"columns": spec.columns, "rows": spec.rows},
        "expected_frames": spec.frame_count,
        "checked_frames": len(frame_reports),
        "passed_frames": sum(frame["status"] == "pass" for frame in frame_reports),
        "failed_frames": sum(frame["status"] == "fail" for frame in frame_reports),
        "unique_target_frames": len(hashes),
        "duplicate_target_frames": duplicate_frame_count,
        "duplicates_are_informational": True,
        "duplicate_groups": duplicate_groups,
        "frames": frame_reports,
    }
    return report, frame_images, errors


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
        lane_count = spec.rows * ((spec.columns + CONTACT_COLUMNS - 1) // CONTACT_COLUMNS)
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
    width = (
        padding * 2
        + label_width
        + CONTACT_COLUMNS * max_cell_width
        + (CONTACT_COLUMNS - 1) * cell_gap
    )
    sheet = Image.new("RGBA", (width, contact_sheet_height()), background)
    draw = ImageDraw.Draw(sheet)
    title_font = load_contact_font(22)
    section_font = load_contact_font(15)
    label_font = load_contact_font(12)
    frame_font = load_contact_font(10)

    status = "PASS" if ok else "FAIL"
    draw.text(
        (padding, 14),
        f"Mascot frame audit - 360 cells - {status} - {theme} background",
        fill=primary,
        font=title_font,
    )
    draw.text(
        (padding, 42),
        "Rendered at final logical sizes: main/motion 90x75, running 90x84",
        fill=secondary,
        font=label_font,
    )
    y = 62

    for spec in ATLAS_SPECS:
        draw.rounded_rectangle(
            (padding, y, width - padding, y + 25),
            radius=7,
            fill=section,
        )
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
                    draw.text(
                        (x + 2, y),
                        f"{column:02d}",
                        fill=secondary,
                        font=frame_font,
                    )
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
                    if frame is None:
                        draw.line((x, cell_top, cell_right - 1, cell_bottom - 1), fill=(220, 50, 65, 255), width=2)
                        draw.line((cell_right - 1, cell_top, x, cell_bottom - 1), fill=(220, 50, 65, 255), width=2)
                    else:
                        sheet.alpha_composite(frame, (x, cell_top))

                y += spec.display_cell[1] + 28

    sheet.convert("RGB").save(output_path, format="PNG", optimize=True)


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

    expected_frames = sum(spec.frame_count for spec in ATLAS_SPECS)
    checked_frames = sum(atlas["checked_frames"] for atlas in atlas_reports)
    passed_frames = sum(atlas["passed_frames"] for atlas in atlas_reports)
    failed_frames = sum(atlas["failed_frames"] for atlas in atlas_reports)
    ok = not errors and checked_frames == expected_frames and passed_frames == expected_frames
    light_sheet = output_dir / "contact-sheet-light.png"
    dark_sheet = output_dir / "contact-sheet-dark.png"
    render_contact_sheet(light_sheet, "light", all_frames, ok)
    render_contact_sheet(dark_sheet, "dark", all_frames, ok)

    report = {
        "schema_version": 1,
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
            "duplicate_frames_are_informational": True,
        },
        "contact_sheets": {
            "light": light_sheet.name,
            "dark": dark_sheet.name,
        },
        "atlases": atlas_reports,
        "errors": errors,
    }
    report_path = output_dir / "report.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print(
        f"{'PASS' if ok else 'FAIL'}: {passed_frames}/{expected_frames} mascot frames; "
        f"report={report_path}"
    )
    print(f"light_contact_sheet={light_sheet}")
    print(f"dark_contact_sheet={dark_sheet}")
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
