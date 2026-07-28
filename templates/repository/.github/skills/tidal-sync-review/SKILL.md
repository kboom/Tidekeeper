---
name: tidal-sync-review
description: Use when reviewing pending Tidekeeper synchronization, refreshing a local TIDAL snapshot, identifying remote removals, or preparing a human-approved push.
---

# TIDAL Sync Review

Prepare a safe synchronization review without applying a remote mutation.

## When to Use

- The user asks whether local changes are ready to synchronize.
- The user wants to refresh their TIDAL library or inspect pending operations.
- A plan reports removals, unavailable tracks, or a conflict.

## Process

1. Read `.github/tidekeeper-cli.md`, verify the repository, and inspect Git
   status.
2. For a refresh, require a clean worktree before applying a pull.
3. Generate the sync plan and summarize its digest, operations, removals, and
   blocked risks.
4. Give the exact human-run push command only after the user has reviewed it.

## Rules

- Never run `sync push --apply`.
- Never bypass dirty-worktree, removal, journal, or concurrency guards.
- Stop after the reviewed plan; human approval is required for every push.
