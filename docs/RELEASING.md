# Releasing Joshify

How a version gets cut, what a tag produces, and why the pipeline is shaped this
way. Covers tracker tasks **P8-02** (image published on tag) and **P8-05**
(versioning, changelog, tagged artefacts).

The whole pipeline is [`.github/workflows/release.yml`](../.github/workflows/release.yml).

---

## Cutting a release

```bash
git checkout main
git pull
pnpm verify                 # the same gate the tag will run. Fail here, not there
git tag -a v1.2.0 -m 'v1.2.0'
git push origin v1.2.0
```

That is the entire procedure. Everything below is what happens next, and why.

To rehearse a change to the pipeline without spending a version number, run the
workflow manually (**Actions → Release → Run workflow**). It builds and packages
everything and publishes nothing.

---

## What a tag produces

| Artefact | Where |
|---|---|
| `ghcr.io/joshhambright/joshify:1.2.0`, `:1.2`, `:1`, `:latest` | GHCR, `linux/amd64` + `linux/arm64` |
| `joshify-1.2.0.tar.gz` | Attached to the GitHub Release |
| `SHA256SUMS` | Attached to the GitHub Release |
| Release notes | The GitHub Release body |

`:latest` moves only for a stable tag. A pre-release (`v1.3.0-rc.1`) publishes
its exact version tags, is marked as a pre-release on GitHub, and leaves
`:latest` where it was.

---

## The tag is the version

`package.json` says `0.0.0` and stays there.

Every package in this workspace is `private: true` and none is published to npm.
A version field that npm never reads is a second source of truth that can only
ever drift from the first — and the failure mode is quiet: a tag that says 1.2.0
shipping an image labelled 1.1.0, discovered months later by someone debugging a
device.

So the git tag is authoritative, end to end. The workflow derives the version
from `GITHUB_REF_NAME`, and it flows into the tarball name, the image tags and
the image's `org.opencontainers.image.version` label. A Pi can answer "what am I
running" from `docker inspect` or from `/opt/joshify/current/VERSION`, and both
answers come from the tag.

If the workspace ever does publish to npm, that inverts: `package.json` becomes
the source of truth and the workflow should refuse a mismatch:

```bash
test "$(node -p 'require("./package.json").version')" = "${GITHUB_REF_NAME#v}" \
  || { echo '::error::tag does not match package.json'; exit 1; }
```

### What the numbers mean here

Joshify is an appliance, not a library, so semver is read from the operator's
side rather than an API consumer's:

- **major** — an upgrade needs a human. A re-auth, a config key that moved, a
  changed systemd unit name.
- **minor** — new capability, upgrade in place, nothing to do.
- **patch** — fixes only.

---

## The changelog

**Approach: generated at tag time from the commit range since the previous tag,
grouped by task ID, with GitHub's own generated notes appended underneath.**

The workflow reads `git log <previous-tag>..<tag>`, sorts by subject, and buckets
commits by the `P<phase>-<task>` prefix this repo already uses, producing:

```markdown
### Phase 7
- P7-03: systemd unit for joshify-server (`a1b2c3d`)
### Phase 8
- P8-02: publish the image from CI on tag (`e4f5a6b`)
```

### Why this and not the usual options

**Why not Conventional Commits** (`feat:` / `fix:`, with semantic-release or
release-please): it requires a commit convention this repo does not use and has
no reason to adopt. Commits here are `P8-02: <what changed>`, and the task IDs
are load-bearing — they are the primary key in [`TRACKING.md`](./TRACKING.md),
which is explicitly the handoff mechanism between sessions. Grouping by task ID
means the release notes and the tracker describe the same work in the same
vocabulary. Adopting `feat:`/`fix:` would add a second taxonomy that answers a
question nobody here asks, and would let a tool infer version numbers from commit
subjects, which is a decision worth making deliberately.

**Why not Changesets**: it is built for publishing many packages to npm with
independent versions. This workspace publishes nothing and ships as one unit. It
would add a per-PR ceremony (a changeset file) to buy coordination we do not
need.

**Why not a hand-maintained `CHANGELOG.md`**: it is the highest-quality option
and the one most likely to rot, because nothing fails when it is not updated.
The generated notes cannot rot — they are derived from what actually landed.

**Why keep GitHub's `--generate-notes` as well**: it answers a different
question. The grouped list says *what changed*; GitHub's section says *who* and
*through which pull requests*. Both are one flag, so there is no reason to pick.

### If a hand-written changelog is ever wanted

