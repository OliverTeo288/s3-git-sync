# S3 Git Sync

An [Obsidian](https://obsidian.md) plugin that syncs your vault to an S3 bucket using a **git-like workflow** — review every pending change before it goes anywhere, stage what you want, write a commit message, and push. No data leaves your vault without your review.

Works with AWS S3, MinIO, Cloudflare R2, Backblaze B2, and any S3-compatible object store.

---

## What it does

Most sync plugins treat your vault like a file-sync tool (Dropbox-style): changes happen automatically and you find out afterwards. S3 Git Sync works differently. Before anything is uploaded or downloaded, you see exactly what changed and why — the same mental model as `git status` and `git commit`.

The plugin maintains a **local sync record** (a snapshot of what was last synced successfully). On every sync it runs a three-way diff between your current local files, the current S3 state, and that snapshot. This is what allows it to distinguish "I deleted this file intentionally" from "this file never existed on this side", and to detect true conflicts (both sides changed independently).

---

## Features

### Sync workflow

| Feature | Description |
|---|---|
| **View Changes** | Opens a modal showing every pending change grouped by type — new, modified, deleted, and conflicts. Select or deselect individual files, write an optional sync message, then commit. |
| **Inline diff preview** | Click **▶ diff** on any modified text file to see a line-by-line diff (± lines with 3-line context) before syncing. Diff is loaded on demand — no extra downloads until you ask. |
| **Quick Sync** | Syncs all non-conflict changes in one shot without opening the modal. Conflicts are skipped and flagged for manual resolution. |
| **Push only** | Uploads local changes to S3. Conflicts are resolved local-wins. |
| **Pull only** | Downloads remote changes from S3. Conflicts are resolved remote-wins. |
| **Sync History** | Browse a timestamped log of past sync operations with per-sync stats. |

### Change detection

| Feature | Description |
|---|---|
| **Three-way diff** | Compares local state, remote state, and last-sync snapshot to correctly classify every change: new, modified, deleted, or conflicted. |
| **ETag-based remote detection** | Uses S3 object ETags (content hashes) to detect remote modifications without downloading file content. |
| **1-second mtime tolerance** | Avoids false positives from filesystem timestamp resolution differences across platforms. |

### Conflict handling

| Feature | Description |
|---|---|
| **Explicit conflict surfacing** | Conflicts (both sides changed since last sync) are always shown explicitly — the plugin never silently overwrites your data. |
| **Per-file resolution** | In View Changes, each conflict shows local vs remote timestamps and sizes, with **Keep Local** / **Keep Remote** buttons per file. |
| **Conflict backup copies** | When remote wins, the local file is saved to `conflict/file.conflict-YYYY-MM-DD-HHMMSS.ext` before being overwritten so you can recover it. |
| **Quick Sync skips conflicts** | Quick Sync skips conflicts and shows a notice telling you how many need manual resolution in View Changes. |
| **Directional resolution** | Push resolves conflicts local-wins; Pull resolves conflicts remote-wins. |

### Authentication

| Feature | Description |
|---|---|
| **Static credentials** | Access Key ID + Secret stored in the plugin's `data.json`. Password-masked fields in the UI. |
| **AWS Named Profile** (desktop only) | Reads `~/.aws/credentials` and `~/.aws/config` via the full AWS SDK credential chain. Credentials are never stored by the plugin. Supports SSO, assume-role, MFA, and all standard AWS auth flows. |
| **SSO expiry handling** | When an SSO session expires, the plugin shows the exact `aws sso login` command to run in a terminal and the profile name to use. |

### Reliability

| Feature | Description |
|---|---|
| **Multipart upload** | Files over 5 MB are automatically uploaded via the S3 multipart API, avoiding single-PUT size limits. |
| **CORS bypass on desktop** | Routes all S3 HTTP calls through Obsidian's `requestUrl` (Electron's native `net` module) to avoid cross-origin restrictions on arbitrary S3 endpoints. |
| **Retry-safe** | Local sync records are only written after a successful S3 operation. A failed sync is always safe to retry. |

### Usability

| Feature | Description |
|---|---|
| **Status bar** | Live sync state in the Obsidian status bar: Ready / Syncing N/M / Synced 14:32 / Error. |
| **Ribbon icon** | One-click access to View Changes. |
| **Command palette** | All sync actions are registered as commands and can be bound to hotkeys. |
| **File type badges** | Each changed file shows its type badge (MD, PDF, PNG, JSON…) in the modal for quick scanning. |
| **Two-line path display** | Long file paths show filename prominently on the first line, directory path muted below — always readable. |
| **Ignore patterns** | Glob patterns (`*`, `?`) to exclude files from sync. |
| **Remote prefix** | Key prefix inside the bucket (e.g. `work-vault/`) so multiple vaults can share one bucket. |
| **Force path-style URLs** | Required for MinIO and other self-hosted S3 implementations. |
| **Connection test** | Verify credentials and bucket access before the first sync. |
| **Reset sync state** | Clears all local sync records so the next run treats everything as a fresh first sync. |
| **Structured error codes** | All errors include a `[S3S-Exx]` code for quick lookup in the troubleshooting table below. |


