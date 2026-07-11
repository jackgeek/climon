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
- Keep explicit deletion possible without resurrecting values from disk.
- Add a regression test for stable `install.id` and ingest tunnel derivation.
- Establish tests that prevent future config sections from being silently lost.

## Non-Goals

- Replacing the config registry or JSONC renderer.
- Adding concurrent-write merging to `saveConfig()`.
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

### Saving

`saveConfig()` will continue to serialize the supplied object with
`renderJsoncConfig()`. It will not reread and merge the file at write time.

This keeps deletion semantics clear: callers can remove a key from the loaded
object and save it. It also avoids reviving stale data if another operation has
intentionally removed a setting.

### Data flow

1. Parse the complete JSONC object.
2. Validate the config version.
3. Start the loaded result from all parsed keys.
4. Overlay defaults and normalized values for known runtime fields.
5. Return the complete object to the caller.
6. Serialize that complete object when a caller saves it.

For server startup, `install.id` therefore survives the host-pinning mutation.
`ensureInstallId()` reads the same ID on every start, and
`deriveIngestTunnelId()` produces the same tunnel ID.

### Error handling

Malformed JSONC and unsupported config versions will continue to fail before
any write. Invalid known values will continue to use the existing normalization
or fallback behavior. Unknown values are treated as opaque data and preserved.

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
6. Existing normalization tests continue to pass.

## Compatibility

The change is backward compatible. Existing valid settings keep the same
runtime values, while data that was previously discarded is retained. The
rendered file may gain preserved sections after a server write, but ordering and
generated comments remain governed by the existing renderer.
