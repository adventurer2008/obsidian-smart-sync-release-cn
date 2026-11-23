import { Plugin } from 'obsidian';
import { registerDocxEditor } from './docx-view.js';
import { registerWordSaveState, wordSyncActive } from './word-coordination.js';

export default class WujieWord extends Plugin {
	onload() {
		const { workspace } = this.app;
		let addFileMenu;
		let navigatorMenus;
		let disposeNavigator;
		const refresh = () => {
			if (this.stopped) return;
			const plugins = this.app.plugins?.plugins;
			const sync = plugins?.['wujie-sync'];
			// Older releases and the Global edition already supply the editor.
			if (!addFileMenu && (plugins?.['smart-sync-global'] || sync && !sync.separateWordEditor)) return;
			addFileMenu ??= registerDocxEditor(this, {
				syncActive: () => wordSyncActive(workspace), viewType: 'wujie-word-docx', openLabel: '打开 Word 文档',
			});
			const menus = plugins?.['notebook-navigator']?.api?.menus;
			if (!addFileMenu || menus === navigatorMenus) return;
			disposeNavigator?.();
			navigatorMenus = menus;
			const file = menus?.registerFileMenu?.(context => {
				if (context.selection?.mode !== 'multiple') addFileMenu(context, context.file);
			});
			const folder = menus?.registerFolderMenu?.(context => addFileMenu(context, context.folder));
			disposeNavigator = () => { file?.(); folder?.(); };
		};
		registerWordSaveState(this);
		this.register(() => disposeNavigator?.());
		this.registerEvent(workspace.on('layout-change', refresh));
		if (workspace.onLayoutReady) workspace.onLayoutReady(refresh);
		else refresh();
	}

	onunload() {
		this.stopped = true;
	}
}
