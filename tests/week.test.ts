import { test } from "node:test";
import assert from "node:assert/strict";
import { PlanStatus } from "../src/kdm-protocol.ts";
import type { PlanEntry } from "../src/kdm-protocol.ts";
import {
	checkSlot,
	gridRange,
	clockToMinutes,
	lunchFromSettings,
	periodOf,
	formatDuration,
	layoutSegments,
	looksLikeLeave,
	matchTask,
	minEditableDate,
	segmentForDay,
	startOfWeek,
	suggestSlot,
	weekDays,
	workHoursFromSettings,
	isFullDayLeave,
	isoDate,
	leaveHours,
	parseIsoDate,
} from "../src/week.ts";

const at = (d: number, h: number, m = 0) => new Date(2026, 9, d, h, m);
const entry = (id: number, d: number, h1: number, m1: number, h2: number, m2: number, statusId: PlanEntry["statusId"] = PlanStatus.Planned): PlanEntry => ({
	id,
	userId: 1,
	statusId,
	startTime: at(d, h1, m1),
	endTime: at(d, h2, m2),
});
const rules = (existing: PlanEntry[] = []) => ({ minEditable: at(19, 0), existing, maxBlockHours: 4, breakMinutes: 15 });

test("weeks start on Monday", () => {
	assert.equal(isoDate(startOfWeek(at(28, 12))), "2026-10-26");
	assert.equal(isoDate(startOfWeek(at(25, 12))), "2026-10-19"); // Sunday belongs to the week before
	assert.equal(weekDays(at(26, 0)).length, 7);
	assert.equal(parseIsoDate("2026-02-30"), null);
});

test("minEditableDate: users of the extended-edit company keep 7 days open, others only the current week", () => {
	assert.equal(isoDate(minEditableDate(43, at(28, 15))), "2026-10-21");
	assert.equal(isoDate(minEditableDate(5, at(28, 15))), "2026-10-26");
});

test("checkSlot enforces the page rules and the 4 hour rule", () => {
	assert.deepEqual(checkSlot(at(27, 9), at(27, 12, 30), rules()).errors, []);
	assert.match(checkSlot(at(27, 9), at(27, 13), rules()).errors.join(), /4 saat ve üstü/);
	// Hours outside the working hours are allowed; they only warn.
	const work = workHoursFromSettings("08:30", "17:30");
	assert.deepEqual(checkSlot(at(27, 7), at(27, 8, 30), { ...rules(), work }).errors, []);
	assert.match(checkSlot(at(27, 7), at(27, 8, 30), { ...rules(), work }).warnings.join(), /Mesai/);
	assert.match(checkSlot(at(27, 17), at(27, 18, 30), { ...rules(), work }).warnings.join(), /Mesai/);
	assert.deepEqual(checkSlot(at(27, 9), at(27, 10), { ...rules(), work }).warnings, []);
	assert.match(checkSlot(at(27, 10), at(27, 9), rules()).errors.join(), /sonra/);
	assert.match(checkSlot(at(18, 9), at(18, 10), rules()).errors.join(), /kilitli/);
	assert.match(checkSlot(at(27, 17), new Date(2026, 9, 28, 9), rules()).errors.join(), /aynı gün/);
});

test("a leave day blocks the slot; overlaps and missing breaks only warn", () => {
	const leave = entry(1, 27, 8, 30, 17, 30, PlanStatus.DayOff);
	assert.match(checkSlot(at(27, 9), at(27, 10), rules([leave])).errors.join(), /izin/);
	const task = entry(2, 27, 9, 0, 10, 0);
	const overlap = checkSlot(at(27, 9, 30), at(27, 10, 30), rules([task]));
	assert.deepEqual(overlap.errors, []);
	assert.match(overlap.warnings.join(), /çakışıyor/);
	assert.match(checkSlot(at(27, 10, 5), at(27, 11), rules([task])).warnings.join(), /mola/);
	assert.deepEqual(checkSlot(at(27, 10, 15), at(27, 11), rules([task])).warnings, []);
	assert.deepEqual(checkSlot(at(27, 9), at(27, 10), { ...rules([task]), ignoreId: 2 }).warnings, []);
});

