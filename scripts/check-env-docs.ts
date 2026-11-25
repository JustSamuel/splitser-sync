import { readdir, readFile } from 'node:fs/promises';

// Every environment variable the code reads must be documented in
// .env.example, and every documented variable must still be read.
const read = new Set<string>();
for (const file of (await readdir('src')).filter((name) =>
  name.endsWith('.ts'),
)) {
  const source = await readFile(`src/${file}`, 'utf8');
  for (const match of source.matchAll(
    /\benv\.([A-Z][A-Z0-9_]+)|['"]([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)['"]/g,
  ))
    read.add((match[1] ?? match[2]) as string);
}
const example = await readFile('.env.example', 'utf8');
const documented = new Set(
  [...example.matchAll(/^#? ?([A-Z][A-Z0-9_]+)=/gm)].map(
    (match) => match[1] as string,
  ),
);

const failures = [
  ...[...read]
    .filter((name) => !documented.has(name))
    .map((name) => `${name} is read in src/ but missing from .env.example`),
  ...[...documented]
    .filter((name) => !read.has(name))
    .map((name) => `${name} is in .env.example but never read in src/`),
];
if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
