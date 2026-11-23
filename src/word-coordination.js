const querySave = 'wujie-word:pending-save';
const querySync = 'wujie-word:sync-active';

export function registerWordSyncState(owner) {
	const workspace = owner.app.workspace;
	if (workspace.on) owner.registerEvent(workspace.on(querySync, report => {
		if (owner.running || owner.stopping) report(true);
	}));
}

export function registerWordSaveState(owner) {
	const workspace = owner.app.workspace;
	owner.registerEvent(workspace.on(querySave, report => {
		if (owner.docxWrite) report(owner.docxWrite);
	}));
}

export function pendingWordSave(workspace) {
	let pending;
	workspace.trigger?.(querySave, promise => { pending ??= promise; });
	return pending;
}

export function wordSyncActive(workspace) {
	let active = false;
	workspace.trigger?.(querySync, value => { active ||= value === true; });
	return active;
}
