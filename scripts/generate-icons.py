#!/usr/bin/env python3
"""
Generate multi-resolution icons for gemini-desktop.
Reads icon.png and outputs standard sizes into assets/icons/.
"""

import os
import sys
from PIL import Image

SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512]


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    project_root = os.path.dirname(script_dir)
    source_icon = os.path.join(project_root, "icon.png")
    output_dir = os.path.join(project_root, "assets", "icons")

    if not os.path.exists(source_icon):
        print(f"Error: Source icon not found at {source_icon}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(output_dir, exist_ok=True)

    print(f"Loading master icon from: {source_icon}")
    with Image.open(source_icon) as img:
        img = img.convert("RGBA")

        # Compatibility for different Pillow versions
        resample_filter = getattr(
            Image, "Resampling", Image
        ).LANCZOS

        for size in SIZES:
            target_path = os.path.join(output_dir, f"{size}x{size}.png")
            resized = img.resize((size, size), resample=resample_filter)
            resized.save(target_path, "PNG", optimize=True)
            print(f"  ✓ Generated: assets/icons/{size}x{size}.png")

    print("Icon generation completed successfully.")


if __name__ == "__main__":
    main()
