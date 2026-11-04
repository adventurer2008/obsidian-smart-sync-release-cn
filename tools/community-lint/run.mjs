import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

// U91/R101, DEC078, CHG-20261016-51: inspect actual runtime .js, including typed rules.
const tools = dirname(fileURLToPath(import.meta.url));
const root = resolve(tools, '../..');
process.chdir(root);
const { default: obsidianmd } = await import('eslint-plugin-obsidianmd');
const edition = process.argv[2];
if (edition !== undefined && !['cn', 'global'].includes(edition))
	throw new Error('Unknown regional lint edition');
const artifactRoot = resolve('artifacts', edition ?? '');
const manifest = JSON.parse(await readFile(edition ? resolve(artifactRoot, 'manifest.json') : 'manifest.json', 'utf8'));
if (
	!/^[a-z]+(?:-[a-z]+)*$/.test(manifest.id) ||
	manifest.id.includes('obsidian') ||
	manifest.id.endsWith('plugin')
)
	throw new Error('Plugin ID does not satisfy the Community manifest rules');
const files = (await readdir('src')).filter((file) => file.endsWith('.js')).sort();
const map = JSON.parse(await readFile(resolve(artifactRoot, 'dependency-map.json'), 'utf8'));
const bundled = Object.keys(map.inputs)
	.filter((file) => file.startsWith('src/'))
	.sort();
if (
	files.length !== 26 ||
	JSON.stringify(files.map((file) => `src/${file}`)) !== JSON.stringify(bundled)
)
	throw new Error('Lint coverage differs from the full client runtime closure');
const generated = resolve('local-test-data/community-lint');
const sdk = resolve(generated, 'sdk/obsidian');
await mkdir(sdk, { recursive: true });
const installed = resolve(tools, 'node_modules/obsidian-api-current');
for (const file of await readdir(installed))
	if (file.endsWith('.d.ts') || file === 'package.json')
		await copyFile(resolve(installed, file), resolve(sdk, file));
const sdkMetadata = JSON.parse(await readFile(resolve(sdk, 'package.json'), 'utf8'));
const config = resolve(generated, 'tsconfig.json');
await writeFile(
	config,
	JSON.stringify(
		{
			compilerOptions: {
				allowJs: true,
				checkJs: false,
				noEmit: true,
				skipLibCheck: true,
				target: 'ES2022',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				baseUrl: root,
				paths: { obsidian: [resolve(sdk, 'obsidian.d.ts')] },
			},
			files: files.map((file) => resolve(root, 'src', file)),
		},
		null,
		2,
	),
);
const lint = new ESLint({
	cwd: root,
	overrideConfigFile: true,
	fix: false,
	overrideConfig: [
		...obsidianmd.configs.recommended,
		{
			settings: { 'import/resolver': { node: { paths: [resolve(tools, 'node_modules')] } } },
		},
		{
			files: ['src/*.js'],
			languageOptions: {
				parserOptions: {
					project: config,
					tsconfigRootDir: root,
					disallowAutomaticSingleRunInference: true,
				},
			},
			rules: {
				...obsidianmd.ruleConfigs.recommendedTypeChecked,
				'obsidianmd/ui/sentence-case': [
					'warn',
					{
						brands: ['Smart Sync'],
						acronyms: ['API', 'ID', 'JSON', 'LAN', 'MiB', 'URL', 'HTTP', 'HTTPS'],
						enforceCamelCaseLower: true,
					},
				],
			},
		},
	],
});
const results = await lint.lintFiles(['src/*.js', 'package.json']);
// Prove the type-dependent API rule is active, rather than silently missing the SDK.
const probe = new ESLint({
	cwd: root,
	overrideConfigFile: true,
	overrideConfig: [
		...obsidianmd.configs.recommended,
		{
			files: ['src/*.js'],
			languageOptions: {
				parserOptions: {
					project: config,
					tsconfigRootDir: root,
					disallowAutomaticSingleRunInference: true,
				},
			},
			rules: { 'obsidianmd/no-unsupported-api': ['error', { minAppVersion: '0.9.7' }] },
		},
	],
});
const probeResults = await probe.lintFiles(['src/plugin.js']);
const apiProbeErrors = probeResults
	.flatMap((file) => file.messages)
	.filter((message) => message.ruleId === 'obsidianmd/no-unsupported-api');
if (!apiProbeErrors.some((message) => message.message.includes('secretStorage')))
	throw new Error('Type-aware API coverage probe did not detect the deliberately low minimum');
const diagnostics = results.flatMap((file) =>
	file.messages.map((message) => ({
		file: file.filePath.slice(root.length + 1).replaceAll('\\', '/'),
		line: message.line,
		column: message.column,
		severity: message.severity,
		rule: message.ruleId,
		message: message.message,
	})),
);
const report = {
	change: 'CHG-20261016-51',
	pluginId: manifest.id,
	version: manifest.version,
	minAppVersion: manifest.minAppVersion,
	apiDeclarations: sdkMetadata.version,
	runtimeFiles: bundled,
	ignoredRuntimeFiles: 0,
	typedRulesEnabled: Object.keys(obsidianmd.ruleConfigs.recommendedTypeChecked),
	errors: results.reduce((count, file) => count + file.errorCount, 0),
	warnings: results.reduce((count, file) => count + file.warningCount, 0),
	diagnostics,
	localOnly: true,
	officialReviewPerformed: false,
	apiCoverageProbe: {
		deliberatelyLowMinimum: '0.9.7',
		detectedApiErrors: apiProbeErrors.length,
		secretStorageDetected: true,
	},
};
if (
	results.filter((file) => file.filePath.endsWith('.js')).length !== files.length ||
	diagnostics.some((message) => /ignored/i.test(message.message))
)
	throw new Error('At least one runtime module was not checked');
await writeFile('artifacts/community-lint-result.json', `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report, null, 2));
if (report.errors > 0) process.exitCode = 1;
