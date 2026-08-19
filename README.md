# Tidekeeper

Tidekeeper is an agent-friendly CLI for TIDAL. It exports owned playlists and
favorite tracks as deterministic YAML, applies reviewed YAML changes back to
TIDAL, and prints complete track-search results.

Tidekeeper synchronizes library metadata. It does not download audio files.

## Requirements

- Node.js 22.13 or newer
- Git
- GitHub CLI (`gh`), authenticated to `github.com`, for automatic repository publishing
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

## Create an agent-ready music repository

`repo create` builds a new Git repository from an embedded, versioned template,
imports the authenticated TIDAL snapshot, makes two reviewable commits, and
publishes them to a private `Tidal` repository under the active personal GitHub
account. The first commit contains the agent guidance and empty library skeleton;
the second contains the imported favorites and playlists. It never mutates TIDAL.

```console
tidekeeper repo create X:\Tidal --country-code US
```

Override the GitHub repository name or visibility, or keep the repository local:

```console
tidekeeper repo create X:\Tidal --country-code US --github-repo MyMusic
tidekeeper repo create X:\Tidal --country-code US --github-visibility public
tidekeeper repo create X:\Tidal --country-code US --no-github
```

When Git identity is not configured globally, provide it only for the generated
repository:

```console
tidekeeper repo create X:\Tidal --country-code US `
  --git-name "Your Name" --git-email you@example.com
```

On a Windows machine where the credential manager is unavailable, use
`--ephemeral-session`. This opens OAuth normally but keeps the resulting
credentials only in process memory for the duration of repository creation:

```console
tidekeeper repo create X:\Tidal --country-code US --ephemeral-session
```

The destination must not already exist. Creation uses a sibling staging
directory and makes it visible only after the import, validation, and both
commits succeed. GitHub publishing starts afterward, so a GitHub failure never
deletes completed local work. Resume an interrupted create/push safely with:

```console
tidekeeper --root X:\Tidal repo publish
```

Publishing reuses an empty matching personal repository, validates an existing
`origin`, and refuses to attach an unrelated or non-empty repository.

The generated repository includes:

```text
.github/copilot-instructions.md
.github/skills/
  music-library-audit/
  music-profile/
  playlist-curator/
  music-discovery/
  tidal-sync-review/
.github/workflows/validate-music-library.yml
.tidekeeper-template.json
music-preferences.md
```

`music-preferences.md` is user-owned guidance for agents. The generated Copilot
instructions and skills may inspect, validate, edit, and commit local YAML, but
they must never run `sync push --apply`. They provide a reviewed plan and exact
human-run command instead. `repo verify` validates the local data, Git worktree,
template ownership hashes, required skill files, and secret/state ignore rules.
`repo upgrade` updates only unmodified generated files and preserves music data
and preferences.

Until Tidekeeper is published to the configured npm registry, generated
repositories attach to the local Tidekeeper build that created them. Their
`npm run tidekeeper -- ...`, `npm run verify`, and `npm run sync:plan` commands
therefore work immediately in a new Copilot session on the same machine without
an npm install. If the local source checkout moves or the repository is cloned
to another machine, run `tidekeeper --root <music-repository> repo upgrade` from
an available Tidekeeper source checkout to attach its local runtime.

```console
cd X:\Tidal
tidekeeper --output json repo verify
tidekeeper --output json repo upgrade
```

## Agent-safe local edits

Agents and automation should use typed local commands rather than hand-writing
the YAML schema. Every mutation holds the normal per-library lock, loads the
complete validated snapshot, atomically replaces it, and returns a fingerprint.
Track batches are JSON files, which avoids interpolating music metadata through
shell arguments.

```console
tidekeeper --output json library summary
tidekeeper --output json library playlist create "Deep Focus" --description "No vocals"
tidekeeper --output json library playlist update <playlist-id> --title "Focus"
tidekeeper --output json library playlist set-tracks <playlist-id> --tracks-file tracks.json
tidekeeper --output json library playlist delete <playlist-id>
tidekeeper --output json library favorites add --tracks-file tracks.json
tidekeeper --output json library favorites remove <track-id> [<track-id>...]
```

The tracks file is a JSON array of Tidekeeper track objects, for example:

```json
[
  {
    "artists": ["Example Artist"],
    "id": "123456789",
    "title": "Example Track"
  }
]
```

Local edits do not contact TIDAL. Use `sync plan` afterward, then commit the
reviewed diff. A playlist containing an unavailable track cannot be rewritten,
which prevents a later remote replacement from dropping that item.

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

## Inspect and expand track candidates

Track files are JSON arrays using the same objects returned by structured
search. Exact quality inspection first filters candidates by TIDAL media tag,
then reads bit depth and sample rate from the in-memory DASH manifest without
downloading audio:

```console
tidekeeper --output json tracks inspect --tracks-file tracks.json
tidekeeper --output json tracks inspect --tracks-file tracks.json \
  --media-tag HIRES_LOSSLESS --min-bit-depth 24 --min-sample-rate 80000
```

Qualified tracks include an optional `audio` block containing media tags,
format, bit depth, and sample rate. Rejections distinguish unavailable tracks,
missing media tags, insufficient exact quality, and inspection failures.

Use related-track discovery to expand seed tracks through their albums or
artists before inspecting the resulting candidates:

```console
tidekeeper --output json tracks related --tracks-file seeds.json --by album
tidekeeper --output json tracks related --tracks-file seeds.json --by artist \
  --limit-per-source 50
```

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
tidekeeper tracks inspect --tracks-file FILE [--media-tag TAG] [--min-bit-depth N] [--min-sample-rate N]
tidekeeper tracks related --tracks-file FILE --by <album|artist> [--limit-per-source N]
tidekeeper sync pull [--apply] [--force]
tidekeeper sync plan
tidekeeper sync push [--apply] [--allow-removals] [--allow-dirty]
tidekeeper init [--country-code CC]
tidekeeper validate
tidekeeper repo create <directory> --country-code CC
tidekeeper repo verify
tidekeeper repo upgrade
tidekeeper library summary
tidekeeper library playlist <create|update|set-tracks|delete>
tidekeeper library favorites <add|remove>
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
