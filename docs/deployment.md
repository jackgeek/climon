# Deployment & release signing

This is the maintainer runbook for publishing signed, auto-updatable climon
releases. It covers the one-time signing-key setup, how a signed release is cut,
and how the auto-update trust chain fits together. For the user-facing view of
updates, see [usage.md](./usage.md); for the security rationale, see
[security.md](./security.md).

## Trust model in one paragraph

Each release artifact (`climon-<platform>.zip`) is signed in CI with an
**Ed25519** private key. The release publishes, alongside each zip, a detached
`<zip>.sig` signature and a `manifest.json` describing the version and
per-artifact download/signature URLs. The client embeds the matching **public
key** and verifies the signature before applying any update. With no public key
embedded (or no signature available), the client refuses to apply the download —
it fails closed.

## One-time signing setup

You must do this once before shipping updates that clients will trust.

### 1. Generate the keypair

```bash
bun scripts/gen-update-keys.ts
```

This prints (and prints nothing to disk):

```
PUBLIC_KEY_B64=<base64 of the 32-byte raw Ed25519 public key>
PRIVATE_KEY_PKCS8_B64=<base64 PKCS8 private key>
```

Treat the private key like any other release-signing secret: never commit it,
never paste it into logs or issues, and store it only in the CI secret store
below. Anyone with this key can forge updates that every installed client will
accept.

### 2. Embed the public key in the client

Put the **public** key into `src/update/pubkey.ts`:

```ts
export const UPDATE_PUBLIC_KEY_B64 = "<PUBLIC_KEY_B64 from step 1>";
```

Commit this change. It must be present in the build that ships to users —
clients built with the empty placeholder will refuse all updates.

### 3. Store the private key as a CI secret

Add the **private** key as the GitHub Actions secret
`CLIMON_UPDATE_PRIVATE_KEY` (repository or environment scope):

```bash
gh secret set CLIMON_UPDATE_PRIVATE_KEY   # paste PRIVATE_KEY_PKCS8_B64 when prompted
```

The release workflow scopes this secret to the single signing step, so it is not
exposed to dependency-install or `curl | bash` steps.

## Cutting a signed release

Releases are otherwise unchanged from the standard flow in the README. With the
secret present, the [`Release`](../.github/workflows/release.yml) workflow:

1. compiles the release binaries and zips them (`dist/climon-<platform>.zip`),
2. runs `bun run sign-release` (the **Sign release artifacts + emit manifest**
   step), which writes `dist/<zip>.sig` for each artifact and `dist/manifest.json`,
3. verifies the signatures are present,
4. publishes the zips to the GitHub Release, then uploads the `.zip.sig` files
   and `manifest.json` as additional release assets.

`sign-release` is driven by two env vars set in the workflow:

- `RELEASE_VERSION` — the release tag (e.g. `v1.2.3`); recorded as
  `manifest.version`.
- `RELEASE_BASE_URL` — the release download base
  (`https://github.com/jackgeek/climon/releases/download/<tag>`); used to build
  the per-artifact `url`/`sig` links in the manifest.

To sign locally for testing:

```bash
CLIMON_UPDATE_PRIVATE_KEY=<PRIVATE_KEY_PKCS8_B64> \
RELEASE_VERSION=v1.2.3 \
RELEASE_BASE_URL=https://example.test/download/v1.2.3 \
bun run sign-release
# reads dist/climon-*.zip, writes dist/*.zip.sig and dist/manifest.json
```

## Manifest layout

`manifest.json` is the file the client polls. Its shape:

```jsonc
{
  "version": "v1.2.3",
  "artifacts": {
    "linux-x64":   { "url": ".../climon-linux-x64.zip",   "sig": ".../climon-linux-x64.zip.sig" },
    "linux-arm64": { "url": ".../climon-linux-arm64.zip", "sig": ".../climon-linux-arm64.zip.sig" },
    "darwin-x64":  { "url": ".../climon-darwin-x64.zip",  "sig": ".../climon-darwin-x64.zip.sig" },
    "darwin-arm64":{ "url": ".../climon-darwin-arm64.zip","sig": ".../climon-darwin-arm64.zip.sig" },
    "windows-x64": { "url": ".../climon-windows-x64.zip", "sig": ".../climon-windows-x64.zip.sig" }
  }
}
```

Artifact keys are `<os>-<arch>` (`os` ∈ `linux|darwin|windows`, `arch` ∈
`x64|arm64`), matching the client's `currentArtifactKey()`. The background check
polls `releases/latest/download/manifest.json`, so always publishing the manifest
to the **latest** release keeps clients pointed at the newest version.

## What the client does with it

1. Background check (≤ once/24h, only for `shell`/`run` launches) fetches the
   manifest, and caches `update.availableVersion` **only** if the version is
   newer *and* an artifact exists for the current platform.
2. The launch banner re-compares the cached version against the running version
   before suggesting (or, in `update.auto` mode, applying) an update.
3. `climon update` downloads the artifact + `.sig`, verifies the detached
   signature against the embedded public key, and only then performs an atomic,
   non-destructive swap (never killing running sessions; see
   [security.md](./security.md#non-destructive-update-guarantee)).

## Releasing without signing

If `CLIMON_UPDATE_PRIVATE_KEY` is not set, the signing, signature-verification,
and manifest-publish steps are skipped via the job-level `HAS_SIGNING_KEY`
guard. The release still builds and publishes the zips — auto-update simply
isn't offered for that release, and clients refuse to apply unsigned downloads.
This is the expected state until the keypair is provisioned.

## Key rotation

To rotate the signing key:

1. Generate a new keypair (step 1).
2. Update `UPDATE_PUBLIC_KEY_B64` in `src/update/pubkey.ts` and ship a release
   built with it. **Clients can only verify releases signed with the key they
   were built with**, so a client must update *to* a build carrying the new
   public key (signed with the old key) before it will accept releases signed
   with the new key. Roll the public key in one release, then switch the CI
   secret to the new private key in the next.
3. Replace the `CLIMON_UPDATE_PRIVATE_KEY` secret with the new private key.

## Manual verification

To confirm a published release verifies end-to-end, download a zip and its
`.sig`, then check the signature against the embedded public key with any
Ed25519 tool, or run `climon update` on a client built with that public key and
confirm it reports `update.applied`.
