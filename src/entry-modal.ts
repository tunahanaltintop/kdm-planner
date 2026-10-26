import { App, Modal, Setting } from "obsidian";
import { PlanEntry } from "./kdm-protocol";
import { clock, formatDuration, sameDay, statusStyle } from "./week";

const dateText = (date: Date) => date.toLocaleDateString("tr-TR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

/** Read-only view of an entry, for records that are locked (past weeks) and cannot be edited. */
export class EntryViewModal extends Modal {
	constructor(
		app: App,
		private readonly entry: PlanEntry,
		private readonly locked: boolean,
	) {
		super(app);
	}

	onOpen(): void {
		const entry = this.entry;
		const job = entry.jobDefinition as { name?: string; job?: { name?: string } } | null | undefined;
		const start = new Date(entry.startTime);
		const end = new Date(entry.endTime);
		const style = statusStyle(entry.statusId);
		this.modalEl.addClass("kdm-view-modal");
		this.setTitle(job?.name ?? (style.label === "İzin günü" ? "İzin günü" : "Görev"));

		const rows = this.contentEl.createDiv({ cls: "kdm-view-rows" });
		const row = (label: string, value: string) => {
			const line = rows.createDiv({ cls: "kdm-view-row" });
			line.createDiv({ cls: "kdm-view-label", text: label });
			return line.createDiv({ cls: "kdm-view-value", text: value });
		};

		const status = row("Durum", style.label);
		status.addClass("kdm-view-status", style.cls);
		if (job?.job?.name) row("Küme", job.job.name);
		if (sameDay(start, end)) {
			row("Tarih", dateText(start));
			row("Saat", `${clock(start)} – ${clock(end)}  (${formatDuration((end.getTime() - start.getTime()) / 60_000)})`);
		} else {
			row("Başlangıç", `${dateText(start)}, ${clock(start)}`);
			row("Bitiş", `${dateText(end)}, ${clock(end)}`);
		}
		if (entry.hour !== undefined) row("Süre", `${entry.hour} saat`);
		row("Açıklama", entry.description?.trim() || "—").addClass("kdm-view-description");
		if (entry.id !== undefined) row("KDM kayıt no", String(entry.id));
		if (this.locked) this.contentEl.createEl("p", { cls: "kdm-message", text: "Bu kayıt kilitli: geçmiş haftalardaki kayıtlar değiştirilemez ve silinemez." });

		new Setting(this.contentEl).addButton((button) => button.setButtonText("Kapat").setCta().onClick(() => this.close()));
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
