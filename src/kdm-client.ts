import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
	API_VERSION,
	assertSuccess,
	errorMessageOf,
	JobCatalogEntry,
	KdmError,
	LoginResult,
	parseLoginResponse,
	parseRefreshResponse,
	PlanEntry,
	revivePlan,
	Session,
	toWireDate,
	toWirePlan,
} from "./kdm-protocol";
import { isTokenExpired } from "./jwt";

export interface KdmClientOptions {
	baseUrl: string;
	/** Current session, if any. Read on every request so a refresh by another call is picked up. */
	getSession: () => Session | null;
	/** Called after a refresh so the new tokens can be stored. */
	onSession: (session: Session | null) => void;
	/**
	 * Signs in again without asking (with a remembered password) when there is no session or the refresh token is dead
	 * too. Resolves to whether there is a session afterwards.
	 */
	relogin?: () => Promise<boolean>;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

/** A request that gets no answer must not leave the buttons that wait for it disabled for ever. */
const REQUEST_TIMEOUT_MS = 30_000;

function fetchWithTimeout(params: RequestUrlParam): Promise<RequestUrlResponse> {
	let timer: number | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = window.setTimeout(() => reject(new KdmError("KDM zamanında yanıt vermedi. Bağlantınızı kontrol edip yeniden deneyin.")), REQUEST_TIMEOUT_MS);
	});
	return Promise.race([requestUrl({ ...params, throw: false }), timeout]).finally(() => window.clearTimeout(timer));
}

/** Client for the KDM REST backend. Authentication and the 401-refresh-retry cycle are handled here. */
export class KdmClient {
	private refreshing: Promise<boolean> | null = null;

	constructor(private readonly options: KdmClientOptions) {}

	private url(path: string): string {
		return `${this.options.baseUrl.replace(/\/+$/, "")}/api/${path}`;
	}

	private headers(token: string | null): Record<string, string> {
		const headers: Record<string, string> = { Accept: "application/json", "api-version": API_VERSION, language: "tr" };
		if (token) headers.Authorization = `Bearer ${token}`;
		return headers;
	}

	/** Exchanges email and password for a session. The client never keeps the password. */
	async login(email: string, password: string): Promise<LoginResult> {
		const response = await fetchWithTimeout({
			url: this.url("Authenticate"),
			method: "POST",
			contentType: "application/json",
			headers: this.headers(null),
			body: JSON.stringify({ email, password, passportNum: "" }),
		});
		if (response.status >= 500) throw new KdmError(`KDM is unavailable (HTTP ${response.status}).`, response.status);
		const result = parseLoginResponse(safeJson(response));
		this.options.onSession({ token: result.token, refreshToken: result.refreshToken });
		return result;
	}

	/** Uses the refresh token to get a new access token. Returns false when the user has to log in again. */
	refresh(): Promise<boolean> {
		this.refreshing ??= this.doRefresh().finally(() => {
			this.refreshing = null;
		});
		return this.refreshing;
	}

	private async doRefresh(): Promise<boolean> {
		const session = this.options.getSession();
		if (!session?.refreshToken) return false;
		const response = await fetchWithTimeout({
			url: this.url("RefreshToken"),
			method: "POST",
			contentType: "application/json",
			headers: this.headers(null),
			body: JSON.stringify({ refreshToken: session.refreshToken }),
		});
		const next = response.status < 300 ? parseRefreshResponse(safeJson(response), session) : null;
		if (next) {
			this.options.onSession(next);
			return true;
		}
		// A rejected refresh token is dead; a server hiccup leaves it for the next try.
		if (response.status >= 400 && response.status < 500) this.options.onSession(null);
		return false;
	}

	private async relogin(): Promise<boolean> {
		return (await this.options.relogin?.()) ?? false;
	}

	/** Renews an expired access token before it is used; when the session is gone, signs in again if it can. */
	private async ensureSession(): Promise<boolean> {
		const session = this.options.getSession();
		if (session && isTokenExpired(session.token, 30)) await this.refresh();
		return this.options.getSession() !== null || this.relogin();
	}