---

## Getting started

### 1. Create an S3 bucket

Create a private bucket in your AWS region of choice. Block all public access. Note the bucket name and region.

### 2. Set up credentials

**Option A — Static credentials (simplest, works on mobile)**

Create an IAM user with the minimum policy below. Generate an access key and copy the Access Key ID and Secret Access Key.

**Option B — AWS Named Profile (recommended for desktop)**

Configure a profile in `~/.aws/credentials` or use `aws configure`. For SSO:

```sh
aws configure sso --profile my-profile
aws sso login --profile my-profile
```

### 3. Install the plugin

> Manual install until the plugin is listed in the community directory.

1. Download the latest release from [GitHub Releases](https://github.com/OliverTeo288/s3sync/releases/latest).
2. Copy `main.js`, `manifest.json`, and `styles.css` into `.obsidian/plugins/s3-git-sync/`.
3. Reload Obsidian and enable the plugin in **Settings → Community Plugins**.

### 4. Configure the plugin

Open **Settings → S3 Git Sync** and fill in:

| Field | Description |
|---|---|
| Authentication method | Static credentials or AWS Named Profile |
| Access Key ID / Secret | For static auth only |
| Profile name | For named-profile auth only (default: `default`) |
| Bucket name | The S3 bucket to sync with |
| Region | AWS region, e.g. `ap-southeast-1` |
| Endpoint | Leave blank for AWS S3; set for MinIO / R2 / B2 |
| Remote prefix | Optional key prefix, e.g. `my-vault/` |

Click **Test connection** to verify everything is wired up.

---

## Usage

### View Changes (the main workflow)

Click the refresh icon in the ribbon, or run **S3 Git Sync: View changes (Git status)** from the command palette.

The modal shows all pending changes:

| Section | Meaning |
|---|---|
| Upload — New files | Exists locally, not on S3, never synced |
| Upload — Modified files | Local file changed since last sync |
| Download — New files | Exists on S3, not locally, never synced |
| Download — Modified files | Remote ETag changed since last sync |
| Delete from S3 | File deleted locally since last sync |
| Delete locally | File deleted from S3 since last sync |
| Conflicts | Both sides changed since last sync |

Check or uncheck individual files, resolve any conflicts per-file, write an optional sync message, and click **Sync**.

For text files in the Modified sections, click **▶ diff** to see a line-by-line diff of local vs remote before committing.

### Quick Sync

Syncs everything except conflicts without opening the modal. Useful as a hotkey for a quick catch-up sync.

```
S3 Git Sync: Quick sync (all changes, default resolutions)
```

### Push / Pull

Directional sync for when you know which way you want to go.

```
S3 Git Sync: Push only (local → S3)
S3 Git Sync: Pull only (S3 → local)
```

Conflicts in push are resolved local-wins. Conflicts in pull are resolved remote-wins.

### Sync History

```
S3 Git Sync: View sync history (Git log)
```

Shows the last 50 sync operations with timestamps, optional messages, and per-sync stats (↑ uploaded, ↓ downloaded, ✕ deleted, ⚠ conflicts, ⛔ errors).

---

## Settings reference

| Setting | Default | Description |
|---|---|---|
| Authentication method | Static | Static credentials or AWS Named Profile |
| Ignore patterns | workspace files | One glob pattern per line. Supports `*` and `?`. |
| Remote prefix | _(empty)_ | Key prefix inside the bucket |
| Force path-style URLs | Off | Enable for MinIO and self-hosted S3 |
| Show status bar | On | Show sync state in the Obsidian status bar |

---

## Multi-user sync

S3 is an object store, not a distributed version-control system. There is **no server-side locking** — S3 doesn't know your vault is a collaborative workspace. Here is what that means in practice for a team of people syncing to the same bucket:

### What works fine

- **Sequential syncs** — if people sync at different times, ETag-based detection correctly classifies each file as modified/new/deleted. No data loss.
- **Non-overlapping files** — if different people primarily edit different notes, there are effectively no conflicts.
- **Small teams, async workflows** — works well if the team syncs periodically rather than in real time.

### The race condition

```
Alice opens note.md (synced at T=0)
Bob  opens note.md (synced at T=0)
Alice edits + syncs at T=10  → uploads Alice's version, records new ETag
Bob  edits + syncs at T=11  → his local snapshot is still T=0
                              → ETag mismatch detected as "remote_modified"
                              → conflict surfaced, Bob must choose Keep Local or Keep Remote
```

The plugin detects this correctly **as long as Bob syncs through View Changes or Quick Sync**. Conflicts are always surfaced and never silently overwritten.

### What does NOT work

- **Simultaneous writes to the same file** — last PUT wins. The window is tiny (the duration of the S3 PUT), but the risk exists.
- **Real-time collaboration** — this is not a CRDT or OT system. Do not use it as a replacement for live collaborative editing tools.
- **Merge of concurrent text edits** — when both sides change the same file, you get Keep Local / Keep Remote, not a three-way text merge.

### Recommended practices for teams

| Practice | Reason |
|---|---|
| Use **remote prefixes** per person | `alice-vault/`, `bob-vault/` — eliminates cross-user conflicts entirely if vaults are personal |
| Sync before starting a work session | Minimise the window for conflicts to accumulate |
| Use View Changes for shared notes | See exactly what changed before committing |
| For truly collaborative notes, use a dedicated tool | Obsidian Publish, Notion, or a shared markdown repo with proper merge |

---

## Troubleshooting

All errors include a bracketed code, e.g. `[S3S-E04] InvalidClientTokenId`.

| Code | Meaning | Fix |
|---|---|---|
| `S3S-E01` | AWS SSO session expired | Run `aws sso login --profile <name>` in a terminal, then retry the sync |
| `S3S-E02` | Named-profile auth not available on mobile | Switch to **Static credentials** on mobile |
| `S3S-E03` | Network error or request timed out | Check your internet connection; verify the bucket region and endpoint URL are correct |
| `S3S-E04` | Invalid or missing credentials | Re-enter your Access Key ID and Secret; check they have not been revoked in IAM |
| `S3S-E05` | Bucket not found | Verify the bucket name and region; confirm the bucket exists in your AWS account |
| `S3S-E06` | Access denied | Check the IAM policy includes the four required actions on the correct bucket ARN (see below) |
| `S3S-E99` | Unexpected error | Open the developer console (`Ctrl/Cmd+Shift+I`) for the full stack trace and open a GitHub issue |

### Minimum IAM policy

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ["s3:ListBucket"],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME"
    },
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
    }
  ]
}
```

---

## Technical reference

### Architecture overview

```
Obsidian vault (local files)
        │
        │  vault.getFiles() + adapter.readBinary/writeBinary
        ▼
  differ.ts  ←── LocalDB (localforage, persisted sync records)
        │              ↑
        │  3-way diff  │ bulkUpsertSyncRecords after each successful sync
        ▼
  FileChange[]  (local_new / local_modified / local_deleted /
                 remote_new / remote_modified / remote_deleted / conflict)
        │
        ▼
  syncEngine.ts
        │
        │  S3ClientWrapper (ObsHttpHandler via requestUrl on desktop,
        │                    FetchHttpHandler on mobile)
        ▼
  S3 bucket
