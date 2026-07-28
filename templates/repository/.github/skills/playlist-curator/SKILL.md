---
name: playlist-curator
description: Use when creating, renaming, reorganizing, splitting, merging, or deleting local TIDAL playlists while preserving a reviewable Git history.
---

# Playlist Curator

Curate local playlists through Tidekeeper's typed local-edit commands.

## When to Use

- The user asks to create, rename, reorder, split, merge, or remove playlists.
- The user asks to organize existing music around a mood, activity, or rule.

Do not use this skill for remote application.

## Process

1. Read `music-preferences.md` and `.github/tidekeeper-cli.md`.
2. Follow its hierarchical help discovery before making the smallest coherent
   typed local edit.
3. Follow its validation, diff review, and local-commit sequence if requested.
4. Produce a sync plan and summarize its effects.

## Rules

- Preserve IDs and order unless the requested change needs them altered.
- Do not hand-edit YAML or bypass unavailable-track protections.
- Never run a TIDAL push apply command; stop after presenting the plan.
