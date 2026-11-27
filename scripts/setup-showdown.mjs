// Fetches the pinned Pokemon Showdown submodule and builds it (JS + type declarations).
// Cross-platform: run with `npm run setup` after `npm install`.
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ps = join(root, 'vendor', 'pokemon-showdown');

function run(cmd, cwd) {
	console.log(`> ${cmd}${cwd !== root ? `   (in ${cwd})` : ''}`);
	execSync(cmd, { cwd, stdio: 'inherit' });
}

if (!existsSync(join(ps, 'package.json'))) {
	run('git submodule update --init --depth 1 vendor/pokemon-showdown', root);
}
run('npm install --no-audit --no-fund', ps);
run('node build', ps);
// Type declarations for the simulator API (same command Showdown uses for its npm package).
run(
	'npx tsc --ignoreConfig sim/global-types.ts sim/index.ts --declaration --emitDeclarationOnly ' +
	'--declarationDir dist/ --target es2020 --strict --module commonjs --moduleResolution bundler ' +
	'--types node --lib es2020',
	ps,
);
console.log('\nShowdown is built. Pinned commit:');
run('git rev-parse HEAD', ps);
