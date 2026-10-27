/**
 * Calendar rules of the KDM planning page ("Planlama"), kept pure so they can be tested.
 * Source: the page's scheduler in the web app's bundle.
 */
import { PlanStatus } from "./kdm-protocol.ts";
import type { PlanEntry, PlanStatusId } from "./kdm-protocol.ts";

/** The scheduler works in 30 minute cells. */
export const SLOT_MINUTES = 30;

/** Company id whose users may edit the last 7 days instead of only the current week. */
export const EXTENDED_EDIT_COMPANY_ID = 43;

/** Default span of a leave day, as existing leave entries use it (08:30-17:30, counted as 8 hours). */
export const DAY_OFF_START = { hour: 8, minute: 30 };
export const DAY_OFF_END = { hour: 17, minute: 30 };
export const DAY_OFF_HOURS = 8;

/** Lunch break as minutes after midnight. */
export interface LunchBreak {
	start: number;
	end: number;
}

export const DEFAULT_LUNCH_START = "12:30";
export const DEFAULT_LUNCH_END = "13:30";

/** Working hours as minutes after midnight. They guide the calendar and suggestions; entries may lie outside them. */
export interface WorkHours {
	start: number;
	end: number;
}

export const DEFAULT_WORK_START = "08:30";
export const DEFAULT_WORK_END = "17:30";

/** Hours of the day the calendar grid shows, `end` exclusive. */
export interface GridRange {
	startHour: number;
	endHour: number;
}

/** `12:30` -> 750; null when malformed. */
export function clockToMinutes(value: string): number | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	return hour > 23 || minute > 59 ? null : hour * 60 + minute;
}

/** Lunch from the two setting strings; falls back to 12:30-13:30 when they are malformed or reversed. */
export function lunchFromSettings(start: string, end: string): LunchBreak {
	const from = clockToMinutes(start);
	const to = clockToMinutes(end);
	if (from === null || to === null || to <= from) return { start: clockToMinutes(DEFAULT_LUNCH_START) ?? 750, end: clockToMinutes(DEFAULT_LUNCH_END) ?? 810 };
	return { start: from, end: to };
}

/** Working hours from the two setting strings; falls back to 08:30-17:30 when they are malformed or reversed. */
export function workHoursFromSettings(start: string, end: string): WorkHours {
	const from = clockToMinutes(start);
	const to = clockToMinutes(end);
	if (from === null || to === null || to <= from) return { start: clockToMinutes(DEFAULT_WORK_START) ?? 510, end: clockToMinutes(DEFAULT_WORK_END) ?? 1050 };
	return { start: from, end: to };
}

/**
 * Hours the grid shows: the whole working hours, widened to whole hours and to any entry that lies outside them, so
 * that nothing is cut off.
 */
export function gridRange(work: WorkHours, entries: PlanEntry[], days: Date[]): GridRange {
	let from = work.start;
	let to = work.end;
	for (const day of days) {
		const dayStart = startOfDay(day);
		const dayEnd = addDays(dayStart, 1);
		for (const entry of entries) {
			const start = asDate(entry.startTime);
			const end = asDate(entry.endTime);
			if (!(start < dayEnd && dayStart < end)) continue;
			from = Math.min(from, start < dayStart ? 0 : start.getHours() * 60 + start.getMinutes());
			to = Math.max(to, end >= dayEnd ? 24 * 60 : end.getHours() * 60 + end.getMinutes());
		}
	}
	return { startHour: Math.floor(from / 60), endHour: Math.min(24, Math.ceil(to / 60)) };
}

export type DayPeriod = "am" | "pm";

export const PERIOD_LABEL: Record<DayPeriod, string> = { am: "Öğleden önce", pm: "Öğleden sonra" };

/** Which half of the day a time belongs to: from the start of the lunch break on it is the afternoon. */
export function periodOf(minutesAfterMidnight: number, lunch: LunchBreak): DayPeriod {
	return minutesAfterMidnight >= lunch.start ? "pm" : "am";
}

export const WEEKDAY_SHORT = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"];
export const WEEKDAY_LONG = ["Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi", "Pazar"];

const pad = (value: number) => String(value).padStart(2, "0");