test("suggestSlot starts the day at the working hours (08:30 by default) and leaves a break after existing entries", () => {
	const day = at(27, 0);
	assert.deepEqual(suggestSlot(day, [], 60, 15), { start: at(27, 8, 30), end: at(27, 9, 30) });
	assert.deepEqual(suggestSlot(day, [], 60, 15, { work: workHoursFromSettings("09:00", "18:00") }), { start: at(27, 9), end: at(27, 10) });
	const slot = suggestSlot(day, [entry(1, 27, 8, 0, 10, 0)], 60, 15);
	assert.deepEqual(slot, { start: at(27, 10, 15), end: at(27, 11, 15) });
	// A gap before a later entry is used when it fits.
	assert.deepEqual(suggestSlot(day, [entry(1, 27, 10, 0, 12, 0)], 60, 15), { start: at(27, 8, 30), end: at(27, 9, 30) });
	assert.equal(suggestSlot(day, [entry(1, 27, 8, 0, 17, 30)], 60, 15), null);
});

test("segmentForDay clips multi-day entries to visible hours", () => {
	const leave: PlanEntry = { userId: 1, statusId: PlanStatus.DayOff, startTime: at(12, 8, 30), endTime: at(16, 17, 30) };
	const wednesday = segmentForDay(leave, at(14, 0), { startHour: 8, endHour: 18 });
	assert.deepEqual([wednesday?.start, wednesday?.end], [at(14, 8), at(14, 18)]);
	assert.equal(segmentForDay(leave, at(17, 0), { startHour: 8, endHour: 18 }), null);
});

test("gridRange covers the working hours and widens for entries outside them", () => {
	const work = workHoursFromSettings("08:30", "17:30");
	const days = [at(27, 0)];
	assert.deepEqual(gridRange(work, [], days), { startHour: 8, endHour: 18 });
	assert.deepEqual(gridRange(work, [entry(1, 27, 9, 0, 10, 0)], days), { startHour: 8, endHour: 18 });
	assert.deepEqual(gridRange(work, [entry(1, 27, 7, 15, 9, 0), entry(2, 27, 17, 0, 19, 30)], days), { startHour: 7, endHour: 20 });
	assert.deepEqual(gridRange(work, [entry(1, 28, 6, 0, 7, 0)], days), { startHour: 8, endHour: 18 });
	assert.deepEqual(workHoursFromSettings("18:00", "09:00"), work);
});

test("layoutSegments puts overlapping entries in separate columns", () => {
	const a = segmentForDay(entry(1, 27, 9, 0, 11, 0), at(27, 0));
	const b = segmentForDay(entry(2, 27, 10, 0, 12, 0), at(27, 0));
	const c = segmentForDay(entry(3, 27, 13, 0, 14, 0), at(27, 0));
	assert.ok(a && b && c);
	const placed = layoutSegments([a, b, c]);
	const byId = Object.fromEntries(placed.map((p) => [p.entry.id, p]));
	assert.deepEqual([byId[1]?.column, byId[1]?.columns], [0, 2]);
	assert.deepEqual([byId[2]?.column, byId[2]?.columns], [1, 2]);
	assert.deepEqual([byId[3]?.column, byId[3]?.columns], [0, 1]);
});

test("matchTask pairs a note with the catalogue entry that shares the most words", () => {
	const catalog = [{ name: "Müşteri ilişkilerini yönetmek" }, { name: "Paydaş yönetimini yürütmek" }, { name: "Sözleşme ve protokol hazırlamak" }];
	assert.equal(matchTask("Müşteri toplantısı", catalog), catalog[0]);
	assert.equal(matchTask("protokol taslağı hazırlandı", catalog), catalog[2]);
	assert.equal(matchTask("öğle yemeği", catalog), null);
});

