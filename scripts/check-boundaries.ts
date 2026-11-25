import { readdir, readFile } from 'node:fs/promises';

// scripts/boundaries.json lists, per risky token, which source files may
// contain it and why. A listed file that no longer contains the token is
// stale and fails, so the allowlist cannot silently grow or rot.
const config: {
  boundaries: Record<string, Record<string, string>>;
  mayPrintCredentials: Record<string, string>;
} = JSON.parse(await readFile('scripts/boundaries.json', 'utf8'));

const names = (await readdir('src')).filter((name) => name.endsWith('.ts'));
const sources = new Map<string, string>();
for (const file of names)
  sources.set(file, await readFile(`src/${file}`, 'utf8'));

const failures: string[] = [];
for (const [token, owners] of Object.entries(config.boundaries)) {
  for (const [file, source] of sources) {
    if (source.includes(token) && !(file in owners))
      failures.push(
        `${file}: ${token} belongs to ${Object.keys(owners).join(', ')}`,
      );
  }
  for (const [file, reason] of Object.entries(owners)) {
    if (!reason.trim()) failures.push(`${token}: ${file} needs a reason`);
    if (!sources.get(file)?.includes(token))
      failures.push(`${token}: ${file} is allowlisted but no longer uses it`);
  }
}

const credentialLogging =
  /console\.(?:log|error)\([^)]*(?:password|secret|cookie|token)/i;
for (const [file, source] of sources) {
  if (credentialLogging.test(source) && !(file in config.mayPrintCredentials))
    failures.push(`${file}: possible credential logging`);
}
for (const [file, reason] of Object.entries(config.mayPrintCredentials)) {
  if (!reason.trim())
    failures.push(`credential logging: ${file} needs a reason`);
  if (!credentialLogging.test(sources.get(file) ?? ''))
    failures.push(
      `credential logging: ${file} is allowlisted but no longer prints credentials`,
    );
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exitCode = 1;
}
