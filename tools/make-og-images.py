#!/usr/bin/env python3
"""Draw the link-preview images (Open Graph / X cards) for noidusa.com.

WhatsApp, Telegram, Discord and X show these when someone shares a NOID link.
Run from the repo root:  python3 tools/make-og-images.py
Needs Pillow + numpy, and the app's fonts (app/node_modules, after npm install).
Writes site/assets/og-home.jpg, og-pay.jpg and og-gift.jpg (1200x630).
"""
import math
import pathlib
import random

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = pathlib.Path(__file__).resolve().parent.parent
FONTS = ROOT / "app" / "node_modules" / "@expo-google-fonts"
OUT = ROOT / "site" / "assets"

S = 2  # draw at 2x, then downscale for smooth edges
W, H = 1200 * S, 630 * S

ACCENT = (63, 209, 160)
TEXT = (232, 239, 236)
TEXT2 = (154, 171, 165)
FAINT = (118, 136, 130)
LINE = (42, 59, 54)


def font(family: str, weight: str, size: int) -> ImageFont.FreeTypeFont:
    folder = "inter" if family == "Inter" else "jetbrains-mono"
    name = f"{family}_{weight}"
    return ImageFont.truetype(str(FONTS / folder / weight / f"{name}.ttf"), size * S)


def background() -> Image.Image:
    y, x = np.mgrid[0:H, 0:W].astype(np.float32)
    t = (x / W * 0.55 + y / H * 0.45)
    c0, c1, c2 = np.array([16, 48, 39]), np.array([10, 26, 21]), np.array([6, 14, 11])
    t3 = t[..., None]
    img = np.where(t3 < 0.55, c0 + (c1 - c0) * (t3 / 0.55), c1 + (c2 - c1) * ((t3 - 0.55) / 0.45))

    def glow(cx, cy, r, color, alpha):
        d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / r
        a = np.clip(1 - d, 0, 1) ** 2 * alpha
        return a[..., None] * (np.array(color) - img)

    img = img + glow(W * 0.86, H * 0.02, W * 0.55, ACCENT, 0.30)
    img = img + glow(W * 0.04, H * 1.0, W * 0.45, (42, 140, 255), 0.12)
    return Image.fromarray(np.clip(img, 0, 255).astype(np.uint8), "RGB")


def rings(d: ImageDraw.ImageDraw, cx: float, cy: float):
    for r, a in ((160, 34), (250, 22), (340, 14)):
        r *= S
        d.ellipse((cx - r, cy - r, cx + r, cy + r), outline=ACCENT + (a,), width=2 * S)


def hexagon(d: ImageDraw.ImageDraw, cx: float, cy: float, size: float, width: float, color=ACCENT):
    # Same shape as the app's logo: pointy-top hexagon with a solid core.
    r = size / 2
    pts = [
        (cx, cy - r * 0.58),
        (cx + r * 0.5, cy - r * 0.29),
        (cx + r * 0.5, cy + r * 0.29),
        (cx, cy + r * 0.58),
        (cx - r * 0.5, cy + r * 0.29),
        (cx - r * 0.5, cy - r * 0.29),
    ]
    d.line(pts + [pts[0], pts[1]], fill=color, width=int(width), joint="curve")
    core = r * 0.17
    d.ellipse((cx - core, cy - core, cx + core, cy + core), fill=color)


def wrap(d: ImageDraw.ImageDraw, text: str, f: ImageFont.FreeTypeFont, max_w: float) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for wd in words:
        test = f"{cur} {wd}".strip()
        if d.textlength(test, font=f) <= max_w:
            cur = test
        else:
            lines.append(cur)
            cur = wd
    if cur:
        lines.append(cur)
    return lines


def brand_and_copy(img: Image.Image, title: str, sub: str, max_w: float):
    d = ImageDraw.Draw(img, "RGBA")
    x0 = 80 * S
    hexagon(d, x0 + 26 * S, 92 * S, 60 * S, 5.5 * S)
    d.text((x0 + 64 * S, 92 * S), "NOID", font=font("JetBrainsMono", "800ExtraBold", 34), fill=ACCENT, anchor="lm")
    ft = font("Inter", "800ExtraBold", 60)
    y = 190 * S
    for line in wrap(d, title, ft, max_w):
        d.text((x0, y), line, font=ft, fill=TEXT)
        y += 72 * S
    y += 14 * S
    fs = font("Inter", "400Regular", 27)
    for line in wrap(d, sub, fs, max_w):
        d.text((x0, y), line, font=fs, fill=TEXT2)
        y += 38 * S
    d.text((x0, 560 * S), "noidusa.com", font=font("Inter", "600SemiBold", 24), fill=FAINT)


