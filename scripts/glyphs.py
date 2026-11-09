"""Regenerate src/glyphs.json: the marker's title and date digits as SVG outlines.

The marker SVG draws "ICCQR Calibration Marker" and the calibration date as
paths rather than text, so it prints identically on machines without the fonts.
Run this only when the title text or the fonts change:

    npm install                        # for the Fontsource font files
    pip install fonttools brotli
    python3 scripts/glyphs.py
    npm run build
"""
import json
import os

from fontTools.pens.boundsPen import BoundsPen
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.svgLib.path import parse_path
from fontTools.ttLib import TTFont
from fontTools.varLib.instancer import instantiateVariableFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FONTS = os.path.join(ROOT, 'node_modules')
TITLE = 'ICCQR Calibration Marker'
DATE_CHARS = '0123456789-'

# Title: Archivo at weight 800, width 125%, the same style as the page heading.
archivo = TTFont(os.path.join(FONTS, '@fontsource-variable/archivo/files/archivo-latin-standard-normal.woff2'))
archivo = instantiateVariableFont(archivo, {'wght': 800, 'wdth': 125})


def outline(font, text):
    """One SVG path for a run of text, baseline at y=0, y pointing down."""
    gs, cmap = font.getGlyphSet(), font.getBestCmap()
    pen = SVGPathPen(gs, lambda v: ('%.1f' % v).rstrip('0').rstrip('.'))
    x = 0
    for ch in text:
        g = cmap[ord(ch)]
        gs[g].draw(TransformPen(pen, (1, 0, 0, -1, x, 0)))
        x += gs[g].width
    return pen.getCommands(), x


title, advance = outline(archivo, TITLE)
bounds = BoundsPen(None)
parse_path(title, bounds)
x0, _, x1, _ = bounds.bounds  # ink extent, used to align the title with the QR code's edges

# Date digits: IBM Plex Mono Bold, one path per character (all share one advance width).
mono = TTFont(os.path.join(FONTS, '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-700-normal.woff2'))
mgs, mcmap = mono.getGlyphSet(), mono.getBestCmap()
digits = {}
for ch in DATE_CHARS:
    pen = SVGPathPen(mgs, lambda v: '%.0f' % v)
    mgs[mcmap[ord(ch)]].draw(TransformPen(pen, (1, 0, 0, -1, 0, 0)))
    digits[ch] = pen.getCommands()

out = {
    'title': {'d': title, 'w': advance, 'upm': archivo['head'].unitsPerEm, 'cap': archivo['OS/2'].sCapHeight,
              'x0': round(x0, 1), 'x1': round(x1, 1)},
    'mono': {'upm': mono['head'].unitsPerEm, 'adv': mgs[mcmap[ord('0')]].width, 'cap': mono['OS/2'].sCapHeight, 'g': digits},
}
path = os.path.join(ROOT, 'src', 'glyphs.json')
with open(path, 'w') as f:
    f.write(json.dumps(out, separators=(',', ':')))
print('wrote', os.path.relpath(path, ROOT))
