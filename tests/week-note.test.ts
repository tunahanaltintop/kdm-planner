import { test } from "node:test";
import assert from "node:assert/strict";
import { addNote, emptyWeekBlock, findBlock, markSent, syncSent, unmarkSent, formatLine, parseLine, parseWeekBlock, serializeWeekBlock } from "../src/week-note.ts";
import { isoDate } from "../src/week.ts";

test("parseLine reads time range, text and the KDM marker", () => {
	assert.deepEqual(parseLine("09:00-10:30 Müşteri toplantısı {kdm:2254827}"), {
		text: "Müşteri toplantısı",
		timeRange: { from: "09:00", to: "10:30" },
		kdmId: 2254827,
	});
	assert.deepEqual(parseLine("Rapor hazırla"), { text: "Rapor hazırla" });
	assert.deepEqual(parseLine("9:00 – 10:00 Not"), { text: "Not", timeRange: { from: "9:00", to: "10:00" } });
});

test("formatLine round-trips", () => {
	for (const raw of ["09:00-10:30 Müşteri toplantısı {kdm:7}", "Rapor hazırla", "13:00-14:00 Demo", "Aktarıldı {kdm:?}"]) {
		assert.equal(formatLine(parseLine(raw)), `- ${raw}`);
	}
});

test("parseWeekBlock assigns notes to weekdays and serializes back", () => {
	const body = ["hafta: 2026-10-28", "## Pzt 26.10", "- Rapor", "## Sal", "- 09:00-10:00 Toplantı {kdm:5}", "- Not 2", "## Paz", "* Dinlen"].join("\n");
	const week = parseWeekBlock(body);
	assert.equal(isoDate(week.weekStart), "2026-10-26"); // normalised to Monday
	assert.deepEqual(week.days[0]?.map((l) => l.text), ["Rapor"]);
	assert.deepEqual(week.days[1]?.map((l) => l.text), ["Toplantı", "Not 2"]);
	assert.equal(week.days[1]?.[0]?.kdmId, 5);
	assert.deepEqual(week.days[6]?.map((l) => l.text), ["Dinlen"]);
	const again = parseWeekBlock(serializeWeekBlock(week));
	assert.deepEqual(again, week);
});

test("an empty body means the current week with no notes", () => {
	const week = parseWeekBlock("", new Date(2026, 9, 29));
	assert.equal(isoDate(week.weekStart), "2026-10-26");
	assert.ok(week.days.every((d) => d.length === 0));
});

test("emptyWeekBlock produces a fenced block", () => {
	const block = emptyWeekBlock(new Date(2026, 9, 29));
	assert.ok(block.startsWith("```kdm-week\nhafta: 2026-10-26\n## Pzt 26.10\n### Öğleden önce\n### Öğleden sonra\n## Sal"));
	assert.ok(block.trimEnd().endsWith("```"));
});

test("a sent note whose id is unknown keeps the marker", () => {
	assert.equal(parseLine("Demo {kdm:?}").kdmId, 0);
	assert.equal(formatLine({ text: "Demo", kdmId: 0 }), "- Demo {kdm:?}");
});