def panel(img: Image.Image, box, radius=34, fill=(11, 24, 20, 235)):
    x1, y1, x2, y2 = [v * S for v in box]
    shadow = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle((x1, y1 + 18 * S, x2, y2 + 18 * S), radius * S, fill=(0, 0, 0, 150))
    img.paste(Image.alpha_composite(img.convert("RGBA"), shadow.filter(ImageFilter.GaussianBlur(26 * S))).convert("RGB"))
    d = ImageDraw.Draw(img, "RGBA")
    d.rounded_rectangle((x1, y1, x2, y2), radius * S, fill=fill, outline=LINE + (255,), width=2 * S)
    return d


def pill(d, x, y, text, size=15):
    f = font("Inter", "700Bold", size)
    w = d.textlength(text, font=f) + 30 * S
    d.rounded_rectangle((x, y, x + w, y + 34 * S), 17 * S, fill=(63, 209, 160, 40))
    d.text((x + 15 * S, y + 17 * S), text, font=f, fill=ACCENT, anchor="lm")
    return w


def qr_like(d, x, y, size):
    # A QR-style motif (finder squares and blocks), deliberately not a scannable code.
    d.rounded_rectangle((x, y, x + size, y + size), 18 * S, fill=(255, 255, 255, 255))
    pad, n = 16 * S, 21
    cell = (size - 2 * pad) / n
    rnd = random.Random(7)

    def finder(cx, cy):
        X, Y = x + pad + cx * cell, y + pad + cy * cell
        d.rectangle((X, Y, X + 7 * cell, Y + 7 * cell), fill=(0, 0, 0))
        d.rectangle((X + cell, Y + cell, X + 6 * cell, Y + 6 * cell), fill=(255, 255, 255))
        d.rectangle((X + 2 * cell, Y + 2 * cell, X + 5 * cell, Y + 5 * cell), fill=(0, 0, 0))

    for i in range(n):
        for j in range(n):
            in_finder = (i < 8 and j < 8) or (i < 8 and j > 12) or (i > 12 and j < 8)
            if not in_finder and rnd.random() < 0.45:
                X, Y = x + pad + i * cell, y + pad + j * cell
                d.rectangle((X, Y, X + cell, Y + cell), fill=(0, 0, 0))
    finder(0, 0)
    finder(14, 0)
    finder(0, 14)
    # The NOID mark in the middle, on a white disc.
    c = x + size / 2
    d.ellipse((c - 30 * S, y + size / 2 - 30 * S, c + 30 * S, y + size / 2 + 30 * S), fill=(255, 255, 255))
    hexagon(d, c, y + size / 2, 44 * S, 4.5 * S, color=(11, 24, 20))


def make_pay():
    img = background()
    d = ImageDraw.Draw(img, "RGBA")
    rings(d, 1110 * S, 40 * S)
    brand_and_copy(img, "You’ve got a payment request", "Open it in the NOID wallet: the address and amount fill in for you. You just confirm.", 560 * S)
    d = panel(img, (735, 70, 1120, 570))
    pill(d, 765 * S, 100 * S, "PAYMENT REQUEST")
    d.text((765 * S, 160 * S), "Pay with", font=font("Inter", "600SemiBold", 22), fill=TEXT2)
    d.text((765 * S, 186 * S), "NOID", font=font("JetBrainsMono", "800ExtraBold", 54), fill=TEXT)
    qr_like(d, 812 * S, 272 * S, 230 * S)
    d.text((927 * S, 535 * S), "Scan or tap to pay", font=font("Inter", "600SemiBold", 18), fill=FAINT, anchor="mm")
    return img


def make_gift():
    img = background()
    d = ImageDraw.Draw(img, "RGBA")
    rings(d, 1110 * S, 40 * S)
    brand_and_copy(img, "You’ve received a NOID gift card", "Open the link to claim it into your own NOID wallet. No sign-up, no fees for you.", 560 * S)
    # The vault-themed gift card, as in the app.
    x1, y1, x2, y2 = 700, 150, 1140, 427
    d = panel(img, (x1, y1, x2, y2), radius=30, fill=(9, 26, 21, 255))
    cx, cy = (x2 - 92) * S, (y1 + 92) * S
    for r, wdt, a in ((74, 2, 90), (54, 9, 150)):
        d.ellipse((cx - r * S, cy - r * S, cx + r * S, cy + r * S), outline=ACCENT + (a,), width=wdt * S)
    d.ellipse((cx - 18 * S, cy - 18 * S, cx + 18 * S, cy + 18 * S), fill=ACCENT)
    for i in range(24):
        a = i / 24 * 2 * math.pi
        r1, r2 = 78 * S, (90 if i % 3 == 0 else 85) * S
        d.line((cx + math.cos(a) * r1, cy + math.sin(a) * r1, cx + math.cos(a) * r2, cy + math.sin(a) * r2), fill=ACCENT + (110,), width=2 * S)
    d.text(((x1 + 30) * S, (y1 + 42) * S), "NOID", font=font("JetBrainsMono", "800ExtraBold", 24), fill=(233, 255, 247))
    d.text(((x1 + 30) * S, (y1 + 74) * S), "GIFT CARD", font=font("Inter", "600SemiBold", 15), fill=(143, 217, 192))
    d.text(((x1 + 30) * S, (y2 - 82) * S), "A gift for you", font=font("Inter", "800ExtraBold", 34), fill=(233, 255, 247))
    d.text(((x1 + 30) * S, (y2 - 40) * S), "CLAIM WITH NOID", font=font("Inter", "700Bold", 15), fill=ACCENT)
    f = font("Inter", "700Bold", 15)
    w = d.textlength("SCAN OR TAP TO CLAIM", font=f) + 30 * S
    pill(d, ((x1 + x2) / 2) * S - w / 2, 462 * S, "SCAN OR TAP TO CLAIM", 15)
    return img


