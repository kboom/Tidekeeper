# Tidekeeper

Tidekeeper is an agent-friendly CLI for TIDAL. It exports owned playlists and
favorite tracks as deterministic YAML, applies reviewed YAML changes back to
TIDAL, and prints complete track-search results.

Tidekeeper synchronizes library metadata. It does not download audio files.

## Requirements

- Node.js 22.13 or newer
- Git
- A registered application from the
  [TIDAL Developer Portal](https://developer.tidal.com/)
- A TIDAL redirect URI registered as
  `http://127.0.0.1:53682/callback`, or another explicit HTTP loopback URI

## Install

From this repository:

```console
npm ci
npm run check
npm link
tidekeeper --help
```

The npm package contains the compiled CLI, README, and license only. The package
smoke test verifies the executable, help output, and initialization flow.

## Configure authentication

Tidekeeper reads application configuration from environment variables:

| Variable              | Required | Default                           | Purpose                                                     |
| --------------------- | -------- | --------------------------------- | ----------------------------------------------------------- |
| `TIDAL_CLIENT_ID`     | Yes      | -                                 | TIDAL developer application client ID                       |
| `TIDAL_CLIENT_SECRET` | No       | -                                 | Client secret when required by the registered application   |
| `TIDAL_REDIRECT_URI`  | No       | `http://127.0.0.1:53682/callback` | Registered OAuth loopback callback                          |
| `TIDAL_SCOPES`        | No       | Enabled TIDAL user scopes         | Comma- or space-separated OAuth scopes to override defaults |

PowerShell example:

```powershell
$env:TIDAL_CLIENT_ID = '<client-id>'
$env:TIDAL_CLIENT_SECRET = '<client-secret>'
tidekeeper auth login
tidekeeper --output json auth status
```

`auth login` opens the system browser and uses OAuth authorization code with
PKCE and state validation. Session credentials are stored in the operating
system credential manager under the `Tidekeeper` service. They are never written
to the repository.

## Initialize and pull

```console
mkdir my-tidal-library
cd my-tidal-library
git init
tidekeeper init --country-code US
git add tidekeeper.yaml library
git commit -m "Initialize Tidekeeper library"
tidekeeper sync pull --output json
tidekeeper sync pull --apply
git add tidekeeper.yaml library
git commit -m "Import TIDAL library"
```

Commit the initialized skeleton before the first pull so the clean-worktree guard
has a baseline. The initial pull command is a preview. `--apply` is required to write files.
Applying a pull refuses to overwrite dirty managed files unless `--force` is
also supplied.

The managed repository layout is:

```text
tidekeeper.yaml
library/
  favorites.yaml
  playlists/
    <slug>--<tidal-id-or-local-id>.yaml
.tidekeeper/
  journal/
```

Commit `tidekeeper.yaml` and `library/**`. Do not commit `.tidekeeper/**`.

## Search tracks

```console
tidekeeper search tracks "kind of blue"
tidekeeper --output json search tracks "kind of blue"
tidekeeper --output jsonl search tracks "kind of blue"
tidekeeper search tracks "kind of blue" --limit 25
tidekeeper search tracks "kind of blue" --country-code US --explicit-filter exclude
```

Search follows TIDAL cursor pagination to exhaustion unless `--limit` is
specified. Results are bulk-hydrated per page and retain TIDAL result order.
JSON Lines emits one track object per line and is the recommended format for
LLM agents processing large result sets.

## Edit and push

Track and playlist IDs are authoritative. Titles, artists, album names,
durations, explicit flags, and TIDAL URLs are readable annotations. Editing
only annotations does not create remote mutations.

If TIDAL lists a playlist item but withholds its catalog metadata in the
configured country, Tidekeeper preserves it as an explicitly marked unavailable
track. It blocks any track-list rewrite of that playlist, preventing a
destructive replacement from removing the unavailable item.

Create a playlist locally with a unique UUID in `localId`:

```yaml
description: Deep work
id: null
kind: playlist
localId: 8b32f860-e4e4-42aa-a9bb-90262f4fa98e
schemaVersion: 1
title: Focus
tracks:
  - artists:
      - Example Artist
    id: '123456789'
    title: Example Track
```

Review and apply:

```console
tidekeeper validate
tidekeeper --output json sync plan
tidekeeper --output json sync push
tidekeeper --output json sync push --apply
```

`sync push` is always a dry run without `--apply`. If the plan removes a
favorite, playlist, or existing playlist item, applying also requires
`--allow-removals`:

```console
tidekeeper --output json sync push --apply --allow-removals
```

Push requires clean managed files. `--allow-dirty` is available for advanced
automation, but committing the reviewed YAML first is safer. Tidekeeper fetches
TIDAL twice before the first mutation and aborts if the remote fingerprint
changes. Applying pulls and pushes use a per-library lock, so concurrent
commands cannot overwrite each other's local state.

## Interrupted push recovery

Every mutation is sent in chunks of at most 50 items with deterministic
idempotency keys. The journal records started and completed operation indexes,
created playlist IDs, and the finalization phase in
`.tidekeeper/journal/push.json`.

If a push exits with code 7:

1. Do not edit `tidekeeper.yaml` or `library/**`.
2. Re-run the same `sync push --apply` command, including
   `--allow-removals` when it was originally required.
3. Tidekeeper compares TIDAL with the original, completed, and safely partial
   operation states. It aborts on unrelated remote edits and otherwise safely
   repeats requests whose responses may have been lost.
4. After success, Tidekeeper refreshes the local snapshot and removes the
   journal.

An authentication failure keeps the journal; log in again and resume. A
conflict can mean the unchanged push is not resumable, such as when TIDAL no
longer recognizes a track. Follow the reported cause and reconcile the remote
state and local files before removing the journal. Do not delete a journal
merely to bypass recovery.

## Output and exit codes

Place the global `--output table|json|jsonl` and `--root <path>` options before
the command. Structured stdout contains data only; diagnostics go to stderr.
Object-shaped JSONL results are emitted as one record.

| Code | Meaning                                                  |
| ---: | -------------------------------------------------------- |
|    0 | Success                                                  |
|    1 | Unexpected internal failure                              |
|    2 | Invalid command usage                                    |
|    3 | Invalid configuration, YAML, or journal                  |
|    4 | Authentication failure                                   |
|    5 | Dirty files, unapproved removal, or concurrency conflict |
|    6 | Network or TIDAL service failure                         |
|    7 | Push may be partially applied; resume from the journal   |

## Commands

```text
tidekeeper auth login [--redirect-uri URI]
tidekeeper auth status
tidekeeper auth logout
tidekeeper search tracks <query> [--limit N] [--country-code CC]
tidekeeper sync pull [--apply] [--force]
tidekeeper sync plan
tidekeeper sync push [--apply] [--allow-removals] [--allow-dirty]
tidekeeper init [--country-code CC]
tidekeeper validate
```

Run `tidekeeper <command> --help` for command-specific options.

## Development

```console
npm ci
npm test
npm run test:coverage
npm run check
```

Tests use local HTTP servers and do not require TIDAL credentials. Live OAuth
and disposable-playlist verification require a developer application and are a
separate release check.
