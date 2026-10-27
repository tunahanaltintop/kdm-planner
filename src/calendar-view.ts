import { ItemView, Menu, Notice, WorkspaceLeaf } from "obsidian";
import type KdmPlannerPlugin from "./main";
import { errorMessage } from "./main";
import { PlanEntry } from "./kdm-protocol";
import {
	addDays,
	addMinutes,
	checkSlot,
	clock,
	formatDuration,
	GridRange,
	gridRange,
	isoDate,
	isPlanned,
	layoutSegments,
	PlacedSegment,
	segmentForDay,
	sameDay,
	SLOT_MINUTES,
	startOfDay,
	startOfWeek,
	statusStyle,
	WEEKDAY_SHORT,
} from "./week";

export const VIEW_TYPE_KDM = "kdm-calendar";

/** Pixels per hour of the time grid. */
const HOUR_PX = 56;
const DRAG_THRESHOLD_PX = 4;
const MONTHS = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

type DragMode = "move" | "resize";

/** The weekly planning calendar of KDM: add by clicking a cell, edit by clicking an entry, drag to move, resize from the bottom edge. */
export class KdmCalendarView extends ItemView {
	private weekStart = startOfWeek(new Date());
	private entries: PlanEntry[] = [];
	private error: string | null = null;
	private loading = false;
	private unsubscribe: (() => void) | null = null;
	private columns: HTMLElement[] = [];
	private dayCount = 7;
	/** Hours the grid shows; set on every render from the working hours and the week's entries. */
	private range: GridRange = { startHour: 8, endHour: 18 };
	/** Entries that are talking to KDM right now; their buttons stay disabled. */
	private busy = new Set<string>();