test("looksLikeLeave and formatDuration", () => {
	assert.equal(looksLikeLeave("İzin"), true);
	assert.equal(looksLikeLeave("yıllık izin"), true);
	assert.equal(looksLikeLeave("izinli"), true);
	assert.equal(looksLikeLeave("izinsiz giriş testi"), false);
	assert.equal(formatDuration(210), "3 sa 30 dk");
	assert.equal(formatDuration(30), "30 dk");
});

test("leaveHours counts 8 hours per working day", () => {
	assert.equal(leaveHours(at(12, 0), at(16, 0)), 40);
	assert.equal(leaveHours(at(28, 0), at(28, 0)), 8);
	assert.equal(leaveHours(at(24, 0), at(25, 0)), 8); // a weekend still counts as one day
	assert.equal(leaveHours(at(23, 0), at(27, 0)), 24);
});

const lunch = { start: 750, end: 810 };

test("lunch settings parse and fall back to 12:30-13:30", () => {
	assert.equal(clockToMinutes("12:30"), 750);
	assert.equal(clockToMinutes("25:00"), null);
	assert.deepEqual(lunchFromSettings("12:00", "13:00"), { start: 720, end: 780 });
	assert.deepEqual(lunchFromSettings("13:00", "12:00"), lunch);
	assert.deepEqual(lunchFromSettings("x", "13:00"), lunch);
});

test("periodOf splits the day at the lunch break", () => {
	assert.equal(periodOf(9 * 60, lunch), "am");
	assert.equal(periodOf(12 * 60, lunch), "am");
	assert.equal(periodOf(750, lunch), "pm");
	assert.equal(periodOf(15 * 60, lunch), "pm");
});

test("a task that runs into lunch only warns", () => {
	const crossing = checkSlot(at(27, 12), at(27, 13), { ...rules(), lunch });
	assert.deepEqual(crossing.errors, []);
	assert.match(crossing.warnings.join(), /Öğle arası/);
	assert.deepEqual(checkSlot(at(27, 11), at(27, 12, 30), { ...rules(), lunch }).warnings, []);
	assert.deepEqual(checkSlot(at(27, 13, 30), at(27, 14), { ...rules(), lunch }).warnings, []);
});

test("suggestSlot never straddles lunch and honours the period", () => {
	const day = at(27, 0);
	// Morning is 08:30-12:30, so a 2 hour task after a 3 hour one does not fit before lunch and moves to the afternoon.
	const slot = suggestSlot(day, [entry(1, 27, 8, 0, 11, 0)], 120, 15, { lunch });
	assert.deepEqual(slot, { start: at(27, 13, 30), end: at(27, 15, 30) });
	assert.deepEqual(suggestSlot(day, [], 60, 15, { lunch, period: "pm" }), { start: at(27, 13, 30), end: at(27, 14, 30) });
	assert.deepEqual(suggestSlot(day, [], 60, 15, { lunch, period: "am" }), { start: at(27, 8, 30), end: at(27, 9, 30) });
	assert.equal(suggestSlot(day, [entry(1, 27, 8, 0, 12, 0)], 60, 15, { lunch, period: "am" }), null);
	// A task that fits exactly before lunch is allowed.
	assert.deepEqual(suggestSlot(day, [entry(1, 27, 8, 0, 11, 0)], 60, 15, { lunch }), { start: at(27, 11, 15), end: at(27, 12, 15) });
});

test("isFullDayLeave tells whole-day leave from an hourly one", () => {
	assert.equal(isFullDayLeave(at(28, 8, 30), at(28, 17, 30)), true);
	assert.equal(isFullDayLeave(at(12, 8, 30), at(16, 17, 30)), true);
	assert.equal(isFullDayLeave(at(28, 8, 0), at(28, 8, 30)), false);
	assert.equal(isFullDayLeave(at(28, 13, 30), at(28, 15, 0)), false);
});
