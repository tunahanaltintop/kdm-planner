/**
 * Wire format of the KDM backend (`<KDM URL>/api`), reconstructed from the web app's bundle.
 * Everything here is pure so it can be tested without Obsidian.
 */

/** Value of the `api-version` header sent with every request. */
export const API_VERSION = "1.0";

/** `statusId` of a plan entry (`UserJobDefinition`). The API speaks enum names, not numbers. */
export const PlanStatus = {
	Planned: "Planned",
	Completed: "Completed",
	NotCompleted: "NotCompleted",
	DayOff: "DayOff",
	AssignedPlanned: "AssignedPlanned",
	AssignedCompleted: "AssignedCompleted",
} as const;
export type PlanStatusId = (typeof PlanStatus)[keyof typeof PlanStatus];

export interface LoginUser {
	id: number;
	name: string;
	surname: string;
	companyId?: number;
	userRoleTypeId?: string;
	languageCode?: string;
	[key: string]: unknown;
}

export interface Session {
	token: string;
	refreshToken: string;
	/**
	 * Cookies of the browser session the tokens were issued to, as a `Cookie` header (`name=value; ...`). KDM binds its
	 * tokens to the HttpOnly session cookie (`__Host-kdm-sid`, the token's `bnd` claim is its hash): without it every
	 * request, the token refresh included, is refused, so a session is never kept without it.
	 */
	cookie: string;
}

/**
 * Applies the `Set-Cookie` header(s) of a response to a `Cookie` header: new values replace old ones, and cookies that
 * are expired (`Max-Age=0` or a past `Expires`) are dropped. Several cookies in one header may be comma-joined.
 */
