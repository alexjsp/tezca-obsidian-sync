# End-to-end tests in real Obsidian

These drive real Obsidian windows with the plugin installed, syncing through a real Tezca server.
They are slow-ish (a couple of minutes for everything) and open windows on your screen, so they
aren't part of `just test`. Run them when a change needs deeper testing:

```sh
just e2e            # everything
just e2e core       # only specs/*core*.e2e.ts
```

`just e2e` builds the plugin first; the spec builds the Go server (`sim/.runs/tezca-server-e2e`).
The first run downloads Obsidian into `e2e/.obsidian-cache` (via
[wdio-obsidian-service](https://github.com/jesse-r-s-hines/wdio-obsidian-service)). Your own
Obsidian, vaults and settings are never touched: every instance gets a fresh copy of
`vaults/empty` and its own app data folder.

## What's covered

| Spec | Instances | Covers |
| --- | --- | --- |
| `core` | mac, phone (mobile emulation) | setup through the settings UI (claim, pair), live typing both ways, simultaneous typing, opening a note made elsewhere (frozen-sidebar regression), fast note switching (overwrite regression), file/folder create/rename/move/delete, attachments rendering, offline edits and renames, same-line conflicts, server restart, app restart |
| `edge-cases` | mac, phone | status bar states, named remote cursors, one note in split panes, case-only renames, extension changes, hidden folders and trash, the size limit, offline edits racing a remote rename or delete, the safety brake and both ways out of it |
| `setup` | mac, new-laptop, other-vault | restoring from the recovery phrase, a second synced vault for the same person, disconnecting |
| `shares` | alice, alice-laptop, bob (mobile) | share from the folder menu, join by invite, live edits and presence avatars, viewer role (read-only editor, outside changes put back), role changes while a note is open, leave, rejoin, remove a member |
| `shares-more` | alice, alice-laptop, bob | revoked and view-only invites, promoting to owner, Recently deleted in a share, moving the shared folder, moving a file out of it, deleting it on one person's devices |
| `guests` | alice, carol (mobile, no setup), dave (own host) | joining as a guest, guest storage quota, joining across hosts |
| `history` | mac, phone | note version restore (with diff), attachment version restore (with preview), Recently deleted |
| `canvas-config` | mac, laptop, phone | Canvas cards edited in the Canvas UI on two devices, new and moved cards, connection labels; settings sync (core settings, a core plugin's settings, snippets, hotkeys), opt-in per device, community plugins (install, settings, disable), Tezca's own settings never syncing |

## When something fails

Each failing test saves, for every open Obsidian, a screenshot (plus one per extra window, e.g.
Settings), the console log including every notice shown, and the sync status, under
`e2e/.logs/<test name>/`.

Useful environment variables:

- `E2E_VERBOSE=1` shows the server's output.
- `E2E_DEBUG=1` turns on the plugin's debug logging in the canvas spec.
- `E2E_KNOWN_ISSUES=1` also runs tests for known, unfixed issues (see `docs/plan.md`).
- `OBSIDIAN_VERSION=1.8.10` tests another Obsidian version (default: latest).

## Writing tests

- `support/device.ts` wraps one Obsidian instance: `exec` runs code inside Obsidian
  (`plugins.tezcaSync` is the plugin), and the UI helpers (`openSettings`, `modal`, `clickButton`,
  `contextMenu`, `type`, …) work across Obsidian's windows (Settings opens in its own window
  since 1.15).
- `support/flows.ts` has the setup flows (claim, pair, invite) through the real UI.
- `support/vault.ts` compares vaults on disk (`waitConverged`).
- Prefer the UI for anything the plugin itself shows (settings, modals, menus, editors), and
  Obsidian's API for plain file operations (that's what the UI calls too).
- Tests in a spec run in order and build on each other, like a person's day with the app.
