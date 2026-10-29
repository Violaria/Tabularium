const { mkdirSync, copyFileSync } = require('node:fs');
mkdirSync('dist/types', { recursive: true });
copyFileSync('src/types/types.d.ts', 'dist/types/types.d.ts');
const { readFileSync, writeFileSync } = require('node:fs');
const entry = 'dist/index.d.ts';
writeFileSync(entry, '/// <reference path="./types/types.d.ts" />\n' + readFileSync(entry, 'utf8'));
