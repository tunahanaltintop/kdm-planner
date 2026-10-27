import { MarkdownPostProcessorContext, MarkdownRenderChild, Notice, TFile } from "obsidian";
import type KdmPlannerPlugin from "./main";
import { errorMessage } from "./main";
import { PlanEntry, PlanStatus } from "./kdm-protocol";
import { confirm } from "./modals";
import { addDays, atTime, clock, DayPeriod, formatDuration, isFullDayLeave, isPlanned, looksLikeLeave, matchTask, segmentForDay, PERIOD_LABEL, periodOf, statusStyle, sameDay, startOfDay, startOfWeek, suggestSlot, WEEKDAY_SHORT } from "./week";
import { addNote, BLOCK_LANGUAGE, findBlock, markSent, NoteLine, parseLine, parseWeekBlock, RemoteState, serializeWeekBlock, syncSent, unmarkSent, WeekNotes } from "./week-note";

/** Registers the `kdm-week` code block: a week of notes, with a "send to KDM" button on every note. */
export function registerWeekBlock(plugin: KdmPlannerPlugin): void {
	plugin.registerMarkdownCodeBlockProcessor(BLOCK_LANGUAGE, (source, el, ctx) => {
		ctx.addChild(new WeekBlock(plugin, source, el, ctx));
	});
}

class WeekBlock extends MarkdownRenderChild {
	private week: WeekNotes;
	private entries: PlanEntry[] = [];
	private focusKey = "";
	private editing: { day: number; index: number } | null = null;
	private unsubscribe: (() => void) | null = null;
	/** Operations that are talking to KDM right now; their buttons stay disabled. */
	private busy = new Set<string>();
	private reconciling = false;

	constructor(
		private readonly plugin: KdmPlannerPlugin,
		source: string,
		private readonly el: HTMLElement,
		private readonly ctx: MarkdownPostProcessorContext,
	) {
		super(el);
		this.week = parseWeekBlock(source);
	}

	onload(): void {
		this.unsubscribe = this.plugin.onPlansChanged(() => void this.loadEntries());
		this.render();
		void this.loadEntries();
	}

	onunload(): void {
		this.unsubscribe?.();
	}

	/** KDM entries of the week, shown as chips under each day. Silent when logged out. */
	private async loadEntries(force = false): Promise<void> {
		if (!this.plugin.loggedIn && !(await this.plugin.ensureSession())) {
			this.entries = [];
			this.render();
			return;
		}
		let loaded = false;
		try {
			this.entries = await this.plugin.getWeekEntries(this.week.weekStart, force);
			loaded = true;
		} catch {
			this.entries = [];
		}
		this.render();
		if (loaded) void this.reconcileMissing();
	}

	/**
	 * A note marked as sent whose entry is not in this week may have been deleted in KDM (or moved to another week).
	 * Each such entry is looked up by id; the ones KDM no longer has turn back into unsent notes.
	 */
	private async reconcileMissing(): Promise<void> {
		if (this.reconciling) return;
		const known = new Set(this.entries.map((e) => e.id));
		const missing = new Set<number>();
		this.week.days.forEach((notes, dayIndex) => {
			for (const note of notes) {
				if (note.kdmId && !known.has(note.kdmId) && !this.linkedEntry(note, addDays(this.week.weekStart, dayIndex))) missing.add(note.kdmId);
			}
		});
		if (!missing.size) return;
		this.reconciling = true;
		try {
			const client = this.plugin.createClient();
			const gone = new Set<number>();
			for (const id of missing) {
				if ((await client.getPlan(id)) === null) gone.add(id);
			}
			if (!gone.size) return;
			let count = 0;
			await this.change((week) => {
				count = unmarkSent(week, gone);
			});
			if (count) new Notice(`${count} notun KDM kaydı silinmiş; not aktarılmamış olarak işaretlendi.`, 6000);
		} catch {
			// Not knowing is not the same as gone: leave the notes as they are and try again next time.
		} finally {
			this.reconciling = false;
		}
	}

