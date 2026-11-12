#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dist = path.join(__dirname, '..', 'dist', 'cli.js');

try {
  await import(pathToFileURL(dist).href);
} catch (err) {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
}
