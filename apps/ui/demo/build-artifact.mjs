/**
 * Fold a demo build into one file the Artifact tool can publish.
 *
 * Vite emits the page and its bundle separately, and a published Artifact is a
 * single document with no second request available to it. So this inlines the
 * module and strips the document scaffolding the publisher supplies itself
 * (`<!doctype>`, `<html>`, `<head>`, `<body>`), leaving the `<title>`, the
 * `<style>` and the body content.
 *
 * It exists because the published page is **not storage** (CLAUDE.md): the
 * container dies, and a review page that can only be rebuilt by hand is a page
 * that quietly stops matching the code it is supposed to be showing.
 *
 *   node demo/build-artifact.mjs <dir> <page.html> "<Title>"
 *
 * `<dir>` is relative to `apps/ui/`, or absolute — the build log under `site/`
 * has no bundler but needs the same fold. All three published pages go through
 * it, so none of them can drift into being assembled by hand, which is how a
 * published page stops matching the source it is supposed to be showing.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const [distName = 'dist-visualiser', pageName = 'visualiser.html', title = 'Joshify'] =
  process.argv.slice(2);

const dist = distName.startsWith('/')
  ? distName.replace(/\/?$/, '/')
  : fileURLToPath(new URL(`../${distName}/`, import.meta.url));
const page = readFileSync(`${dist}${pageName}`, 'utf8');

/*
 * A bundled page keeps its module in `assets/`; a hand-written one (the build
 * log) has its script inline in the body and no `assets/` at all. Both fold the
 * same way — an inline `<script>` survives the body extraction untouched, so
 * there is simply nothing to append.
 */
const assets = existsSync(`${dist}assets`)
  ? readdirSync(`${dist}assets`).filter((name) => name.endsWith('.js'))
  : [];
if (assets.length > 1) {
  throw new Error(`expected at most one bundle, found ${String(assets.length)}`);
}
const bundle =
  assets[0] === undefined ? '' : readFileSync(`${dist}assets/${assets[0]}`, 'utf8');

const between = (source, open, close) => {
  const start = source.indexOf(open);
  const end = source.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`could not find ${open}`);
  return source.slice(start + open.length, end);
};

/*
 * The publisher wraps what it is given in its own document, so everything above
 * <body> is dropped except the styles and the stylesheet links.
 *
 * The links are not optional. SCREENS.md's measurements are made in specific
 * faces, and a review page that renders the type in a fallback is reviewing a
 * different design — so the font stylesheet has to survive the fold.
 */
const pageStyle = between(page, '<style>', '</style>');
const head = page.slice(0, page.indexOf('</head>'));
const tags = [...head.matchAll(/<link\b[^>]*>/g)]
  .map((match) => match[0])
  .filter((tag) => !tag.includes('rel="modulepreload"'));

/*
 * A local stylesheet is folded in; a remote one is kept as a link.
 *
 * Vite emits the compiled component CSS as its own file even with
 * `cssCodeSplit` off, and a published artifact gets no second request — so an
 * un-inlined stylesheet is a page with no styles at all, which looks like the
 * build broke rather than like a missing file.
 */
const local = (tag) => /href="\.\//.test(tag);
const hrefOf = (tag) => /href="([^"]+)"/.exec(tag)?.[1] ?? '';
const bundledCss = tags
  .filter(local)
  .map((tag) => readFileSync(`${dist}${hrefOf(tag).replace('./', '')}`, 'utf8'))
  .join('\n');
const links = tags.filter((tag) => !local(tag)).join('\n');
const style = `${pageStyle}\n${bundledCss}`;
const body = between(page, '<body>', '</body>').replace(
  /\s*<script[^>]*><\/script>/g,
  '',
);

const out = `${dist}artifact.html`;
writeFileSync(
  out,
  [
    `<title>${title}</title>`,
    links,
    `<style>${style}</style>`,
    body.trim(),
    bundle === '' ? '' : `<script type="module">\n${bundle}\n</script>`,
    '',
  ].join('\n'),
);
console.log(out);