	/**
	 * Applies a change to the model, shows it at once and writes it into the note.
	 *
	 * The block is found in the file by what it contains, not only by line number, so a note with several plan blocks
	 * (even for the same week) never gets a change written into the wrong one. If the block on disk is no longer what
	 * is shown, nothing is written and the view goes back to what it showed.
	 */
	private async change(fn: (week: WeekNotes) => void): Promise<void> {
		const info = this.ctx.getSectionInfo(this.el);
		const file = this.plugin.app.vault.getFileByPath(this.ctx.sourcePath);
		if (!info || !(file instanceof TFile)) {
			new Notice("Bu blok burada düzenlenemiyor. Notu açıp düzenleyin.");
			return;
		}
		const snapshot = serializeWeekBlock(this.week);
		fn(this.week);
		this.render();
		try {
			await this.plugin.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const found = findBlock(lines, info.lineStart, snapshot);
				if (!found) throw new Error("Blok notta değişmiş; değişiklik yazılmadı. Notu yeniden açıp tekrar deneyin.");
				const current = parseWeekBlock(lines.slice(found.start + 1, found.end).join("\n"));
				fn(current);
				lines.splice(found.start + 1, found.end - found.start - 1, ...serializeWeekBlock(current).split("\n"));
				return lines.join("\n");
			});
		} catch (error) {
			new Notice(errorMessage(error), 8000);
			this.week = parseWeekBlock(snapshot);
			this.render();
		}
	}

	/**
	 * Runs an operation that calls KDM. The buttons of `key` are disabled while it runs. On success the view is
	 * refreshed from KDM before they come back; on failure they come back at once and the error is shown.
	 * An operation resolving to `false` was cancelled or failed on its own and needs no refresh.
	 */
	private async guard(key: string, run: () => Promise<boolean | void>): Promise<void> {
		if (this.busy.has(key)) return;
		this.busy.add(key);
		this.render();
		try {
			if ((await run()) !== false) await this.loadEntries();
		} catch (error) {
			new Notice(errorMessage(error), 8000);
			// The request may have gone through before it failed (e.g. a timeout): show what KDM really has.
			await this.loadEntries(true);
		} finally {
			this.busy.delete(key);
			this.render();
		}
	}

	private button(parent: HTMLElement, key: string, options: { text: string; cls?: string; label?: string }, onClick: () => void): HTMLButtonElement {
		const button = parent.createEl("button", { text: options.text, cls: options.cls, attr: options.label ? { "aria-label": options.label, title: options.label } : {} });
		if (this.busy.has(key)) {
			button.disabled = true;
			button.addClass("is-busy");
		}
		button.addEventListener("click", (event) => {
			event.stopPropagation();
			onClick();
		});
		return button;
	}

	private lineKey(dayIndex: number, line: NoteLine): string {
		return `line:${dayIndex}:${line.text}`;
	}

	private render(): void {
		const root = this.el;
		root.empty();
		root.addClass("kdm-note-week");

		const bar = root.createDiv({ cls: "kdm-note-bar" });
		const visibleDays = this.plugin.settings.showWeekend ? 7 : 5;
		const end = addDays(this.week.weekStart, visibleDays - 1);
		bar.createEl("strong", { text: `${this.week.weekStart.getDate()}.${this.week.weekStart.getMonth() + 1} – ${end.getDate()}.${end.getMonth() + 1}.${end.getFullYear()}` });
		this.button(bar, "refresh", { text: this.busy.has("refresh") ? "Yenileniyor..." : "Yenile", label: "KDM'deki güncel durumu getir. Aktarılmamış notlara dokunulmaz." }, () => void this.guard("refresh", () => this.refreshFromKdm()));
		bar.createEl("button", { text: "Takvimi aç", cls: "kdm-note-open" }).addEventListener("click", () => void this.plugin.activateView());
		bar.createEl("button", { text: "Bloğu kaldır", cls: "kdm-note-remove-block", attr: { title: "Bu haftalık bloğu nottan siler. KDM kayıtlarına dokunulmaz." } }).addEventListener("click", () => void this.removeBlock());

		const grid = root.createDiv({ cls: "kdm-note-grid" });
		const today = new Date();
		this.week.days.forEach((notes, index) => {
			if (index >= visibleDays) return;
			const day = addDays(this.week.weekStart, index);
			const card = grid.createDiv({ cls: "kdm-note-day" });
			if (sameDay(day, today)) card.addClass("is-today");

			const head = card.createDiv({ cls: "kdm-note-day-head" });
			head.createSpan({ cls: "kdm-day-name", text: WEEKDAY_SHORT[index] });
			head.createSpan({ cls: "kdm-day-number", text: String(day.getDate()) });
			const total = this.dayEntries(day).filter((e) => e.statusId !== PlanStatus.DayOff).reduce((sum, e) => sum + (new Date(e.endTime).getTime() - new Date(e.startTime).getTime()) / 60_000, 0);
			if (total) head.createSpan({ cls: "kdm-note-total", text: formatDuration(total), attr: { title: "KDM'de girilen süre" } });

			const lunch = this.plugin.lunch();
			const linked = this.linkedIds(notes, day);
			for (const period of ["am", "pm"] as const) {
				if (period === "pm") {
					const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
					card.createDiv({ cls: "kdm-note-lunch", text: `Öğle arası ${fmt(lunch.start)} – ${fmt(lunch.end)}` });
				}
				const section = card.createDiv({ cls: "kdm-note-period" });
				section.createDiv({ cls: "kdm-note-period-label", text: PERIOD_LABEL[period] });
				this.renderKdmEntries(section, day, period, linked, lunch);
				const list = section.createDiv({ cls: "kdm-note-lines" });
				notes.forEach((line, lineIndex) => {
					if ((line.period ?? "am") === period) this.renderLine(list, line, index, lineIndex, day);
				});

				const input = section.createEl("input", { type: "text", cls: "kdm-note-add", attr: { placeholder: "Not ekle..." } });
				input.addEventListener("keydown", (event) => {
					if (event.key !== "Enter" || !input.value.trim()) return;
					const parsed = parseLine(input.value);
					// A note with a time belongs where that time falls, whichever box it was typed in.
					const start = parsed.timeRange ? atTime(day, parsed.timeRange.from) : null;
					const where: DayPeriod = start ? periodOf(start.getHours() * 60 + start.getMinutes(), lunch) : period;
					this.focusKey = `${index}-${where}`;
					void this.change((week) => {
						const target = week.days[index];
						if (target) addNote(target, { ...parsed, period: where });
					});
				});
				if (this.focusKey === `${index}-${period}`) window.setTimeout(() => input.focus(), 0);
			}
		});
	}

	/** Ids of the KDM entries that a note of this day already stands for, so they are not listed twice. */
	private linkedIds(notes: NoteLine[], day: Date): Set<number> {
		const ids = new Set<number>();
		for (const note of notes) {
			if (note.kdmId === undefined) continue;
			const entry = this.linkedEntry(note, day);
			if (entry?.id !== undefined) ids.add(entry.id);
		}
		return ids;
	}

	/** Entries already in KDM for this day half, so it is clear what is taken before a note is sent. */
	private renderKdmEntries(section: HTMLElement, day: Date, period: DayPeriod, linked: Set<number>, lunch: { start: number; end: number }): void {
		const chips = this.entries
			.filter((e) => e.id === undefined || !linked.has(e.id))
			.map((entry) => ({ entry, segment: segmentForDay(entry, day) }))
			.filter((c) => c.segment && periodOf(c.segment.start.getHours() * 60 + c.segment.start.getMinutes(), lunch) === period)
			.sort((a, b) => (a.segment?.start.getTime() ?? 0) - (b.segment?.start.getTime() ?? 0));
		if (!chips.length) return;
		const box = section.createDiv({ cls: "kdm-note-kdm" });
		for (const { entry } of chips) {
			const style = statusStyle(entry.statusId);
			const start = new Date(entry.startTime);
			const end = new Date(entry.endTime);
			const name = (entry.jobDefinition as { name?: string } | null | undefined)?.name ?? "İzin günü";
			const description = entry.description?.trim();
			// Laid out like a sent note, in full: what was written is the text, the task it was entered under is below.
			const chip = box.createDiv({ cls: "kdm-note-line has-status kdm-note-entry", attr: { title: [`KDM: ${name}`, style.label].join("\n") } });
			chip.addClass(style.cls);
			const text = chip.createDiv({ cls: "kdm-note-text" });
			text.createSpan({ cls: "kdm-note-time", text: sameDay(start, end) ? `${clock(start)}–${clock(end)}` : "Tüm gün" });
			text.createSpan({ text: description || name });
			chip.addEventListener("click", () => void this.plugin.editEntry(entry));

			const actions = chip.createDiv({ cls: "kdm-note-actions" });
			actions.createSpan({ cls: "kdm-note-sent kdm-note-origin", text: description ? `KDM · ${name}` : "KDM" });
			// Same quick actions as on the calendar; past (locked) entries have none.
			if (!this.plugin.isLocked(entry) && entry.id !== undefined) {
				const key = `chip:${entry.id}`;
				if (isPlanned(entry.statusId)) {
					this.button(actions, key, { text: "✓", cls: "kdm-action is-complete", label: "Tamamlandı yap" }, () => void this.guard(key, () => this.complete(entry)));
				}
				this.button(actions, key, { text: "✎", cls: "kdm-action is-edit", label: "KDM kaydını düzenle" }, () => void this.plugin.editEntry(entry));
				this.button(actions, key, { text: "×", cls: "kdm-action is-delete", label: "KDM'den sil" }, () => void this.deleteChip(key, entry));
			}
		}
	}

	/** Asks first; the buttons are only disabled once the delete request is actually sent. */
	private async deleteChip(key: string, entry: PlanEntry): Promise<void> {
		if (!(await this.plugin.askDelete())) return;
		await this.guard(key, async () => {
			await this.plugin.deleteEntry(entry);
			new Notice("Görev KDM'den silindi.");
		});
	}

	private dayEntries(day: Date): PlanEntry[] {
		return this.entries.filter((e) => sameDay(new Date(e.startTime), day));
	}

	private renderLine(list: HTMLElement, line: NoteLine, dayIndex: number, lineIndex: number, day: Date): void {
		const row = list.createDiv({ cls: "kdm-note-line" });
		if (line.kdmId !== undefined) row.addClass("is-sent");

		if (this.editing?.day === dayIndex && this.editing.index === lineIndex) {
			const input = row.createEl("input", { type: "text", cls: "kdm-note-edit" });
			input.value = `${line.timeRange ? `${line.timeRange.from}-${line.timeRange.to} ` : ""}${line.text}`;
			window.setTimeout(() => input.focus(), 0);
			const finish = (save: boolean) => {
				this.editing = null;
				if (save && input.value.trim()) {
					const text = input.value;
					void this.change((week) => {
						const target = week.days[dayIndex];
						if (target?.[lineIndex]) target[lineIndex] = { ...parseLine(text), kdmId: target[lineIndex].kdmId };
					});
				} else this.render();
			};
			input.addEventListener("keydown", (event) => {
				if (event.key === "Enter") finish(true);
				if (event.key === "Escape") finish(false);
			});
			input.addEventListener("blur", () => this.editing && finish(true));
			return;
		}

		const text = row.createDiv({ cls: "kdm-note-text" });
		if (line.timeRange) text.createSpan({ cls: "kdm-note-time", text: `${line.timeRange.from}–${line.timeRange.to}` });
		text.createSpan({ text: line.text });
		text.addEventListener("dblclick", () => {
			this.editing = { day: dayIndex, index: lineIndex };
			this.render();
		});

		const actions = row.createDiv({ cls: "kdm-note-actions" });
		const key = this.lineKey(dayIndex, line);
		if (line.kdmId !== undefined) {
			const entry = this.linkedEntry(line, day);
			actions.createSpan({ cls: "kdm-note-sent", text: "✓ KDM", attr: { title: line.kdmId ? `KDM kaydı #${line.kdmId}` : "KDM'ye aktarıldı" } });
			if (entry) {
				// Same colours as on the calendar; the colour says the status, so no label is needed.
				const style = statusStyle(entry.statusId);
				row.addClass("has-status");
				row.addClass(style.cls);
				row.title = style.label;
			}
			if (entry && isPlanned(entry.statusId)) {
				this.button(actions, key, { text: "✓", cls: "kdm-action is-complete", label: "Tamamlandı yap" }, () => void this.guard(key, () => this.complete(entry)));
			}
		} else {
			this.button(actions, key, { text: "KDM'ye aktar", cls: "mod-cta kdm-note-send" }, () => void this.guard(key, () => this.send(line, dayIndex, lineIndex, day)));
		}
		// A sent note edits its KDM entry; a note that was never sent edits only the local text.
		this.button(actions, key, { text: "✎", cls: "kdm-action is-edit", label: line.kdmId !== undefined ? "KDM kaydını düzenle" : "Notu düzenle" }, () => {
			if (line.kdmId !== undefined) {
				void this.guard(key, () => this.editLinked(line, dayIndex, day));
				return;
			}
			this.editing = { day: dayIndex, index: lineIndex };
			this.render();
		});
		this.button(actions, key, { text: "×", cls: "kdm-action is-delete", label: line.kdmId !== undefined ? "KDM'den ve nottan sil" : "Nottan sil" }, () => {
			// A note that was never sent only lives in the note, so there is nothing to wait for.
			if (line.kdmId === undefined) void this.dropLine(dayIndex, lineIndex, line);
			else void this.guard(key, () => this.remove(line, dayIndex, lineIndex, day));
		});
	}

	/**
	 * Removes this whole block from the note. Only the note changes: nothing is sent to KDM, so entries that were
	 * created from its notes stay there.
	 */
	private async removeBlock(): Promise<void> {
		const info = this.ctx.getSectionInfo(this.el);
		const file = this.plugin.app.vault.getFileByPath(this.ctx.sourcePath);
		if (!info || !(file instanceof TFile)) {
			new Notice("Bu blok burada kaldırılamıyor. Notu açıp bloğu elle silin.");
			return;
		}
		const count = this.week.days.reduce((sum, notes) => sum + notes.length, 0);
		const sent = this.week.days.reduce((sum, notes) => sum + notes.filter((n) => n.kdmId !== undefined).length, 0);
		const message =
			count === 0
				? "Boş haftalık blok nottan kaldırılacak."
				: `Bloktaki ${count} not nottan silinecek${sent ? ` (${sent} tanesi KDM'ye aktarılmış)` : ""}. KDM'deki kayıtlara dokunulmaz.`;
		if (!(await confirm(this.plugin.app, "Bloğu kaldır", message, "Kaldır"))) return;
		const snapshot = serializeWeekBlock(this.week);
		try {
			await this.plugin.app.vault.process(file, (data) => {
				const lines = data.split("\n");
				const found = findBlock(lines, info.lineStart, snapshot);
				if (!found) throw new Error("Blok notta değişmiş; hiçbir şey silinmedi. Notu yeniden açıp tekrar deneyin.");
				// Take the empty line that separated the block from the text around it, so no gap is left behind.
				const extra = (lines[found.end + 1] ?? "x").trim() === "" && (lines[found.start - 1] ?? "x").trim() === "" ? 1 : 0;
				lines.splice(found.start, found.end - found.start + 1 + extra);
				return lines.join("\n");
			});
			new Notice("Haftalık blok kaldırıldı. KDM kayıtları değişmedi.");
		} catch (error) {
			new Notice(errorMessage(error), 8000);
		}
	}

	/** The KDM entry a sent note points to: by id, or for an unknown id the single entry of that day with the same text. */
	private linkedEntry(line: NoteLine, day: Date): PlanEntry | null {
		if (line.kdmId) return this.entries.find((e) => e.id === line.kdmId) ?? null;
		const same = this.dayEntries(day).filter((e) => e.description?.trim() === line.text);
		return same.length === 1 ? (same[0] ?? null) : null;
	}

	private async complete(entry: PlanEntry): Promise<void> {
		try {
			await this.plugin.completeEntry(entry);
		} catch (error) {
			throw new Error(`Durum değiştirilemedi: ${errorMessage(error)}`);
		}
		new Notice("Görev tamamlandı.");
	}

	/** Opens KDM's edit dialog for the entry a sent note stands for, and keeps the note in step with what is saved. */
	private async editLinked(line: NoteLine, dayIndex: number, day: Date): Promise<boolean> {
		// Read KDM fresh so the dialog shows what it has now.
		this.entries = await this.plugin.getWeekEntries(startOfWeek(day), true);
		const entry = this.linkedEntry(line, day);
		if (!entry) {
			new Notice("Bu notun KDM kaydı bulunamadı. Yenile'ye basın ya da notu silin.", 8000);
			return false;
		}
		const sameLine = (l: NoteLine) => l.kdmId === entry.id || (l.kdmId === 0 && l.text === line.text);
		await this.plugin.editEntry(entry, {
			onUpdated: (value) => {
				void (async () => {
					await this.loadEntries();
					await this.change((week) => {
						const note = week.days[dayIndex]?.find(sameLine);
						if (note && value.description) note.text = value.description;
						syncSent(week, (l, i) => this.remoteState(l, i));
					});
				})();
			},
			// The entry is gone from KDM, so the note is simply a note that was not sent.
			onRemoved: () => {
				void this.change((week) => {
					const note = week.days[dayIndex]?.find(sameLine);
					if (note) delete note.kdmId;
				});
			},
		});
		return false;
	}

	private dropLine(dayIndex: number, lineIndex: number, line: NoteLine): Promise<void> {
		return this.change((week) => {
			const notes = week.days[dayIndex];
			if (notes?.[lineIndex]?.text === line.text) notes.splice(lineIndex, 1);
		});
	}

	/**
	 * Deletes a note that was sent to KDM: the entry goes first, and if KDM refuses, the note is kept and a warning is
	 * shown. Resolves to false when nothing was deleted.
	 */
	private async remove(line: NoteLine, dayIndex: number, lineIndex: number, day: Date): Promise<boolean> {
		// Read KDM fresh: the entry may be gone already, or the id may be unknown.
		try {
			this.entries = await this.plugin.getWeekEntries(startOfWeek(day), true);
		} catch (error) {
			new Notice(`${errorMessage(error)} Not silinmedi.`, 8000);
			return false;
		}
		const entry = this.linkedEntry(line, day);
		if (!entry) {
			const note = line.kdmId ? "Bu notun KDM kaydı artık yok." : "Bu notun KDM kaydı bulunamadı.";
			if (!(await confirm(this.plugin.app, "Notu sil", `${note} Yalnızca not silinsin mi?`, "Notu sil"))) return false;
			await this.dropLine(dayIndex, lineIndex, line);
			return true;
		}
		if (!(await this.plugin.askDelete("Bu not KDM'ye aktarılmış. KDM kaydı ve not birlikte silinecek. Emin misiniz?"))) return false;
		try {
			await this.plugin.deleteEntry(entry);
		} catch (error) {
			new Notice(`${errorMessage(error)} Not silinmedi.`, 8000);
			return false;
		}
		await this.dropLine(dayIndex, lineIndex, line);
		new Notice("Görev KDM'den ve nottan silindi.");
		return true;
	}

	/** What KDM currently says about the entry a sent note points to. */
	private remoteState(line: NoteLine, dayIndex: number): RemoteState | undefined {
		const entry = this.linkedEntry(line, addDays(this.week.weekStart, dayIndex));
		if (!entry || entry.id === undefined) return undefined;
		const start = new Date(entry.startTime);
		const end = new Date(entry.endTime);
		const wholeDay = entry.statusId === PlanStatus.DayOff && isFullDayLeave(start, end);
		return {
			id: entry.id,
			day: this.week.days.findIndex((_, i) => sameDay(addDays(this.week.weekStart, i), start)),
			timeRange: wholeDay ? undefined : { from: clock(start), to: clock(end) },
			period: wholeDay ? undefined : periodOf(start.getHours() * 60 + start.getMinutes(), this.plugin.lunch()),
		};
	}

	/**
	 * Fetches the week from KDM and shows it. Notes that were sent follow KDM (time, half of the day, weekday); notes
	 * that were never sent are left exactly as they are.
	 */
	private async refreshFromKdm(): Promise<boolean | void> {
		if (!this.plugin.loggedIn && !(await this.plugin.login())) return false;
		this.entries = await this.plugin.getWeekEntries(this.week.weekStart, true);
		// Notes whose entry was deleted in KDM become unsent first, so they are not reported as missing below.
		await this.reconcileMissing();
		let result = { changed: 0, missing: 0 };
		await this.change((week) => {
			result = syncSent(week, (line, dayIndex) => this.remoteState(line, dayIndex));
		});
		// Other views (the calendar) show the same fresh data.
		this.plugin.notifyPlansChanged();
		const parts = ["KDM'den yenilendi."];
		if (result.changed) parts.push(`${result.changed} not KDM'e göre güncellendi.`);
		if (result.missing) parts.push(`${result.missing} notun KDM kaydı bu haftada bulunamadı.`);
		new Notice(parts.join(" "), 6000);
	}

	/** Opens the add-task dialog prefilled from the note; on success the line is marked as sent. */
	private async send(line: NoteLine, dayIndex: number, lineIndex: number, day: Date): Promise<void> {
		if (!this.plugin.loggedIn && !(await this.plugin.login())) return;
		let entries = this.entries;
		try {
			entries = await this.plugin.getWeekEntries(startOfWeek(day));
		} catch {
			// The dialog loads them again and reports the problem.
		}
		const catalog = await this.plugin.refreshCatalog().catch(() => []);
		const leave = looksLikeLeave(line.text);
		const rules = this.plugin.rules();
		const past = startOfDay(day) < startOfDay(new Date());
		const stated = line.timeRange ? { start: atTime(day, line.timeRange.from), end: atTime(day, line.timeRange.to) } : null;
		// Without a stated time, look for a free slot in the half of the day the note was written in, then anywhere.
		const slot =
			stated?.start && stated.end
				? { start: stated.start, end: stated.end }
				: (suggestSlot(day, entries, rules.defaultMinutes, rules.breakMinutes, { lunch: rules.lunch, work: rules.work, period: line.period }) ??
					suggestSlot(day, entries, rules.defaultMinutes, rules.breakMinutes, { lunch: rules.lunch, work: rules.work }));
		await this.plugin.openPlanModal(
			{
				date: day,
				startTime: slot ? clock(slot.start) : undefined,
				endTime: slot ? clock(slot.end) : undefined,
				status: leave ? PlanStatus.DayOff : past ? PlanStatus.Completed : PlanStatus.Planned,
				jobDefinitionId: leave ? undefined : matchTask(line.text, catalog)?.id,
				description: line.text,
				leaveHourly: leave && stated !== null,
			},
			(id, value) => {
				// The note follows the time that was actually chosen: it moves to that half of the day, in time order.
				const fullDayLeave = value.status === PlanStatus.DayOff && isFullDayLeave(value.start, value.end);
				const sent = {
					id: id ?? 0,
					timeRange: fullDayLeave ? undefined : { from: clock(value.start), to: clock(value.end) },
					period: periodOf(value.start.getHours() * 60 + value.start.getMinutes(), rules.lunch),
				};
				void this.change((week) => {
					const notes = week.days[dayIndex];
					if (notes) markSent(notes, line.text, sent);
				});
			},
		);
	}
}
