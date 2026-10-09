# Contributing to this fork

This is the independently maintained `danbrag/obsidian-fingerprint` fork of
Alex Paz's Fingerprint Lock. Preserve the MIT license and original attribution.
The upstream community-plugin listing and upstream releases distribute the
upstream plugin; use this repository's build instructions for this fork.

## What belongs in Git

Commit TypeScript and native helper **sources**, CSS, tests, public project
documentation, dependency manifests and `package-lock.json`, build scripts,
and GitHub workflows. Public review notes may describe architecture and
validation, but must not contain personal vault data or private diagnostics.

This repository intentionally also tracks root `main.js` and the ready-to-copy
package's `main.js`, `manifest.json`, and `styles.css`. Run `npm run build` to
refresh them together. Root `styles.css` and `manifest.json` are source files.
Production bundles must not contain development source maps. Other generated
outputs and installed dependencies do not belong in Git.

Never commit real vaults/notes, `.obsidian/`, `data.json` (including password
verifiers and security-key registrations), environment secrets, signing keys,
compiled native helpers, logs, screenshots of private notes, machine-specific
paths, or local editor/agent state. Use synthetic data in tests and examples.
The `.env.example` ignore-rule exception is for documented placeholder values only.

## Checks before a commit

```bash
npm ci
npm test
npm run build
npm run check:repo
git diff --check
```

`check:repo` checks tracked and non-ignored untracked files for forbidden paths
and common credential formats, then verifies distribution file parity and the
absence of source maps in the bundles. It is a guardrail, not a complete secret
scanner. Review the diff yourself, including generated files, filenames, public
documentation, and any new dependency. Ignoring a file does not untrack it and
does not remove it from Git history. If credentials were committed, rotate them
and coordinate any history cleanup separately.

An optional local pre-commit hook checks the actual staged file contents:

```bash
git config --local core.hooksPath .githooks
```

Enable it explicitly for your checkout; it is not installed automatically.
When committing, stage specific paths, inspect `git diff --cached`, and run
`npm run check:staged`. Keep unrelated local work out of the commit.
CI runs the same repository checks, tests, and production build on pushes and
pull requests. Release tags also run these checks before publishing assets.

## Platform and release scope

The plugin is desktop-only. Changing `isDesktopOnly` alone cannot provide
mobile support: desktop Node imports and native helper authentication need an
appropriate implementation for mobile first. Automated tests establish mocked
state behavior; real Obsidian and native biometric behavior require separate
verification.

Changing the plugin ID, branding, versions, community listing, or release
process is a deliberate maintenance decision. Keep the existing ID for manual
updates until a migration is planned. The release workflow publishes when a
matching version tag is pushed; push a tag only when a release is intended.
