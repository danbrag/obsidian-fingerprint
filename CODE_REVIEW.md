# Relock implementation review

Reviewed the completed feature at `df7d4db`. Improvements are on
the maintained `main` baseline, consolidated from `review/relock-architecture`.
The original feature and review branches remain available as historical references.

## Findings and fixes

| Priority | Finding in the previous implementation | Change |
| --- | --- | --- |
| P1 | A note authentication result could arrive after `relock()` and unlock the same surviving overlay again. Checking DOM connection was insufficient. | Note authentication captures a revision; navigation, relock, global lock, and clearing state invalidate pending results. |
| P1 | A vault authentication result could unlock a newer lock screen after the old one was hidden and replaced. | Each attempt captures the exact overlay and only applies to that overlay. |
| P2 | Native-dialog blur still invoked note relocking and global blur policy. Successful note authentication could also be discarded if renderer focus returned after the result. | One shared authentication guard suppresses dialog focus events. Background policy is reconciled on the next renderer turn without automatically retrying authentication. |
| P2 | Vault and note screens had independent busy flags, allowing overlapping provider requests. | The plugin serializes authentication across both screens and settings-based biometric testing/key registration. |
| P2 | A rejected provider/password promise could leave an unlock screen busy indefinitely. | Both UI owners handle exceptions and release busy state in `finally`. |
| P3 | Note unlocks and away timestamps were maintained in separate collections, with multiple synchronization passes. | One map stores each unlocked note and its optional away timestamp; one traversal expires entries and finds the next deadline. |
| P3 | Cleanup was duplicated, and delayed startup/authentication work could outlive plugin unload. | Cleanup lives in `onunload`; an unload guard prevents delayed work from reopening locks or applying results. Clearing note guards also revokes session unlocks. |

## Architecture decision

Keep the existing plugin, note guard, and vault lock screen. A whole rewrite
would add churn without improving the feature's scope. The plugin owns global
lock policy, return prompting, and authentication serialization. The note guard
owns note unlock state, its one deadline timer, and note overlays. The lock
screen owns the vault overlay and its validity checks. Authentication providers
and password formats are unchanged.

The deadline update is O(number of unlocked notes), with O(number of unlocked
notes) state and at most one pending note deadline timer. It no longer creates
an array and spreads all timestamps into `Math.min`. There are no new runtime
dependencies. Existing global-idle polling remains unchanged in frequency.

## Validation

`npm test` runs ten focused source-level regressions using Node's built-in test
runner, existing esbuild, a minimal Obsidian stub, and a fake clock. Six tests
failed against the previous implementation; all ten pass after the changes.
The production build (including TypeScript checking) and diff checks pass.

These checks establish state and callback behavior, not real native UI behavior.
Before adopting this branch, verify background lock → app return, cancellation,
manual unlock, per-note time away, and combined authentication in Obsidian.
In particular, check Touch ID focus restoration on the actual machine.

## Remaining scope limits

- Focus handling follows the main Obsidian window; independent pop-out windows
  remain outside the current implementation's scope.
- Note unlock state is shared by path across panes. Per-note time away follows
  the active note rather than whether the note is visible in another pane.
- If the user switches apps while authentication is already pending, lock policy
  is resumed afterward, but an automatic retry is suppressed. Use Unlock to retry.
- Files remain plaintext. This review does not claim encryption or a security
  boundary against plugins, file access, search, or previews.

## Password preference follow-up

The shared unlock-method selector now supports password as the primary method
for both vault and note locks, reusing the saved backup password. The test set
now contains twelve regressions, including password-first return behavior,
incorrect/correct passwords, combined unlock, and switching back to fingerprint.

## Touch ID focus restoration follow-up

The zero-delay focus reconciliation could run before macOS returned focus from
Touch ID and immediately relock a successfully unlocked note. Authentication now
allows one second for focus restoration, suppresses late dialog blur events, and
cancels reconciliation on focus return or a new authentication attempt. If the
app stays in the background, relocking still resumes without an automatic retry,
including when the global blur timer locks the vault. The fifteen regressions
cover delayed focus return, late blur, sustained background state, overlapping
reconciliation timers, and unload cleanup. Native Touch ID acceptance still
requires testing in Obsidian on the user's Mac.

## Startup note concealment follow-up

The stylesheet now hides markdown view content until NoteGuard explicitly marks
it visible. Startup enables this concealment before awaiting settings and
classifies existing views before layout readiness or native-helper setup.
Missing metadata gets a provisional cover without unlock controls, then metadata
change/resolution events replace it with either the normal lock card or visible
ordinary content. Disabling/unloading removes concealment; a settings-load
failure also releases the provisional startup state. Nineteen state regressions
pass, including delayed metadata and pre-layout startup. Actual cold-launch
paint timing still needs checking in Obsidian; no plugin can hide rendering that
precedes its stylesheet loading.
