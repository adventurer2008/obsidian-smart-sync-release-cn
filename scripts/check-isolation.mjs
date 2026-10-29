import { readFile } from 'node:fs/promises';

const selected = process.argv[2];
if (selected && !['cn', 'global'].includes(selected)) throw Error('Unknown edition');
const folder = selected ? `artifacts/${selected}` : 'artifacts';
const metadata = JSON.parse(await readFile(`${folder}/dependency-map.json`, 'utf8'));
const expected = [
	'src/edition.js',
	'src/android-transport.js',
	'src/billing.js',
	'src/client.js',
	'src/compatibility.js',
	'node_modules/@noble/ed25519/index.js',
	'node_modules/fflate/esm/browser.js',
	'src/checkpoint.js',
	'src/codec.js',
	'src/configuration.js',
	'src/routing.js',
	'src/merge.js',
	'node_modules/node-diff3/dist/diff3.mjs',
	'src/plugin.js',
	'src/pinning.js',
	'src/search.js',
	'src/note-crypto.js',
	'src/note-encryption.js',
	'src/pairing.js',
	'src/recovery.js',
	'src/synchronizer.js',
	'src/tasks.js',
	'src/i18n.js',
	'src/planning.js',
	'src/desktop.js',
	'src/background-tray.js',
	'src/startup.js',
	'src/peers.js',
	'src/resume.js',
];
if (selected) expected.push('<define:__SMART_SYNC_EDITION__>');
expected.sort();
const actual = Object.keys(metadata.inputs).sort();
if (JSON.stringify(actual) !== JSON.stringify(expected))
	throw new Error(`Unexpected source dependency: ${actual.join(', ')}`);
const imports = Object.values(metadata.outputs).flatMap((output) => output.imports);
if (imports.some((entry) => !entry.external || !['obsidian', '@codemirror/state', '@codemirror/view'].includes(entry.path)))
	throw new Error('Unexpected bundled or runtime dependency');
const manifest = JSON.parse(await readFile('manifest.json', 'utf8'));
const built = JSON.parse(await readFile(`${folder}/manifest.json`, 'utf8'));
if (selected) {
 const { loadEdition } = await import('./edition-config.mjs');
 const config = await loadEdition(selected);
 Object.assign(manifest, { id: config.id, name: config.name });
}
if (JSON.stringify(manifest) !== JSON.stringify(built)) throw new Error('Manifest drift');
console.log(
	'Plugin closure verified: twenty-six source modules and the licensed node-diff3, noble-ed25519 and fflate modules; Obsidian and its host CodeMirror interfaces are the only external runtime imports.',
);
