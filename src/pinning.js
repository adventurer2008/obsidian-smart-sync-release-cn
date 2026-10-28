import { safeNotePath, encryptNotePin, decryptNotePin, encryptNotePosition, decryptNotePosition } from './codec.js';

export function notePinState() {
	return { actor: crypto.randomUUID(), clock: 0, cursor: 0, entries: {}, pending: {} };
}
export function noteIdAtPath(notes, path) {
	return Object.entries(notes ?? {}).find(([, note]) => !note.removed && note.path === path)?.[0];
}
export function queueNotePin(state, notes, path, pinned) {
	path = safeNotePath(path);
	if (typeof pinned !== 'boolean' || !Number.isSafeInteger(state.clock + 1)) throw Error('Invalid note pin');
	state.pending[path] = { path, note: noteIdAtPath(notes,path), pinned, counter: ++state.clock };
}
export function queueNotePosition(state, notes, path, position) {
	if (!['normal', 'top', 'bottom'].includes(position)) throw Error('Invalid note position');
	queueNotePin(state, notes, path, position === 'top');
	state.pending[path].bottomed = position === 'bottom';
}
export function moveNotePins(state, from, to) {
	let changed = false;
	for (const [key, operation] of Object.entries(state.pending)) {
		if (operation.path !== from && !operation.path.startsWith(`${from}/`)) continue;
		changed = true;
		const path = to + operation.path.slice(from.length);
		delete state.pending[key];
		if (!state.pending[path] || operation.counter > state.pending[path].counter) state.pending[path] = { ...operation, path };
	}
	// A local rename precedes the next content round's stable identity update.
	for (const entry of Object.values(state.entries))
		if ((entry.pinned || entry.bottomed) && (entry.path === from || entry.path?.startsWith(`${from}/`))) { entry.path = to + entry.path.slice(from.length); changed = true; }
	return changed;
}
export function pinPathSet(state, notes, kind = 'pinned') {
	const paths = new Set();
	for (const [id, entry] of Object.entries(state.entries)) {
		const note = notes?.[id];
		if (entry[kind] && !note?.removed && (entry.path ?? note?.path)) paths.add(entry.path ?? note.path);
	}
	for (const operation of Object.values(state.pending)) {
		if (operation.deleted) { paths.delete(operation.path); continue; }
		if (operation[kind]) paths.add(operation.path); else paths.delete(operation.path);
	}
	return paths;
}
export async function synchronizeNotePins({ api, keys, state, notes, direction = 'both', save, active = () => true, positions = false }) {
	const check = () => { if (!active() || api.signal?.aborted) throw new DOMException('Pin synchronization stopped','AbortError'); };
	const apply = async row => {
		if (!/^[a-f0-9]{64}$/.test(row?.note) || !Number.isSafeInteger(row.sequence) || row.sequence <= 0) throw Error('Invalid pin feed');
		const pinned = await decryptNotePin(keys,api.workspace,row.note,row.value);
		const position = positions && row.position != null ? await decryptNotePosition(keys,api.workspace,row.note,row.position) : pinned ? 'top' : 'normal';
		if (pinned !== (position === 'top')) throw Error('Inconsistent note position');
		check();
		if ((state.entries[row.note]?.sequence ?? 0) <= row.sequence)
			state.entries[row.note] = { sequence: row.sequence, pinned: position === 'top', bottomed: position === 'bottom', path: notes[row.note]?.path };
	};
	check();
	if (direction === 'paused') return;
	if (!positions && (state.positionFeed || Object.values(state.pending).some(operation => operation.bottomed))) throw Object.assign(Error('Position service upgrade required'), { code: 'PIN_SERVICE_UPGRADE' });
	if (positions && !state.positionFeed) { state.cursor = 0; state.positionFeed = true; await save(); }
	if (direction !== 'receive') {
		// False records remain in the shared register, even after note deletion.
		for (const [id, entry] of Object.entries(state.entries)) {
			if ((!entry.pinned && !entry.bottomed) || !notes[id]?.removed || Object.values(state.pending).some(op => op.note === id)) continue;
			state.pending[`deleted:${id}`] = { note: id, path: notes[id].path, pinned: false, deleted: true, counter: ++state.clock };
		}
		for (const [key, operation] of Object.entries(state.pending).sort((a,b) => a[1].counter - b[1].counter)) {
			check();
			const note = operation.note ?? noteIdAtPath(notes,operation.path) ?? (operation.deleted ? Object.entries(notes).find(([,item]) => item.path === operation.path)?.[0] : undefined);
			if (!note) {
				if (operation.deleted && state.pending[key]?.counter === operation.counter) { delete state.pending[key]; await save(); }
				continue; // A new/excluded note remains local until it has a cloud identity.
			}
			operation.note = note;
			await save(); // Persist the operation identity before the first network write.
			check();
			const value = await encryptNotePin(keys,api.workspace,note,operation.pinned);
			const input = { actor: state.actor, counter: operation.counter, value };
			const row = positions
				? await api.setPosition(note, { ...input, position: await encryptNotePosition(keys, api.workspace, note, operation.bottomed ? 'bottom' : operation.pinned ? 'top' : 'normal') })
				: await api.setPin(note, input);
			check();
			if (row.note !== note) throw Error('Unexpected pin reply');
			await apply(row);
			if (state.pending[key]?.counter === operation.counter) delete state.pending[key];
			await save();
		}
	}
	if (direction !== 'send') {
		let more;
		do {
			check();
			const page = positions ? await api.positions(state.cursor) : await api.pins(state.cursor);
			check();
			if (!Array.isArray(page?.entries) || page.entries.length > 128 || typeof page.more !== 'boolean' || (page.more && !page.entries.length)) throw Error('Invalid pin feed');
			let cursor = state.cursor;
			for (const row of page.entries) {
				if (row.sequence <= cursor) throw Error('Invalid pin cursor');
				await apply(row); cursor = row.sequence;
			}
			if (cursor !== state.cursor) { state.cursor = cursor; await save(); }
			more = page.more;
		} while (more);
	}
	let moved = false;
	for (const [id, entry] of Object.entries(state.entries)) if (notes[id] && !notes[id].removed && entry.path !== notes[id].path) { entry.path = notes[id].path; moved = true; }
	if (moved) await save();
}
