# 🔱 Trident

A modern, web-based Git client built with Next.js. Manage your repositories, view commit history with a visual graph, and perform common Git operations through an intuitive interface.

![](./docs/poster.jpeg)

## Features

- **Repository Management** - Add, delete, and manage multiple local Git repositories
- **Visual Commit Graph** - Fork-style commit visualization with branch lanes
- **Branch Operations** - Create, checkout, delete, rename, rebase, and merge branches
- **Conflict Resolver** - Detect merge/rebase conflicts and resolve them with a dedicated workflow
- **Change Staging & Committing** - Stage/unstage files individually or all at once, create new commits, or amend the last commit with draft preservation
- **Stash Support** - Stash, reapply, and delete stashed changes
- **Diff Viewer** - Syntax-highlighted diff view for reviewing changes
- **Commit History** - Browse commit history with infinite scroll and branch filtering
- **Branch Deep Links** - Open History with `?branch=<name>` to initialize branch checkout/head focus
- **Iconized Context Menus** - Faster scanning with icons across branch/tag/commit/worktree actions
- **Command Palette** - Quick access to common actions via Cmd/Ctrl+K
- **Settings** - Configure default repository folder and preferences
- **Dark/Light Mode** - Theme toggle for comfortable viewing

## Roadmap & TODO

### Implemented

#### Repository Management
- [x] Open local repositories from a filesystem browser
- [x] List recent repositories and reopen quickly (Command Palette)
- [x] Sort repositories by last active time on home page
- [x] Delete repositories from the app list (without deleting files)
- [x] Shared repository/settings storage across app instances
- [x] Set repository display name
- [x] Configure default root folder for browsing repositories
- [x] Clone repositories from URL (HTTPS/SSH with optional credentials)
- [x] Initialize a new repository when opening a non-Git folder
- [x] GitHub repository picker in clone dialog (credential-aware)

#### Working Directory & Staging
- [x] View working tree and index status
- [x] Stage/unstage individual files
- [x] Stage all / unstage all
- [x] Discard unstaged changes and untracked files
- [x] Stash changes with message
- [x] List/apply/pop/drop stashes
- [x] Inspect stash file lists and per-file stash diffs

#### Committing
- [x] Commit with subject + optional body
- [x] Amend last commit when committing local changes (with automatic message pre-fill, draft recovery, and pushed commit warning)
- [x] Amend latest commit message from history (reword)

#### Branching, History & Graph
- [x] Visual commit graph with branch lanes
- [x] Improved branch-junction rendering for same-row merges and aligned branch starts
- [x] Branch visibility filters persisted per repository
- [x] List local/remote branches with ahead/behind tracking info
- [x] Create branch from current HEAD or selected ref
- [x] Checkout local branch
- [x] Checkout remote branch to new local tracking branch
- [x] Delete local and remote branches
- [x] Rename local branches
- [x] Rename remote branches
- [x] Merge with options (rebase-before-merge, squash, fast-forward)
- [x] Rebase onto target branch (with optional auto-stash)
- [x] Preflight conflict checks for merge/rebase
- [x] Conflict resolver page for merge/rebase (stage resolved files, continue/abort)
- [x] Hard/soft/mixed reset to selected commit
- [x] Revert commits with confirmation
- [x] Cherry-pick single/multiple commits and abort cherry-pick
- [x] Commit details and per-file commit diffs (split/inline)
- [x] One-way history branch query initialization (`?branch=<name>`)

#### Remote Operations
- [x] Fetch default remote
- [x] Fetch specific remote
- [x] Fetch all remotes (prune)
- [x] Pull from remote branch (rebase option)
- [x] Push to remote branch (force, set-upstream, rebase-first, squash, local-tags)
- [x] Manage remotes (add/rename/remove remote definitions)

#### Tags, Credentials, and Automation
- [x] Create local tag and optionally push to remote
- [x] Delete local tag
- [x] Delete remote tag
- [x] Manage credentials (GitHub/GitLab) and associate per repository
- [x] Run repository custom bash scripts from branch context menu (with live output/cancel)
- [x] Automated release tagging on main PR merge and npm publish on release tags

