from PIL import Image, ImageDraw, ImageChops
import os
import subprocess
import numpy as np
from scipy.ndimage import binary_dilation

os.makedirs('assets', exist_ok=True)
os.makedirs('public', exist_ok=True)
os.makedirs('src-tauri/icons', exist_ok=True)

def load_and_clean_image(path):
    im = Image.open(path).convert('RGBA')
    arr = np.array(im)
    a = arr[:, :, 3]
    solid = a >= 10
    dilated = binary_dilation(solid, iterations=2)
    arr[~dilated, 3] = 0
    arr[arr[:, :, 3] < 5, 3] = 0
    return Image.fromarray(arr)

# Load source trident logo
src = load_and_clean_image('assets/trident-logo-source.png')

# Crop to non-transparent bounding box
bbox = src.getbbox()
trident_cropped = src.crop(bbox)
w, h = trident_cropped.size

# 1. App Icon (1024x1024 master)
# Pure white background squircle, centered trident with proper padding (~70% inner dimension per macOS HIG), keeping original icon color
size = 1024
radius = int(size * 0.223)  # Apple standard squircle corner ratio (~228px on 1024)

app_icon = Image.new('RGBA', (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(app_icon)
draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=(255, 255, 255, 255))

# Scale to fit canvas with proper padding (15% padding on each side, inner 70% safe area)
padding_pct = 0.15
inner = int(round(size * (1 - 2 * padding_pct)))
scale = float(inner) / max(w, h)
nw, nh = int(round(w * scale)), int(round(h * scale))
trident_resized = trident_cropped.resize((nw, nh), Image.Resampling.LANCZOS)
ox = (size - nw) // 2
oy = (size - nh) // 2

trident_layer = Image.new('RGBA', (size, size), (0, 0, 0, 0))
trident_layer.paste(trident_resized, (ox, oy))
app_icon = Image.alpha_composite(app_icon, trident_layer)

# Mask any bleed strictly to the squircle
squircle_mask = Image.new('L', (size, size), 0)
mask_draw = ImageDraw.Draw(squircle_mask)
mask_draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
r, g, b, a = app_icon.split()
a = ImageChops.multiply(a, squircle_mask)
app_icon.putalpha(a)

app_icon.save('assets/icon.png')

# 2. Status bar / Tray icons
# Pure white on transparent background for template & dark mode
tray_src_path = 'assets/tray-icon-source.png' if os.path.exists('assets/tray-icon-source.png') else 'assets/trident-logo-source.png'
tray_src = load_and_clean_image(tray_src_path)
tray_bbox = tray_src.getbbox()
tray_cropped = tray_src.crop(tray_bbox)
tray_w, tray_h = tray_cropped.size

_, _, _, tray_a = tray_cropped.split()

sizes = [
    (18, 18, 'assets/iconTemplate.png'),
    (36, 36, 'assets/iconTemplate@2x.png'),
    (22, 22, 'assets/trayIcon.png'),
    (44, 44, 'assets/trayIcon@2x.png'),
    (16, 16, 'assets/trayIcon-16.png'),
    (32, 32, 'assets/trayIcon-32.png'),
    (44, 44, 'src-tauri/icons/tray-icon.png'),
]

def render_tray_icons():
    for target_w, target_h, out_path in sizes:
        margin = 1 if target_w <= 22 else 2
        inner_dim = target_w - margin * 2
        t_scale = float(inner_dim) / max(tray_w, tray_h)
        tw, th = max(1, int(round(tray_w * t_scale))), max(1, int(round(tray_h * t_scale)))
        a_scaled = tray_a.resize((tw, th), Image.Resampling.LANCZOS)
        
        white_icon = Image.merge('RGBA', (
            Image.new('L', (tw, th), 255),
            Image.new('L', (tw, th), 255),
            Image.new('L', (tw, th), 255),
            a_scaled
        ))
        
        tray_canvas = Image.new('RGBA', (target_w, target_h), (255, 255, 255, 0))
        pos_x = (target_w - tw) // 2
        pos_y = (target_h - th) // 2
        tray_canvas.paste(white_icon, (pos_x, pos_y), white_icon)
        tray_canvas.save(out_path)

render_tray_icons()

# 3. Vector SVG Favicon, high-res web icons, and multi-resolution ICO
TRIDENT_SVG = '''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="100%" height="100%">
  <g transform="translate(0, 1024) scale(0.1, -0.1)">
    <path fill="#FCC611" d="M4998 9060 c-260 -44 -477 -238 -548 -490 -23 -83 -32 -231 -70 -1170 -11 -278 -25 -611 -30 -740 -5 -129 -14 -383 -20 -565 -6 -181 -15 -367 -21 -413 -24 -200 -97 -356 -213 -453 -99 -84 -155 -104 -286 -104 -100 0 -109 2 -173 34 -81 41 -138 100 -179 187 -56 118 -56 149 -18 749 11 165 29 449 40 630 11 182 29 463 40 625 10 162 22 345 25 405 3 61 13 202 21 315 16 221 10 305 -26 423 -66 212 -264 392 -492 447 -266 64 -556 -33 -722 -241 -97 -122 -122 -185 -171 -434 -19 -99 -76 -387 -126 -640 -300 -1530 -433 -2208 -500 -2555 -22 -113 -49 -249 -60 -302 -59 -285 -91 -743 -71 -1012 30 -398 109 -706 262 -1021 307 -632 847 -1083 1610 -1346 478 -165 1194 -251 1945 -235 543 11 934 53 1300 137 985 228 1720 757 2075 1494 169 350 244 663 256 1075 10 326 -13 596 -81 950 -216 1115 -350 1804 -410 2105 -29 149 -92 468 -140 710 -143 733 -165 836 -191 899 -126 312 -471 490 -811 420 -207 -42 -383 -181 -480 -379 -63 -127 -74 -222 -57 -485 7 -113 20 -313 29 -445 9 -132 24 -379 35 -550 11 -170 22 -339 25 -375 9 -109 54 -885 61 -1055 7 -173 -2 -240 -47 -327 -32 -63 -115 -144 -178 -175 -51 -25 -66 -28 -166 -28 -105 0 -113 2 -178 34 -175 88 -290 278 -317 525 -5 50 -19 343 -30 651 -11 308 -27 711 -35 895 -8 184 -21 506 -30 715 -21 495 -28 574 -60 664 -33 91 -55 129 -124 215 -148 184 -412 278 -663 236z" />
    <path fill="#181817" d="M3867 4319 c-139 -33 -259 -158 -297 -310 -7 -30 -10 -207 -8 -564 l3 -520 30 -60 c37 -76 113 -151 190 -190 55 -28 68 -30 165 -30 101 0 109 2 174 34 78 40 133 97 180 186 l31 60 0 540 c0 611 2 592 -79 703 -92 124 -247 184 -389 151z M6215 4321 c-147 -39 -268 -162 -305 -311 -7 -31 -10 -205 -8 -565 l3 -520 29 -55 c84 -161 214 -238 385 -228 161 9 279 100 341 263 23 60 23 63 24 565 l1 505 -24 70 c-13 39 -37 89 -52 111 -39 58 -120 122 -181 146 -58 22 -167 32 -213 19z" />
  </g>
</svg>'''

for p in ['assets/trident.svg', 'public/icon.svg']:
    with open(p, 'w') as f:
        f.write(TRIDENT_SVG)

if os.path.exists('src/app'):
    with open('src/app/icon.svg', 'w') as f:
        f.write(TRIDENT_SVG)
    # Remove any src/app/favicon.ico to prevent Next.js from injecting low-res 16x16 icon tag
    if os.path.exists('src/app/favicon.ico'):
        os.remove('src/app/favicon.ico')

# Render vector PNGs with rsvg-convert if available
has_rsvg = subprocess.run(['which', 'rsvg-convert'], capture_output=True).returncode == 0
if has_rsvg:
    subprocess.run(['rsvg-convert', '-w', '256', '-h', '256', 'public/icon.svg', '-o', 'public/icon.png'], check=True)
    subprocess.run(['rsvg-convert', '-w', '64', '-h', '64', 'public/icon.svg', '-o', 'public/favicon.png'], check=True)
    if os.path.exists('src/app'):
        subprocess.run(['rsvg-convert', '-w', '256', '-h', '256', 'public/icon.svg', '-o', 'src/app/icon.png'], check=True)
else:
    # High-quality fallback using PIL
    def make_transparent_icon(target_size, padding_pct=0.06):
        inner = int(round(target_size * (1 - 2 * padding_pct)))
        scale = float(inner) / max(w, h)
        tw, th = max(1, int(round(w * scale))), max(1, int(round(h * scale)))
        resized = trident_cropped.resize((tw, th), Image.Resampling.LANCZOS)
        canvas = Image.new('RGBA', (target_size, target_size), (0, 0, 0, 0))
        pos_x = (target_size - tw) // 2
        pos_y = (target_size - th) // 2
        canvas.paste(resized, (pos_x, pos_y), resized)
        return canvas

    fav = make_transparent_icon(64)
    fav.save('public/favicon.png')
    app_fav = make_transparent_icon(256)
    app_fav.save('public/icon.png')
    if os.path.exists('src/app'):
        app_fav.save('src/app/icon.png')

# Save multi-resolution favicon.ico for legacy browser fallbacks (up to 256x256)
ico_master = Image.open('public/icon.png')
ico_master.save('public/favicon.ico', format='ICO', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])

app_icon.save('assets/icon.ico', format='ICO', sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])

print("Running tauri icon generator for bundle assets...")
subprocess.run(['npx', 'tauri', 'icon', 'assets/icon.png', '-o', 'src-tauri/icons'], check=True)

# Use a new bundle icon filename so macOS does not reuse the old notification icon.
os.replace('src-tauri/icons/icon.icns', 'src-tauri/icons/trident.icns')

# Re-save tray-icon.png in case tauri icon altered it or touched it
render_tray_icons()

print("All trident icons successfully generated!")
