// The plug-in's sharing dialog words sharing as the web pages do. Its repository builds on its own, so it carries a copy of
// the sharing texts and server error texts of apps/server/ui/messages.ts. This script writes that copy; with --check it
// fails when the copy is out of date (part of npm run check).
import { readFileSync, writeFileSync } from 'node:fs';
import { catalogues } from '../apps/server/ui/messages.ts';

const target = new URL('../apps/obsidian/src/features/tabularium/share/texts.ts', import.meta.url);
const pick = (catalogue) => Object.fromEntries(Object.entries(catalogue).filter(([key]) => key.startsWith('share.') || key.startsWith('error.')));
const body = Object.entries(catalogues).map(([lang, catalogue]) => `    ${lang}: ${JSON.stringify(pick(catalogue), null, 4).replace(/\n/g, '\n    ')},`).join('\n');
const text = `// Sharing texts and server error texts of the web pages (apps/server/ui/messages.ts in the Tabularium repository).
// Written by scripts/share-texts.mjs there; do not edit here.
export const catalogues = {
${body}
} as const;
export type Language = keyof typeof catalogues;
`;
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== text) {
    process.stderr.write('apps/obsidian/src/features/tabularium/share/texts.ts is out of date: run node scripts/share-texts.mjs\n');
    process.exit(1);
  }
} else writeFileSync(target, text);
