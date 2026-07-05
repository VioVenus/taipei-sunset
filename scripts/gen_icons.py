"""產生 PWA icons（純 stdlib PNG：夕陽漸層 + 半沉太陽 + 地平線）。

輸出 web/icons/icon-512.png / icon-192.png / apple-touch-icon.png (180)。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parents[1] / "web" / "icons"

SKY_TOP = (27, 36, 64)  # 深靛藍
SKY_MID = (122, 48, 72)  # 紫紅
SKY_LOW = (255, 138, 61)  # 夕陽橘
GROUND = (20, 22, 29)  # 深色地面
SUN = (255, 217, 160)  # 太陽


def _lerp(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(round(a + (b - a) * t) for a, b in zip(c1, c2, strict=True))


def _pixel(x: int, y: int, size: int) -> tuple[int, int, int]:
    horizon = int(size * 0.72)
    if y >= horizon:
        return GROUND
    t = y / horizon
    sky = _lerp(SKY_TOP, SKY_MID, min(1.0, t / 0.55)) if t < 0.55 else _lerp(
        SKY_MID, SKY_LOW, (t - 0.55) / 0.45
    )
    # 半沉太陽：圓心在地平線上，半徑 0.18 size
    cx, cy, r = size * 0.5, horizon, size * 0.20
    d2 = (x - cx) ** 2 + (y - cy) ** 2
    if d2 <= r * r:
        return SUN
    if d2 <= (r * 1.25) ** 2:  # 光暈
        glow = 1.0 - (d2**0.5 - r) / (r * 0.25)
        return _lerp(sky, SUN, max(0.0, glow) * 0.5)
    return sky


def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def make_png(size: int) -> bytes:
    raw = bytearray()
    for y in range(size):
        raw.append(0)  # filter: none
        for x in range(size):
            raw.extend(_pixel(x, y, size))
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)  # 8-bit RGB
    return (
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", ihdr)
        + _png_chunk(b"IDAT", zlib.compress(bytes(raw), 9))
        + _png_chunk(b"IEND", b"")
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, size in (("icon-512.png", 512), ("icon-192.png", 192), ("apple-touch-icon.png", 180)):
        (OUT_DIR / name).write_bytes(make_png(size))
        print(f"wrote {OUT_DIR / name}")


if __name__ == "__main__":
    main()
