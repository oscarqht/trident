# GitLab desktop releases

Adapted from Raft's current direct-build `.gitlab-ci.yml` and release scripts. GitHub is not required for GitLab builds or publication.

A push to `main`, a manual pipeline on `main`, or a `vMAJOR.MINOR.PATCH` tag starts `prepare → build → publish`:

1. Prepare runs release tests. For main pipelines, it fetches current main under a `release-version` resource lock, increments the minor version, and atomically pushes the version commit and tag. Package metadata, the npm lockfile, Tauri config, and Cargo.toml stay aligned. Release commits include `[skip ci]` and are also excluded by workflow rules.
2. Each build checks out that exact tag, runs `npm ci` and `npm run build` to prepare the Next.js standalone server, and creates signed Tauri updater artifacts.
3. Publish waits for all three builds, checks all three updater signatures, generates `latest.json`, uploads installers and signatures to the Generic Package Registry (`trident/<version>/<filename>`), and creates or updates `Trident v<version>` with permanent asset links. Failed uploads prevent release creation. Job artifacts expire after one week; registry packages must be retained.

No tag, push, pipeline, or release is created by local tests. This pipeline does not publish the npm package.

## Runners

- **Prepare/publish:** an untagged Linux Docker runner running `node:22-bookworm`.
- **macOS Apple Silicon:** shell runner tagged `Alpha-iOS`, matching Raft. Install Node.js 22.13+ with npm, Git, Xcode command-line tools, and Rust/rustup (the job installs rustup if absent). Override `MACOS_RUNNER_TAG` if needed. Keychain operations are serialized within this project. The runner must have a working Node 22+ first in PATH.
- **Windows x64:** a native Windows shell/PowerShell runner tagged `windows` (override `WINDOWS_RUNNER_TAG`). Install Node.js 22.13+ with npm, Git, Rust/rustup with the MSVC host toolchain, Visual Studio C++ build tools, Python for native npm builds, and WebView2. Tauri builds NSIS and MSI installers. Trident bundles native Node dependencies such as keytar, so Raft's Linux cargo-xwin approach cannot simply be copied: it would embed Linux Node modules in a Windows package. A Windows runner must be registered before a complete release can finish; none was identifiable in the project's runner inventory during implementation.
- **Linux x64:** an untagged Docker runner with root package-install access. CI installs WebKitGTK, AppIndicator, OpenSSL, libsecret (keytar), Python, build tools, and Arch packaging tools. It produces AppImage, deb/rpm (Tauri defaults), and an Arch `.pkg.tar.zst`. AppImage extraction is enabled for container builds.

Allow enough runner/job time for Rust and Next.js builds. All runners need access to GitLab, npm, Rust distribution/crate hosts, and Tauri bundler download hosts. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and [Windows packaging](https://v2.tauri.app/distribute/windows-installer/).

## CI/CD variables and permissions

Protect `main` and release tags; store credentials as masked/protected CI variables. Enable the project's Package Registry and retain release packages. Allow duplicate Generic package uploads for publication retries.

| Variable | Purpose |
| --- | --- |
| `CI_RELEASE_TOKEN` | GitLab project/personal access token with `write_repository`, permitted to push main and `v*` tags. Alternatively enable repository pushes by `CI_JOB_TOKEN`. |
| `TAURI_SIGNING_PRIVATE_KEY` | Existing Trident updater private key matching `src-tauri/tauri.conf.json`'s public key. Required on all build runners. Use a value variable. Legacy `TAURI_PRIVATE_KEY` is also accepted. |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Updater key password, if encrypted. Legacy `TAURI_KEY_PASSWORD` is also accepted. |
| `APPLE_CERTIFICATE` | Optional base64 Developer ID `.p12` with its private key. Imported into a temporary keychain and removed after the build. |
| `APPLE_CERTIFICATE_PASSWORD` | Required with `APPLE_CERTIFICATE`. |
| `APPLE_SIGNING_IDENTITY` | Required with `APPLE_CERTIFICATE`; overrides the repository's ad-hoc signing identity. |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Optional Tauri notarization credentials; `APPLE_PASSWORD` is an Apple app-specific password. |
| `UPDATER_ENDPOINTS` | Optional comma-separated updater URLs applied only to GitLab-built bundles. See update limitations below. |
| `RELEASE_TAG` | Optional existing `vX.Y.Z` tag for a manual pipeline on main. |

The built-in `CI_JOB_TOKEN` handles package uploads and release API calls. No GitHub token or GitHub CLI is needed. Apple signing/notarization is optional, as in Raft's direct-build script; absent credentials retain Trident's ad-hoc signing. Native signing and notarization require actual runner validation.

## Retries

Retry prepare against unchanged main to reuse its release tag; it does not bump again. Retrying a build checks out `RELEASE_TAG` from the prepare dotenv artifact. Retrying publish reuploads packages and updates existing release links.

If main has advanced, start a manual pipeline on main with `RELEASE_TAG=vX.Y.Z` to rebuild that exact existing tag. The tag's package version must match. Tags from before these scripts landed cannot build through this pipeline without backporting the scripts. A main push arriving while another prepare job runs fetches the latest main before calculating its version; Git rejects concurrent changes during publication rather than force-pushing.

GitHub Actions is manual-only and requires an existing tag, preventing two CI systems from independently bumping main. GitLab does not mirror tags or packages to GitHub. To publish there manually, first make the desired commit/tag available in that repository.

## Desktop update limitations

GitLab publishes `latest.json` with internal version-specific package download URLs. Its stable release link is:

`https://git.insea.io/api/v4/projects/alpha%2Fprojects%2Fchatgpt%2Ftrident/releases/permalink/latest/downloads/latest.json`

The existing app config still points to GitHub. This change adds build/release automation; it does not add the private GitLab updater authentication integration used by Raft. Existing installs therefore continue checking GitHub, and GitLab-only releases are installed manually. Set `UPDATER_ENDPOINTS` only when the updater can authenticate to/read the manifest **and** package downloads, or when those endpoints are accessible without authentication. Merely changing the URL does not provide access to a private project.

## Validation

Use Node.js 22.13+:

```sh
node --test scripts/bump-version.test.js scripts/gitlab-release.test.js
glab ci lint .gitlab-ci.yml --include-jobs
```

Tests use disposable local Git remotes and a mock GitLab server. They cover atomic pushes, retries, tag/version resolution, architecture-aware asset collection, internal updater URLs, missing signatures, upload failure, and creating/updating releases. A passing lint/test run does not prove native builds, signing credentials, runner availability, or live publication.
