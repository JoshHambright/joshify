# Spike: N2O tunnel (Phase 5)

A working WebGL2 prototype of the PS1-era tunnel visualiser mode.
Published for review at the artifact link in the session; the source lives here
so it survives the container.

**Open `index.html` in any browser.** No build step, no dependencies.

## What it proves

| Claim | Verified how |
|---|---|
| The PS1 artefact set is reproducible in GLSL | All six are implemented and individually toggleable |
| Album art works as a tunnel texture | 256px, `NEAREST`, `REPEAT` — tiles down the tube |
| Accent extraction drives the scene | Sampled from the cover at load; feeds fog + beat flash |
| Tier 1 beat maths feels right | `pow(1-phase,4)` off BPM, phase-locked, adjustable live |
| Half-res rendering *is* the aesthetic (D-011) | Renders to ~320x180, upscales `NEAREST` |
| It's cheap | One draw call, ~1600 verts, no libraries |

## Techniques worth keeping

**Vertex snap** — round NDC to a coarse grid in the vertex shader:
```glsl
vec3 ndc = clip.xyz/clip.w;
ndc.xy = floor(ndc.xy*grid + 0.5)/grid;
clip.xyz = ndc*clip.w;
```

**Affine texture mapping** — cancel the GPU's perspective correction by
premultiplying UVs by `w` and dividing in the fragment shader:
```glsl
// vertex
vW = mix(1.0, clip.w, uAffine);   // uAffine=0 -> perspective-correct
vUv = aUv*vW;
// fragment
vec2 uv = vUv/vW;
```
Perspective-correct interpolation computes `sum(Li*Vi/wi) / sum(Li/wi)`. With
`Vi = uv_i * w_i` the numerator collapses to `sum(Li*uv_i)`, and dividing by the
interpolated `w` leaves plain linear interpolation — affine, exactly as the PSX
GPU did it.

**No z-buffer** — `gl.disable(gl.DEPTH_TEST)` with rings drawn back-to-front.
The sorting errors are the effect.

**Tunnel curve that doesn't clip the camera** — fade the curve offset toward
the near plane so the ring you are inside stays centred:
```glsl
float ease = smoothstep(0.0, 70.0, -z);
```

## Known gaps (deliberate — it's a spike)

- Beat is simulated from a BPM slider, not a real ISRC lookup or FFT.
- Album covers are procedurally generated, not fetched from Spotify.
- No preset system; the effect chain is fixed.
- Not tested on Pi hardware — that is P3-01 / P5-30.
