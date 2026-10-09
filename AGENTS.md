# Repository rules

This repository maintains a public fork of Fingerprint Lock. Read
`CONTRIBUTING.md` before making or preparing changes.

- Preserve existing work and keep changes scoped to the requested task.
- Commit source, tests, public documentation, dependency manifests/lockfiles,
  and build/CI tooling. Never commit vault notes, user settings (`data.json`),
  credentials, private keys, local paths/logs, native helper binaries, or local
  editor/agent state. `.gitignore` does not protect already tracked files.
- Keep the upstream MIT license and attribution. Describe this fork accurately;
  do not imply that the upstream community listing installs this fork.
- `styles.css` is source. Root `main.js` and the three files in
  `plugins/fingerprint-lock/` are intentional distribution artifacts. Update
  them with `npm run build`; never hand-edit the generated JavaScript or copies.
  Do not commit development bundles containing inline source maps.
- Before handoff, run `npm run check:repo`. For runtime changes also run
  `npm test` and `npm run build`. Report automated checks separately from actual
  Obsidian, native biometric, and mobile verification.
- Desktop-only remains the supported scope until mobile code is implemented
  and verified. Do not enable mobile by changing only the manifest.
- Never commit, push, tag, publish a release, or open an upstream PR unless the
  user requests it. Review staged files explicitly before an authorized commit.
