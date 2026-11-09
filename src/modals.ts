import { App, Modal, Setting } from "obsidian";
import { addDays, isoDate, parseIsoDate, startOfWeek } from "./week";

/** Yes/no question. Resolves to whether the user confirmed. */
export function confirm(app: App, title: string, message: string, action: string): Promise<boolean> {
	return new Promise((resolve) => {
		let answered = false;
		const modal = new (class extends Modal {
			onOpen(): void {
				this.setTitle(title);
				this.contentEl.createEl("p", { text: message });
				new Setting(this.contentEl)
					.addButton((button) => button.setButtonText("Vazgeç").onClick(() => this.close()))
					.addButton((button) =>
						button.setButtonText(action).setDestructive().onClick(() => {
							answered = true;
							this.close();
						}),
					);
			}
			onClose(): void {
				this.contentEl.empty();
				resolve(answered);
			}
		})(app);
		modal.open();
	});
}

const MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

/** Asks which week a plan block should be for. Resolves to the Monday of that week, or null when cancelled. */
export function pickWeek(app: App): Promise<Date | null> {
	return new Promise((resolve) => {
		let chosen: Date | null = null;
		let date = new Date();
		const modal = new (class extends Modal {
			private label!: HTMLElement;
			private input!: HTMLInputElement;
			private quick: { button: HTMLButtonElement; text: string; offset: number }[] = [];

			private show(): void {
				const monday = startOfWeek(date);
				const sunday = addDays(monday, 6);
				this.label.setText(`${monday.getDate()} ${MONTHS[monday.getMonth()]} – ${sunday.getDate()} ${MONTHS[sunday.getMonth()]} ${sunday.getFullYear()} haftası`);
				this.input.value = isoDate(date);
				// Mark the quick button of the chosen week, if it is one of the three.
				for (const { button, text, offset } of this.quick) {
					const selected = isoDate(monday) === isoDate(addDays(startOfWeek(new Date()), offset));
					button.setText(selected ? `✓ ${text}` : text);
					button.toggleClass("mod-cta", selected);
					button.setAttr("aria-pressed", String(selected));
				}
			}

			onOpen(): void {
				this.setTitle("Hangi hafta için plan eklensin?");
				const quick = this.contentEl.createDiv({ cls: "kdm-chips" });
				for (const [text, offset] of [["Geçen hafta", -7], ["Bu hafta", 0], ["Gelecek hafta", 7]] as const) {
					const button = quick.createEl("button", { text });
					this.quick.push({ button, text, offset });
					button.addEventListener("click", () => {
						date = addDays(startOfWeek(new Date()), offset);
						this.show();
					});
				}
				new Setting(this.contentEl).setName("Haftanın herhangi bir günü").addText((text) => {
					text.inputEl.type = "date";
					this.input = text.inputEl;
					text.onChange((value) => {
						const parsed = parseIsoDate(value);
						if (!parsed) return;
						date = parsed;
						this.label.setText("");
						this.show();
					});
				});
				this.label = this.contentEl.createEl("p", { cls: "kdm-message" });
				new Setting(this.contentEl)
					.addButton((button) => button.setButtonText("Vazgeç").onClick(() => this.close()))
					.addButton((button) =>
						button.setButtonText("Ekle").setCta().onClick(() => {
							chosen = startOfWeek(date);
							this.close();
						}),
					);
				this.show();
			}

			onClose(): void {
				this.contentEl.empty();
				resolve(chosen);
			}
		})(app);
		modal.open();
	});
}
