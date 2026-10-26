import { App, ButtonComponent, Modal, Notice, Setting } from "obsidian";
import { JobCatalogEntry, PlanEntry, PlanStatus, PlanStatusId } from "./kdm-protocol";
import {
	addMinutes,
	atTime,
	checkSlot,
	clock,
	DAY_OFF_END,
	DAY_OFF_START,
	formatDuration,
	isoDate,
	isPlanned,
	isFullDayLeave,
	leaveHours,
	LunchBreak,
	parseIsoDate,
	SlotCheck,
	STATUS_CHOICES,
	suggestSlot,
} from "./week";

export interface PlanFormValue {
	status: PlanStatusId;
	jobDefinitionId?: number;
	start: Date;
	end: Date;
	description: string;
	/** Only set for a leave: the hours it counts for. */
	hour?: number;
}

export interface PlanModalInit {
	date: Date;
	startTime?: string;
	endTime?: string;
	status?: PlanStatusId;
	jobDefinitionId?: number;
	description?: string;
	/** A leave entered for some hours instead of whole days. */
	leaveHourly?: boolean;
	/** Entry being edited. */
	entry?: PlanEntry;
}

/** What the dialog needs from the plugin. */
export interface PlanModalHost {
	catalog: JobCatalogEntry[];
	rules(): { minEditable: Date; maxBlockHours: number; breakMinutes: number; defaultMinutes: number; lunch: LunchBreak };
	/** Entries of the week containing `date`, for conflict checks. */
	loadEntries(date: Date): Promise<PlanEntry[]>;
	submit(value: PlanFormValue, entry?: PlanEntry): Promise<void>;
	/** Resolving to false keeps the dialog open (e.g. the user declined a confirmation). */
	complete?(entry: PlanEntry): Promise<boolean | void>;
	remove?(entry: PlanEntry): Promise<boolean | void>;
}

const DURATIONS = [30, 60, 90, 120, 180, 210];

/** The "add task" / "edit task" dialog, used from the calendar and from the notes. */
export class PlanModal extends Modal {
	private status: PlanStatusId;
	private jobId: number | undefined;
	private date: Date;
	private endDate: Date;
	private startTime: string;
	private endTime: string;
	private description: string;
	private existing: PlanEntry[] = [];
	private busy = false;
	private filter = "";
	private leaveMode: "day" | "hours";

	private taskSetting!: Setting;
	private timeSetting!: Setting;
	private leaveSetting!: Setting;
	private leaveTypeSetting!: Setting;
	private chipsEl!: HTMLElement;
	private durationEl!: HTMLElement;
	private messagesEl!: HTMLElement;
	private submitButton!: ButtonComponent;
	/** Every footer button, so all of them can be disabled while a request to KDM is running. */
	private footerButtons: ButtonComponent[] = [];
	private taskSelect!: HTMLSelectElement;
	private startInput!: HTMLInputElement;
	private endInput!: HTMLInputElement;

	constructor(
		app: App,
		private readonly host: PlanModalHost,
		private readonly init: PlanModalInit,
	) {
		super(app);
		const entry = init.entry;
		this.status = entry?.statusId ?? init.status ?? PlanStatus.Planned;
		this.jobId = entry?.jobDefinitionId ?? init.jobDefinitionId ?? undefined;
		this.date = new Date(init.date.getFullYear(), init.date.getMonth(), init.date.getDate());
		const entryEnd = entry ? new Date(entry.endTime) : null;
		this.endDate = entryEnd ? new Date(entryEnd.getFullYear(), entryEnd.getMonth(), entryEnd.getDate()) : this.date;
		this.startTime = init.startTime ?? "";
		this.endTime = init.endTime ?? "";
		this.description = entry?.description ?? init.description ?? "";
		this.leaveMode = init.leaveHourly || (entry?.statusId === PlanStatus.DayOff && !isFullDayLeave(new Date(entry.startTime), new Date(entry.endTime))) ? "hours" : "day";
	}