/** 750 -> `12:30` */
export const minutesToClock = (minutes: number): string => `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;

export function startOfDay(date: Date): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date: Date, days: number): Date {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days, date.getHours(), date.getMinutes(), date.getSeconds());
}

export function addMinutes(date: Date, minutes: number): Date {
	return new Date(date.getTime() + minutes * 60_000);
}

/** Monday of the week containing `date`, at 00:00. */
export function startOfWeek(date: Date): Date {
	const day = startOfDay(date);
	return addDays(day, -((day.getDay() + 6) % 7));
}

export function sameDay(a: Date, b: Date): boolean {
	return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** `2026-10-26` */
export function isoDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function parseIsoDate(value: string): Date | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
	if (!match) return null;
	const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
	return isoDate(date) === value.trim() ? date : null;
}

/** `09:30` */
export function clock(date: Date): string {
	return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Combines a day with an `HH:MM` string; null when the time is malformed. */
export function atTime(day: Date, time: string): Date | null {
	const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
	if (!match) return null;
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	if (hour > 23 || minute > 59) return null;
	return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute);
}

export function weekDays(weekStart: Date, count = 7): Date[] {
	return Array.from({ length: count }, (_, i) => addDays(weekStart, i));
}

/** `3 sa 30 dk` */
export function formatDuration(minutes: number): string {
	const total = Math.max(0, Math.round(minutes));
	const hours = Math.floor(total / 60);
	const rest = total % 60;
	if (hours && rest) return `${hours} sa ${rest} dk`;
	return hours ? `${hours} sa` : `${rest} dk`;
}

/**
 * Earliest start the user may still edit. For users of the extended-edit company the last 7 days stay open, otherwise only the current
 * week (from Monday).
 */
export function minEditableDate(companyId: number | undefined, now = new Date()): Date {
	if (companyId === EXTENDED_EDIT_COMPANY_ID) return addDays(startOfDay(now), -7);
	return startOfWeek(now);
}

/** Whether a leave covers whole days (the default 08:30-17:30 span, or several days) rather than some hours. */
export function isFullDayLeave(start: Date, end: Date): boolean {
	if (!sameDay(start, end)) return true;
	return start.getHours() * 60 + start.getMinutes() === DAY_OFF_START.hour * 60 + DAY_OFF_START.minute && end.getHours() * 60 + end.getMinutes() === DAY_OFF_END.hour * 60 + DAY_OFF_END.minute;
}

/** Hours a leave counts for: 8 per working day in the range, at least one day (existing leave: Mon-Fri = 40). */
export function leaveHours(firstDay: Date, lastDay: Date): number {
	let days = 0;
	for (let day = startOfDay(firstDay); day <= lastDay; day = addDays(day, 1)) if (day.getDay() !== 0 && day.getDay() !== 6) days++;
	return Math.max(1, days) * DAY_OFF_HOURS;
}

export const isPlanned = (status: string | undefined): boolean => status === PlanStatus.Planned || status === PlanStatus.AssignedPlanned;

export interface StatusStyle {
	label: string;
	/** CSS class that carries the colours (see styles.css), so themes and snippets can adjust them. */
	cls: string;
}

/** Look of an entry by status, with a Turkish label. The colours are the ones KDM's calendar uses. */
export function statusStyle(status: string | undefined): StatusStyle {
	switch (status) {
		case PlanStatus.Completed:
		case PlanStatus.AssignedCompleted:
			return { label: "Tamamlandı", cls: "kdm-status-completed" };
		case PlanStatus.NotCompleted:
			return { label: "Tamamlanmadı", cls: "kdm-status-not-completed" };
		case PlanStatus.DayOff:
			return { label: "İzin günü", cls: "kdm-status-day-off" };
		default:
			return { label: "Planlandı", cls: "kdm-status-planned" };
	}
}

/** Status choices offered when entering a task. */
export const STATUS_CHOICES: { id: PlanStatusId; label: string }[] = [
	{ id: PlanStatus.Planned, label: "Planlandı" },
	{ id: PlanStatus.Completed, label: "Tamamlandı" },
	{ id: PlanStatus.NotCompleted, label: "Tamamlanmadı" },
	{ id: PlanStatus.DayOff, label: "İzin günü" },
];

export interface Segment {
	entry: PlanEntry;
	start: Date;
	end: Date;
}

const asDate = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));

/** The part of an entry that falls on `day`, clipped to the visible hours. Null when it does not touch the day. */
export function segmentForDay(entry: PlanEntry, day: Date, range: GridRange = { startHour: 0, endHour: 24 }): Segment | null {
	const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), range.startHour);
	const dayEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), range.endHour);
	const start = asDate(entry.startTime);
	const end = asDate(entry.endTime);
	const from = start > dayStart ? start : dayStart;
	const to = end < dayEnd ? end : dayEnd;
	return to > from ? { entry, start: from, end: to } : null;
}

export interface PlacedSegment extends Segment {
	column: number;
	columns: number;
}

/** Puts overlapping segments of one day side by side. */
export function layoutSegments(segments: Segment[]): PlacedSegment[] {
	const sorted = [...segments].sort((a, b) => a.start.getTime() - b.start.getTime() || b.end.getTime() - a.end.getTime());
	const placed: PlacedSegment[] = [];
	let cluster: PlacedSegment[] = [];
	let clusterEnd = 0;
	const closeCluster = () => {
		const columns = cluster.reduce((max, s) => Math.max(max, s.column + 1), 1);
		for (const s of cluster) s.columns = columns;
		placed.push(...cluster);
		cluster = [];
	};
	for (const segment of sorted) {
		if (cluster.length && segment.start.getTime() >= clusterEnd) closeCluster();
		const taken = new Set(cluster.filter((s) => s.end > segment.start).map((s) => s.column));
		let column = 0;
		while (taken.has(column)) column++;
		cluster.push({ ...segment, column, columns: 1 });
		clusterEnd = Math.max(clusterEnd, segment.end.getTime());
	}
	closeCluster();
	return placed;
}

export interface SlotRules {
	/** Earliest editable start (see `minEditableDate`). */
	minEditable: Date;
	/** Other entries of the user, used for leave and overlap checks. */
	existing: PlanEntry[];
	/** Entry being edited; ignored in the checks. */
	ignoreId?: number;
	/** Blocks of this many hours or more are refused. */
	maxBlockHours: number;
	/** Gap that should separate two tasks, in minutes; only a warning. */
	breakMinutes: number;
	/** A task that runs into the lunch break gets a warning. */
	lunch?: LunchBreak;
	/** A task outside the working hours gets a warning; it is still allowed. */
	work?: WorkHours;
}

export interface SlotCheck {
	errors: string[];
	warnings: string[];
}

const overlaps = (aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) => aStart < bEnd && bStart < aEnd;

/** Checks a task slot against the planning page's rules and the user's own (no block of 4 hours or more). */
export function checkSlot(start: Date, end: Date, rules: SlotRules): SlotCheck {
	const errors: string[] = [];
	const warnings: string[] = [];
	if (isNaN(start.getTime()) || isNaN(end.getTime())) return { errors: ["Tarih veya saat geçersiz."], warnings };
	if (end <= start) return { errors: ["Bitiş saati başlangıçtan sonra olmalı."], warnings };
	if (!sameDay(start, end)) errors.push("Kayıt aynı gün içinde başlayıp bitmeli.");
	if (rules.work && sameDay(start, end) && (start.getHours() * 60 + start.getMinutes() < rules.work.start || end.getHours() * 60 + end.getMinutes() > rules.work.end)) {
		warnings.push(`Mesai saatlerinin (${minutesToClock(rules.work.start)} - ${minutesToClock(rules.work.end)}) dışında.`);
	}
	if (start < rules.minEditable) errors.push(`${isoDate(rules.minEditable)} öncesindeki günler kilitli.`);
	const minutes = (end.getTime() - start.getTime()) / 60_000;
	if (minutes >= rules.maxBlockHours * 60) errors.push(`${rules.maxBlockHours} saat ve üstü bloklar girilmez (en fazla ${formatDuration(rules.maxBlockHours * 60 - SLOT_MINUTES)}).`);
	if (rules.lunch) {
		const from = start.getHours() * 60 + start.getMinutes();
		const to = end.getHours() * 60 + end.getMinutes();
		if (sameDay(start, end) && from < rules.lunch.end && rules.lunch.start < to) warnings.push("Öğle arasına denk geliyor.");
	}
	for (const other of rules.existing) {
		if (other.id !== undefined && other.id === rules.ignoreId) continue;
		const otherStart = asDate(other.startTime);
		const otherEnd = asDate(other.endTime);
		if (other.statusId === PlanStatus.DayOff) {
			if (overlaps(start, end, otherStart, otherEnd)) errors.push("Bu saatler bir izin gününe denk geliyor.");
		} else if (overlaps(start, end, otherStart, otherEnd)) {
			warnings.push(`Başka bir kayıtla çakışıyor (${clock(otherStart)}-${clock(otherEnd)}).`);
		} else if (sameDay(start, otherStart) && rules.breakMinutes > 0) {
			const gap = start >= otherEnd ? (start.getTime() - otherEnd.getTime()) / 60_000 : (otherStart.getTime() - end.getTime()) / 60_000;
			if (gap < rules.breakMinutes) warnings.push(`Önceki/sonraki kayıtla arada ${rules.breakMinutes} dk mola yok.`);
		}
	}
	return { errors: [...new Set(errors)], warnings };
}

/**
 * First free slot of a day (within the working hours) for a task of the given length: after the last entry plus a break, never inside the lunch
 * break. With `period` the slot must lie in that half of the day. Returns null when nothing fits.
 */
export function suggestSlot(
	day: Date,
	entries: PlanEntry[],
	durationMinutes: number,
	breakMinutes: number,
	options: { lunch?: LunchBreak; period?: DayPeriod; work?: WorkHours } = {},
): { start: Date; end: Date } | null {
	const at = (minutes: number) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes);
	const { lunch, period, work = workHoursFromSettings(DEFAULT_WORK_START, DEFAULT_WORK_END) } = options;
	let windowStart = at(work.start);
	let windowEnd = at(work.end);
	if (lunch && period === "am") windowEnd = at(lunch.start);
	if (lunch && period === "pm") windowStart = at(lunch.end);
	const busy = entries
		.map((e) => ({ start: asDate(e.startTime), end: asDate(e.endTime), padded: true }))
		.filter((e) => overlaps(e.start, e.end, windowStart, windowEnd));
	if (lunch) busy.push({ start: at(lunch.start), end: at(lunch.end), padded: false });
	busy.sort((a, b) => a.start.getTime() - b.start.getTime());
	let cursor = windowStart;
	for (const slot of busy) {
		if (slot.end <= cursor) continue;
		// A gap before this entry is used when the task and the break after it fit.
		const gap = slot.padded ? breakMinutes : 0;
		if (addMinutes(cursor, durationMinutes + gap) <= slot.start) break;
		cursor = addMinutes(slot.end, slot.padded ? breakMinutes : 0);
	}
	const end = addMinutes(cursor, durationMinutes);
	return end <= windowEnd ? { start: cursor, end } : null;
}

const STOP_WORDS = new Set(["ve", "ile", "için", "bir", "bu", "da", "de", "ki", "mi", "yapmak", "yapıldı", "etmek"]);

function tokens(text: string): string[] {
	return text
		.toLocaleLowerCase("tr")
		.split(/[^\p{L}\p{N}]+/u)
		.filter((word) => word.length > 2 && !STOP_WORDS.has(word))
		// Turkish suffixes: compare on a 5-letter stem so "toplantısı" matches "toplantı".
		.map((word) => word.slice(0, 5));
}

/** Best catalogue entry for a note by shared word stems; null when nothing overlaps. */
export function matchTask<T extends { name: string }>(note: string, catalog: T[]): T | null {
	const wanted = new Set(tokens(note));
	if (!wanted.size) return null;
	let best: T | null = null;
	let bestScore = 0;
	for (const task of catalog) {
		const score = tokens(task.name).filter((word) => wanted.has(word)).length;
		if (score > bestScore) {
			best = task;
			bestScore = score;
		}
	}
	return best;
}

/** Leave notes: "izin", "izinli", "yıllık izin"... */
export function looksLikeLeave(note: string): boolean {
	return /(^|\s)(yıllık\s+)?izin(li|de)?\b/i.test(note.toLocaleLowerCase("tr"));
}
