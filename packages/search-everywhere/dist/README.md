<!-- demo-video:start -->
[![Plugin demo](https://raw.githubusercontent.com/toxyduck/monorepo/main/packages/search-everywhere/assets/demo.gif)](https://github.com/toxyduck/monorepo/blob/main/packages/search-everywhere/assets/demo.mp4)
<!-- demo-video:end -->

## Install

Requires Fresh **0.5.2 or newer**. In the command palette, choose **Package: Install from URL** and enter:

```text
https://github.com/toxyduck/monorepo#packages/search-everywhere/dist
```

Restart Fresh, then run **Search Everywhere** from the command palette. The committed native package needs no build, Node, GitHub CLI authentication, or manual repository checkout.

### Release archive (optional)

Version **0.1.0** uses tag `search-everywhere-v0.1.0`.

- [search-everywhere-0.1.0.tar.gz](https://github.com/toxyduck/monorepo/releases/download/search-everywhere-v0.1.0/search-everywhere-0.1.0.tar.gz)
- [SHA256SUMS](https://github.com/toxyduck/monorepo/releases/download/search-everywhere-v0.1.0/SHA256SUMS)

Run in a fresh shell. Downloads, checksum verification, and layout checks finish before an existing installation is moved. On macOS, the commands use `shasum`; on Linux, `sha256sum`.

```sh
set -eu
version=0.1.0
work=$(mktemp -d)
base=https://github.com/toxyduck/monorepo/releases/download/search-everywhere-v$version
archive=search-everywhere-$version.tar.gz
curl -fL "$base/$archive" -o "$work/$archive"
curl -fL "$base/SHA256SUMS" -o "$work/SHA256SUMS"
(cd "$work" && if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c SHA256SUMS
else
  shasum -a 256 -c SHA256SUMS
fi)
name=search-everywhere-$version
printf '%s\n' "$name/README.md" "$name/package.json" "$name/search_everywhere.ts" > "$work/expected"
tar -tzf "$work/$archive" | LC_ALL=C sort > "$work/actual"
cmp "$work/expected" "$work/actual"
tar -xzf "$work/$archive" -C "$work"
for file in README.md package.json search_everywhere.ts; do
  test -f "$work/$name/$file" && test ! -L "$work/$name/$file"
done
dest="${XDG_CONFIG_HOME:-$HOME/.config}/fresh/plugins/packages/search-everywhere"
mkdir -p "$(dirname "$dest")"
if test -e "$dest" || test -L "$dest"; then
  mv "$dest" "$work/previous-search-everywhere"
fi
mv "$work/$name" "$dest"
printf 'Installed. Backup/downloads retained at %s\n' "$work"
```

Restart Fresh. Keep the printed backup directory until installation is confirmed; restore its `previous-search-everywhere` directory to `dest` if needed. Do not also install a loose `search_everywhere.ts` plugin: that would register the plugin twice. Checksums detect corruption; they do not independently authenticate the publisher.

## Current behavior and limits

The package preserves the source plugin's controller and UI. There is **no default filename backend**: a file provider must be registered through the `search-everywhere` plugin API. Workspace symbols default to Kotlin. Built-in bounded ripgrep is intentionally unavailable; content search needs a registered grep provider. Packaging checks and controlled native fixtures do not establish full default-backend search acceptance.

[Source and tests](https://github.com/toxyduck/monorepo/tree/main/packages/search-everywhere).
Public distribution does not grant an open-source license; the manifest is `UNLICENSED`.

## Build and check (maintainers)

Node and pinned esbuild **0.25.12** are build/test-only dependencies. Build with npm in a disposable prefix and cache; no repository or global `node_modules` is needed. Archive creation uses GNU tar and gzip.

```sh
tools=$(mktemp -d)
release=$(mktemp -d)
npm install --prefix "$tools" --cache "$tools/cache" --no-audit --no-fund --save-exact esbuild@0.25.12
node packages/search-everywhere/scripts/build-package.mjs "$tools" "$release"
ESBUILD_PREFIX="$tools" node --test packages/search-everywhere/tests/package.test.mjs
node --experimental-strip-types --test packages/search-everywhere/tests/core.test.ts
```

Run from the repository root. The build updates the three committed `dist/` files and writes the archive, `SHA256SUMS`, and build metafile to the temporary release directory. Fresh loads the self-contained ES2020 bundle without npm imports. No third-party runtime is bundled.
