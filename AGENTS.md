# AGENTS.md

This repository contains the packaging and colocated YARF UI tests for
the **gemini-desktop** application.

## Tests

YARF UI test suites belong under `tests/suite/` in this repository.

## Conventions

- Do not remove the `tests/suite/` directory.
- Releases are automated via Release Please (`.github/workflows/release.yml`);
  `.deb` and `.snap` packages are built and attached to GitHub Releases.
  Nothing is published to the Snap Store.
