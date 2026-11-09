# ICCQR

**https://iccqr.github.io/**

Turn your display's ICC profile into a printable QR code, a *calibration marker*, and stick it on the display it belongs to. Scan it with a phone to open a link that rebuilds the `.icc` file, ready to install on the computer the display is connected to.

When you recalibrate, print a new marker and stick it on top of the old one. The newest calibration is always the one you can scan.

Everything runs in the browser. Profiles are never uploaded, and the calibration data sits after the `#` in the link, which browsers don't send to the server.

## Rebuilding the site

`index.html` is generated. Edit the files in `src/`, then rebuild:

```sh
npm ci          # installs the exact versions in package-lock.json
npm run build   # writes index.html
npm test        # checks the codec, that old markers still decode, and fuzzes the decoders
```

Needs Node.js 20.12 or newer. Commit `index.html` together with the source change; the GitHub Action fails if they don't match.

The marker title and date digits are pre-drawn outlines in `src/glyphs.json`. To change the title text or its fonts, regenerate them (needs Python 3):

```sh
pip install fonttools brotli
python3 scripts/glyphs.py
npm run build
```

## Testing with your own profiles

Put `.icc` or `.icm` files in `test/profiles/` and run `npm test`. Each one is encoded, decoded, rebuilt and checked, and the fuzz test uses them as seeds for damaged files.

The fuzz test is reproducible. To run it longer or with another seed:

```sh
FUZZ_SEED=42 FUZZ_RUNS=5000 node --test test/fuzz.test.js
```

## How it works

See [docs/Architecture.md](docs/Architecture.md) for the marker format, the build, and the rules that keep printed markers working.

## Licenses

ICCQR's own code is yours to license. It bundles qrcode-generator by Kazuhiko Arase (MIT) and the Archivo, IBM Plex Sans and IBM Plex Mono fonts (SIL Open Font License 1.1, texts in `fonts/`). Font placeholders are made with [Invisible Ink](https://github.com/Y2Z/invisible-ink).
