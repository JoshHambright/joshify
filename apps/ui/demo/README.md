# The review build

`pnpm --filter @joshify/ui exec vite build --config vite.demo.config.ts`

Mounts the real `App.svelte` with the same props `main.ts` gives it, and swaps
only the three things that would otherwise need a server: the socket, the
command client and the device source. Everything else — components, tokens,
CSS, the progress model, the crossfade — is the code that ships.

That distinction is the whole point. A mockup can be right about the layout and
wrong about the thing that actually matters on a Pi: whether the crossfade
waits for a decode, whether the scrubber fights the poll while a finger is
down, whether the plate stays legible over a pale sleeve. Those are only
reviewable if the review runs the real code (D-016).

## Why the covers are data URIs

A published page has no network guarantee, and the crossfade's entire premise
is that it waits for a `decode()`. An image that never arrives would make the
panel look broken while behaving exactly as designed.

## The harness rail

The states worth reviewing — reconnecting, nothing playing, no device — are the
ones a reviewer cannot reach by tapping, and the ones most likely to be wrong.
Keeping them one button away is the difference between reviewing the panel and
reviewing its happy path. The rail ships on no device.

## What it does not yet show

- **The album's colour.** Extraction (P3-03) and application (P3-07) both
  exist; nothing connects them (P3-13), so the accent stays neutral.
- **The Search surface.** Built and tested (P6-02/03/04/08), not yet reachable.
- **Not-Premium**, except by forcing it: the flag is not on the wire (P3-14).