#### UX & Reliability
- [x] Dark/light/system theme toggle
- [x] Enter key confirms primary action across modal dialogs
- [x] Image diff support and binary file detection
- [x] Large-diff protection to prevent UI freeze
- [x] Persist key UI state (sidebar/panel sizes/folders/filters)
- [x] Git error handling with actionable messages + lock file cleanup action

### TODO
- [ ] Commit signing (GPG/SSH)
- [ ] Co-author commit support
- [ ] Interactive rebase UI
- [ ] Blame/annotate view
- [ ] Submodule management
- [ ] Git LFS workflows

## Tech Stack

- **Framework:** [Next.js](https://nextjs.org/) 16 (App Router)
- **Language:** TypeScript
- **UI Components:** [DaisyUI](https://daisyui.com/)
- **Styling:** [Tailwind CSS](https://tailwindcss.com/) 4
- **State Management:** [TanStack Query](https://tanstack.com/query)
- **Git Operations:** [simple-git](https://github.com/steveukx/git-js)
- **Diff Rendering:** [@alexbruf/react-diff-viewer](https://www.npmjs.com/package/@alexbruf/react-diff-viewer)
- **Theming:** [next-themes](https://github.com/pacocoursey/next-themes)
- **Validation:** [Zod](https://zod.dev/)

## Getting Started

### Prerequisites

- Node.js 18+
- Git installed and available in PATH

### Run with npx

```bash
npx trident-git
```

This launches the app on an available local port (default `3100`).  
You can also pass options:

```bash
npx trident-git --port 3200
npx trident-git --dev
```

Published npm packages are expected to include a prebuilt `.next` output, so `npx trident-git` does not build on the end user's machine.

### Installation

```bash
# Clone the repository
git clone <repository-url>
cd trident

# Install dependencies
npm install

# Start the development server
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build for Production

```bash
npm run build
npm start
```

## Usage

1. **Add a Repository** - Click "Add Repository" on the home page and browse to select a local Git repository
2. **View Changes** - The workspace view shows staged and unstaged changes with diff previews
3. **Commit Changes** - Stage files and enter a commit message, or toggle "Amend" to update the previous commit (Cmd/Ctrl+Enter to commit/amend)
4. **Browse History** - Navigate to the History tab to view the commit graph
5. **Manage Branches** - Use the branch sidebar to switch, create, or manage branches

## Project Structure

```
.github/workflows/         # CI/CD (release tagging + npm publish)
bin/                       # Packaged CLI entrypoint
src/
├── app/                    # Next.js App Router pages
│   ├── api/               # API routes for Git operations
│   │   ├── git/           # Git action endpoints
│   │   ├── fs/            # File system endpoints
│   │   └── repos/         # Repository management
│   └── workspace/         # Workspace pages (history, changes, stashes, settings)
├── components/            # React components
│   ├── git/              # Git-specific components
│   │   ├── diff-view.tsx
│   │   ├── git-graph.tsx
│   │   ├── history-view.tsx
│   │   └── status-view.tsx
│   ├── layout/           # Layout components
│   └── context-menu.tsx  # Shared context menu (supports action icons)
├── hooks/                # Custom React hooks
├── lib/                  # Utilities and services
│   ├── git.ts           # Git service wrapper
│   ├── graph-utils.ts   # Commit graph algorithms
│   ├── store.ts         # State management
│   └── types.ts         # TypeScript definitions
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server |
| `npm run build` | Build for production |
| `npm run prepack` | Clean `.next` and build package artifacts before publish |
| `npm run start` | Start production server |
| `npm run lint` | Run ESLint |
| `npm run cli` | Start through the packaged CLI launcher |
| `npm run pack:preview` | Preview npm package contents |

## Release Automation

The repository ships with GitHub Actions workflows for automated releases:

1. On pushes to `main` (including local merge commits pushed to GitHub), `Release On Main Merge` bumps the npm minor version (`npm version minor`), creates a `v*` tag, and pushes both commit + tag.
2. `Publish To NPM` runs on `v*` tag pushes (and also after successful release workflow completion), resolves the release tag, verifies the tagged commit is on `main`, and publishes with `npm publish --access public --provenance`.

Required secret:

- `NPM_TOKEN` with publish access to the `trident-git` package.

## License

MIT
