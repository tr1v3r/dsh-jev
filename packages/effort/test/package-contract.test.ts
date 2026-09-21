import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(
  readFileSync(resolve(packageDir, 'package.json'), 'utf8'),
) as { name: string };

describe('published package identity', () => {
  it('uses the manifest name in both host and browser bundle entries', () => {
    const hostBundle = readFileSync(resolve(packageDir, 'cordis.patch.yml'), 'utf8');
    const browserBundle = readFileSync(resolve(packageDir, 'lib/client.js'), 'utf8');

    expect(hostBundle).toContain(`name: '${manifest.name}'`);
    expect(browserBundle).toContain(`id: "${manifest.name}"`);
  });
});
