import { Notice, PluginSettingTab, Setting, SettingDefinitionItem } from "obsidian";
import { normalizeBaseUrl } from "./kdm-protocol";
import type KdmPlannerPlugin from "./main";
import { clockToMinutes, DEFAULT_LUNCH_END, DEFAULT_LUNCH_START, DEFAULT_WORK_END, DEFAULT_WORK_START } from "./week";

export interface KdmPlannerSettings {
	baseUrl: string;
	/** Account email. The password is asked for at login and never stored. */
	email: string;
	/** Gap that should separate two tasks of a day, in minutes. */
	breakMinutes: number;
	/** Blocks of this many hours or more are refused. */
	maxBlockHours: number;
	/** Length proposed for a new task, in minutes. */
	defaultMinutes: number;
	/** Show Saturday and Sunday in the calendar. */
	showWeekend: boolean;
	/** Working hours, `HH:MM`. They set the calendar's span and the default times of a task; entries may lie outside them. */
	workStart: string;
	workEnd: string;
	/** Lunch break, `HH:MM`. It splits each day into morning and afternoon. */
	lunchStart: string;
	lunchEnd: string;
}

export const DEFAULT_SETTINGS: KdmPlannerSettings = {
	baseUrl: "",
	email: "",
	breakMinutes: 15,
	maxBlockHours: 4,
	defaultMinutes: 60,
	showWeekend: true,
	workStart: DEFAULT_WORK_START,
	workEnd: DEFAULT_WORK_END,
	lunchStart: DEFAULT_LUNCH_START,
	lunchEnd: DEFAULT_LUNCH_END,
};

export class KdmPlannerSettingTab extends PluginSettingTab {
	constructor(app: PluginSettingTab["app"], private readonly plugin: KdmPlannerPlugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const settings = this.plugin.settings;
		const report = (error: unknown) => new Notice(error instanceof Error ? error.message : String(error));
		const number = (key: "breakMinutes" | "maxBlockHours" | "defaultMinutes", min: number, max: number) => (setting: Setting) => {
			setting.addText((text) => {
				text.inputEl.type = "number";
				text.setValue(String(settings[key])).onChange((value) => {
					const parsed = Number(value);
					if (!Number.isFinite(parsed) || parsed < min || parsed > max) return;
					settings[key] = parsed;
					this.plugin.saveSoon();
				});
			});
		};
		const lunch = (key: "lunchStart" | "lunchEnd") => (setting: Setting) => {
			setting.addText((text) => {
				text.inputEl.type = "time";
				text.setValue(settings[key]).onChange((value) => {
					const minutes = clockToMinutes(value);
					if (minutes === null) return;
					const other = clockToMinutes(settings[key === "lunchStart" ? "lunchEnd" : "lunchStart"]);
					const [from, to] = key === "lunchStart" ? [minutes, other] : [other, minutes];
					if (from === null || to === null || to <= from) return new Notice("Öğle arası bitişi başlangıçtan sonra olmalı.");
					settings[key] = value;
					this.plugin.saveSoon();
					this.plugin.notifyPlansChanged();
				});
			});
		};
		const work = (key: "workStart" | "workEnd") => (setting: Setting) => {
			setting.addText((text) => {
				text.inputEl.type = "time";
				text.setValue(settings[key]).onChange((value) => {
					const minutes = clockToMinutes(value);
					if (minutes === null) return;
					const other = clockToMinutes(settings[key === "workStart" ? "workEnd" : "workStart"]);
					const [from, to] = key === "workStart" ? [minutes, other] : [other, minutes];
					if (from === null || to === null || to <= from) return new Notice("Mesai bitişi başlangıçtan sonra olmalı.");
					settings[key] = value;
					this.plugin.saveSoon();
					this.plugin.notifyPlansChanged();
				});
			});
		};
		return [
			{
				type: "group",
				items: [
					{
						name: "KDM URL",
						desc: "KDM sitesinin adresi. HTTPS kullanın: erişim anahtarı her istekle gönderilir.",
						render: (setting: Setting) =>
							setting.addText((text) =>
								text.setPlaceholder("https://kdm.example.com").setValue(settings.baseUrl).onChange((value) => {
									settings.baseUrl = value.trim();
									this.plugin.saveSoon();
									// Check once the field is left, not on every key.
									text.inputEl.onblur = () => {
										const checked = normalizeBaseUrl(settings.baseUrl);
										if (checked.error !== undefined && settings.baseUrl) new Notice(checked.error, 8000);
										this.plugin.dropForeignSession();
										this.update();
									};
								}),
							),
					},
					{
						name: "E-posta",
						desc: "KDM'ye giriş yaptığınız hesap.",
						render: (setting: Setting) =>
							setting.addText((text) =>
								text.setValue(settings.email).onChange((value) => {
									settings.email = value.trim();
									this.plugin.saveSoon();
								}),
							),
					},
					{
						name: "Oturum",
						desc: this.plugin.sessionSummary() ?? "Giriş yapılmadı. Giriş sonrası erişim anahtarı Obsidian'ın gizli depolamasında tutulur; parola saklanmaz.",
						render: (setting: Setting) => {
							const loggedIn = this.plugin.sessionSummary() !== null;
							setting
								.addButton((button) =>
									button.setButtonText(loggedIn ? "Yeniden giriş" : "Giriş yap").setCta().onClick(() => {
										void this.plugin.login().then(() => this.update());
									}),
								)
								.addButton((button) =>
									button.setButtonText("Görevleri yenile").setDisabled(!loggedIn).onClick(() => {
										void this.plugin.refreshCatalog(true).catch(report);
									}),
								)
								.addButton((button) =>
									button.setButtonText("Çıkış").setDisabled(!loggedIn).onClick(() => {
										this.plugin.logout();
										this.update();
									}),
								);
						},
					},
				],
			},
			{
				type: "group",
				heading: "Planlama kuralları",
				items: [
					{ name: "Mesai başlangıcı", desc: "Varsayılan 08:30. Yeni görevler bu saatten başlar; isterseniz daha erken bir saat de girebilirsiniz.", render: work("workStart") },
					{ name: "Mesai bitişi", desc: "Varsayılan 17:30. Mesai dışına taşan kayıtlar yalnızca uyarı verir.", render: work("workEnd") },
					{ name: "Öğle arası başlangıcı", desc: "Günü öğleden önce ve öğleden sonra diye böler. Varsayılan 12:30.", render: lunch("lunchStart") },
					{ name: "Öğle arası bitişi", desc: "Varsayılan 13:30. Görevler öğle arasına yerleştirilmez.", render: lunch("lunchEnd") },
					{ name: "Görevler arası mola (dk)", desc: "Aynı gündeki iki görev arasında bırakılması istenen boşluk. Eksikse uyarı verilir.", render: number("breakMinutes", 0, 120) },
					{ name: "Blok sınırı (saat)", desc: "Bu süre ve üstündeki görev blokları girilmez.", render: number("maxBlockHours", 1, 10) },
					{ name: "Varsayılan görev süresi (dk)", desc: "Yeni görev için önerilen süre.", render: number("defaultMinutes", 15, 240) },
					{
						name: "Hafta sonunu göster",
						desc: "Takvimde ve haftalık plan bloğunda Cumartesi ve Pazar.",
						render: (setting: Setting) =>
							setting.addToggle((toggle) =>
								toggle.setValue(settings.showWeekend).onChange((value) => {
									settings.showWeekend = value;
									this.plugin.saveSoon();
									this.plugin.notifyPlansChanged();
								}),
							),
					},
				],
			},
		];
	}
}