	onOpen(): void {
		const editing = !!this.init.entry;
		this.setTitle(editing ? "Görevi düzenle" : "KDM'ye görev ekle");
		this.modalEl.addClass("kdm-plan-modal");
		const { contentEl } = this;

		new Setting(contentEl).setName("Durum").addDropdown((dropdown) => {
			for (const choice of STATUS_CHOICES) dropdown.addOption(choice.id, choice.label);
			dropdown.setValue(this.status).onChange((value) => {
				this.status = value as PlanStatusId;
				this.layout();
				this.refresh();
			});
		});

		this.taskSetting = new Setting(contentEl).setName("Görev");
		this.taskSetting.addSearch((search) => {
			search.setPlaceholder("Görevlerde ara...").onChange((value) => {
				this.filter = value.trim().toLocaleLowerCase("tr");
				this.fillTasks();
			});
		});
		this.taskSelect = this.taskSetting.controlEl.createEl("select", { cls: "dropdown kdm-task-select" });
		this.taskSelect.addEventListener("change", () => {
			this.jobId = Number(this.taskSelect.value) || undefined;
			this.refresh();
		});
		this.fillTasks();

		new Setting(contentEl).setName("Tarih").addText((text) => {
			text.inputEl.type = "date";
			text.setValue(isoDate(this.date)).onChange((value) => {
				const parsed = parseIsoDate(value);
				if (!parsed) return;
				this.date = parsed;
				if (this.endDate < parsed) this.endDate = parsed;
				void this.loadExisting();
			});
		});

		this.leaveTypeSetting = new Setting(contentEl).setName("İzin türü").addDropdown((dropdown) => {
			dropdown
				.addOption("day", "Tüm gün (08:30 - 17:30)")
				.addOption("hours", "Saatlik")
				.setValue(this.leaveMode)
				.onChange((value) => {
					this.leaveMode = value === "hours" ? "hours" : "day";
					if (this.leaveMode === "hours" && (!this.startTime || !this.endTime)) this.suggest();
					this.layout();
					this.refresh();
				});
		});

		this.leaveSetting = new Setting(contentEl).setName("Bitiş tarihi").setDesc("İzin birden çok gün sürebilir.");
		this.leaveSetting.addText((text) => {
			text.inputEl.type = "date";
			text.setValue(isoDate(this.endDate)).onChange((value) => {
				const parsed = parseIsoDate(value);
				if (!parsed) return;
				this.endDate = parsed;
				this.refresh();
			});
		});

		this.timeSetting = new Setting(contentEl).setName("Saat");
		this.startInput = this.timeSetting.controlEl.createEl("input", { type: "time", cls: "kdm-time" });
		this.timeSetting.controlEl.createSpan({ text: "–" });
		this.endInput = this.timeSetting.controlEl.createEl("input", { type: "time", cls: "kdm-time" });
		this.startInput.step = this.endInput.step = "300";
		this.startInput.value = this.startTime;
		this.endInput.value = this.endTime;
		this.startInput.addEventListener("input", () => {
			this.startTime = this.startInput.value;
			this.refresh();
		});
		this.endInput.addEventListener("input", () => {
			this.endTime = this.endInput.value;
			this.refresh();
		});

		const chips = (this.chipsEl = contentEl.createDiv({ cls: "kdm-chips" }));
		for (const minutes of DURATIONS) {
			chips.createEl("button", { text: formatDuration(minutes) }).addEventListener("click", () => {
				const start = atTime(this.date, this.startTime);
				if (!start) return;
				this.endTime = clock(addMinutes(start, minutes));
				this.endInput.value = this.endTime;
				this.refresh();
			});
		}
		this.durationEl = chips.createSpan({ cls: "kdm-duration" });

		new Setting(contentEl)
			.setName("Açıklama")
			.addTextArea((area) => {
				area.setValue(this.description).onChange((value) => (this.description = value));
				area.inputEl.rows = 3;
				area.inputEl.addEventListener("keydown", (event) => {
					if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void this.save();
				});
			});

		this.messagesEl = contentEl.createDiv({ cls: "kdm-messages" });

		const footer = new Setting(contentEl);
		const entry = this.init.entry;
		if (entry && this.host.remove) {
			footer.addButton((button) => {
				this.footerButtons.push(button);
				button.setButtonText("Sil").setDestructive().onClick(() => void this.run(async () => this.host.remove?.(entry)));
			});
		}
		if (entry && this.host.complete && isPlanned(entry.statusId)) {
			footer.addButton((button) => {
				this.footerButtons.push(button);
				button.setButtonText("Tamamla").onClick(() => void this.run(async () => this.host.complete?.(entry)));
			});
		}
		footer.addButton((button) => {
			this.footerButtons.push(button);
			button.setButtonText("Vazgeç").onClick(() => this.close());
		});
		footer.addButton((button) => {
			this.submitButton = button;
			button.setButtonText(editing ? "Kaydet" : "Ekle").setCta().onClick(() => void this.save());
		});

		this.layout();
		void this.loadExisting(true);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private get isLeave(): boolean {
		return this.status === PlanStatus.DayOff;
	}

	/** A leave that covers whole days, as opposed to a task or an hourly leave. */
	private get isDayLeave(): boolean {
		return this.isLeave && this.leaveMode === "day";
	}

	/** Shows the fields that belong to the chosen status. */
	private layout(): void {
		this.taskSetting.settingEl.toggle(!this.isLeave);
		this.leaveTypeSetting.settingEl.toggle(this.isLeave);
		this.leaveSetting.settingEl.toggle(this.isDayLeave);
		this.timeSetting.settingEl.toggle(!this.isDayLeave);
		this.chipsEl.toggle(!this.isDayLeave);
	}

	private fillTasks(): void {
		const tasks = this.host.catalog.filter((t) => !this.filter || `${t.name} ${t.jobName}`.toLocaleLowerCase("tr").includes(this.filter));
		this.taskSelect.empty();
		if (!tasks.some((t) => t.id === this.jobId) && !this.filter) this.jobId = this.jobId ?? tasks[0]?.id;
		for (const task of tasks) {
			const option = this.taskSelect.createEl("option", { text: task.name, value: String(task.id) });
			option.selected = task.id === this.jobId;
		}
		if (!tasks.length) this.taskSelect.createEl("option", { text: "Eşleşen görev yok", value: "" });
		else if (!tasks.some((t) => t.id === this.jobId)) this.jobId = tasks[0]?.id;
	}

	/** Counts loads so that the answer for a date the user already moved away from is ignored. */
	private loadSeq = 0;

	private async loadExisting(first = false): Promise<void> {
		const seq = ++this.loadSeq;
		let entries: PlanEntry[] = [];
		try {
			entries = await this.host.loadEntries(this.date);
		} catch {
			// Conflict checks are then skipped; saving still reports whatever KDM says.
		}
		if (seq !== this.loadSeq) return;
		this.existing = entries;
		if (first && (!this.startTime || !this.endTime)) this.suggest();
		this.refresh();
	}

	/** Fills the time fields with the first free slot of the day. */
	private suggest(): void {
		const rules = this.host.rules();
		const slot = suggestSlot(this.date, this.existing, rules.defaultMinutes, rules.breakMinutes, { lunch: rules.lunch });
		if (!slot) return;
		this.startTime = clock(slot.start);
		this.endTime = clock(slot.end);
		this.startInput.value = this.startTime;
		this.endInput.value = this.endTime;
	}

	private slot(): { start: Date; end: Date } | null {
		if (this.isDayLeave) {
			const start = atTime(this.date, `${DAY_OFF_START.hour}:${String(DAY_OFF_START.minute).padStart(2, "0")}`);
			const end = atTime(this.endDate, `${DAY_OFF_END.hour}:${DAY_OFF_END.minute}`);
			return start && end ? { start, end } : null;
		}
		const start = atTime(this.date, this.startTime);
		const end = atTime(this.date, this.endTime);
		return start && end ? { start, end } : null;
	}

	private check(): SlotCheck {
		const slot = this.slot();
		if (!slot) return { errors: ["Başlangıç ve bitiş saatini girin."], warnings: [] };
		const rules = this.host.rules();
		const result: SlotCheck = { errors: [], warnings: [] };
		if (this.isLeave) {
			if (this.isDayLeave) {
				if (slot.end < slot.start) result.errors.push("Bitiş tarihi başlangıçtan önce olamaz.");
				if (slot.start < rules.minEditable) result.errors.push(`${isoDate(rules.minEditable)} öncesindeki günler kilitli.`);
			} else {
				// An hourly leave follows the day's hours and lock, but not the task rules (block limit, lunch, breaks).
				const others = this.existing.filter((e) => e.statusId !== PlanStatus.DayOff);
				const checked = checkSlot(slot.start, slot.end, { minEditable: rules.minEditable, existing: others, ignoreId: this.init.entry?.id, maxBlockHours: 99, breakMinutes: 0 });
				result.errors.push(...checked.errors);
				result.warnings.push(...checked.warnings);
			}
			const clash = this.existing.find((e) => e.statusId === PlanStatus.DayOff && e.id !== this.init.entry?.id && new Date(e.startTime) < slot.end && slot.start < new Date(e.endTime));
			if (clash) result.warnings.push("Bu tarihlerde zaten bir izin kaydı var.");
		} else {
			const checked = checkSlot(slot.start, slot.end, { ...rules, existing: this.existing, ignoreId: this.init.entry?.id });
			result.errors.push(...checked.errors);
			result.warnings.push(...checked.warnings);
			if (!this.jobId) result.errors.push("Bir görev seçin.");
		}
		return result;
	}

	private refresh(): void {
		if (!this.messagesEl) return;
		const slot = this.slot();
		this.durationEl.setText(slot && !this.isDayLeave && slot.end > slot.start ? formatDuration((slot.end.getTime() - slot.start.getTime()) / 60_000) : "");
		const result = this.check();
		this.messagesEl.empty();
		for (const message of result.errors) this.messagesEl.createDiv({ cls: "kdm-message is-error", text: message });
		for (const message of result.warnings) this.messagesEl.createDiv({ cls: "kdm-message is-warning", text: message });
		if (this.isDayLeave && slot && !result.errors.length) {
			this.messagesEl.createDiv({ cls: "kdm-message", text: `İzin günü 08:30 - 17:30 olarak girilir (${leaveHours(this.date, this.endDate)} saat).` });
		}
		this.submitButton?.setDisabled(this.busy || result.errors.length > 0);
		for (const button of this.footerButtons) button.setDisabled(this.busy);
	}

	private async run(action: () => Promise<boolean | void | undefined>): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		this.refresh();
		try {
			const result = await action();
			if (result === false) {
				this.busy = false;
				this.refresh();
				return;
			}
			this.close();
		} catch (error) {
			new Notice(error instanceof Error ? error.message : String(error));
			this.busy = false;
			this.refresh();
		}
	}

	private async save(): Promise<void> {
		const slot = this.slot();
		if (!slot || this.check().errors.length) return;
		const value: PlanFormValue = {
			status: this.status,
			jobDefinitionId: this.isLeave ? undefined : this.jobId,
			start: slot.start,
			end: slot.end,
			description: this.description.trim(),
			hour: this.isDayLeave ? leaveHours(this.date, this.endDate) : undefined,
		};
		await this.run(() => this.host.submit(value, this.init.entry));
	}
}
