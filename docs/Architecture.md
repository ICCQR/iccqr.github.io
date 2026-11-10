# ICCQR site architecture

`https://iccqr.github.io/` turns a display's ICC profile into a printed QR code (a *calibration marker*) that lives on the display itself. Scanning the marker opens this site with the calibration encoded in the link, and the page rebuilds a working `.icc` file from it.

The site is one static page. There is no server-side code and nothing is uploaded: the profile is read in the browser, and the calibration data sits after the `#` in the link, which browsers never send to the server.

Everything about profiles and markers lives in the [iccqr](https://github.com/iccqr/iccqr) package: reading profiles, the marker format, drawing the marker SVG, and rebuilding the `.icc` file. Its [FORMAT.md](https://github.com/iccqr/iccqr/blob/main/FORMAT.md) is the reference for the marker format. This repository holds the page around it: markup, styles, fonts, icons and the user interface.

```
 .icc file ──▶ ICCQR.makeMarker() ──▶ link + SVG ──▶ printed marker
                                                         │ scan
 Save .icc ◀── ICCQR.readMarker() ◀── https://iccqr.github.io/#<payload> ◀──┘
```

## Repository layout

| Path | What it is |
|---|---|
| `index.html` | The built site. GitHub Pages serves it. **Generated: do not edit by hand.** |
| `fonts/` | The web fonts (WOFF2, Latin subset, from Fontsource 5.3.0) and their SIL Open Font License texts. Served with the site, and read by the build. |
| `src/page.html` | Markup and CSS, with placeholders the build fills in. |
| `src/app.js` | The user interface: the marker maker, the decoder view, and the charts. |
| `src/icons/` | Favicon (32 px) and home-screen icon (180 px), made from the organization logo. |
| `scripts/build.js` | Assembles `index.html` from the files above and the iccqr package. |
| `.github/workflows/build.yml` | Checks on every push and pull request that `index.html` matches the source. |

## Build

`scripts/build.js` reads `src/page.html` and fills in its placeholders:

1. **Fonts.** The `<style>` block goes through the [Invisible Ink](https://github.com/Y2Z/invisible-ink) PostCSS plugin. Each `@font-face` marked `invisible-ink: hollow` gets a companion `"<Family> Placeholder"` face with an invisible, metric-identical copy of the font inlined as a data URL, and the plugin adds that family after the real one in every `font-family` and `--font-*` custom property. Text is laid out with the real font's metrics from the first frame, so nothing moves when the real font arrives. The stylesheet is processed as if it were at the repo root, so `url("fonts/…")` points at `./fonts`, the same files the site serves.
2. **Icons.** `/*ICON:<file>*/` markers become the base64 contents of `src/icons/<file>`.
3. **Scripts.** `/*ICCQR*/` becomes the package's browser bundle, `node_modules/iccqr/dist/iccqr.min.js`, which defines the `ICCQR` global. `/*APP*/` becomes `src/app.js`.

The package is pinned to an exact version, and the bundle is inlined rather than loaded from a CDN. The page keeps working from a saved copy, and nothing outside this repository can break printed markers. All dependency versions are pinned in `package.json` and `package-lock.json`, so the build reproduces `index.html` byte for byte. The Action checks this.

## The page

`src/app.js` shows one of two views, chosen at load:

- **Decoder**, when the link has a fragment matching `^[A-Za-z2-7]{8,}$` that `ICCQR.readMarker()` accepts. It shows the date, name and note, and offers *Save .icc file*, *Share file…* (Web Share with files, where the browser supports it) and *Copy link*. The install steps for Windows, macOS and Linux include the video card notes only when the profile has a `vcgt`.
- **Maker** otherwise. It opens with a built-in example profile (`ICCQR.exampleICC()`, labeled "not yours") so the page shows a real marker before a file is chosen. A chosen file never leaves the browser. Every change to the form calls `ICCQR.makeMarker()` again. Its result feeds the marker preview, the readouts (printed size, data size, match to file) and *Download SVG*. Its error messages are shown as they are.

**Decoder address.** Markers link to the address the page is served from. A copy opened from disk links to `https://iccqr.github.io/`. Both can be overridden under *Encoding and link*, and the override is remembered in `localStorage` (`iccqr.base`).

**Readouts.** The table under the charts is `ICCQR.summarize()` plus a row or two about the file itself.

**Charts.** The gamut chart draws the CIE 1931 spectral locus (400–700 nm, 5 nm steps) as a Catmull-Rom spline closed by the line of purples, with the display's primaries and white point and sRGB for reference. Chromaticities come from `ICCQR.chromaticities()`. The video card chart plots each channel's correction as output minus input, in 8-bit steps.

## Rules for changing things

- **Never change the decoder address.** It is printed on every marker. If hosting ever moves, keep `iccqr.github.io` serving a copy of the decoder, or redirect it.
- **Change marker behavior in the iccqr package**, release it, then move this site to the new version. The page should only call the package.
- **Edit `src/`, then run `npm run build`** and commit `index.html` with the source change, so the two never drift apart.

## Third-party code and fonts

| Component | License | Where |
|---|---|---|
| iccqr | 0BSD | inlined in `index.html`; includes qrcode-generator 1.4.4 (MIT) |
| Archivo, IBM Plex Sans, IBM Plex Mono (via Fontsource 5.3.0) | SIL OFL 1.1 | `fonts/`, license texts alongside |
| Invisible Ink 2.0.1, PostCSS 8.5.9 | CC0, MIT | build only; Invisible Ink's placeholders are inlined |

## Known issues

- iPhone Safari once showed a black rectangle over the start of the heading, with an earlier hand-made version of the font placeholders. If it reappears, check whether the page looks right with the placeholder families removed. Both variable fonts (Archivo, IBM Plex Sans) get variable placeholders, and Invisible Ink has so far been tested only in Chromium.