export function mergeSetCookie(cookie: string, setCookie: string | string[] | undefined, now = Date.now()): string {
	const jar = new Map<string, string>();
	for (const part of cookie.split(";")) {
		const index = part.indexOf("=");
		if (index > 0) jar.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
	}
	const lines = (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
		// A comma starts a new cookie only when a `name=` follows; the comma inside an `Expires` date does not.
		.flatMap((line) => line.split(/,\s*(?=[^;,=\s]+=)/));
	for (const line of lines) {
		const [pair = "", ...attributes] = line.split(";");
		const index = pair.indexOf("=");
		if (index <= 0) continue;
		const name = pair.slice(0, index).trim();
		let expired = false;
		for (const attribute of attributes) {
			const [key = "", value = ""] = attribute.split("=").map((x) => x.trim());
			if (/^max-age$/i.test(key) && Number(value) <= 0) expired = true;
			if (/^expires$/i.test(key) && Date.parse(value) <= now) expired = true;
		}
		if (expired) jar.delete(name);
		else jar.set(name, pair.slice(index + 1).trim());
	}
	return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** A plan entry as the planning calendar reads and writes it. Dates are local times without a zone. */
export interface PlanEntry {
	id?: number;
	userId: number;
	jobDefinitionId?: number | null;
	/** An entry that is not tied to a catalogue task ("other task"); it requires a description. */
	otherJob?: boolean;
	otherPositionJob?: boolean;
	positionId?: number | null;
	statusId: PlanStatusId;
	startTime: Date | string;
	endTime: Date | string;
	description?: string;
	hour?: number;
	piece?: number;
	completedPiece?: number;
	/** `Hour` or `Piece`; null on plan entries, the task carries it. */
	definitionTypeId?: string | null;
	dataStatus?: "Activated";
	[key: string]: unknown;
}

/** One task the user may plan against, as `UserJobDefinitionCustom/GetUserJobs` lists it. */
export interface JobCatalogEntry {
	id: number;
	jobId: number;
	jobName: string;
	definitionType: string;
	name: string;
	defaultDuration: number | null;
}

export class KdmError extends Error {
	readonly status: number;

	constructor(message: string, status = 0) {
		super(message);
		this.name = "KdmError";
		this.status = status;
	}
}

/** The first of `names` that `source` has a value for; KDM answers in camelCase or PascalCase. */
export function pick<T>(source: Record<string, unknown>, ...names: string[]): T | undefined {
	for (const name of names) if (source[name] !== undefined && source[name] !== null) return source[name] as T;
	return undefined;
}

/**
 * Write endpoints answer HTTP 200 with `{ isSuccess, error, success }`. A failed write is `isSuccess: false`, so the
 * status code alone cannot be trusted. Returns the server's success message, if any.
 */
export function assertSuccess(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const json = body as Record<string, unknown>;
	if (json.isSuccess === false) throw new KdmError(errorMessageOf(json) ?? "KDM rejected the request.");
	const success = json.success as { message?: string } | null | undefined;
	return success?.message ?? null;
}

/** Length of a plan entry in hours, as the `hour` field expects it (`3.5`). */
export function hoursBetween(start: Date, end: Date): number {
	return Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 100) / 100;
}

/**
 * Body for creating a plan entry, shaped like the one the web app sends. A day-off has no task. The server fills in
 * `positionId` and the colour, and does not return the new id: read the entry back with `getMyTasks`.
 */
export function buildNewPlan(input: {
	userId: number;
	status: PlanStatusId;
	start: Date;
	end: Date;
	jobDefinitionId?: number;
	description?: string;
	/** Overrides the computed length, e.g. 8 hours per day for a leave that spans a whole working day. */
	hour?: number;
}): PlanEntry {
	const plan: PlanEntry = {
		dataStatus: "Activated",
		hour: input.hour ?? hoursBetween(input.start, input.end),
		piece: 0,
		otherPositionJob: false,
		userId: input.userId,
		statusId: input.status,
		startTime: input.start,
		endTime: input.end,
		positionId: null,
	};
	if (input.status !== PlanStatus.DayOff && input.jobDefinitionId !== undefined) plan.jobDefinitionId = input.jobDefinitionId;
	if (input.description) plan.description = input.description;
	return plan;
}

/** Refresh answers either casing; a missing refresh token means the old one stays valid. */
export function parseRefreshResponse(body: unknown, previous: Session): Session | null {
	if (typeof body !== "object" || body === null) return null;
	const json = body as Record<string, unknown>;
	const token = pick<string>(json, "token", "Token");
	if (!token) return null;
	return { ...previous, token, refreshToken: pick<string>(json, "refreshToken", "RefreshToken") ?? previous.refreshToken };
}

const pad = (value: number) => String(value).padStart(2, "0");

/** Local date-time without zone, the form the planning endpoints accept (`2026-10-26T09:30:00`). */
export function toWireDate(date: Date): string {
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Converts every `Date` in a plan entry to the wire form. */
export function toWirePlan(entry: PlanEntry): Record<string, unknown> {
	return JSON.parse(JSON.stringify(entry, function (this: Record<string, unknown>, key: string, value: unknown) {
		const original = this[key];
		return original instanceof Date ? toWireDate(original) : value;
	})) as Record<string, unknown>;
}

/** Revives `startTime` and `endTime` of an entry the server returned. */
export function revivePlan<T extends { startTime?: unknown; endTime?: unknown }>(entry: T): T {
	for (const key of ["startTime", "endTime"] as const) {
		const value = entry[key];
		if (typeof value === "string") (entry as Record<string, unknown>)[key] = new Date(value);
	}
	return entry;
}

/** Hosts for which plain `http://` is accepted (a local test server); everything else must use HTTPS. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Checks the KDM URL typed in the settings. The access tokens and the session cookie travel to this address, so it must be
 * HTTPS (plain HTTP only for the local machine) and must not carry credentials. Query and fragment are dropped.
 */
export function normalizeBaseUrl(input: string): { url: string; error?: undefined } | { url?: undefined; error: string } {
	const text = input.trim();
	if (!text) return { error: "KDM URL'sini girin." };
	let parsed: URL;
	try {
		parsed = new URL(text);
	} catch {
		return { error: "KDM URL'si geçerli bir adres değil (https://… biçiminde olmalı)." };
	}
	if (parsed.username || parsed.password) return { error: "KDM URL'sinde kullanıcı adı veya parola olamaz." };
	const secure = parsed.protocol === "https:" || (parsed.protocol === "http:" && LOOPBACK_HOSTS.has(parsed.hostname));
	if (!secure) return { error: "KDM URL'si https:// ile başlamalı: erişim anahtarları bu adrese gönderilir." };
	const path = parsed.pathname.replace(/\/+$/, "");
	return { url: `${parsed.origin}${path}` };
}

/** Reads the message of an error body such as `{ error: { message } }` or `{ Error: { Message } }`. */
export function errorMessageOf(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const json = body as Record<string, unknown>;
	const error = errorOf(json);
	if (typeof error === "string") return error;
	const message = error?.message ?? error?.Message ?? json.message ?? json.Message;
	return typeof message === "string" && message.trim() ? message : null;
}

/** Reads the code of an error body such as `{ error: { code } }` or `{ Error: { Code } }`. */
export function errorCodeOf(body: unknown): string | null {
	if (typeof body !== "object" || body === null) return null;
	const error = errorOf(body as Record<string, unknown>);
	const code = typeof error === "object" ? (error.code ?? error.Code) : undefined;
	return typeof code === "string" ? code : null;
}

function errorOf(json: Record<string, unknown>): Record<string, unknown> | string | undefined {
	return (json.error ?? json.Error) as Record<string, unknown> | string | undefined;
}
