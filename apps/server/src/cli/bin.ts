#!/usr/bin/env node
import { main } from './joshify.js';

main(process.argv.slice(2), process.env)
  .then((code) => {
    process.exitCode = code;
  })
  .catch((cause: unknown) => {
    // Anything reaching here is a bug rather than an expected failure; expected
    // ones are returned as exit codes with a printed explanation.
    process.stderr.write(`joshify: unexpected error\n${String(cause)}\n`);
    process.exitCode = 70;
  });