	async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
		if (!(await this.ensureSession())) throw new KdmError("Not logged in to KDM.", 401);
		let response = await this.send(method, path, this.options.getSession()?.token ?? null, body);
		if (response.status === 401 && ((await this.refresh()) || (await this.relogin()))) {
			response = await this.send(method, path, this.options.getSession()?.token ?? null, body);
		}
		if (response.status === 401) throw new KdmError("The KDM session has expired. Log in again.", 401);
		if (response.status >= 400) {
			throw new KdmError(errorMessageOf(safeJson(response)) ?? `KDM request failed (HTTP ${response.status}).`, response.status);
		}
		if (response.status === 204 || !response.text) return undefined as T;
		const json = safeJson(response);
		assertSuccess(json);
		return json as T;
	}

	private send(method: Method, path: string, token: string | null, body?: unknown) {
		return fetchWithTimeout({
			url: this.url(path),
			method,
			contentType: body === undefined ? undefined : "application/json",
			headers: this.headers(token),
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	}

	/**
	 * Tells KDM to forget a refresh token (what the web page does when it logs out). Best effort: the session is already
	 * gone locally, so a failure here is ignored.
	 */
	async revoke(session: Session): Promise<void> {
		try {
			await fetchWithTimeout({
				url: this.url("RevokeRefreshToken"),
				method: "POST",
				contentType: "application/json",
				headers: this.headers(session.token),
				body: JSON.stringify({ refreshToken: session.refreshToken }),
			});
		} catch {
			// Nothing to do: the tokens were removed from this device either way.
		}
	}

	/** Tasks (catalogue entries) the user may plan against. */
	getUserJobs(userId: number): Promise<JobCatalogEntry[]> {
		return this.request<JobCatalogEntry[] | null>("GET", `UserJobDefinitionCustom/GetUserJobs?userId=${userId}`).then((r) => r ?? []);
	}

	/** Plan entries and day-offs in a date range, as shown on the planning calendar. */
	async getMyTasks(userId: number, start?: Date, end?: Date): Promise<PlanEntry[]> {
		let path = `UserJobDefinition/GetMyTask?userId=${userId}`;
		if (start) path += `&startDate=${encodeURIComponent(toWireDate(start))}`;
		if (end) path += `&endDate=${encodeURIComponent(toWireDate(end))}`;
		return ((await this.request<PlanEntry[] | null>("GET", path)) ?? []).map(revivePlan);
	}

	/**
	 * One entry by id, or null when KDM does not have it (deleted). Authentication and server errors are not "gone"
	 * and are thrown, so a hiccup never makes a note look unsent.
	 */
	async getPlan(id: number): Promise<PlanEntry | null> {
		try {
			const plan = await this.request<PlanEntry | null>("GET", `UserJobDefinition?key=${id}`);
			if (!plan || typeof plan !== "object" || plan.id === undefined) return null;
			// KDM may delete softly: the record is still returned, but no longer active.
			if (plan.dataStatus && (plan.dataStatus as string) !== "Activated") return null;
			return revivePlan(plan);
		} catch (error) {
			if (error instanceof KdmError && error.status !== 401 && error.status !== 403 && error.status < 500) return null;
			throw error;
		}
	}

	createPlan(entry: PlanEntry): Promise<unknown> {
		return this.request("POST", "UserJobDefinition", toWirePlan(entry));
	}

	updatePlan(id: number, changes: Partial<PlanEntry>): Promise<unknown> {
		return this.request("PATCH", `UserJobDefinition?key=${id}`, toWirePlan(changes as PlanEntry));
	}

	deletePlan(id: number): Promise<unknown> {
		return this.request("DELETE", `UserJobDefinition?key=${id}`);
	}
}

function safeJson(response: { json: unknown }): unknown {
	try {
		return response.json;
	} catch {
		return null;
	}
}
