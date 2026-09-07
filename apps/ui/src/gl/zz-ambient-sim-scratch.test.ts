import { it } from 'vitest';
import { AMBIENT_MESH, ATTRIBUTE_FACE, ATTRIBUTE_HOME, ATTRIBUTE_POSITION, ATTRIBUTE_SPIN, ATTRIBUTE_TRAIT } from './scenes/ambient.js';
it('sim', () => {
/* Throwaway: replays the ambient vertex shader in JS and rasterises coverage. */

const data = (loc: number) => AMBIENT_MESH.attributes.find((a) => a.location === loc)!.data;
const P = data(ATTRIBUTE_POSITION), F = data(ATTRIBUTE_FACE), H = data(ATTRIBUTE_HOME),
      S = data(ATTRIBUTE_SPIN), T = data(ATTRIBUTE_TRAIT);
const idx = AMBIENT_MESH.indices!;

const FOCAL = 1 / Math.tan(1.15 / 2), NEAR = 0.5, FAR = 500, CALM = 0.25;
const turn = (a: number[], ang: number) => {
  const c = Math.cos(ang), s = Math.sin(ang), t = 1 - c;
  // column-major cols
  return [
    [t*a[0]*a[0]+c, t*a[0]*a[1]+s*a[2], t*a[0]*a[2]-s*a[1]],
    [t*a[0]*a[1]-s*a[2], t*a[1]*a[1]+c, t*a[1]*a[2]+s*a[0]],
    [t*a[0]*a[2]+s*a[1], t*a[1]*a[2]-s*a[0], t*a[2]*a[2]+c],
  ];
};
const mul = (m: number[][], v: number[]) => [
  m[0][0]*v[0]+m[1][0]*v[1]+m[2][0]*v[2],
  m[0][1]*v[0]+m[1][1]*v[1]+m[2][1]*v[2],
  m[0][2]*v[0]+m[1][2]*v[1]+m[2][2]*v[2],
];

const run = (time: number, intensity: number, size: number, beat: number) => {
  const motion = CALM + (1 - CALM) * intensity;
  const aspect = 16 / 9;
  const out: { ndc: number[][]; kind: string; solid: number; culled: boolean }[] = [];
  for (let tri = 0; tri * 3 < idx.length; tri += 1) {
    const verts = [0, 1, 2].map((o) => idx[tri * 3 + o]);
    if (T[verts[0] * 4 + 3] > 0.5) { out.push({ ndc: [], kind: 'field', solid: -1, culled: false }); continue; }
    const ndc: number[][] = []; let culled = false; let solidDepth = 0;
    for (const v of verts) {
      const home = [H[v*3], H[v*3+1], H[v*3+2]];
      const depth = -home[2]; solidDepth = depth;
      const rate = T[v*4+1], phase = T[v*4], radius = T[v*4+2];
      const wander = 1 * depth * 0.05;
      const off = [Math.sin(time*rate*motion+phase)*wander, Math.cos(time*rate*0.78*motion+phase*1.7)*wander];
      off[1] += Math.sin(0.3 * 2*Math.PI) * 0.12 * intensity * depth * 0.02;
      const centre = [home[0]+off[0], home[1]+off[1], home[2]];
      const scale = radius * size * (1 + 0.12 * intensity * beat);
      const spin = turn([S[v*4],S[v*4+1],S[v*4+2]], 2*Math.PI*S[v*4+3]*1*motion*time);
      const normal = mul(spin, [F[v*4],F[v*4+1],F[v*4+2]]);
      const world = centre.map((c, i) => c + mul(spin, [P[v*3],P[v*3+1],P[v*3+2]])[i] * scale);
      const side = -(normal[0]*centre[0]+normal[1]*centre[1]+normal[2]*centre[2]) - F[v*4+3]*scale;
      if (side <= 0) culled = true;
      const w = -world[2];
      ndc.push([world[0]*FOCAL/aspect/w, world[1]*FOCAL/w, (((FAR+NEAR)*world[2]+2*FAR*NEAR)/(NEAR-FAR))/w]);
    }
    out.push({ ndc, kind: 'solid', solid: solidDepth, culled });
  }
  return out;
};

for (const [time, intensity, size, beat] of [[0,1,1,0],[37.5,1,1,1],[900,0,1.25,0],[3600,1,0.4,0]] as const) {
  const tris = run(time, intensity, size, beat);
  const solids = tris.filter((t) => t.kind === 'solid');
  const drawn = solids.filter((t) => !t.culled);
  const byDepth = new Map<number, {drawn: number; total: number}>();
  for (const t of solids) {
    const e = byDepth.get(t.solid) ?? { drawn: 0, total: 0 };
    e.total += 1; if (!t.culled) e.drawn += 1; byDepth.set(t.solid, e);
  }
  const bad = drawn.some((t) => t.ndc.some((p) => p.some((c) => !Number.isFinite(c)) || Math.abs(p[2]) > 1));
  console.log(`t=${time} i=${intensity} size=${size} beat=${beat}: ${drawn.length}/${solids.length} tris drawn, nan/zclip=${bad}`,
    [...byDepth.entries()].map(([d, e]) => `${d}:${e.drawn}/${e.total}`).join(' '));

  // ASCII coverage
  const W = 76, Hh = 26;
  const grid = Array.from({ length: Hh }, () => new Array(W).fill(' '));
  const order = ['#','@','o','+','.'];
  const depths = [...new Set(solids.map(s=>s.solid))].sort((a,b)=>b-a);
  for (const t of drawn) {
    const ch = order[depths.indexOf(t.solid)] ?? '?';
    const [a,b,c] = t.ndc;
    for (let y = 0; y < Hh; y += 1) for (let x = 0; x < W; x += 1) {
      const px = (x + 0.5) / W * 2 - 1, py = 1 - (y + 0.5) / Hh * 2;
      const s1 = (b[0]-a[0])*(py-a[1])-(b[1]-a[1])*(px-a[0]);
      const s2 = (c[0]-b[0])*(py-b[1])-(c[1]-b[1])*(px-b[0]);
      const s3 = (a[0]-c[0])*(py-c[1])-(a[1]-c[1])*(px-c[0]);
      if ((s1>=0&&s2>=0&&s3>=0)||(s1<=0&&s2<=0&&s3<=0)) grid[y][x] = ch;
    }
  }
  console.log(grid.map((r) => '|' + r.join('') + '|').join('\n'));
}

});
