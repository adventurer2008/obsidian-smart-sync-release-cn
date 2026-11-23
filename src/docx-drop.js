import { clickToPositionDom } from '@eigenpal/docx-editor-core/layout-bridge/clickToPositionDom';
import { INSERT_IMAGE_MAX_WIDTH_PX, insertImageNode } from '@eigenpal/docx-editor-core/prosemirror/commands';
import { DOCX_MAX_BYTES } from './docx.js';

const formats = {
	png: ['image/png', /^iVBORw0KGgo/u],
	jpg: ['image/jpeg', /^\/9j\//u],
	jpeg: ['image/jpeg', /^\/9j\//u],
	gif: ['image/gif', /^R0lGOD[lh]/u],
};

async function readImage(window, file) {
	const extension = /\.([a-z]+)$/iu.exec(file.name)?.[1].toLowerCase();
	if (!Object.hasOwn(formats, extension)) throw Error('image');
	const [type, signature] = formats[extension];
	const src = await new Promise((resolve, reject) => {
		const reader = new window.FileReader();
		reader.onload = () => resolve(reader.result);
		reader.onerror = reject;
		reader.readAsDataURL(file.slice(0, file.size, type));
	});
	if (!signature.test(src.slice(src.indexOf(',') + 1))) throw Error('image');
	const image = new window.Image();
	await new Promise((resolve, reject) => {
		image.onload = resolve;
		image.onerror = reject;
		image.src = src;
	});
	const width = Math.min(image.naturalWidth, INSERT_IMAGE_MAX_WIDTH_PX);
	const height = Math.max(1, Math.round(image.naturalHeight * (width / image.naturalWidth)));
	return { src, width, height, alt: file.name, wrapType: 'inline', displayMode: 'inline',
		rId: `rId_img_${window.crypto.randomUUID()}` };
}

export function registerDocxImageDrop(target, { getEditor, canEdit, current, sourceSize, report, signal }) {
	const window = target.ownerDocument.defaultView;
	const bodyPage = event => {
		if (!Array.from(event.dataTransfer?.types ?? []).includes('Files')) return;
		return event.target.closest?.('.layout-page-content');
	};
	const options = { capture: true, signal };
	target.addEventListener('dragover', event => {
		if (!bodyPage(event)) return;
		event.preventDefault();
		event.stopPropagation();
		event.dataTransfer.dropEffect = canEdit() && getEditor()?.getEditorRef()?.getView()?.editable ? 'copy' : 'none';
	}, options);
	target.addEventListener('drop', event => {
		const body = bodyPage(event);
		if (!body) return;
		event.preventDefault();
		event.stopPropagation();
		const editor = getEditor();
		const paged = editor?.getEditorRef();
		const view = paged?.getView();
		if (!canEdit() || !view?.editable) return;
		const files = Array.from(event.dataTransfer.files);
		if (!files.length) return;
		if (files.reduce((total, file) => total + file.size, sourceSize()) >= DOCX_MAX_BYTES) {
			report('docx.large');
			return;
		}
		const { doc } = view.state;
		const pages = body.closest('.layout-page')?.parentElement;
		if (!pages) return;
		const hit = clickToPositionDom(pages, event.clientX, event.clientY, editor.getZoom());
		if (hit === null || hit < 0 || hit > doc.content.size) return;
		const resolved = doc.resolve(hit);
		const position = resolved.parent.inlineContent ? resolved : doc.resolve(Math.min(hit + 1, doc.content.size));
		if (!position.parent.inlineContent) return;
		void (async () => {
			try {
				const images = [];
				for (const file of files) {
					if (!current() || signal.aborted) return;
					images.push(await readImage(window, file));
				}
				if (!current() || signal.aborted) return;
				if (!canEdit() || paged.getView() !== view || !view.editable || view.state.doc !== doc) throw Error('changed');
				let pos = position.pos;
				for (const attrs of images) {
					const image = view.state.schema.nodes.image.create(attrs);
					insertImageNode(view.state, view.dispatch, image, pos);
					pos += image.nodeSize;
				}
				paged.setSelection(pos);
				paged.focus();
			} catch {
				if (current() && !signal.aborted) report('docx.imageDropFailed');
			}
		})();
	}, options);
}
