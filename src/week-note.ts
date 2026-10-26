/**
 * The `kdm-week` block: a week of notes inside an ordinary note.
 *
 *     ```kdm-week
 *     hafta: 2026-10-26
 *     ## Pzt 26.10
 *     ### Öğleden önce
 *     - 09:00-10:30 Müşteri toplantısı {kdm:2254827}
 *     ### Öğleden sonra
 *     - Rapor hazırla
 *     ## Sal 27.10
 *     ```
 *
 * A line is a note; `{kdm:ID}` marks one that was already entered in KDM. Pure so it can be tested.
 */
import { addDays, clockToMinutes, isoDate, parseIsoDate, startOfWeek, WEEKDAY_SHORT } from "./week.ts";
import type { DayPeriod } from "./week.ts";

export const BLOCK_LANGUAGE = "kdm-week";

export interface NoteLine {
	text: string;
	/** Optional `HH:MM-HH:MM` written before the text. */
	timeRange?: { from: string; to: string };
	/** Id of the KDM entry created from this note; 0 when it was entered but the id could not be read back. */
	kdmId?: number;
	/** Half of the day the note belongs to. Set on every line read from a block; missing on lines parsed alone. */
	period?: DayPeriod;
}

export interface WeekNotes {
	/** Monday of the week. */
	weekStart: Date;
	/** Notes of each weekday, Monday first. */
	days: NoteLine[][];
}

const TIME_RANGE = /^(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})\s+/;
const MARKER = /\s*\{kdm:(\d+|\?)\}\s*$/;
const HEADER = /^##\s*(Pzt|Sal|Çar|Per|Cum|Cmt|Paz)\b/i;
const PERIOD_HEADER = /^###\s*(öğleden\s+önce|öğleden\s+sonra)/i;
const PERIOD_TITLE: Record<DayPeriod, string> = { am: "Öğleden önce", pm: "Öğleden sonra" };

export function parseLine(raw: string): NoteLine {
	let text = raw.trim();
	const result: NoteLine = { text: "" };
	const marker = MARKER.exec(text);
	if (marker) {
		result.kdmId = marker[1] === "?" ? 0 : Number(marker[1]);
		text = text.slice(0, marker.index).trim();
	}
	const range = TIME_RANGE.exec(`${text} `);
	if (range) {
		result.timeRange = { from: range[1] ?? "", to: range[2] ?? "" };
		text = text.slice(range[0].length - 1).trim();
	}
	result.text = text;
	return result;
}

const startMinutes = (line: NoteLine): number => clockToMinutes(line.timeRange?.from ?? "") ?? Infinity;

/**
 * Puts a note into its half of the day: timed notes in time order, ahead of notes without a time; a note without a
 * time goes to the end of the half.
 */
export function placeNote(notes: NoteLine[], line: NoteLine): void {
	const period = line.period ?? "am";
	const firstPm = notes.findIndex((n) => n.period === "pm");
	const amEnd = firstPm < 0 ? notes.length : firstPm;
	const [from, to] = period === "am" ? [0, amEnd] : [amEnd, notes.length];
	let at = to;
	if (line.timeRange) {
		for (let i = from; i < to; i++) {
			const other = notes[i];
			if (other && (!other.timeRange || startMinutes(other) > startMinutes(line))) {
				at = i;
				break;
			}
		}
	}
	notes.splice(at, 0, { ...line, period });
}

/**
 * Marks the first unsent note with this text as entered in KDM. When the entry got a time, the note takes it and moves
 * to the half of the day it falls in, in time order. Returns false when no such note exists.
 */
export function markSent(notes: NoteLine[], text: string, sent: { id: number; timeRange?: { from: string; to: string }; period: DayPeriod }): boolean {
	const index = notes.findIndex((n) => n.text === text && n.kdmId === undefined);
	const line = notes[index];
	if (!line) return false;
	line.kdmId = sent.id;
	if (!sent.timeRange && sent.period === (line.period ?? "am")) return true;
	notes.splice(index, 1);
	if (sent.timeRange) line.timeRange = sent.timeRange;
	line.period = sent.period;
	placeNote(notes, line);
	return true;
}

/** Marks the notes whose KDM entry no longer exists as not sent. Returns how many notes changed. */
export function unmarkSent(week: WeekNotes, goneIds: Set<number>): number {
	let count = 0;
	for (const notes of week.days) {
		for (const line of notes) {
			if (line.kdmId !== undefined && line.kdmId > 0 && goneIds.has(line.kdmId)) {
				delete line.kdmId;
				count++;
			}
		}
	}
	return count;
}

/** What KDM says about the entry a sent note points to. */
export interface RemoteState {
	id: number;
	/** Index of the weekday the entry falls on; outside 0-6 when it is not in this week. */
	day: number;
	/** Undefined for a whole-day leave, whose time the note does not carry. */
	timeRange?: { from: string; to: string };
	/** Undefined when the entry says nothing about the half of the day. */
	period?: DayPeriod;
}

/**
 * Brings the notes that were already sent to KDM in line with KDM: id, time, half of the day and weekday. Notes that
 * were never sent are not touched. `missing` counts sent notes whose entry could not be found in this week.
 */
