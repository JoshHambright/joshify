/**
 * Fold the visualiser build into one file the Artifact tool can publish.
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
 *   pnpm --filter @joshify/ui build:visualiser
 *   node demo/build-artifact.mjs            # -> dist-visualiser/artifact.html
 */
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist-visualiser/', import.meta.url));
const page = readFileSync(`${dist}visualiser.html`, 'utf8');

const assets = readdirSync(`${dist}assets`).filter((name) => name.endsWith('.js'));
if (assets.length !== 1) {
  throw new Error(`expected exactly one bundle, found ${String(assets.length)}`);
}
const bundle = readFileSync(`${dist}assets/${assets[0]}`, 'utf8');

const between = (source, open, close) => {
  const start = source.indexOf(open);
  const end = source.indexOf(close, start);
  if (start < 0 || end < 0) throw new Error(`could not find ${open}`);
  return source.slice(start + open.length, end);
};

// The publisher wraps what it is given in its own document, so anything above
// <body> other than the title and the styles has to go.
const style = between(page, '<style>', '</style>');
const body = between(page, '<body>', '</body>').replace(
  /\s*<script[^>]*><\/script>/g,
  '',
);

const out = `${dist}artifact.html`;
writeFileSync(
  out,
  [
    '<title>Joshify Visualiser</title>',
    `<style>${style}</style>`,
    body.trim(),
    `<script type="module">\n${bundle}\n</script>`,
    '',
  ].join('\n'),
);
console.log(out);
