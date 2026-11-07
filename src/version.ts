import fs from 'node:fs';
import path from 'node:path';

/** Replaced with the package version when the Hermes plugin is bundled. */
declare const __LEAFI_VERSION__: string | undefined;

/** The package version, read from `package.json` so it is written in one place. */
export const VERSION: string =
  typeof __LEAFI_VERSION__ === 'string' ? __LEAFI_VERSION__ : readPackageVersion();

function readPackageVersion(): string {
  // dist/version.js and src/version.ts both sit one level below the package root.
  const file = path.join(__dirname, '..', 'package.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}
