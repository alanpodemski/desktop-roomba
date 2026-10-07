#!/usr/bin/env python3
"""Replace public/mac/desktop.json with a fake but believable desktop.

Creates placeholder files in a temp folder, renders their real Finder icons /
QuickLook previews with scripts/.bin/icon-helper, and writes made-up names,
sizes (which drive icon mass in the sim) and Finder grid positions.
No personal file names or contents are used.

    python3 scripts/fake-desktop.py
"""
import json, os, random, shutil, subprocess, tempfile, zipfile
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'mac')
ICONS = os.path.join(OUT, 'icons')
HELPER = os.path.join(ROOT, 'scripts', '.bin', 'icon-helper')
rng = random.Random(42)

# Finder grid on a 1728 px wide desktop: columns step 72 from the right edge, rows step 88.
COL = lambda c: 1688 - 72 * c
ROW = lambda r: 69 + 88 * r

# name, kind, bytes, (col, row) or (x, y) absolute for strays, icloud
ITEMS = [
    ('Macintosh HD',                          'volume', 18_576_642_048, (0, 0)),
    ('Old Projects',                          'folder',  4_812_000_000, (0, 1)),
    ('Taxes 2025',                            'folder',     38_400_000, (0, 2)),
    ('Design Assets',                         'folder',    912_000_000, (0, 3)),
    ('untitled folder',                       'folder',              0, (0, 4)),
    ('Archive.zip',                           'zip',       264_000_000, (0, 5)),
    ('Screenshot 2026-10-03 at 14.22.18.png', 'png',         1_480_000, (1, 0)),
    ('Screenshot 2026-10-05 at 09.41.07.png', 'png',           920_000, (1, 1)),
    ('IMG_4821.jpeg',                         'jpeg',        3_210_000, (1, 2)),
    ('invoice_final_v3.pdf',                  'pdf',           184_000, (1, 3)),
    ('Blender-4.5-arm64.dmg',                 'dmg',       412_000_000, (1, 4)),
    ('notes.txt',                             'txt',             2_100, (2, 0)),
    ('budget_2026.csv',                       'csv',            46_000, (2, 1)),
    ('Screen Recording 2026-10-06 at 21.40.12.mov', 'mov', 1_240_000_000, (2, 2)),
    ('resume_2026.pdf',                       'pdf',           96_000, (2, 3)),
    ('wallpaper ideas',                       'folder',     58_000_000, (3, 0)),
    # strays a person dragged into the middle of the desktop and forgot about
    ('cat.jpeg',                              'jpeg',        2_400_000, ('abs', 1020, 380)),
    ('final_FINAL.psd',                       'psd',       188_000_000, ('abs', 760, 640)),
    ('todo.md',                               'md',              1_300, ('abs', 1240, 820)),
    ('Node Modules (do not open)',            'folder',  2_100_000_000, ('abs', 420, 300)),
]

def slug(s):
    out = ''.join(ch.lower() if ch.isalnum() else '-' for ch in s)
    while '--' in out: out = out.replace('--', '-')
    return out.strip('-')

def gradient(w, h, top, bottom):
    im = Image.new('RGB', (w, h))
    d = ImageDraw.Draw(im)
    for y in range(h):
        t = y / (h - 1)
        d.line([(0, y), (w, y)], fill=tuple(int(top[i] + (bottom[i] - top[i]) * t) for i in range(3)))
    return im

def fake_photo(path, kind):
    w, h = 1600, 1200
    if kind == 'cat':
        im = gradient(w, h, (196, 170, 140), (120, 96, 72))
        d = ImageDraw.Draw(im)
        d.ellipse([480, 420, 1180, 1100], fill=(225, 150, 70))           # body
        d.ellipse([560, 220, 980, 620], fill=(232, 160, 80))              # head
        d.polygon([(590, 300), (640, 120), (720, 260)], fill=(232, 160, 80))
        d.polygon([(820, 260), (900, 120), (950, 300)], fill=(232, 160, 80))
        for ex in (680, 860): d.ellipse([ex - 28, 380, ex + 28, 440], fill=(40, 60, 30))
        im = im.filter(ImageFilter.GaussianBlur(6))
    else:
        im = gradient(w, h, (120, 170, 220), (250, 210, 160))            # sky at sunset
        d = ImageDraw.Draw(im)
        for i, col in enumerate([(70, 90, 110), (50, 64, 80), (34, 44, 54)]):
            pts = [(0, h)] + [(x, 620 + i * 120 + int(90 * ((x * (i + 3)) % 377) / 377)) for x in range(0, w + 80, 80)] + [(w, h)]
            d.polygon(pts, fill=col)
        im = im.filter(ImageFilter.GaussianBlur(3))
    im.save(path, quality=88)

