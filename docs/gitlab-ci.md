# GitLab desktop releases

Adapted from Raft's current direct-build `.gitlab-ci.yml` and release scripts. GitHub is not required for GitLab builds or publication.

A push to `main`, a manual pipeline on `main`, or a `vMAJOR.MINOR.PATCH` tag starts `prepare → build → publish`:

1. Prepare runs release tests. For main pipelines, it fetches current main under a `release-version` resource lock, increments the minor version, and atomically pushes the version commit and tag. Package metadata, the npm lockfile, Tauri config, and Cargo.toml stay aligned. Release commits include `[skip ci]` and are also excluded by workflow rules.
2. The macOS build checks out that exact tag, runs `npm ci` and `npm run build` to prepare the Next.js standalone server, and creates signed Tauri updater artifacts.
3. Publish waits for the macOS build, checks the macOS updater signature, generates `latest.json`, uploads installers and signatures to the Generic Package Registry (`trident/<version>/<filename>`), and creates or updates `Trident v<version>` with permanent asset links. Failed uploads prevent release creation. Job artifacts expire after one week; registry packages must be retained.

No tag, push, pipeline, or release is created by local tests. This pipeline does not publish the npm package.

## Runners

- **Prepare/publish:** an untagged Linux Docker runner running `node:22-bookworm`.
- **macOS Apple Silicon:** shell runner tagged `Alpha-iOS`, matching Raft. Install Node.js 22.13+ with npm, Git, Xcode command-line tools, and Rust/rustup (the job installs rustup if absent). Override `MACOS_RUNNER_TAG` if needed. Keychain operations are serialized within this project. The runner must have a working Node 22+ first in PATH.

Allow enough runner/job time for Rust and Next.js builds. All runners need access to GitLab, npm, Rust distribution/crate hosts, and Tauri bundler download hosts. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/). Windows and Linux desktop packaging is not supported by this release workflow.

## CI/CD variables and permissions

Protect `main` and release tags; store credentials as masked/protected CI variables. Enable the project's Package Registry and retain release packages. Allow duplicate Generic package uploads for publication retries.

| Variable | Purpose |
| --- | --- |
| `CI_RELEASE_TOKEN` | GitLab project/personal access token with `write_repository`, permitted to push main and `v*` tags. Alternatively enable repository pushes by `CI_JOB_TOKEN`. |
| `TAURI_SIGNING_PRIVATE_KEY` | Existing Trident updater private key matching `src-tauri/tauri.conf.json`'s public key. Required on the macOS build runner. Use a value variable. Legacy `TAURI_PRIVATE_KEY` is also accepted. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password, if encrypted. Legacy `TAURI_KEY_PASSWORD` is also accepted. |
| `APPLE_CERTIFICATE` | Required base64 Developer ID `.p12` with its private key. Imported into a temporary keychain and removed after the build. |
| `APPLE_CERTIFICATE_PASSWORD` | Required. |
| `APPLE_SIGNING_IDENTITY` | Required; overrides the repository's ad-hoc signing identity. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Required Tauri notarization credentials; `APPLE_PASSWORD` is an Apple app-specific password. |
| `UPDATER_ENDPOINTS` | Optional comma-separated updater URLs applied only to GitLab-built bundles. Defaults to the internal GitLab release manifest. |
| `RELEASE_TAG` | Optional existing `vX.Y.Z` tag for a manual pipeline on main. |

The built-in `CI_JOB_TOKEN` handles package uploads and release API calls. No GitHub token or GitHub CLI is needed. Release builds require all six Apple variables and a Developer ID Application identity. A before-bundle hook signs and verifies bundled Mach-O code (including native Node modules such as keytar). Tauri notarizes and staples the app before packaging its signed updater archive and DMG. Before collecting assets, CI verifies the app's identity, team, hardened runtime, stapled ticket, and Gatekeeper acceptance; checks the updater signature's key ID against the embedded public key; then submits the signed DMG to Apple, requires Accepted, staples it, and assesses the final installer. Any missing credentials or failed check blocks publication. Local developer builds can retain ad-hoc signing.

## Retries

