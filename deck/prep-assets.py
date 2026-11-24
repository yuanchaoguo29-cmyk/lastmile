# -*- coding: utf-8 -*-
"""为 PPT 准备截图素材：按卡片色条自动定位并裁剪。
用法：python deck/prep-assets.py
产出：deck/assets/*.png
"""
import os
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHOTS = os.path.join(ROOT, "shots")
OUT = os.path.join(ROOT, "deck", "assets")
os.makedirs(OUT, exist_ok=True)

BLUE = (29, 78, 216)    # --s-quiz  #1d4ed8
MINT = (14, 159, 110)   # --s-accent #0e9f6e


def close(px, target, tol=26):
    return all(abs(px[i] - target[i]) <= tol for i in range(3))


def find_bands(img, color, x=22, min_len=40):
    """返回该列上该颜色所有连续段 [(top,bottom), ...]"""
    w, h = img.size
    px = img.convert("RGB").load()
    rows = [y for y in range(h) if close(px[x, y], color)]
    bands = []
    if not rows:
        return bands
    start = prev = rows[0]
    for y in rows[1:]:
        if y == prev + 1:
            prev = y
        else:
            if prev - start >= min_len:
                bands.append((start, prev))
            start = prev = y
    if prev - start >= min_len:
        bands.append((start, prev))
    return bands


def crop(src, dst, box=None, pad_top=0, pad_bottom=0):
    img = Image.open(os.path.join(SHOTS, src)).convert("RGB")
    w, h = img.size
    if box:
        left, top, right, bottom = box
    else:
        left, top, right, bottom = 0, 0, w, h
    top = max(0, top - pad_top)
    bottom = min(h, bottom + pad_bottom)
    out = img.crop((left, top, right, bottom))
    out.save(os.path.join(OUT, dst), optimize=True)
    print(f"  {dst:<16} {out.size[0]}x{out.size[1]}  (from {src} y={top}..{bottom})")
    return out


# 1. 品牌图标
Image.open(os.path.join(ROOT, "web", "public", "icon-512.png")).save(
    os.path.join(OUT, "icon.png"), optimize=True
)
print("  icon.png         512x512")

# 2. 学生端首屏（图例 + 第一张卡 + 行动项开头）
crop("cpolar_student.png", "student.png", box=(0, 0, 390, 1215))

# 3. 小测卡：按蓝色竖条定位（蓝色只有一处）
quiz_src = Image.open(os.path.join(SHOTS, "quiz_wrong_new.png")).convert("RGB")
quiz_bands = find_bands(quiz_src, BLUE)
print("  blue bands:", quiz_bands)
if quiz_bands:
    top, bottom = quiz_bands[0]
    crop("quiz_wrong_new.png", "quiz.png", box=(0, top, 390, bottom + 1),
         pad_top=26, pad_bottom=24)

# 4. 确认卡：薄荷色条有两处（官方渠道块 + 确认卡），取最后一处
mint_bands = find_bands(quiz_src, MINT)
print("  mint bands:", mint_bands)
if mint_bands:
    top, bottom = mint_bands[-1]
    crop("quiz_wrong_new.png", "confirm_card.png", box=(0, top, 390, bottom + 1),
         pad_top=44, pad_bottom=22)

# 5. 辅导员端：确认页（字段 + 原文片段）
crop("parse_flow.png", "counselor_confirm.png", box=(0, 0, 1440, 1080))

# 6. 看板
crop("dashboard.png", "dashboard.png", box=(0, 0, 1440, 1010))

# 7. 通知列表
crop("final_console.png", "console.png")

# 8. 催办结果
crop("nudge_final.png", "nudge.png", box=(0, 0, 1440, 1200))

# 9. 门禁
crop("lock.png", "lock.png", box=(0, 0, 1440, 780))

print("done ->", OUT)