def fake_screenshot(path, variant):
    w, h = 1800, 1120
    im = Image.new('RGB', (w, h), (30, 30, 34) if variant else (242, 242, 246))
    d = ImageDraw.Draw(im)
    fg = (60, 60, 66) if variant else (210, 210, 216)
    d.rounded_rectangle([60, 60, w - 60, h - 60], 24, fill=(44, 44, 50) if variant else (255, 255, 255), outline=fg, width=2)
    d.rectangle([60, 60, 420, h - 60], fill=(38, 38, 44) if variant else (246, 246, 250))
    for i in range(9): d.rounded_rectangle([100, 140 + i * 70, 380, 170 + i * 70], 8, fill=fg)
    for i in range(6):
        d.rounded_rectangle([480, 140 + i * 150, 480 + rng.randint(500, 1200), 190 + i * 150], 10, fill=fg)
        d.rounded_rectangle([480, 210 + i * 150, 480 + rng.randint(300, 900), 230 + i * 150], 6, fill=fg)
    d.rounded_rectangle([1300, 130, 1700, 520], 20, fill=(90, 120, 240))
    im.save(path)

def fake_pdf(path, title_lines):
    pages = []
    im = Image.new('RGB', (1240, 1754), 'white'); d = ImageDraw.Draw(im)
    d.rectangle([110, 120, 700, 180], fill=(30, 30, 30))
    for i in range(title_lines): d.rectangle([110, 260 + i * 42, 110 + rng.randint(600, 1000), 280 + i * 42], fill=(150, 150, 150))
    d.rectangle([110, 1100, 1130, 1104], fill=(60, 60, 60))
    for i in range(6): d.rectangle([110, 1150 + i * 50, 1130, 1170 + i * 50], fill=(205, 205, 205))
    pages.append(im)
    pages[0].save(path, 'PDF', resolution=150)

def main():
    if not os.path.exists(HELPER):
        raise SystemExit('icon helper missing: run `npm run scan` once to compile scripts/.bin/icon-helper')
    tmp = tempfile.mkdtemp(prefix='fake-desktop-')
    os.makedirs(ICONS, exist_ok=True)
    # remove previously generated desktop icons (they came from real files)
    for f in os.listdir(ICONS):
        if f.startswith('desk-'): os.remove(os.path.join(ICONS, f))

    thumbs, icons, items = [], [], []
    for name, kind, size, place in ITEMS:
        id_ = slug(name)
        if kind == 'volume':
            p = '/'
        else:
            p = os.path.join(tmp, name)
            if kind == 'folder':
                os.makedirs(p)
            elif kind in ('png',):
                fake_screenshot(p, '09.41' in name)
            elif kind == 'jpeg':
                fake_photo(p, 'cat' if 'cat' in name else 'landscape')
            elif kind == 'pdf':
                fake_pdf(p, 14 if 'invoice' in name else 22)
            elif kind == 'zip':
                with zipfile.ZipFile(p, 'w') as z: z.writestr('readme.txt', 'archive')
            elif kind == 'csv':
                open(p, 'w').write('month,amount\nJan,1200\nFeb,980\n')
            elif kind in ('txt', 'md'):
                open(p, 'w').write('- buy milk\n- fix roomba\n')
            else:
                open(p, 'wb').write(b'\0' * 64)   # dmg / mov / psd: generic type icon by extension
        out = os.path.join(ICONS, f'desk-{id_}.png')
        (thumbs if kind in ('png', 'jpeg', 'pdf', 'txt', 'md', 'csv') else icons).append((p, out))
        if place[0] == 'abs':
            pos = {'x': place[1], 'y': place[2]}
        else:
            pos = {'x': COL(place[0]), 'y': ROW(place[1])}
        ext = '' if kind in ('folder', 'volume') else name.rsplit('.', 1)[-1].lower()
        items.append({
            'id': id_, 'name': name, 'path': p, 'kind': kind, 'ext': ext,
            'isFolder': kind in ('folder', 'volume'), 'bytes': size, 'icloud': False,
            'finderKind': kind, 'pos': pos, 'icon': f'/mac/icons/desk-{id_}.png',
        })

    def run(mode, pairs):
        if not pairs: return
        args = [HELPER, mode, '256']
        for a, b in pairs: args += [a, b]
        subprocess.run(args, check=True)
    run('thumb', thumbs)
    run('icon', icons)
    for it in items:
        if not os.path.exists(os.path.join(ICONS, f"desk-{it['id']}.png")):
            print('no icon for', it['name']); it['icon'] = None
        it['path'] = '/Users/demo/Desktop/' + it['name'] if it['kind'] != 'volume' else '/'

    desktop_path = os.path.join(OUT, 'desktop.json')
    prev = json.load(open(desktop_path)) if os.path.exists(desktop_path) else {}
    data = {
        'display': {'width': 1728, 'height': 1117},
        'positionsFromFinder': True,
        'view': prev.get('view', {'iconSize': 48, 'gridSpacing': 32, 'textSize': 10, 'labelOnBottom': True,
                                  'arrangeBy': 'grid', 'showItemInfo': False, 'showIconPreview': True,
                                  'showHardDrives': True, 'showExternalDrives': True}),
        'items': items,
        'fake': True,
    }
    json.dump(data, open(desktop_path, 'w'), indent=2)
    shutil.rmtree(tmp, ignore_errors=True)
    print(f'wrote {len(items)} fake desktop items to {desktop_path}')

if __name__ == '__main__':
    main()
