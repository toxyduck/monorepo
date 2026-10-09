# Search Everywhere

One literal query searches filenames and content in the active project. Results have one row per file, with a representative content line when available. The native centered overlay retains keyboard selection, file icons, theme colors, loading animation and native file preview.

## Configuration

Fresh 0.5.2 or newer, Linux and Python 3.9+ are required. Declare providers through Fresh's native plugin settings:

```json
{
  "plugins": {
    "search-everywhere": {
      "settings": {"backend": "rg", "arcBackend": "remote"}
    }
  }
}
```

`backend` chooses the provider in a positively verified non-Arc project; `arcBackend` chooses it in a verified mounted Arc project. Defaults are `rg` and `remote`. Invalid combinations are visible configuration errors: rg is never allowed in Arc, and remote outside Arc has no source mapping. Unknown, remote-authority, HOME, root, mount-parent, nested-mount and symlink-root scopes are rejected. Missing Arc CLI or uncertain mount metadata fails closed. There is no silent fallback or backend selector in the overlay. Configuration changes close the popup and invalidate its results; reopen to search with the new configuration.

- **Arc:** `ya grep --remote` searches indexed **trunk**, restricted by an anchored Arc-root-relative project filter. It does not search the current branch or local edits. `ya` and `arc` must be available on PATH with working remote search authorization.
- **Non-Arc:** ordinary bare PATH `rg` searches the verified project with standard ignores, hidden/binary policy, no config, no following symlinks and one-filesystem traversal. Filename listing and JSON content search are separate bounded invocations. Binary filenames may appear although their contents are not searched.

The footer reports the actual source, `trunk` or `local`. Only native plugin settings choose the provider. The existing exported `configure({demotePaths, maxResults, timeoutMs})` API controls ranking and limits, not provider selection.

## Search and navigation

Queries are single-line literals, up to 512 UTF-16 units. ASCII case folds; non-ASCII characters match exactly. Filename matching is a literal substring of the project-relative path, not fuzzy subsequence matching. Content and filename hits are deduplicated; the earliest returned content line represents each file (not a promise of the global earliest line under truncation).

Only the selected file is physically checked for preview/open. Remote paths map into the **current verified Arc mount**, not a fixed checkout. Native preview starts at the beginning. Enter checks the bounded current local line and literal match before computing a UTF-8 byte cursor position. A differing/missing/oversized line opens at the beginning with a warning; remote columns/byte offsets are never invented. Unsaved existing buffers are preserved and retain their cursor. Unsaved contents are not searched. Unsafe or missing selected files are not opened.

Native file APIs are path-based, not descriptor-pinned. Identity checks detect observed scope/root/mount changes, but a narrow metadata-check-to-native-open race remains. Selected native preview/open can read the local or ArcFS file; this is not a zero-local-read plugin.

## Bounds and lifecycle

No SQLite, saved-text index, source hashing, cache migration/deletion, dirty-buffer corpus snapshots or save/reconcile background jobs remain. No query means no helper or corpus listing/reads. Queries debounce for 250 ms; popup closure cancels owned work. A replacement waits for the previous helper handle to settle; only the latest pending query is retained. Failures do not trigger background retries or cross-provider fallbacks; type a fresh query or reopen explicitly.

Default search work budget is **15 seconds total for both search operations**, configurable from 100 ms to 30 seconds. Scope checks have a shared additional 8-second ceiling; the native controller watchdog allows one further second for collection. There are two Arc metadata commands per invocation, not per candidate. In-invocation physical root/mount checks run before each recursive child. No actual Arc latency or project performance claim is made.

Limits: 800 unique candidates; 80 displayed by default, at most 200; 20,000 examined local paths/records; 1 MiB command/reply output; 16 KiB stderr and individual record caps; 4 KiB paths; 8 KiB source line snippets. Hitting a cap reports a partial result or explicit partial-limit error, not empty success. FCS excludes files above 1 MB and its filename coverage may differ from the local tree. Normal ignores, unsupported filenames (including colon/control/backslash paths), invalid UTF-8 and server truncation further limit coverage.

## Development

Build-only esbuild must be 0.25.12 in an isolated prefix:

```sh
python3 tests/index_backend_test.py
python3 tests/test_checker.py
ESBUILD_PREFIX=/tmp/your-isolated-prefix node --experimental-strip-types --test tests/core.test.ts
node scripts/build-package.mjs /tmp/your-isolated-prefix /tmp/new-release-directory
ESBUILD_PREFIX=/tmp/your-isolated-prefix node --test tests/package.test.mjs tests/entry.test.mjs
python3 tests/smoke.py /path/to/fresh
```

The four packaged files are `package.json`, `search-everywhere.ts`, `search_backend.py`, and `README.md`, version 0.4.0. The native smoke exercises configuration-layer loading in disposable HOME/XDG/project directories; it never controls a user's session. Arc protocol tests inject metadata/results, with format evidence from bounded server smokes. Archived assets describe the older implementation and are not 0.4.0 acceptance evidence.
