// Runs before `npm test`: explains what's missing instead of failing with a cryptic error.
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const [major] = process.versions.node.split('.').map(Number);
if (major < 22) problems.push(`Node.js 22 or newer is required (you have ${process.version}). Install it from https://nodejs.org.`);
if (!existsSync(join(root, 'node_modules', 'vitest'))) problems.push('Dependencies are not installed. Run: npm install');
if (!existsSync(join(root, 'vendor', 'pokemon-showdown', 'dist', 'sim', 'index.js'))) problems.push('The Showdown simulator is not built. Run: npm run setup');
if (problems.length) {
	console.error('\nSetup is not finished:\n' + problems.map(p => `  - ${p}`).join('\n') + '\n');
	process.exit(1);
}
