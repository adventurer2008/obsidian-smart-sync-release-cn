export * from './obsidian-double.mjs';
import { Setting as BaseSetting } from './obsidian-double.mjs';
export class Setting extends BaseSetting {
	constructor(container) {
		super(container);
		this.settingEl = container.createDiv({ cls: 'setting-item' });
		this.settingEl.setting = this;
	}
}
