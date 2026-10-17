# About


Unofficial wrapper for Google's Gemini, providing a native Linux desktop experince.

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

## Updating the source code

Simply pull the latest version of main and install any changed dependencies:

```bash
git checkout main
git pull
npm install
```