export function syncSent(week: WeekNotes, lookup: (line: NoteLine, dayIndex: number) => RemoteState | undefined): { changed: number; missing: number } {
	let changed = 0;
	let missing = 0;
	const jobs: { line: NoteLine; from: number; remote: RemoteState }[] = [];
	week.days.forEach((notes, from) => {
		for (const line of notes) {
			if (line.kdmId === undefined) continue;
			const remote = lookup(line, from);
			if (remote) jobs.push({ line, from, remote });
			else missing++;
		}
	});
	for (const { line, from, remote } of jobs) {
		const target = remote.day >= 0 && remote.day < week.days.length ? remote.day : from;
		const timeChanged = remote.timeRange !== undefined && (line.timeRange?.from !== remote.timeRange.from || line.timeRange?.to !== remote.timeRange.to);
		const periodChanged = remote.period !== undefined && (line.period ?? "am") !== remote.period;
		const idChanged = line.kdmId !== remote.id;
		if (!timeChanged && !periodChanged && !idChanged && target === from) continue;
		changed++;
		line.kdmId = remote.id;
		if (!timeChanged && !periodChanged && target === from) continue;
		const source = week.days[from] ?? [];
		const index = source.indexOf(line);
		if (index < 0) continue;
		source.splice(index, 1);
		if (timeChanged) line.timeRange = remote.timeRange;
		if (remote.period) line.period = remote.period;
		placeNote((week.days[target] ??= []), line);
	}
	return { changed, missing };
}

export function formatLine(line: NoteLine): string {
	const range = line.timeRange ? `${line.timeRange.from}-${line.timeRange.to} ` : "";
	return `- ${range}${line.text}${line.kdmId === undefined ? "" : ` {kdm:${line.kdmId || "?"}}`}`;
}

/** Reads the block body. Without a `hafta:` line the current week is assumed. */
export function parseWeekBlock(body: string, now = new Date()): WeekNotes {
	let weekStart = startOfWeek(now);
	const days: NoteLine[][] = Array.from({ length: 7 }, () => []);
	let current = -1;
	let period: DayPeriod = "am";
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) continue;
		const week = /^hafta\s*:\s*(\S+)/i.exec(line);
		if (week) {
			const parsed = parseIsoDate(week[1] ?? "");
			if (parsed) weekStart = startOfWeek(parsed);
			continue;
		}
		const periodHeader = PERIOD_HEADER.exec(line);
		if (periodHeader) {
			period = /sonra/i.test(periodHeader[1] ?? "") ? "pm" : "am";
			continue;
		}
		const header = HEADER.exec(line);
		if (header) {
			period = "am";
			current = WEEKDAY_SHORT.findIndex((d) => d.toLocaleLowerCase("tr") === (header[1] ?? "").toLocaleLowerCase("tr"));
			continue;
		}
		if (current < 0) continue;
		const text = line.replace(/^[-*]\s*/, "");
		if (text) (days[current] ??= []).push({ ...parseLine(text), period });
	}
	for (const notes of days) notes.sort((a, b) => Number(a.period === "pm") - Number(b.period === "pm"));
	return { weekStart, days };
}

/** Adds a note at the end of its half of the day, keeping morning notes before afternoon notes. */
export function addNote(notes: NoteLine[], line: NoteLine): void {
	const period = line.period ?? "am";
	let at = notes.length;
	if (period === "am") {
		const firstPm = notes.findIndex((n) => n.period === "pm");
		if (firstPm >= 0) at = firstPm;
	}
	notes.splice(at, 0, { ...line, period });
}

export function serializeWeekBlock(week: WeekNotes): string {
	const lines = [`hafta: ${isoDate(week.weekStart)}`];
	week.days.forEach((notes, index) => {
		const date = addDays(week.weekStart, index);
		lines.push(`## ${WEEKDAY_SHORT[index]} ${String(date.getDate()).padStart(2, "0")}.${String(date.getMonth() + 1).padStart(2, "0")}`);
		for (const period of ["am", "pm"] as const) {
			lines.push(`### ${PERIOD_TITLE[period]}`);
			for (const note of notes) if ((note.period ?? "am") === period) lines.push(formatLine(note));
		}
	});
	return lines.join("\n");
}

/** Empty block for the week containing `date`. */
export function emptyWeekBlock(date: Date): string {
	return "```" + BLOCK_LANGUAGE + "\n" + serializeWeekBlock({ weekStart: startOfWeek(date), days: Array.from({ length: 7 }, () => []) }) + "\n```\n";
}

/**
 * Finds the `kdm-week` block in a note's lines whose content equals `snapshot` (the serialized model that is shown).
 * `hint` is the line the editor believes the block starts at; with several identical blocks the nearest one wins, and
 * a block that has changed since it was shown is not found, so nothing is ever written into the wrong block.
 */
export function findBlock(lines: string[], hint: number, snapshot: string): { start: number; end: number } | null {
	const open = new RegExp("^\\s*(```|~~~)\\s*" + BLOCK_LANGUAGE + "\\s*$");
	const close = /^\s*(```|~~~)\s*$/;
	let best: { start: number; end: number } | null = null;
	for (let i = 0; i < lines.length; i++) {
		if (!open.test(lines[i] ?? "")) continue;
		let end = -1;
		for (let j = i + 1; j < lines.length; j++) {
			if (close.test(lines[j] ?? "")) {
				end = j;
				break;
			}
		}
		if (end < 0) break;
		if (serializeWeekBlock(parseWeekBlock(lines.slice(i + 1, end).join("\n"))) === snapshot) {
			if (!best || Math.abs(i - hint) < Math.abs(best.start - hint)) best = { start: i, end };
		}
		i = end;
	}
	return best;
}