```

### Project structure

```
src/
  main.ts          Plugin entry point, lifecycle, commands
  s3client.ts      S3ClientWrapper, credential resolution, ObsHttpHandler, SSO helpers
  differ.ts        3-way diff engine (computeChanges, groupChanges)
  syncEngine.ts    executeSync, dryRunStats, conflict resolution
  localdb.ts       LocalForage wrappers for sync records and history
  changeView.ts    ChangeViewModal, HistoryModal
  settings.ts      PluginSettingTab
  types.ts         All shared types and interfaces
tests/
  differ.test.ts        3-way diff engine, ignore patterns, content-hash de-dup
  syncEngine.test.ts    dryRunStats, validateAccessKeyId, S3ClientWrapper prefix
  localdb.test.ts       LocalDB upsert / get / delete / history pruning
  s3client.test.ts      errorCode classifier, parseAWSConfigForSSO
  integration/          S3 + full-sync scenarios against LocalStack
  __mocks__/            Obsidian and localforage stubs for unit tests
```

### Local development

**Prerequisites:** Node.js 25, npm

```sh
# Install dependencies
npm install

# Development build with watch mode (rebuilds on file change)
npm run dev

# Production build
npm run build

# Run tests
npm test

# Run tests with coverage
npm run test:coverage
```

Copy (or symlink) the output files into your Obsidian vault to test:

```sh
cp main.js manifest.json styles.css \
  /path/to/vault/.obsidian/plugins/s3-git-sync/
```

Then reload Obsidian (`Ctrl/Cmd+R` with the developer console open, or disable/enable the plugin).

### Running tests

```sh
npm test              # single run
npm run test:watch    # watch mode
npm run test:coverage # coverage report (HTML in coverage/)
```

Tests use [Vitest](https://vitest.dev) with in-memory stubs for the Obsidian API and localforage. The test suite covers the diff engine and sync executor; UI components (modals, settings tab) are not unit-tested.

### Tech stack

| Layer | Library |
|---|---|
| Bundler | esbuild |
| Language | TypeScript 5 |
| S3 client | `@aws-sdk/client-s3`, `@aws-sdk/lib-storage` |
| Credential chain | `@aws-sdk/credential-providers` |
| Local storage | localforage (IndexedDB) |
| ID generation | nanoid |
| Test runner | Vitest |
