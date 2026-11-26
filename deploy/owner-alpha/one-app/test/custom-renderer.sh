#!/bin/bash
# Deliberately tiny renderer with one known synthetic source. It is copied by
# the lab into the persistent, node-only renderer slot, never the app image.
set -euo pipefail
[[ $# == 2 && "$CYBERBASER_SOURCE_PROVENANCE" == enabled && "$CYBERBASER_EDIT_LINK_MODE" == owner ]]
[[ -z $(ip -4 route show) && -z $(ip -6 route show) ]]
# This succeeds in the node's normal namespace; a separate network namespace
# cannot even reach that same loopback listener.
if curl -fsS --noproxy '*' --max-time 2 http://127.0.0.1:48080/_control/report >/dev/null 2>&1; then exit 1; fi
bun - "$@" <<'JS'
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
const [source, out] = process.argv.slice(2);
const text = (await readFile(path.join(source, 'Garden/Note.md'), 'utf8')).trim();
if (!text.startsWith('# Lab note\n') || !text.includes('This is the signed synthetic update.')) throw new Error('unexpected input');
const html = (text) => `<!doctype html><html lang="en"><title>Lab note</title><body><main data-renderer="one-app-fixture">${text}</main></body></html>\n`;
await mkdir(path.join(out, 'Garden'), { recursive: true });
await writeFile(path.join(out, 'index.html'), html('<a href="./Garden/Note">Lab note</a>'));
await writeFile(path.join(out, 'Garden/Note.html'), html(`<h1>Lab note</h1><p>${Bun.escapeHTML(text.split('\n').at(-1))}</p>`));
JS
