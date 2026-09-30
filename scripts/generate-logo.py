#!/usr/bin/env python3
"""生成 BiliTV 应用图标 / 启动页。

源图：assets/logo-source.png（用户提供的 Q 版角色图，100x100，纯黑底）
产出：
  android/app/src/main/res/mipmap-*/ic_launcher.png            （方形图标）
  android/app/src/main/res/mipmap-*/ic_launcher_round.png      （圆形图标）
  android/app/src/main/res/mipmap-*/ic_launcher_foreground.png （自适应图标前景层）
  android/app/src/main/res/drawable/splash.png                 （启动页）
  android/app/src/main/res/values/ic_launcher_background.xml   （自适应图标底色）
预览：
  assets/icon-preview/icon-<size>.png
"""
import os
import math
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "assets", "logo-source.png")
RES = os.path.join(ROOT, "bilitv-web", "android", "app", "src", "main", "res")
PREVIEW = os.path.join(ROOT, "assets", "icon-preview")

# 自适应图标画布（dp）：前景层 108dp
DP = 1.0
# 角色占画布比例
CHAR_SCALE = 0.94
# 背景：中心 -> 边缘 深色渐变
BG_IN = (44, 56, 92)      # #2C385C
BG_OUT = (10, 13, 22)     # #0A0D16
BG_SOLID = "#0A0D16"

UP = 8  # 源图放大倍数（100px -> 800px）


def build_cutout(size):
    """黑底 -> 透明，得到角色抠图 RGBA。"""
    src = Image.open(SRC).convert("RGB")
    src = src.resize((src.width * UP, src.height * UP), Image.LANCZOS)
    src = src.filter(ImageFilter.UnsharpMask(radius=2, percent=60, threshold=2))
    px = src.load()
    w, h = src.size
    rgba = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    dest = rgba.load()
    for y in range(h):
        for x in range(w):
            r, g, b = px[x, y]
            lum = max(r, g, b)
            # 纯黑背景（及杂色点）-> 全透明；亮度 10~44 之间线性过渡到不透明
            a = 0 if lum <= 10 else (255 if lum >= 44 else int((lum - 10) / 34 * 255))
            if a:
                dest[x, y] = (r, g, b, a)
    return rgba


def grow(img, size, scale):
    """把抠图按 scale 居中绘制到 size 画布（RGBA）。"""
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    nw = int(size * scale)
    art = img.resize((nw, nw), Image.LANCZOS)
    ox, oy = (size - nw) // 2, (size - nw) // 2
    canvas.paste(art, (ox, oy), art)
    return canvas


def radial_bg(size):
    """深色径向渐变背景（纯 PIL 实现）。"""
    bg = Image.new("RGB", (size, size), BG_OUT)
    d = ImageDraw.Draw(bg)
    cx, cy = size * 0.5, size * 0.46
    maxr = size * 0.62
    steps = 48
    for i in range(steps, 0, -1):
        f = i / steps                       # 1 -> 0（中心为 0）
        r = maxr * f
        t = f ** 1.35                       # 边缘衰减曲线
        col = tuple(int(BG_OUT[c] + (BG_IN[c] - BG_OUT[c]) * (1 - t)) for c in range(3))
        d.ellipse([cx - r, cy - r * 0.86, cx + r, cy + r * 0.86], fill=col)
    return bg


CUT = None  # 抠图（RGBA），在 main() 中构建


def build(size):
    """完整图标：渐变底 + 角色。"""
    bg = radial_bg(size).convert("RGBA")
    art = grow(CUT, size, CHAR_SCALE)
    bg.alpha_composite(art)
    return bg.convert("RGB")


def main():
    global CUT
    CUT = build_cutout(0)
    os.makedirs(PREVIEW, exist_ok=True)

    # 1) 完整图标瓦片（渐变底 + 角色）
    master = build(1024)
    master.save(os.path.join(PREVIEW, "icon-tile-1024.png"))

    fg_master = grow(CUT, 1024, CHAR_SCALE)

    # 2) 传统 mipmap 图标（全尺寸密度）
    legacy = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    for d, s in legacy.items():
        img = master.resize((s, s), Image.LANCZOS)
        img.save(os.path.join(RES, "mipmap-" + d, "ic_launcher.png"))
        img.save(os.path.join(RES, "mipmap-" + d, "ic_launcher_round.png"))
        # 预览（黑底 + 白圈，模拟圆形裁切）
        prev = Image.new("RGB", (s * 3, s * 3), (255, 0, 0))
        pim = img.resize((s * 3, s * 3), Image.LANCZOS)
        mask = Image.new("L", (s * 3, s * 3), 0)
        ImageDraw.Draw(mask).ellipse([0, 0, s * 3 - 1, s * 3 - 1], fill=255)
        prev.paste(pim, (0, 0), mask)
        prev.save(os.path.join(PREVIEW, "preview-legacy-%s.png" % d))

    # 3) 自适应图标前景层（仅角色，透明底）
    fg_sizes = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
    for d, s in fg_sizes.items():
        fg = fg_master.resize((s, s), Image.LANCZOS)
        fg.save(os.path.join(RES, "mipmap-" + d, "ic_launcher_foreground.png"))
    fg_master.save(os.path.join(PREVIEW, "icon-foreground-1024.png"))

    # 4) 启动页（logo 居中 + 深色底）
    sw, sh = 480, 320
    splash = Image.new("RGB", (sw, sh), BG_OUT)
    d = ImageDraw.Draw(splash)
    for i in range(sh):
        t = i / sh
        col = tuple(int(BG_OUT[c] + (BG_IN[c] - BG_OUT[c]) * 0.25) for c in range(3))
        d.line([(0, i), (sw, i)], fill=col)
    logo = master.resize((180, 180), Image.LANCZOS).convert("RGBA")
    splash_rgba = splash.convert("RGBA")
    splash_rgba.alpha_composite(logo, ((sw - 180) // 2, (sh - 180) // 2 - 6))
    splash = splash_rgba.convert("RGB")
    splash.save(os.path.join(RES, "drawable", "splash.png"))
    splash.save(os.path.join(PREVIEW, "preview-splash.png"))

    # 5) 自适应图标底色
    bgxml = os.path.join(RES, "values", "ic_launcher_background.xml")
    with open(bgxml, "w", encoding="utf-8") as f:
        f.write('<?xml version="1.0" encoding="utf-8"?>\n')
        f.write('<resources>\n')
        f.write('    <color name="ic_launcher_background">%s</color>\n' % BG_SOLID)
        f.write('</resources>\n')

    # 6) 预览拼版（1080 宽）
    base = Image.new("RGB", (1040, 280), (250, 250, 250))
    p = ImageDraw.Draw(base)
    p.text((22, 8), "launched icon previews (red = circular crop)", fill=(60, 60, 60))
    for i, s in enumerate([48, 72, 96, 144, 192]):
        x = 30 + i * 200
        img = Image.new("RGB", (192, 192), (255, 0, 0))
        m = Image.new("L", (192, 192), 0)
        ImageDraw.Draw(m).rounded_rectangle([0, 0, 191, 191], radius=38, fill=255)
        im = master.resize((192, 192), Image.LANCZOS)
        img.paste(im, (0, 0), m)
        base.paste(img, (x, 45))
    base.save(os.path.join(PREVIEW, "preview-sheet.png"))
    print("done")


if __name__ == "__main__":
    main()