test("notes are grouped into morning and afternoon and round-trip", () => {
	const body = ["hafta: 2026-10-26", "## Pzt", "### Öğleden sonra", "- Rapor", "### Öğleden önce", "- 09:00-10:00 Toplantı", "- Not"].join("\n");
	const week = parseWeekBlock(body);
	assert.deepEqual(week.days[0]?.map((l) => [l.text, l.period]), [["Toplantı", "am"], ["Not", "am"], ["Rapor", "pm"]]);
	assert.deepEqual(parseWeekBlock(serializeWeekBlock(week)), week);
	assert.match(serializeWeekBlock(week), /### Öğleden önce\n- 09:00-10:00 Toplantı\n- Not\n### Öğleden sonra\n- Rapor/);
});

test("addNote keeps morning notes ahead of afternoon notes", () => {
	const notes = [{ text: "a", period: "am" as const }, { text: "p", period: "pm" as const }];
	addNote(notes, { text: "b", period: "am" });
	addNote(notes, { text: "q", period: "pm" });
	assert.deepEqual(notes.map((n) => n.text), ["a", "b", "p", "q"]);
});

test("a block written before the split reads as morning notes", () => {
	const week = parseWeekBlock("## Sal\n- eski not");
	assert.equal(week.days[1]?.[0]?.period, "am");
});

test("markSent moves a morning note to the afternoon in time order", () => {
	const notes = parseWeekBlock(
		["## Pzt", "### Öğleden önce", "- Sabah işi", "- Rapor", "### Öğleden sonra", "- 13:30-14:30 Eski", "- 16:00-17:00 Geç", "- Zamansız"].join("\n"),
	).days[0] ?? [];
	assert.equal(markSent(notes, "Rapor", { id: 9, timeRange: { from: "15:00", to: "16:00" }, period: "pm" }), true);
	assert.deepEqual(notes.map((n) => [n.text, n.period]), [["Sabah işi", "am"], ["Eski", "pm"], ["Rapor", "pm"], ["Geç", "pm"], ["Zamansız", "pm"]]);
	assert.equal(notes[2]?.kdmId, 9);
	assert.deepEqual(notes[2]?.timeRange, { from: "15:00", to: "16:00" });
});

test("markSent keeps a note in place when nothing about its time changed", () => {
	const notes = parseWeekBlock("## Sal\n- İzin\n- Başka").days[1] ?? [];
	assert.equal(markSent(notes, "İzin", { id: 3, period: "am" }), true);
	assert.deepEqual(notes.map((n) => n.text), ["İzin", "Başka"]);
	assert.equal(notes[0]?.kdmId, 3);
	assert.equal(markSent(notes, "Yok", { id: 1, period: "am" }), false);
	assert.equal(markSent(notes, "İzin", { id: 1, period: "am" }), false); // already sent
});

test("syncSent follows KDM for sent notes and leaves unsent ones alone", () => {
	const week = parseWeekBlock(
		[
			"hafta: 2026-10-26",
			"## Pzt",
			"### Öğleden önce",
			"- 09:00-10:00 Toplantı {kdm:10}",
			"- Henüz gönderilmedi",
			"- Kayıp {kdm:11}",
			"## Sal",
			"### Öğleden önce",
			"- Rapor {kdm:12}",
		].join("\n"),
	);
	const remote: Record<number, { id: number; day: number; timeRange?: { from: string; to: string }; period?: "am" | "pm" }> = {
		// Moved in KDM to Monday afternoon, 14:00-15:30.
		10: { id: 10, day: 0, timeRange: { from: "14:00", to: "15:30" }, period: "pm" },
		// Moved from Tuesday to Wednesday.
		12: { id: 12, day: 2, timeRange: { from: "10:00", to: "11:00" }, period: "am" },
	};
	const result = syncSent(week, (line) => (line.kdmId ? remote[line.kdmId] : undefined));
	assert.deepEqual(result, { changed: 2, missing: 1 });
	assert.deepEqual(week.days[0]?.map((n) => [n.text, n.period, n.timeRange?.from]), [["Henüz gönderilmedi", "am", undefined], ["Kayıp", "am", undefined], ["Toplantı", "pm", "14:00"]]);
	assert.deepEqual(week.days[1], []);
	assert.deepEqual(week.days[2]?.map((n) => [n.text, n.kdmId]), [["Rapor", 12]]);
	// Unsent note is exactly as written.
	assert.deepEqual(week.days[0]?.[0], { text: "Henüz gönderilmedi", period: "am" });
});

test("syncSent heals an unknown id and keeps a whole-day leave where it is", () => {
	const week = parseWeekBlock("## Çar\n### Öğleden sonra\n- İzin {kdm:?}");
	const result = syncSent(week, () => ({ id: 77, day: 2 }));
	assert.deepEqual(result, { changed: 1, missing: 0 });
	assert.deepEqual(week.days[2]?.[0], { text: "İzin", kdmId: 77, period: "pm" });
	assert.deepEqual(syncSent(week, () => ({ id: 77, day: 2 })), { changed: 0, missing: 0 });
});

test("unmarkSent turns notes whose entry is gone back into unsent notes", () => {
	const week = parseWeekBlock("## Pzt\n- 09:00-10:00 A {kdm:5}\n- B {kdm:6}\n- C {kdm:?}\n- D");
	assert.equal(unmarkSent(week, new Set([5])), 1);
	assert.deepEqual(week.days[0]?.map((n) => [n.text, n.kdmId]), [["A", undefined], ["B", 6], ["C", 0], ["D", undefined]]);
	assert.equal(week.days[0]?.[0]?.timeRange?.from, "09:00"); // the time stays, so it is easy to send again
	assert.equal(unmarkSent(week, new Set()), 0);
});

test("findBlock locates the block that is shown, even after lines moved, and never a different one", () => {
	const a = serializeWeekBlock(parseWeekBlock("hafta: 2026-10-26\n## Pzt\n- A"));
	const b = serializeWeekBlock(parseWeekBlock("hafta: 2026-11-02\n## Pzt\n- B"));
	const note = ["# Not", "```kdm-week", ...a.split("\n"), "```", "", "metin", "```kdm-week", ...b.split("\n"), "```"];
	const second = note.indexOf("```kdm-week", 3);
	// The editor's idea of where the block starts is stale (one line off), but the content identifies it.
	assert.deepEqual(findBlock(note, 1, b), { start: second, end: note.length - 1 });
	assert.deepEqual(findBlock(note, second, a), { start: 1, end: 1 + a.split("\n").length + 1 });
	// A block that changed since it was shown is not found.
	assert.equal(findBlock(note, 1, serializeWeekBlock(parseWeekBlock("hafta: 2026-10-26\n## Pzt\n- değişti"))), null);
});

test("findBlock picks the nearest of two identical blocks", () => {
	const body = serializeWeekBlock(parseWeekBlock("hafta: 2026-10-26"));
	const block = ["```kdm-week", ...body.split("\n"), "```"];
	const note = [...block, "", ...block];
	const second = block.length + 1;
	assert.equal(findBlock(note, 0, body)?.start, 0);
	assert.equal(findBlock(note, second + 1, body)?.start, second);
});