def icon(d, name, cx, cy, color):
    """Small line icons matching the app's Send / Receive / Scan / Gift buttons."""
    u, w = 9 * S, int(3 * S)
    if name == "Send":
        d.line((cx - u, cy + u, cx + u, cy - u), fill=color, width=w)
        d.line((cx - u * 0.2, cy - u, cx + u, cy - u, cx + u, cy + u * 0.2), fill=color, width=w, joint="curve")
    elif name == "Receive":
        d.line((cx + u, cy - u, cx - u, cy + u), fill=color, width=w)
        d.line((cx + u * 0.2, cy + u, cx - u, cy + u, cx - u, cy - u * 0.2), fill=color, width=w, joint="curve")
    elif name == "Scan":
        k = u * 0.55
        for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            x0, y0 = cx + sx * u, cy + sy * u
            d.line((x0, y0 - sy * k, x0, y0, x0 - sx * k, y0), fill=color, width=w, joint="curve")
        d.line((cx - u, cy, cx + u, cy), fill=color, width=w)
    else:  # Gift
        d.rectangle((cx - u, cy - u * 0.2, cx + u, cy + u), outline=color, width=w)
        d.line((cx - u * 1.15, cy - u * 0.2, cx + u * 1.15, cy - u * 0.2), fill=color, width=w)
        d.line((cx, cy - u * 0.2, cx, cy + u), fill=color, width=w)
        d.ellipse((cx - u * 0.75, cy - u * 0.85, cx - u * 0.05, cy - u * 0.25), outline=color, width=w)
        d.ellipse((cx + u * 0.05, cy - u * 0.85, cx + u * 0.75, cy - u * 0.25), outline=color, width=w)


def make_home():
    img = background()
    d = ImageDraw.Draw(img, "RGBA")
    rings(d, 1110 * S, 40 * S)
    brand_and_copy(img, "Your Parano1d wallet, in your pocket.", "Send, receive, gift and request NOID. Your keys never leave your phone.", 560 * S)
    x1, y1, x2, y2 = 720, 120, 1125, 540
    d = panel(img, (x1, y1, x2, y2), radius=36)
    d.text(((x1 + 32) * S, (y1 + 46) * S), "TOTAL BALANCE", font=font("Inter", "600SemiBold", 16), fill=TEXT2)
    d.text(((x1 + 32) * S, (y1 + 78) * S), "1,250.00", font=font("JetBrainsMono", "800ExtraBold", 58), fill=TEXT)
    d.text(((x1 + 32) * S, (y1 + 152) * S), "NOID", font=font("JetBrainsMono", "700Bold", 24), fill=ACCENT)
    labels = ["Send", "Receive", "Scan", "Gift"]
    for i, lab in enumerate(labels):
        cx = (x1 + 66 + i * 92) * S
        cy = (y1 + 262) * S
        r = 32 * S
        d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=ACCENT if i == 0 else (26, 38, 34))
        icon(d, lab, cx, cy, (11, 24, 20) if i == 0 else TEXT)
        d.text((cx, cy + 54 * S), lab, font=font("Inter", "600SemiBold", 16), fill=TEXT, anchor="mm")
    d.line(((x1 + 32) * S, (y1 + 352) * S, (x2 - 32) * S, (y1 + 352) * S), fill=LINE, width=2 * S)
    d.text(((x1 + 32) * S, (y1 + 380) * S), "Received · Gift card", font=font("Inter", "600SemiBold", 18), fill=TEXT)
    d.text(((x2 - 32) * S, (y1 + 380) * S), "+5.0", font=font("JetBrainsMono", "700Bold", 20), fill=ACCENT, anchor="ra")
    return img


def save(img: Image.Image, name: str):
    out = img.resize((1200, 630), Image.LANCZOS)
    path = OUT / name
    out.save(path, "JPEG", quality=88, optimize=True, progressive=True)
    print(f"{path.relative_to(ROOT)}  {path.stat().st_size // 1024} KB")


if __name__ == "__main__":
    save(make_home(), "og-home.jpg")
    save(make_pay(), "og-pay.jpg")
    save(make_gift(), "og-gift.jpg")
