import { requestUrl, RequestUrlParam, RequestUrlResponse } from "obsidian";
import {
	API_VERSION,
	assertSuccess,
	errorMessageOf,
	JobCatalogEntry,
	KdmError,
	LoginUser,
	mergeSetCookie,
	parseRefreshResponse,
	PlanEntry,
	revivePlan,
	Session,
	toWireDate,
	toWirePlan,
} from "./kdm-protocol";
import { isTokenExpired } from "./jwt";
import { isSignatureRejection, RequestSigner } from "./request-signer";

export interface KdmClientOptions {
	baseUrl: string;
	/** Current session, if any. Read on every request so a refresh by another call is picked up. */
	getSession: () => Session | null;
	/** Called after a refresh, or when KDM renews the session cookie, so the session can be stored. */
	onSession: (session: Session | null) => void;
	/** Signs authenticated requests; shared so the signing key is fetched once per access token. */
	signer: RequestSigner;
	/**
	 * Logs in again when there is no usable session any more (the refresh token ran out too). Resolves to whether there
	 * is a session afterwards. Left out, such a request fails with "not logged in".
	 */
	relogin?: () => Promise<boolean>;
}

/** What one call to KDM needs besides its method and path. */
interface Call {
	/** Access token; a call that carries one is signed. */
	token?: string;
	/** The session cookie the tokens are bound to; every call, the refresh included, has to carry it. */
	cookie: string;
	body?: unknown;
	/** Off only for `RequestKey`, which hands out the signing key itself. */
	sign?: boolean;
}

/** The `Set-Cookie` header(s) of a response, whatever casing the headers come in. */
function setCookieOf(response: RequestUrlResponse): string | string[] | undefined {
	const headers = (response.headers ?? {}) as Record<string, string | string[]>;
	for (const name of Object.keys(headers)) if (name.toLowerCase() === "set-cookie") return headers[name];
	return undefined;
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

	/**
	 * The one way a call reaches KDM: the headers (token, session cookie, signature), the timeout, picking up a renewed
	 * cookie, and one more try when the server refuses the signature (its key ran out early, e.g. after a restart).
	 */
	private async exchange(method: Method, path: string, call: Call): Promise<RequestUrlResponse> {
		const url = this.url(path);
		const signed = call.token !== undefined && call.sign !== false;
		const attempt = async () => {
			const headers: Record<string, string> = { Accept: "application/json", "api-version": API_VERSION, language: "tr", Cookie: call.cookie };
			if (call.token !== undefined) headers.Authorization = `Bearer ${call.token}`;
			if (signed) Object.assign(headers, await this.options.signer.headers(method, url, call.token as string, (t) => this.fetchRequestKey(t, call.cookie)));
			const response = await fetchWithTimeout({
				url,
				method,
				contentType: call.body === undefined ? undefined : "application/json",
				headers,
				body: call.body === undefined ? undefined : JSON.stringify(call.body),
			});
			this.absorbCookies(response);
			return response;
		};
		const response = await attempt();
		// Only a 403 can be a refused signature, so other answers are not parsed here.
		if (!signed || response.status !== 403 || !isSignatureRejection(response.status, safeJson(response))) return response;
		this.options.signer.invalidate();
		return attempt();
	}

	/** Keeps the session cookie up to date when KDM renews it in a response. */
	private absorbCookies(response: RequestUrlResponse): void {
		const setCookie = setCookieOf(response);
		const session = this.options.getSession();
		if (!setCookie || !session) return;
		const cookie = mergeSetCookie(session.cookie, setCookie);
		if (cookie !== session.cookie) this.options.onSession({ ...session, cookie });
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
		const response = await this.exchange("POST", "RefreshToken", { cookie: session.cookie, body: { refreshToken: session.refreshToken } });
		// Read again: the exchange may have stored a renewed cookie, and a logout meanwhile must stay a logout.
		const current = this.options.getSession();
		if (!current) return false;
		const next = response.status < 300 ? parseRefreshResponse(safeJson(response), current) : null;
		if (next) {
			this.options.onSession(next);
			return true;
		}
		// A refused refresh token is dead: KDM says so with a 4xx or with an empty 204. A server hiccup (5xx) leaves it
		// for the next try.
		if (response.status === 204 || (response.status >= 400 && response.status < 500)) this.options.onSession(null);
		return false;
	}

	private async relogin(): Promise<boolean> {
		if (!this.options.relogin) return false;
		try {
			return await this.options.relogin();
		} catch {
			return false;
		}
	}

	/** Renews an expired access token before it is used. Resolves to whether there is a session. */
	private async ensureSession(): Promise<boolean> {
		const session = this.options.getSession();
		if (session && isTokenExpired(session.token, 30)) await this.refresh();
		return this.options.getSession() !== null;
	}

	async request<T>(method: Method, path: string, body?: unknown): Promise<T> {
		const send = () => {
			const session = this.options.getSession();
			if (!session) throw new KdmError("Not logged in to KDM.", 401);
			return this.exchange(method, path, { token: session.token, cookie: session.cookie, body });
		};
		if (!(await this.ensureSession()) && !(await this.relogin())) throw new KdmError("Not logged in to KDM.", 401);
		let response = await send();
		if (response.status === 401 && (await this.refresh())) response = await send();
		// Refused even after a refresh (or the refresh was refused): a new login is the only way left.
		if (response.status === 401 && (await this.relogin())) response = await send();
		if (response.status === 401) throw new KdmError("The KDM session has expired. Log in again.", 401);
		if (response.status >= 400) {
			throw new KdmError(errorMessageOf(safeJson(response)) ?? `KDM request failed (HTTP ${response.status}).`, response.status);
		}
		if (response.status === 204 || !response.text) return undefined as T;
		const json = safeJson(response);
		assertSuccess(json);
		return json as T;
	}

	/** The signing key for an access token, or null when KDM does not give one (the request then goes out unsigned). */
	private async fetchRequestKey(token: string, cookie: string): Promise<unknown> {
		const response = await this.exchange("GET", "RequestKey", { token, cookie, sign: false });
		return response.status < 300 ? safeJson(response) : null;
	}

	/**
	 * Tells KDM to forget a refresh token (what the web page does when it logs out). Best effort: the session is already
	 * gone locally, so a failure here is ignored.
	 */
	async revoke(session: Session): Promise<void> {
		try {
			await this.exchange("POST", "RevokeRefreshToken", { token: session.token, cookie: session.cookie, body: { refreshToken: session.refreshToken } });
		} catch {
			// Nothing to do: the tokens were removed from this device either way.
		}
	}

	/** Profile of the signed-in user (`id`, `name`, `surname`, `companyId`, ...), or null when KDM gives none. */
	async getLoginUser(): Promise<LoginUser | null> {
		const user = await this.request<LoginUser | null>("GET", "LoginUser");
		return user && typeof user === "object" ? user : null;
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
