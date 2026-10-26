import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { loadEdition } from './edition-config.mjs';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
if (args.length > 1 || args.some(value => !['--edition=cn', '--edition=global', '--all'].includes(value))) throw Error('Use --edition=cn, --edition=global or --all');
const selections = args[0] === '--all' ? ['cn', 'global'] : args.length ? [args[0].split('=')[1]] : [null];
const license = (await readFile('LICENSE', 'utf8')).replaceAll('\r\n', '\n');
const logo = (await readFile('assets/boundless-sync.png')).toString('base64');
const dependencyNotices = (await readFile('THIRD-PARTY-NOTICES.md', 'utf8')).replaceAll(
	'\r\n',
	'\n',
);
for (const selected of selections) {
const config = selected ? await loadEdition(selected) : null;
const output = selected ? `artifacts/${selected}` : 'artifacts';
await mkdir(output, { recursive: true });
const result = await build({
	entryPoints: ['src/plugin.js'],
	bundle: true,
	preserveSymlinks: true,
	format: 'cjs',
	platform: 'browser',
	target: ['es2022', 'safari15.4'],
	external: ['obsidian', '@codemirror/state', '@codemirror/view'],
	outfile: `${output}/main.js`,
	define: {
		...(config ? { __SMART_SYNC_EDITION__: JSON.stringify({ ...config, development: false }) } : {}),
		__SMART_SYNC_TRAY_LOGO__: JSON.stringify(`data:image/png;base64,${logo}`),
	},
	minify: true,
	metafile: true,
	banner: { js: `/* Smart Sync protocol 2 test candidate.\n${license}\n${dependencyNotices}\n*/` },
});
await writeFile(`${output}/dependency-map.json`, JSON.stringify(result.metafile, null, 2));
if (config) {
 const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
 Object.assign(manifest, { id: config.id, name: config.name });
 await writeFile(`${output}/manifest.json`, JSON.stringify(manifest, null, 2) + '\n');
 await writeFile(`${output}/edition.json`, JSON.stringify(config, null, 2) + '\n');
} else await copyFile('manifest.json', `${output}/manifest.json`);
const styles = (await readFile('source-styles.css', 'utf8')).replace("./assets/boundless-sync.png", `data:image/png;base64,${logo}`);
await writeFile(`${output}/styles.css`, styles);
if (config) {
 const sha = bytes => createHash('sha256').update(bytes).digest('hex');
 const inputs = {};
 const paths = [...Object.keys(result.metafile.inputs).filter(path => path !== '<define:__SMART_SYNC_EDITION__>'), 'scripts/build.mjs', 'scripts/edition-config.mjs', `editions/${selected}.json`, 'manifest.json', 'package.json', 'package-lock.json', 'source-styles.css', 'assets/boundless-sync.png', 'LICENSE', 'THIRD-PARTY-NOTICES.md'];
 for (const path of [...new Set(paths)].sort()) inputs[path] = sha(await readFile(path));
 const files = {};
 for (const part of ['main.js', 'manifest.json', 'styles.css']) files[part] = sha(await readFile(`${output}/${part}`));
 const receipt = { format: 'smart-sync-build-1', edition: selected, inputs, files };
 await writeFile(`${output}/build-receipt.json`, JSON.stringify({ ...receipt, checksum: sha(JSON.stringify(receipt)) }, null, 2) + '\n');
}
console.log(`Built ${selected ?? 'local development'} plugin artifacts in ${output}. No installation or publication performed.`);
}
