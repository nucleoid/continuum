#!/usr/bin/env node
import { runTagVocabularyCli } from '../dist/cli/tag-vocabularies.js';

await runTagVocabularyCli(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`continuum-tags: ${error.message}\n`);
  process.exitCode = 1;
});