Retry prepare against unchanged main to reuse its release tag; it does not bump again. Retrying a build checks out `RELEASE_TAG` from the prepare dotenv artifact. Retrying publish reuploads packages and updates existing release links.

If main has advanced, start a manual pipeline on main with `RELEASE_TAG=vX.Y.Z` to rebuild that exact existing tag. The tag's package version must match. Tags from before these scripts landed cannot build through this pipeline without backporting the scripts. A main push arriving while another prepare job runs fetches the latest main before calculating its version; Git rejects concurrent changes during publication rather than force-pushing.

GitHub Actions is manual-only and requires an existing tag, preventing two CI systems from independently bumping main. GitLab does not mirror tags or packages to GitHub. To publish there manually, first make the desired commit/tag available in that repository.

## Desktop updates

GitLab publishes `latest.json` with internal version-specific package download URLs. Its stable release link is:

`https://git.insea.io/api/v4/projects/alpha%2Fprojects%2Fchatgpt%2Ftrident/releases/permalink/latest/downloads/latest.json`

New desktop builds check this GitLab manifest and download the signed macOS package from the internal registry. Add a GitLab account for `https://git.insea.io` in **Credentials**, with a token that has `api` scope and access to this project and its packages. Office network/VPN access is required.

The native updater retrieves the token from the existing OS credential store through a local endpoint protected by a random per-launch secret. Browser requests cannot read updater tokens. Authentication applies to both the manifest and package download. Tokens are restricted to the HTTPS `git.insea.io` origin; mixed-host endpoints, external package URLs, and redirects off that origin are rejected. `UPDATER_ENDPOINTS` can point at another source, but saved internal GitLab credentials are never attached to that source.

Older installed builds still use the GitHub endpoint embedded in their binary. Install a new GitLab-built version manually once (or distribute it through the existing GitHub channel) to switch future updates to GitLab. This configuration change cannot rewrite already-installed binaries.

## Validation

Use Node.js 22.13+:

```sh
node --test scripts/bump-version.test.js scripts/gitlab-release.test.js scripts/updater-credentials.test.mjs scripts/macos-release.test.mjs
cargo test --manifest-path src-tauri/Cargo.toml --lib updater_auth
glab ci lint .gitlab-ci.yml --include-jobs
```

Tests use disposable local Git remotes and a mock GitLab server. Credential tests verify bridge authorization, exact-server matching, and missing/unavailable keychain behavior. They cover atomic pushes, retries, tag/version resolution, architecture-aware asset collection, internal updater URLs, missing signatures, upload failure, and creating/updating releases. A passing lint/test run does not prove native builds, signing credentials, runner availability, or live publication.

## Signing failures

If Tauri reports `skipping app notarization`, the result is not ready for distribution even if the DMG opens and the build is green. Configure `APPLE_PASSWORD` with an Apple app-specific password for `APPLE_ID`; never use the normal account password. See [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/) and [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

An updater key mismatch is separate from Apple code signing. Restore the private updater key that matches the public key embedded in existing builds, or deliberately rotate the public key and distribute a new installer manually. Rebuilding with an unrelated updater private key cannot update old installations.

Transient Apple CloudKit network errors during ticket stapling or validation are retried up to three times, with 5-second and 15-second waits. Notarization submission is not repeated by those retries. Invalid tickets, signing failures, Apple notarization rejections, and exhausted network retries still fail the build and block publication.

Native-module signing uses the job's explicit `--keychain` path. CI checks that this keychain contains the configured valid identity before compiling and passes the path into the bundle hook. It re-registers its keychain immediately before native signing, because macOS requires search-list membership even with an explicit signing keychain. Cleanup removes only that job's entry from the current list, preserving other jobs instead of restoring an old snapshot. The standalone hook used by the manual GitHub workflow creates its own temporary keychain when needed.

If the imported `.p12` contains only the leaf certificate and private key, CI adds the public Developer ID G1/G2 intermediates from [Apple PKI](https://www.apple.com/certificateauthority/) to that temporary keychain and rechecks the identity. These public certificates are vendored under `scripts/certificates/` so signing does not depend on downloading them during the job. Their trust still comes from macOS's Apple root certificates; no trust override is installed.
