import { test } from "node:test";
import assert from "node:assert/strict";
import {
	assertSuccess,
	buildNewPlan,
	hoursBetween,
	errorMessageOf,
	KdmError,
	normalizeBaseUrl,
	parseLoginResponse,
	parseRefreshResponse,
	PlanStatus,
	revivePlan,
	toWireDate,
	toWirePlan,
} from "../src/kdm-protocol.ts";

test("parseLoginResponse returns the session and user", () => {
	const result = parseLoginResponse({ token: "t", refreshToken: "r", loginUser: { id: 3, name: "Ada", surname: "L" } });
	assert.equal(result.token, "t");
	assert.equal(result.refreshToken, "r");
	assert.equal(result.user?.id, 3);
	assert.equal(parseLoginResponse({ Token: "t2", RefreshToken: "r2" }).refreshToken, "r2");
});

test("parseLoginResponse surfaces the server's failure message (HTTP 200 with isSuccess false)", () => {
	assert.throws(
		() => parseLoginResponse({ isSuccess: false, error: { code: null, message: "Parola hatalı", time: null }, success: null }),
		(error: unknown) => error instanceof KdmError && error.message === "Parola hatalı",
	);
	assert.throws(() => parseLoginResponse("<html>"), /JSON/);
	assert.throws(() => parseLoginResponse({}), /Login failed/);
	// Refused credentials are told apart from a broken answer, so a remembered password can be dropped.
	assert.throws(() => parseLoginResponse({}), (error: KdmError) => error.status === 401);
	assert.throws(() => parseLoginResponse("<html>"), (error: KdmError) => error.status === 0);
});

test("parseRefreshResponse keeps the old refresh token when none is returned", () => {
	const previous = { token: "old", refreshToken: "keep" };
	assert.deepEqual(parseRefreshResponse({ token: "new" }, previous), { token: "new", refreshToken: "keep" });
	assert.deepEqual(parseRefreshResponse({ Token: "n", RefreshToken: "r" }, previous), { token: "n", refreshToken: "r" });
	assert.equal(parseRefreshResponse({}, previous), null);
});

test("toWireDate uses local time without a zone", () => {
	assert.equal(toWireDate(new Date(2026, 9, 5, 9, 3, 7)), "2026-10-05T09:03:07");
});

test("toWirePlan converts dates and leaves the rest alone", () => {
	const wire = toWirePlan({
		userId: 1,
		statusId: PlanStatus.DayOff,
		startTime: new Date(2026, 9, 26, 9, 0, 0),
		endTime: new Date(2026, 9, 26, 17, 0, 0),
	});
	assert.deepEqual(wire, { userId: 1, statusId: "DayOff", startTime: "2026-10-26T09:00:00", endTime: "2026-10-26T17:00:00" });
});

test("revivePlan turns wire dates into Dates", () => {
	const plan = revivePlan({ startTime: "2026-10-26T09:00:00", endTime: "2026-10-26T10:00:00" }) as { startTime: Date; endTime: Date };
	assert.ok(plan.startTime instanceof Date);
	assert.equal(plan.endTime.getHours(), 10);
});

test("errorMessageOf tolerates odd bodies", () => {
	assert.equal(errorMessageOf({ error: { message: "x" } }), "x");
	assert.equal(errorMessageOf({ Error: { Message: "y" } }), "y");
	assert.equal(errorMessageOf({ error: "z" }), "z");
	assert.equal(errorMessageOf(null), null);
});

test("buildNewPlan matches the body the web app sends", () => {
	const plan = buildNewPlan({
		userId: 7,
		status: PlanStatus.Planned,
		start: new Date(2026, 9, 26, 8, 0, 0),
		end: new Date(2026, 9, 26, 11, 30, 0),
		jobDefinitionId: 1001,
		description: "Test",
	});
	assert.deepEqual(toWirePlan(plan), {
		dataStatus: "Activated",
		hour: 3.5,
		piece: 0,
		otherPositionJob: false,
		userId: 7,
		statusId: "Planned",
		startTime: "2026-10-26T08:00:00",
		endTime: "2026-10-26T11:30:00",
		positionId: null,
		jobDefinitionId: 1001,
		description: "Test",
	});
});

test("a day-off carries no task even if one is passed", () => {
	const plan = buildNewPlan({ userId: 7, status: PlanStatus.DayOff, start: new Date(2026, 9, 28, 8), end: new Date(2026, 9, 28, 8, 30), jobDefinitionId: 1 });
	assert.equal("jobDefinitionId" in plan, false);
	assert.equal(plan.hour, 0.5);
});

test("hoursBetween rounds to quarter-hour friendly values", () => {
	assert.equal(hoursBetween(new Date(2026, 0, 1, 13, 45), new Date(2026, 0, 1, 17, 0)), 3.25);
});

test("assertSuccess turns isSuccess false into an error and returns the success message", () => {
	assert.equal(assertSuccess({ isSuccess: true, error: null, success: { message: "Plan Oluşturma Başarılı!" } }), "Plan Oluşturma Başarılı!");
	assert.equal(assertSuccess([{ id: 1 }]), null);
	assert.throws(() => assertSuccess({ isSuccess: false, error: { message: "Çakışma var" } }), /Çakışma var/);
});

test("normalizeBaseUrl accepts HTTPS (and local HTTP) and rejects the rest", () => {
	assert.deepEqual(normalizeBaseUrl(" https://kdm.example.com/ "), { url: "https://kdm.example.com" });
	assert.deepEqual(normalizeBaseUrl("https://kdm.example.com/app/?x=1#y"), { url: "https://kdm.example.com/app" });
	assert.deepEqual(normalizeBaseUrl("http://localhost:8080"), { url: "http://localhost:8080" });
	assert.match(normalizeBaseUrl("http://kdm.example.com").error ?? "", /https/);
	assert.match(normalizeBaseUrl("https://user:pw@kdm.example.com").error ?? "", /parola/);
	assert.match(normalizeBaseUrl("kdm.example.com").error ?? "", /geçerli/);
	assert.match(normalizeBaseUrl("ftp://kdm.example.com").error ?? "", /https/);
	assert.match(normalizeBaseUrl("  ").error ?? "", /girin/);
});
