"""生成 PixDesk 应用图标：1024 超采样渲染 -> 多尺寸 PNG -> 打包成 .ico"""

import zlib, struct, os, math

OUT_DIR = os.path.dirname(os.path.abspath(__file__))  # build/
os.makedirs(OUT_DIR, exist_ok=True)

SS = 4  # 超采样倍数


def png_bytes(w, h, rgba):
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        row = rgba[y]
        for x in range(w):
            i = x * 4
            raw += row[i:i + 3]
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def rgba_png(w, h, buf):
    """带 alpha 的 PNG，用于 ico 内嵌"""
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw += bytes(buf[y * w * 4:(y + 1) * w * 4])
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(bytes(raw), 9)) + chunk(b"IEND", b""))


def render(size):
    """返回 size*size 的 RGBA bytearray（已超采样降噪）"""
    W = size * SS
    buf = bytearray(W * W * 4)

    # 几何参数（归一化到 0..1）
    r = 0.215                      # 圆角半径
    pad = 0.045                    # 外边距
    x0, x1 = pad, 1.0 - pad
    y0, y1 = pad, 1.0 - pad
    cx_sun, cy_sun, r_sun = 0.335, 0.345, 0.078
    # 山峰折线（归一化坐标）
    peak = [(0.085, 0.795), (0.30, 0.545), (0.435, 0.685), (0.575, 0.455), (0.895, 0.795)]

    for py in range(W):
        ny = (py + 0.5) / W
        for px in range(W):
            nx = (px + 0.5) / W
            i = (py * W + px) * 4

            # 圆角矩形遮罩
            inside = True
            if nx < x0 + r and ny < y0 + r:
                inside = math.hypot(nx - (x0 + r), ny - (y0 + r)) <= r
            elif nx > x1 - r and ny < y0 + r:
                inside = math.hypot(nx - (x1 - r), ny - (y0 + r)) <= r
            elif nx < x0 + r and ny > y1 - r:
                inside = math.hypot(nx - (x0 + r), ny - (y1 - r)) <= r
            elif nx > x1 - r and ny > y1 - r:
                inside = math.hypot(nx - (x1 - r), ny - (y1 - r)) <= r
            elif nx < x0 or nx > x1 or ny < y0 or ny > y1:
                inside = False
            if not inside:
                continue

            # 背景：斜向渐变 蓝 -> 青蓝
            t = (nx * 0.55 + ny * 0.45 - pad) / (1 - 2 * pad)
            t = min(1.0, max(0.0, t))
            br = 46 + (18 - 46) * t
            bg = 123 + (196 - 123) * t
            bb = 255 + (255 - 255) * t

            rr, gg, bb2, aa = br, bg, bb, 255

            # 太阳
            if math.hypot(nx - cx_sun, ny - cy_sun) <= r_sun:
                rr = gg = bb2 = 255

            # 山体（折线下方填充）
            if ny > y0:
                seg = None
                for k in range(len(peak) - 1):
                    ax, ay = peak[k]
                    bx, by = peak[k + 1]
                    if ax <= nx <= bx:
                        seg = (ax, ay, bx, by)
                        break
                if seg:
                    ax, ay, bx, by = seg
                    edge = ay + (by - ay) * ((nx - ax) / (bx - ax)) if bx != ax else ay
                    if ny >= edge:
                        shade = 0.72 + 0.28 * ((ny - edge) / max(1e-6, (0.86 - edge)))
                        rr = int(24 * shade + 40)
                        gg = int(58 * shade + 60)
                        bb2 = int(112 * shade + 70)
                        # 山脊高光
                        if 0 <= ny - edge < 0.012:
                            rr, gg, bb2 = 235, 244, 255

            buf[i] = max(0, min(255, int(rr)))
            buf[i + 1] = max(0, min(255, int(gg)))
            buf[i + 2] = max(0, min(255, int(bb2)))
            buf[i + 3] = aa

    # 降采样
    out = bytearray(size * size * 4)
    n = SS * SS
    for y in range(size):
        for x in range(size):
            sr = sg = sb = sa = 0
            for dy in range(SS):
                base = ((y * SS + dy) * W + x * SS) * 4
                for dx in range(SS):
                    i = base + dx * 4
                    a = buf[i + 3]
                    sr += buf[i] * a
                    sg += buf[i + 1] * a
                    sb += buf[i + 2] * a
                    sa += a
            o = (y * size + x) * 4
            if sa:
                out[o] = sr // sa
                out[o + 1] = sg // sa
                out[o + 2] = sb // sa
            out[o + 3] = min(255, sa // n)
    return out


sizes = [256, 128, 64, 48, 32, 16]
images = []
for s in sizes:
    data = render(s)
    p = rgba_png(s, s, data)
    images.append((s, p))
    if s in (256, 512):
        with open(os.path.join(OUT_DIR, "icon-%d.png" % s), "wb") as f:
            f.write(p)

# 打包 ICO（PNG 负载，Vista+ 支持）
header = struct.pack("<HHH", 0, 1, len(images))
offset = 6 + 16 * len(images)
entries = b""
payload = b""
for s, data in images:
    entries += struct.pack("<BBBBHHII", s if s < 256 else 0, s if s < 256 else 0,
                           0, 0, 1, 32, len(data), offset)
    payload += data
    offset += len(data)

ico_path = os.path.join(OUT_DIR, "icon.ico")
with open(ico_path, "wb") as f:
    f.write(header + entries + payload)

print("icon.ico:", os.path.getsize(ico_path), "bytes, sizes:", sizes)
