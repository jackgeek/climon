# Lossless Config Round-Trip Design

## Problem

`loadConfig()` currently constructs a new `ClimonConfig` from a fixed subset of
sections. When the server changes `server.host` and calls `saveConfig()`, every
section omitted by that reconstruction is removed from `config.jsonc`.

This deletes `install.id` on every server startup. The remotes startup path then
generates a new install ID, derives a different ingest tunnel ID, and creates a
new dev tunnel. The same behavior can silently remove other registered sections
and any future or externally owned keys.

## Goals

- Preserve every parsed top-level and nested config key through load/save.
- Keep the existing defaults and normalization for known runtime settings.
- Preserve unrelated changes made after a caller loaded its config.
- Keep explicit deletion possible.
- Add a regression test for stable `install.id` and ingest tunnel derivation.
- Establish tests that prevent future config sections from being silently lost.

## Non-Goals

- Replacing the config registry or JSONC renderer.
- Adding cross-process config locking.
- Changing config precedence, validation, comments, or ordering.
- Preserving original user-authored JSONC comments or formatting.

## Design

### Lossless loading

After parsing the global config, `loadConfig()` will use the complete parsed
object as the base of the returned config. It will overlay the normalized known
sections it already constructs:

- `version`
- `server`
- `terminal`
- `attention`
- `remote`
- `session`
- `feature`
- `hotKeys`

All other parsed sections and keys remain present. Known sections retain their
current defaulting and validation behavior. Unknown nested fields inside known
sections are preserved because normalized known values are merged with the
parsed section rather than replacing unrelated fields.

### Golden snapshots

`loadConfig()` will register a deep-cloned golden snapshot of the loaded config
in a module-private `WeakMap`, keyed by the returned config object. The snapshot
is process-local metadata and is not serialized.

Using a `WeakMap` avoids adding internal properties to `ClimonConfig` and lets
the snapshot be collected with the loaded object. Existing callers mutate and
save the same object returned by `loadConfig()`, so no public API shape changes
are required.

### Three-way saving

When `saveConfig()` receives an object registered by `loadConfig()`, it will:

1. Deep-diff the golden snapshot against the caller's current object.
2. Reload the latest complete config from disk without registering another
   caller-facing snapshot.
3. Apply only the caller's delta to that latest object.
4. Render and write the merged object.
5. Advance the caller's golden snapshot to a deep clone of its current
   in-memory state.

The deep delta supports additions, replacements, nested changes, and explicit
deletions. Arrays and primitive values are replaced as units. Object changes
recurse so unrelated nested keys remain untouched.

If two stale callers change different settings and save sequentially, both
changes survive. If they change the same setting, the later save wins.

The caller object is not mutated to include unrelated values discovered during
the merge. Advancing its golden snapshot from its own current state ensures a
later save does not mistake those absent concurrent values for caller-requested
deletions.

Objects not produced by `loadConfig()` have no golden snapshot and retain the
existing full-save behavior. This preserves initialization and migration
callers that intentionally provide a complete config.

No cross-process lock will be added. A small collision window remains if two
processes reload the same latest config and write simultaneously. The
three-way merge protects changes that completed before another save begins,
which covers the normal server/config-command overlap while avoiding a broader
locking mechanism.

### Data flow

1. Parse the complete JSONC object.
2. Validate the config version.
3. Start the loaded result from all parsed keys.
4. Overlay defaults and normalized values for known runtime fields.
5. Register a golden snapshot and return the complete object to the caller.
6. On save, calculate the golden-to-current delta.
7. Reload the latest complete config and apply only that delta.
8. Serialize the merged object and advance the golden snapshot from the
   caller's current state.

For server startup, `install.id` therefore survives the host-pinning mutation.
`ensureInstallId()` reads the same ID on every start, and
`deriveIngestTunnelId()` produces the same tunnel ID.

### Error handling

Malformed JSONC and unsupported config versions will continue to fail before
any write. Invalid known values will continue to use the existing normalization
or fallback behavior. Unknown values are treated as opaque data and preserved.
If the latest config becomes invalid between load and save, the save fails
rather than overwriting it from the stale caller.

## Testing

Add focused tests covering:

1. A server-style load, mutate `server.host`, save, and reload cycle preserves
   `install.id`.
2. The preserved install ID derives the same ingest tunnel ID before and after
   the round-trip.
3. Registered sections not currently reconstructed by `loadConfig()` survive,
   including `dashboard`, `tunnelLink`, `logging`, `telemetry`, `update`, and
   `install`.
4. Unknown top-level keys survive.
5. Unknown nested keys inside known sections survive.
6. Two stale loaded configs changing different top-level settings preserve both
   changes when saved sequentially.
7. Two stale loaded configs changing different nested settings preserve both
   changes when saved sequentially.
8. A deletion is applied without removing unrelated concurrent changes.
9. Two stale callers changing the same setting use last-writer-wins behavior.
10. Repeated saves from the same loaded object advance the golden snapshot.
11. Objects not returned by `loadConfig()` retain full-save behavior.
12. Existing normalization tests continue to pass.

## Compatibility

The change is backward compatible. Existing valid settings keep the same
runtime values, while data that was previously discarded is retained. The
rendered file may gain preserved sections after a server write, but ordering and
generated comments remain governed by the existing renderer. Sequential
overlapping writes preserve unrelated settings; exact simultaneous writes
remain last-file-writer-wins because the design intentionally does not add a
cross-process lock.
