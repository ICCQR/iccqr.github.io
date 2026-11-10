# ICCQR

**https://iccqr.github.io/**

Turn your display's ICC profile into a printable QR code, a *calibration marker*, and stick it on the display it belongs to. Scan it with a phone to open a link that rebuilds the `.icc` file, ready to install on the computer the display is connected to.

When you recalibrate, print a new marker and stick it on top of the old one. The newest calibration is always the one you can scan.

Everything runs in the browser. Profiles are never uploaded, and the calibration data sits after the `#` in the link, which browsers don't send to the server.

This repository is the website. Markers are made and read by the [iccqr](https://github.com/iccqr/iccqr) package, which also has a command-line tool:

```sh
npx iccqr make studio.icc --note "Brightness 35 · Contrast 75"
```

## Rebuilding the site

`index.html` is generated. Edit the files in `src/`, then rebuild:

```sh
npm ci          # installs the exact versions in package-lock.json
npm run build   # writes index.html
```

Needs Node.js 20.12 or newer. Commit `index.html` together with the source change; the GitHub Action fails if they don't match.

To move to a new release of the iccqr package:

```sh
npm install --save-exact iccqr@<version>
npm run build
```

Commit `package.json`, `package-lock.json` and `index.html` together.

## How it works

See [docs/Architecture.md](docs/Architecture.md) for the site, and the package's [FORMAT.md](https://github.com/iccqr/iccqr/blob/main/FORMAT.md) for the marker format.

## Licenses

The site bundles the iccqr package (0BSD), which includes qrcode-generator by Kazuhiko Arase (MIT), and the Archivo, IBM Plex Sans and IBM Plex Mono fonts (SIL Open Font License 1.1, texts in `fonts/`). Font placeholders are made with [Invisible Ink](https://github.com/Y2Z/invisible-ink).
