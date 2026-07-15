#!/usr/bin/env python3
"""Extract the supplied Huali mark and build reproducible application artwork."""

from __future__ import annotations

import argparse
from pathlib import Path
from statistics import median

from PIL import Image, ImageDraw, ImageFilter, ImageOps


BRAND_CANVAS_SIZE = 512
ICON_CANVAS_SIZE = 1024


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, help="Screenshot containing the red Huali mark")
    parser.add_argument(
        "--brand-dir",
        type=Path,
        default=Path("src/assets/brand"),
        help="Directory for transparent brand assets",
    )
    parser.add_argument(
        "--icon-out",
        type=Path,
        default=Path("src-tauri/icons/app-icon-master.png"),
        help="Master icon consumed by `tauri icon`",
    )
    parser.add_argument(
        "--robot-atlas",
        type=Path,
        default=Path("src/assets/mascot/xiaoli-spritesheet.webp"),
        help="Branded runtime atlas used to render the complete robot icon",
    )
    return parser.parse_args()


def extract_mark(source: Image.Image) -> Image.Image:
    """Recover one exact red color and sub-pixel alpha from a white screenshot."""

    rgb = source.convert("RGB")
    saturated: list[tuple[int, int, int]] = []
    for red, green, blue in rgb.get_flattened_data():
        if red > 120 and red - green > 80 and red - blue > 45:
            saturated.append((red, green, blue))
    if not saturated:
        raise ValueError("No red logo pixels found in the supplied source")

    solid = [pixel for pixel in saturated if pixel[0] > 180 and pixel[1] < 45]
    samples = solid or saturated
    brand_red = tuple(round(median(pixel[channel] for pixel in samples)) for channel in range(3))

    rgba = Image.new("RGBA", rgb.size, (brand_red[0], brand_red[1], brand_red[2], 0))
    output = rgba.load()
    source_pixels = rgb.load()
    for y in range(rgb.height):
        for x in range(rgb.width):
            red, green, blue = source_pixels[x, y]
            if red - green < 20 or red - blue < 12:
                continue
            alpha_green = (255 - green) / max(1, 255 - brand_red[1])
            alpha_blue = (255 - blue) / max(1, 255 - brand_red[2])
            alpha_red = (255 - red) / max(1, 255 - brand_red[0])
            alpha = max(0.0, min(1.0, median((alpha_red, alpha_green, alpha_blue))))
            if alpha < 0.01:
                continue
            output[x, y] = (*brand_red, round(alpha * 255))

    bbox = rgba.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("Extracted logo is empty")
    padding = 2
    left = max(0, bbox[0] - padding)
    top = max(0, bbox[1] - padding)
    right = min(rgba.width, bbox[2] + padding)
    bottom = min(rgba.height, bbox[3] + padding)
    return rgba.crop((left, top, right, bottom))


def fit_mark(mark: Image.Image, size: tuple[int, int]) -> Image.Image:
    copy = mark.copy()
    copy.thumbnail(size, Image.Resampling.LANCZOS)
    return copy


def build_square_brand_asset(mark: Image.Image) -> Image.Image:
    canvas = Image.new("RGBA", (BRAND_CANVAS_SIZE, BRAND_CANVAS_SIZE), (0, 0, 0, 0))
    fitted = fit_mark(mark, (round(BRAND_CANVAS_SIZE * 0.62), round(BRAND_CANVAS_SIZE * 0.74)))
    canvas.alpha_composite(
        fitted,
        ((BRAND_CANVAS_SIZE - fitted.width) // 2, (BRAND_CANVAS_SIZE - fitted.height) // 2),
    )
    return canvas


def build_icon(robot_atlas: Image.Image) -> Image.Image:
    """Build a legible robot icon for the desktop, tray, and installer."""

    size = ICON_CANVAS_SIZE
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_draw = ImageDraw.Draw(shadow)
    tile_box = (72, 58, size - 72, size - 86)
    radius = 222
    shadow_draw.rounded_rectangle(
        (tile_box[0], tile_box[1] + 24, tile_box[2], tile_box[3] + 24),
        radius=radius,
        fill=(9, 31, 65, 92),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(30))
    canvas.alpha_composite(shadow)

    vertical = Image.linear_gradient("L").resize((size, size), Image.Resampling.BICUBIC)
    tile = ImageOps.colorize(vertical, (17, 126, 236), (4, 28, 78)).convert("RGBA")
    glow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((180, 84, size - 180, 720), fill=(44, 211, 255, 105))
    glow = glow.filter(ImageFilter.GaussianBlur(78))
    tile = Image.alpha_composite(tile, glow)
    tile_mask = Image.new("L", canvas.size, 0)
    ImageDraw.Draw(tile_mask).rounded_rectangle(tile_box, radius=radius, fill=255)
    tile.putalpha(tile_mask)
    tile_draw = ImageDraw.Draw(tile)
    tile_draw.rounded_rectangle(tile_box, radius=radius, outline=(92, 202, 255, 255), width=9)
    tile_draw.rounded_rectangle(
        (tile_box[0] + 16, tile_box[1] + 16, tile_box[2] - 16, tile_box[3] - 16),
        radius=radius - 16,
        outline=(255, 255, 255, 125),
        width=5,
    )
    canvas.alpha_composite(tile)

    atlas = robot_atlas.convert("RGBA")
    frame_width = atlas.width // 12
    frame_height = atlas.height // 10
    frame = atlas.crop((0, 0, frame_width, frame_height))
    bbox = frame.getchannel("A").getbbox()
    if bbox is None:
        raise ValueError("Robot atlas first frame is empty")
    frame = frame.crop(bbox)
    scale = min(700 / frame.width, 790 / frame.height)
    frame = frame.resize(
        (round(frame.width * scale), round(frame.height * scale)),
        Image.Resampling.LANCZOS,
    )
    robot_x = (size - frame.width) // 2
    robot_y = 126 + (790 - frame.height) // 2

    robot_shadow = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    shadow_alpha = frame.getchannel("A").filter(ImageFilter.GaussianBlur(18))
    shadow_shape = Image.new("RGBA", frame.size, (2, 12, 40, 0))
    shadow_shape.putalpha(shadow_alpha.point(lambda alpha: round(alpha * 0.54)))
    robot_shadow.alpha_composite(shadow_shape, (robot_x, robot_y + 22))
    canvas.alpha_composite(robot_shadow)
    canvas.alpha_composite(frame, (robot_x, robot_y))
    return canvas


def main() -> None:
    args = parse_args()
    mark = extract_mark(Image.open(args.source))
    args.brand_dir.mkdir(parents=True, exist_ok=True)
    args.icon_out.parent.mkdir(parents=True, exist_ok=True)

    mark.save(args.brand_dir / "huali-logo-mark.png", optimize=True)
    build_square_brand_asset(mark).save(args.brand_dir / "huali-logo.png", optimize=True)
    build_icon(Image.open(args.robot_atlas)).save(args.icon_out, optimize=True)
    print(
        f"Wrote transparent logo assets to {args.brand_dir} and icon master to {args.icon_out}"
    )


if __name__ == "__main__":
    main()