	constructor(
		leaf: WorkspaceLeaf,
		private readonly plugin: KdmPlannerPlugin,
	) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_KDM;
	}

	getDisplayText(): string {
		return "KDM takvim";
	}

	getIcon(): string {
		return "calendar-days";
	}

	async onOpen(): Promise<void> {
		this.contentEl.addClass("kdm-calendar");
		this.unsubscribe = this.plugin.onPlansChanged(() => void this.reload());
		await this.reload();
	}

	onClose(): Promise<void> {
		this.unsubscribe?.();
		return Promise.resolve();
	}

	/** Counts reloads so that a slow answer for a week the user already left cannot replace the current one. */
	private loadSeq = 0;

	private async reload(force = false): Promise<void> {
		const seq = ++this.loadSeq;
		this.dayCount = this.plugin.settings.showWeekend ? 7 : 5;
		if (!this.plugin.loggedIn) {
			this.entries = [];
			this.error = null;
			this.render();
			return;
		}
		this.loading = true;
		this.render();
		let entries: PlanEntry[] = [];
		let error: string | null = null;
		try {
			entries = await this.plugin.getWeekEntries(this.weekStart, force);
		} catch (e) {
			error = errorMessage(e);
		}
		if (seq !== this.loadSeq) return;
		this.entries = entries;
		this.error = error;
		this.loading = false;
		this.render();
	}

	/**
	 * Runs an operation that calls KDM. The buttons of `key` are disabled while it runs. On success the week is reloaded
	 * from KDM before they come back; on failure they come back at once and the error is shown.
	 */
	private async guard(key: string, run: () => Promise<boolean | void>): Promise<void> {
		if (this.busy.has(key)) return;
		this.busy.add(key);
		this.render();
		try {
			if ((await run()) !== false) await this.reload();
		} catch (error) {
			this.report(error);
			// The request may have gone through before it failed (e.g. a timeout): show what KDM really has.
			await this.reload(true);
		} finally {
			this.busy.delete(key);
			this.render();
		}
	}

	private go(weekStart: Date): void {
		this.weekStart = startOfWeek(weekStart);
		void this.reload();
	}

	private title(): string {
		const last = addDays(this.weekStart, 6);
		const first = this.weekStart;
		const left = `${first.getDate()} ${MONTHS[first.getMonth()]}`;
		return `${left} – ${last.getDate()} ${MONTHS[last.getMonth()]} ${last.getFullYear()}`;
	}

	// ---- rendering ----

	private render(): void {
		const root = this.contentEl;
		root.empty();
		this.columns = [];

		const bar = root.createDiv({ cls: "kdm-toolbar" });
		const nav = bar.createDiv({ cls: "kdm-toolbar-group" });
		nav.createEl("button", { text: "‹", attr: { "aria-label": "Önceki hafta" } }).addEventListener("click", () => this.go(addDays(this.weekStart, -7)));
		nav.createEl("button", { text: "Bugün" }).addEventListener("click", () => this.go(new Date()));
		nav.createEl("button", { text: "›", attr: { "aria-label": "Sonraki hafta" } }).addEventListener("click", () => this.go(addDays(this.weekStart, 7)));
		bar.createEl("strong", { cls: "kdm-title", text: this.title() });
		const actions = bar.createDiv({ cls: "kdm-toolbar-group" });
		const refresh = actions.createEl("button", { text: this.loading ? "Yükleniyor..." : "Yenile" });
		refresh.disabled = this.loading;
		refresh.addEventListener("click", () => void this.reload(true));
		actions.createEl("button", { text: "Yeni görev", cls: "mod-cta" }).addEventListener("click", () => void this.newTask(startOfDay(new Date())));

		if (!this.plugin.loggedIn) {
			const empty = root.createDiv({ cls: "kdm-empty" });
			empty.createEl("p", { text: "Takvimi görmek için KDM'ye giriş yapın." });
			empty.createEl("button", { text: "Giriş yap", cls: "mod-cta" }).addEventListener("click", () => void this.plugin.login());
			return;
		}
		if (this.error) root.createDiv({ cls: "kdm-error", text: this.error });

		const grid = root.createDiv({ cls: "kdm-grid" });
		grid.setCssProps({ "--kdm-days": String(this.dayCount), "--kdm-hour": `${HOUR_PX}px` });
		const days = Array.from({ length: this.dayCount }, (_, i) => addDays(this.weekStart, i));
		const today = new Date();
		const work = this.plugin.work();
		const range = (this.range = gridRange(work, this.entries, days));
		grid.setCssProps({ "--kdm-days": String(this.dayCount), "--kdm-hour": `${HOUR_PX}px`, "--kdm-hours": String(range.endHour - range.startHour) });

		const head = grid.createDiv({ cls: "kdm-head" });
		head.createDiv({ cls: "kdm-gutter" });
		days.forEach((day, index) => {
			const cell = head.createDiv({ cls: "kdm-day-head" });
			if (sameDay(day, today)) cell.addClass("is-today");
			cell.createSpan({ cls: "kdm-day-name", text: WEEKDAY_SHORT[index] });
			cell.createSpan({ cls: "kdm-day-number", text: String(day.getDate()) });
		});

		const body = grid.createDiv({ cls: "kdm-body" });
		const gutter = body.createDiv({ cls: "kdm-gutter" });
		for (let hour = range.startHour; hour < range.endHour; hour++) gutter.createDiv({ cls: "kdm-hour-label", text: `${String(hour).padStart(2, "0")}:00` });

		days.forEach((day, index) => {
			const column = body.createDiv({ cls: "kdm-column" });
			column.dataset.day = isoDate(day);
			if (sameDay(day, today)) column.addClass("is-today");
			column.addEventListener("click", (event) => {
				if (event.target !== column) return;
				const minutes = Math.floor((event.offsetY / HOUR_PX) * 60 / SLOT_MINUTES) * SLOT_MINUTES;
				void this.newTask(day, addMinutes(new Date(day.getFullYear(), day.getMonth(), day.getDate(), range.startHour), minutes));
			});
			this.columns.push(column);

			// The lunch break splits the day into morning and afternoon.
			const lunch = this.plugin.lunch();
			const first = range.startHour * 60;
			const last = range.endHour * 60;
			if (lunch.end > first && lunch.start < last) {
				const band = column.createDiv({ cls: "kdm-lunch" });
				band.setCssProps({
					top: `${((Math.max(lunch.start, first) - first) / 60) * HOUR_PX}px`,
					height: `${((Math.min(lunch.end, last) - Math.max(lunch.start, first)) / 60) * HOUR_PX}px`,
				});
				if (index === 0) band.createSpan({ text: "Öğle arası" });
			}

			const segments = this.entries.map((e) => segmentForDay(e, day, range)).filter((s): s is NonNullable<typeof s> => s !== null);
			for (const placed of layoutSegments(segments)) this.renderEntry(column, placed, index);

			if (sameDay(day, today)) {
				const minutes = (today.getHours() - range.startHour) * 60 + today.getMinutes();
				if (minutes >= 0 && minutes <= (range.endHour - range.startHour) * 60) {
					column.createDiv({ cls: "kdm-now" }).setCssProps({ top: `${(minutes / 60) * HOUR_PX}px` });
				}
			}
		});
	}

	private isLocked(entry: PlanEntry): boolean {
		return this.plugin.isLocked(entry);
	}

	private renderEntry(column: HTMLElement, placed: PlacedSegment, dayIndex: number): void {
		const { entry } = placed;
		const style = statusStyle(entry.statusId);
		const jobName = (entry.jobDefinition as { name?: string } | null | undefined)?.name;
		const title = jobName ?? (entry.statusId === "DayOff" ? "İzin günü" : "Görev");
		const startMinutes = (placed.start.getHours() - this.range.startHour) * 60 + placed.start.getMinutes();
		const length = (placed.end.getTime() - placed.start.getTime()) / 60_000;

		const block = column.createDiv({ cls: "kdm-entry" });
		block.addClass(style.cls);
		block.setCssProps({
			top: `${(startMinutes / 60) * HOUR_PX}px`,
			height: `${Math.max((length / 60) * HOUR_PX - 2, 14)}px`,
			left: `${(placed.column / placed.columns) * 100}%`,
			width: `calc(${100 / placed.columns}% - 2px)`,
		});
		const locked = this.isLocked(entry);
		if (locked) block.addClass("is-locked");
		const movable = isPlanned(entry.statusId) && !locked && sameDay(new Date(entry.startTime), new Date(entry.endTime));
		if (movable) block.addClass("is-movable");

		block.createDiv({ cls: "kdm-entry-title", text: title });
		block.createDiv({ cls: "kdm-entry-time", text: `${clock(new Date(entry.startTime))} – ${clock(new Date(entry.endTime))}` });
		if (entry.description) block.createDiv({ cls: "kdm-entry-desc", text: entry.description });
		block.title = [title, `${style.label} · ${formatDuration((new Date(entry.endTime).getTime() - new Date(entry.startTime).getTime()) / 60_000)}`, entry.description ?? "", locked ? "Kilitli (geçmiş hafta): görüntülemek için tıklayın" : ""]
			.filter(Boolean)
			.join("\n");
		const handle = movable ? block.createDiv({ cls: "kdm-resize" }) : null;

		// Quick actions on the entry itself: mark as completed, delete. Locked (past) entries have none.
		if (!locked) {
			block.addClass(isPlanned(entry.statusId) ? "has-two-actions" : "has-one-action");
			const actions = block.createDiv({ cls: "kdm-entry-actions" });
			const key = `entry:${entry.id}`;
			const action = (text: string, label: string, kind: "complete" | "delete", onClick: () => void) => {
				const button = actions.createEl("button", { text, cls: `kdm-action is-${kind}`, attr: { "aria-label": label, title: label } });
				if (this.busy.has(key)) {
					button.disabled = true;
					button.addClass("is-busy");
				}
				button.addEventListener("pointerdown", (event) => event.stopPropagation());
				button.addEventListener("click", (event) => {
					event.stopPropagation();
					onClick();
				});
			};
			if (isPlanned(entry.statusId)) {
				action("✓", "Tamamlandı yap", "complete", () =>
					void this.guard(key, async () => {
						await this.plugin.completeEntry(entry);
						new Notice("Görev tamamlandı.");
					}),
				);
			}
			action("×", "Sil", "delete", () => void this.deleteEntry(key, entry));
		}

		block.addEventListener("click", (event) => event.stopPropagation());
		block.addEventListener("contextmenu", (event) => {
			event.preventDefault();
			this.contextMenu(entry, event);
		});
		block.addEventListener("pointerdown", (event) => {
			if (event.button !== 0) return;
			this.pointerDown(event, block, entry, dayIndex, movable, handle !== null && event.target === handle ? "resize" : "move");
		});
	}

	private contextMenu(entry: PlanEntry, event: MouseEvent): void {
		const menu = new Menu();
		const locked = this.isLocked(entry);
		menu.addItem((item) => item.setTitle(locked ? "Görüntüle" : "Düzenle").setIcon(locked ? "eye" : "pencil").onClick(() => this.edit(entry)));
		if (isPlanned(entry.statusId) && !locked) {
			menu.addItem((item) =>
				item.setTitle("Tamamla").setIcon("check").onClick(() =>
						void this.guard(`entry:${entry.id}`, async () => {
							await this.plugin.completeEntry(entry);
							new Notice("Görev tamamlandı.");
						}),
					),
			);
		}
		if (!locked) {
			menu.addItem((item) => item.setTitle("Sil").setIcon("trash").onClick(() => void this.deleteEntry(`entry:${entry.id}`, entry)));
		}
		menu.showAtMouseEvent(event);
	}

	/** Asks first; the buttons are only disabled once the delete request is actually sent. */
	private async deleteEntry(key: string, entry: PlanEntry): Promise<void> {
		if (!(await this.plugin.askDelete())) return;
		await this.guard(key, async () => {
			await this.plugin.deleteEntry(entry);
			new Notice("Görev KDM'den silindi.");
		});
	}

	private readonly report = (error: unknown): void => {
		new Notice(errorMessage(error));
	};

	private async newTask(day: Date, start?: Date): Promise<void> {
		const init = { date: day, startTime: start ? clock(start) : undefined, endTime: start ? clock(addMinutes(start, SLOT_MINUTES)) : undefined };
		await this.plugin.openPlanModal(init);
	}

	private edit(entry: PlanEntry): void {
		void this.plugin.editEntry(entry);
	}

	// ---- drag to move, drag the bottom edge to resize ----

	private pointerDown(event: PointerEvent, block: HTMLElement, entry: PlanEntry, dayIndex: number, movable: boolean, mode: DragMode): void {
		const originX = event.clientX;
		const originY = event.clientY;
		let dragging = false;
		let target: { start: Date; end: Date; dayIndex: number } | null = null;
		const start = new Date(entry.startTime);
		const end = new Date(entry.endTime);
		const columnWidth = this.columns[0]?.getBoundingClientRect().width ?? 0;

		const compute = (e: PointerEvent) => {
			const slotPx = (HOUR_PX * SLOT_MINUTES) / 60;
			const snappedY = Math.round((e.clientY - originY) / slotPx) * slotPx;
			const deltaMinutes = Math.round(snappedY / slotPx) * SLOT_MINUTES;
			if (mode === "resize") {
				const newEnd = addMinutes(end, deltaMinutes);
				return { start, end: newEnd < addMinutes(start, SLOT_MINUTES) ? addMinutes(start, SLOT_MINUTES) : newEnd, dayIndex, offsetX: 0, offsetY: 0 };
			}
			const columnDelta = columnWidth ? Math.max(-dayIndex, Math.min(this.dayCount - 1 - dayIndex, Math.round((e.clientX - originX) / columnWidth))) : 0;
			const newStart = addMinutes(addDays(start, columnDelta), deltaMinutes);
			const newEnd = addMinutes(addDays(end, columnDelta), deltaMinutes);
			return { start: newStart, end: newEnd, dayIndex: dayIndex + columnDelta, offsetX: columnDelta * columnWidth, offsetY: snappedY };
		};

		const onMove = (e: PointerEvent) => {
			if (!movable) return;
			if (!dragging && Math.hypot(e.clientX - originX, e.clientY - originY) < DRAG_THRESHOLD_PX) return;
			if (!dragging) {
				dragging = true;
				block.addClass("is-dragging");
				block.setPointerCapture(e.pointerId);
			}
			const next = compute(e);
			target = next;
			if (mode === "resize") block.setCssProps({ height: `${Math.max(((next.end.getTime() - next.start.getTime()) / 3_600_000) * HOUR_PX - 2, 14)}px` });
			else block.setCssProps({ transform: `translate(${next.offsetX}px, ${next.offsetY}px)` });
		};

		const onUp = () => {
			block.removeEventListener("pointermove", onMove);
			block.removeEventListener("pointerup", onUp);
			block.removeEventListener("pointercancel", onUp);
			block.removeClass("is-dragging");
			if (!dragging) {
				this.edit(entry);
				return;
			}
			const moved = target;
			if (!moved || (moved.start.getTime() === start.getTime() && moved.end.getTime() === end.getTime())) {
				this.render();
				return;
			}
			void this.commitMove(entry, moved.start, moved.end, mode === "resize");
		};

		block.addEventListener("pointermove", onMove);
		block.addEventListener("pointerup", onUp);
		block.addEventListener("pointercancel", onUp);
	}

	private async commitMove(entry: PlanEntry, start: Date, end: Date, resized: boolean): Promise<void> {
		const rules = this.plugin.rules();
		const result = checkSlot(start, end, { ...rules, existing: this.entries, ignoreId: entry.id });
		if (result.errors.length) {
			new Notice(result.errors[0] ?? "Taşınamadı.");
			this.render();
			return;
		}
		try {
			await this.plugin.moveEntry(entry, start, end, resized);
			new Notice(result.warnings[0] ? `Taşındı. Uyarı: ${result.warnings[0]}` : "Görev taşındı.");
		} catch (error) {
			new Notice(errorMessage(error));
			await this.reload(true);
		}
	}
}
