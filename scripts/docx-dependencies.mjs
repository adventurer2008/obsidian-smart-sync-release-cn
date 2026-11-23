import { readdir, readFile } from 'node:fs/promises';

const packages = new Set(`
@eigenpal/docx-editor-agents @eigenpal/docx-editor-core @eigenpal/docx-editor-i18n @eigenpal/docx-editor-react
@floating-ui/core @floating-ui/dom @floating-ui/react-dom @floating-ui/utils
@radix-ui/number @radix-ui/primitive @radix-ui/react-arrow @radix-ui/react-collection
@radix-ui/react-compose-refs @radix-ui/react-context @radix-ui/react-direction @radix-ui/react-dismissable-layer
@radix-ui/react-focus-guards @radix-ui/react-focus-scope @radix-ui/react-id @radix-ui/react-popper
@radix-ui/react-portal @radix-ui/react-presence @radix-ui/react-primitive @radix-ui/react-select @radix-ui/react-slot
@radix-ui/react-use-callback-ref @radix-ui/react-use-controllable-state @radix-ui/react-use-effect-event
@radix-ui/react-use-layout-effect @radix-ui/react-use-size @radix-ui/react-visually-hidden
@xmldom/xmldom aria-hidden clsx detect-node-es docxtemplater dompurify get-nonce jszip orderedmap pizzip
@noble/hashes adler-32 crc-32 cfb
prosemirror-commands prosemirror-dropcursor prosemirror-history prosemirror-keymap prosemirror-model
prosemirror-state prosemirror-tables prosemirror-transform prosemirror-view react react-dom react-remove-scroll
react-remove-scroll-bar react-style-singleton rope-sequence sax scheduler sonner tslib use-callback-ref
use-sidecar w3c-keyname xml-js
`.trim().split(/\s+/u));
const secureEditorPackages = new Set([
	'@codemirror/commands', '@codemirror/language', '@codemirror/streamparser',
	'@lezer/common', '@lezer/highlight', '@lezer/markdown', 'style-mod',
]);

export function bundledEditorPackage(input) {
	if (input === 'node_modules/pizzip/node_modules/pako/dist/pako.es5.min.js') return 'pizzip/node_modules/pako';
	const name = /^node_modules\/(@[^/]+\/[^/]+|[^/]+)\//u.exec(input)?.[1];
	return (packages.has(name) || secureEditorPackages.has(name)) &&
		!input.slice('node_modules/'.length).includes('/node_modules/') ? name : undefined;
}

export async function editorLicenseNotices(inputs) {
	const names = [...new Set(inputs.map(bundledEditorPackage).filter(Boolean))].sort();
	const files = [];
	const notices = [];
	for (const name of names) {
		const directory = `node_modules/${name}`;
		const metadataPath = `${directory}/package.json`;
		const { version, license } = JSON.parse(await readFile(metadataPath, 'utf8'));
		files.push(metadataPath);
		const entries = (await readdir(directory)).filter(file => /^(?:licen[sc]e|notice|copying)(?:\.|$)/iu.test(file)).sort();
		const paths = entries.map(file => `${directory}/${file}`);
		if (name === 'react-remove-scroll-bar') paths.push('scripts/docx-scroll-bar-license.txt');
		if (!paths.length) throw Error(`Missing license for editor dependency ${name}`);
		files.push(...paths);
		notices.push(`${name} ${version} (${license})\n` + (await Promise.all(paths.map(path => readFile(path, 'utf8')))).join('\n'));
	}
	return { files, text: notices.join('\n\n') };
}
