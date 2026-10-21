# About


Unofficial wrapper for Google's Gemini, providing a native Linux desktop experince.

## Key Features

- **Full HTML artifact preview** — When Gemini generates a complete HTML
  document, the app merges the response's HTML, CSS and JavaScript code blocks
  into a single page and renders it live in a sandboxed iframe directly inside
  the conversation. A *Rendered | Source* toggle switches to a syntax-highlighted
  source view, and a fullscreen button expands the preview to the whole window
  (`Esc` exits). The preview updates as the response streams, auto-resizes with
  its content (capped at 75% of the window height — taller artifacts scroll
  inside the preview instead of pushing the chat away), and follows Gemini's
  light/dark theme. Answers that merely show code snippets (fragments that are
  not full HTML documents) keep their normal code blocks.
- **Find in conversation** — `Ctrl+F` opens a custom find bar with a live match
  counter, match-case toggle and next/previous navigation (`Enter`/`Shift+Enter`,
  `F3`, `Ctrl+G`/`Ctrl+Shift+G`). Highlights keep up with streaming replies and
  infinite scroll, and `Esc` closes the bar.
- **System tray integration** — closing the window keeps Gemini running in the
  background. The tray menu provides Show/Hide, an Autostart toggle (launch at
  login), About and Quit. Starting with `--tray` launches straight to the tray.
- **Offline page** — when the connection drops or the app fails to load, a
  dedicated offline page is shown with a Retry button instead of a browser
  error.
- **Safe link handling** — only `gemini.google.com` and `accounts.google.com`
  may navigate inside the app; every other link opens in your default browser,
  and unsafe protocols (`javascript:`, `data:`, …) are blocked.
- **Single instance** — launching the app again focuses the existing window
  instead of opening a second one.
- **Keyboard shortcuts** — `Ctrl+R` reloads the app, `Ctrl+F` opens find, and
  `F3`/`Ctrl+G` step through matches.

## Disclaimer

This project and its contributors are not affiliated with Google. This is simply an Electron wrapper that loads the offical Google Gemini web application.

# Installation

Download the latest `.deb` or `.snap` package from the
[GitHub Releases](https://github.com/saptarshimondal/gemini-desktop/releases) page.

Both `amd64` and `arm64` `.deb` packages are provided. `.snap` packages are
currently published for `amd64` only — `arm64` users should install the `.deb`.

### Debian / Ubuntu

```bash
sudo apt install ./gemini-desktop_*_amd64.deb
```

### Snap

```bash
sudo snap install --dangerous gemini-desktop_*_amd64.snap
```

## Requirements

You will need to install [npm](https://www.npmjs.com/), the Node.js package manager. On most distributions, the package is simply called `npm`.

## Cloning the source code

Once you have npm, clone the wrapper to a convenient location:

```bash
git clone https://github.com/saptarshimondal/gemini-desktop.git
```

## Building

```bash
npm install
npm start
```

On subsequent runs, `npm start` will be all that's required.

## Building packages

You can build packages locally using the following commands:

```bash
# Build Debian package
npm run build:deb

# Build Snap package
npm run build:snap

# Build both Debian and Snap packages
npm run build:all
```

Packages are written to the `dist/` directory.

The application icons live in `assets/icons/`. If you change `icon.png`, regenerate
the multi-resolution icon set (requires `python3` with `Pillow`):

```bash
npm run generate:icons
```

## Updating the source code

Simply pull the latest version of main and install any changed dependencies:

```bash
git checkout main
git pull
npm install
```