Add `CHANGELOG.md` with `## [1.2.0]` sections, and change the notes step to
prefer a matching section when one exists, falling back to the generated list
otherwise. That keeps the guarantee that a release always has notes, while
letting a release that deserves a narrative have one.

### Known limitation

Grouping is lexical, so `P10-*` would sort before `P2-*`. There are nine phases,
so this cannot bite today; if a Phase 10 ever appears, zero-pad the sort key.

---

## Two artefacts, because there are two install paths

### The image (P8-01, P8-02)

Multi-arch via `buildx` and QEMU: `linux/arm64` for the Pi (D-008), `linux/amd64`
so the compose file can be tried on a laptop. Built from the repo's
[`Dockerfile`](../Dockerfile), which is multi-stage — pnpm, TypeScript, Vite and
every devDependency exist in the build stages and reach the published image
never.

Expect about **285MB uncompressed, ~105MB to pull**: ~230MB of that is
`node:22-bookworm-slim` itself, ~51MB is the production dependency tree, and
~3MB is Joshify. If that ever needs to come down, the dependency tree is the
lever — the base image is not.

Pushed to GHCR with the automatic `GITHUB_TOKEN`. The `packages: write` scope is
granted to that one job and nothing else in the workflow; the workflow's default
is `contents: read`. There is no registry PAT stored anywhere.

**arm64 is emulated, and emulation is slow.** Expect the arm64 leg to dominate
the run. The upgrade path when that becomes annoying is GitHub's native arm64
runners: split the build into one job per architecture (`ubuntu-latest` and
`ubuntu-24.04-arm`), push by digest, and join them with
`docker buildx imagetools create`. That is a real speedup and a real increase in
workflow complexity, so it is written down here rather than done pre-emptively.

### The bundle (P8-04, P8-05)

`joshify-<version>.tar.gz` is what [`scripts/install.sh`](../scripts/install.sh)
consumes: manifests, a flat production `node_modules`, the compiled output, the
built panel, the systemd units, and the installer itself.

It ships **already built**, so no compiler runs on the Pi. That is most of the
reason a fresh install fits inside Phase 8's 30-minute exit criterion.

The tarball is built with `--sort=name --owner=0 --group=0 --mtime='@0'`, so two
builds of one tag are byte-identical and the published checksum means something.

#### ⚠️ Tripwire: the bundle is architecture-independent, and that is a property to defend

One tarball serves every architecture **only because every runtime dependency is
pure JavaScript** — `fastify`, `@fastify/websocket`, `jimp`. Nothing compiles a
native addon at install time, so a `node_modules` built on the CI runner runs
unmodified on a Pi.

**Adding a dependency with a native or platform-specific binary breaks this
silently.** The bundle would install fine and fail at runtime on the device, on
an error that points at the dependency rather than at this decision.

If that day comes, the fix is one of:

1. keep the dependency out of the runtime path (prefer this — it is usually a
   build-time tool);
2. build one bundle per architecture, and have the installer pick by `uname -m`;
3. drop the prebuilt tree and have the installer run `pnpm install --prod` on the
   device, accepting the extra minutes and the toolchain requirement.

Whoever adds the dependency should pick, and record it in `DECISIONS.md`.

---

## What CI runs before any of it

The release workflow's first job runs `pnpm install --frozen-lockfile` and then
`pnpm verify` — the identical command [`ci.yml`](../.github/workflows/ci.yml)
runs on every push, and the identical one a contributor runs locally. The image
and the bundle are gated on it, so a tag cannot ship something a branch would
have failed on.

**No Spotify credentials are involved, and none may be added.** The test suite
runs against the fake Spotify server (P1-10), and Joshify uses PKCE, so no client
secret exists anywhere to be leaked. The only credential in the workflow is the
automatic `GITHUB_TOKEN`.

---

## If a release goes wrong

Releases are cheap; a rewritten one is not. Prefer rolling forward.

- **The run failed before publishing** — fix, delete the tag locally and on the
  remote, re-tag. Nothing was published, so nothing is stale.
- **The image published but the release did not** — re-running the workflow is
  safe; the image tags are overwritten with identical content.
- **A bad version reached devices** — cut the next patch. Do not delete a
  published image: an appliance that pinned it will fail to restart, and it will
  fail at 1am, on a black screen, with no maintainer nearby. On the device,
  rolling back is one symlink (see [`INSTALL.md`](./INSTALL.md)).

---

## Not yet automated

- **The E2E smoke test (P8-06)** — a Playwright run against the fake Spotify
  server. It belongs in the `verify` job, as a gate on the tag, once it exists.
- **The optional `librespot` module (P8-09)** — will need its own unit and
  installer flag, and must never be able to break the core install.
