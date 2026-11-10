import { App, ItemView, Setting, WorkspaceLeaf } from "obsidian";
import { Session } from "./kdm-protocol";

/** Where the KDM web page keeps its session in `localStorage`. */
const WEB_TOKEN_KEY = "education-core-dashboard";
const WEB_REFRESH_TOKEN_KEY = `${WEB_TOKEN_KEY}-refresh`;
/** KDM's HttpOnly session cookie, which its tokens are bound to. */
const WEB_SESSION_COOKIE = "__Host-kdm-sid";
/** Path of the web page's login screen, below the KDM URL. */
const WEB_LOGIN_PATH = "/giris";

/** The parts of Electron's `<webview>` element that are used here. */
interface WebviewElement extends HTMLElement {
	executeJavaScript(code: string): Promise<unknown>;
	getURL(): string;
	getWebContentsId(): number;
}

declare global {
	interface HTMLElementTagNameMap {
		webview: WebviewElement;
	}
}

/** A cookie as Electron's session API lists it. */
interface ElectronCookie {
	name: string;
	value: string;
	expirationDate?: number;
}

/** The part of Electron's `remote` module used here (Obsidian's own web viewer uses the same). */
interface ElectronRemote {
	webContents: { fromId(id: number): { session: { cookies: { get(filter: { url: string }): Promise<ElectronCookie[]> } } } | undefined };
}

const POLL_MS = 800;

/** Cookies that run out this soon after login (the captcha pass) are not kept with the session. */
const SHORT_LIVED_COOKIE_S = 60 * 60;

/** Reads the web page's session from its `localStorage`; runs inside the page. */
const READ_SESSION = `(() => { try { return JSON.stringify({ token: localStorage.getItem(${JSON.stringify(WEB_TOKEN_KEY)}), refreshToken: localStorage.getItem(${JSON.stringify(WEB_REFRESH_TOKEN_KEY)}) }); } catch (e) { return null; } })()`;

/** Finds the password field and the form's submit button; shared by the page scripts below. */
const FIND_FORM = `const password = document.getElementById("login-password") || document.querySelector('input[type="password"]');
	const button = (password && password.form && password.form.querySelector('button[type="submit"], button:not([type])')) || document.querySelector('button[type="submit"]');`;

/**
 * Fills in the login form once it is on the page, the way typing would (so Angular sees the values); fields that already
 * hold something are left alone. `password` null fills only the email. Runs inside the page; resolves to whether the
 * form was there. Focus is deliberately not moved: moving the keyboard focus into a webview from code crashed Obsidian
 * (Electron 43).
 */
function fillLogin(email: string, password: string | null): string {
	return `(() => { const set = (input, value) => { if (!input || input.value || !value) return; input.value = value; input.dispatchEvent(new Event("input", { bubbles: true })); };
		const email = document.getElementById("login-email"); if (!email) return false; ${FIND_FORM}
		set(email, ${JSON.stringify(email)}); if (${JSON.stringify(password)} !== null) { if (!password) return false; set(password, ${JSON.stringify(password)}); } return true; })()`;
}

/** `sessionStorage` key of the page where the form's values are kept; it outlives a reload of the page, not the tab. */
const CAPTURE_KEY = "__kdmPlannerLogin";

/**
 * Keeps what is typed into the login form ("remember password" only), so it can be stored once KDM accepted it. The
 * values are written to the page's `sessionStorage` on every change and at the moment the form is sent (click, Enter,
 * submit): the plugin only looks every POLL_MS, and the page may reload right after a login, so what was in the fields
 * when the form went out (the password KDM accepted) must survive both. Runs inside the page; resolves to
 * `{ email, password }` as JSON.
 */
const CAPTURE_LOGIN = `(() => { const key = ${JSON.stringify(CAPTURE_KEY)};
	const read = () => { try { return JSON.parse(sessionStorage.getItem(key) || "{}") || {}; } catch (e) { return {}; } };
	const save = () => { const value = read(); const email = document.getElementById("login-email"); ${FIND_FORM}
		if (email && email.value) value.email = email.value; if (password && password.value) value.password = password.value;
		try { sessionStorage.setItem(key, JSON.stringify(value)); } catch (e) {} return value; };
	if (!window.__kdmPlannerCapture) { window.__kdmPlannerCapture = true;
		for (const type of ["input", "change", "paste", "keydown", "click", "submit"]) document.addEventListener(type, () => { save(); setTimeout(save, 0); }, true); }
	return JSON.stringify(save()); })()`;

/** Removes the kept values from the page once they have been taken. */
const CLEAR_CAPTURE = `(() => { try { sessionStorage.removeItem(${JSON.stringify(CAPTURE_KEY)}); } catch (e) {} return true; })()`;

/**
 * State of a filled-in form, for sending it by itself: whether the security check (Cloudflare Turnstile, which leaves
 * its answer in a hidden `cf-turnstile-response` field) has passed and whether the button can be pressed. With `click`
 * the button is pressed when it can be. Runs inside the page.
 */
function submitScript(click: boolean): string {
	return `(() => { ${FIND_FORM} if (!password || !password.value) return null;
		const response = document.querySelector('[name="cf-turnstile-response"]');
		const ready = !!button && !button.disabled; if (${click} && ready) button.click();
		return JSON.stringify({ captcha: response ? (response.value ? "passed" : "pending") : "none", ready }); })()`;
}

interface SubmitState {
	captcha: "passed" | "pending" | "none";
	ready: boolean;
}

/** Wait after the security check passed before sending: the page still has to confirm it with KDM. */
const AFTER_CAPTCHA_MS = 1500;
/** Without a recognisable security check the form is sent this long after it was filled in. */
const NO_CAPTCHA_MS = 8000;
/** A check still open after this long wants a click from the user. */
const CAPTCHA_HINT_MS = 10_000;
/** A sent form that brought no session after this long failed (e.g. a changed password). */
const SUBMIT_TIMEOUT_MS = 10_000;

/**
 * The cookies of the page's browser session, HttpOnly ones included, as a `Cookie` header. KDM binds its tokens to the
 * HttpOnly session cookie, which the page's own script cannot read, so it is taken through Electron. Null when that is
 * not possible.
 */
async function sessionCookies(webview: WebviewElement, base: string): Promise<string | null> {
	try {
		const electron = (window as unknown as { require?: (name: string) => { remote?: ElectronRemote } }).require?.("electron");
		const contents = electron?.remote?.webContents.fromId(webview.getWebContentsId());
		if (!contents) return null;
		const now = Date.now() / 1000;
		const cookies = (await contents.session.cookies.get({ url: base })).filter((c) => !c.expirationDate || c.expirationDate - now > SHORT_LIVED_COOKIE_S);
		if (!cookies.some((c) => c.name === WEB_SESSION_COOKIE)) return null;
		return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
	} catch {
		return null;
	}
}

export const VIEW_TYPE_KDM_LOGIN = "kdm-login";

/** An email and password, as remembered or as typed into the login page. */
export interface LoginCredentials {
	email: string;
	password: string;
}

export interface WebLoginOptions {
	/** Fills in the email field (the settings' email). */
	email: string;
	/** A remembered login: it is filled in and sent by itself once the security check has passed. */
	saved: LoginCredentials | null;
	/** Whether what is typed into the page is kept, to be remembered after a successful login. Can be changed in the tab. */
	remember: boolean;
	onRememberChange(remember: boolean): void;
}

export interface WebLoginResult {
	session: Session;
	/** The email and password the login was made with; only when "remember password" was on. */
	credentials: LoginCredentials | null;
}

/**
 * KDM's own login page inside Obsidian (desktop only), in a tab of its own. The user passes the security check and logs
 * in there. As soon as the page holds a session, its tokens and session cookie are taken and the tab closes, before the
 * page does anything else with them. The page runs in a fresh, in-memory browser session that keeps nothing afterwards.
 *
 * With "remember password" on, the email and password typed into the form are kept to be stored after the login, and a
 * remembered login is filled in and sent by itself once the security check has passed (it still has to be passed on
 * the page: KDM's login cannot be done without it). The password is only ever put into a page on the KDM address.
 *
 * It is a tab and not a modal on purpose: inside a modal, Obsidian's window did not pass mouse and keyboard events on
 * to the page (the form looked disabled). Obsidian's own web viewer also shows its pages in tabs.
 */
export class KdmLoginView extends ItemView {
	private result: WebLoginResult | null = null;
	private onDone: ((result: WebLoginResult | null) => void) | null = null;
	private base = "";
	private options!: WebLoginOptions;
	private timer: number | undefined;
	private webview: WebviewElement | null = null;
	private ready = false;
	private filled = false;
	private busy = false;
	private status!: HTMLElement;
	/** What was typed into the page, kept while "remember password" is on. */
	private typed: Partial<LoginCredentials> = {};
	/** Sending the remembered login by itself; switched off once it has been tried, so it is never sent twice. */
	private auto = false;
	private filledAt = 0;
	private captchaPassedAt = 0;
	private submittedAt = 0;
	private hinted = false;

	constructor(leaf: WorkspaceLeaf) {
		super(leaf);
		this.navigation = false;
	}

	getViewType(): string {
		return VIEW_TYPE_KDM_LOGIN;
	}

	getDisplayText(): string {
		return "KDM girişi";
	}

	getIcon(): string {
		return "log-in";
	}

	async onOpen(): Promise<void> {
		// A login tab brought back with the workspace after a restart has nothing to do.
		if (this.onDone === null) this.contentEl.setText("KDM girişi için ayarlardan ya da komut paletinden \"KDM'ye giriş yap\"ı kullanın.");
	}

	/** Loads the login page of `base`; `onDone` is called once, with the session or with what the user chose instead. */
	start(base: string, options: WebLoginOptions, onDone: (result: WebLoginResult | null) => void): void {
		this.base = base;
		this.options = options;
		this.onDone = onDone;
		this.auto = options.saved !== null;
		const root = this.contentEl;
		root.empty();
		root.addClass("kdm-web-login");
		root.createEl("p", {
			cls: "kdm-message",
			text: this.auto
				? "Kayıtlı bilgilerinizle KDM'ye yeniden giriş yapılıyor. Güvenlik doğrulaması geçince giriş kendiliğinden gönderilir ve bu sekme kapanır."
				: "KDM'nin giriş sayfası aşağıda. Güvenlik doğrulamasını ve girişi burada yapın; giriş tamamlanınca bu sekme kendiliğinden kapanır.",
		});
		this.status = root.createEl("p", { cls: "kdm-message", text: "Sayfa yükleniyor…" });
		new Setting(root)
			.setName("Parolayı bu cihazda hatırla")
			.setDesc("Açıksa giriş sayfasına yazdığınız parola, giriş başarılı olunca Obsidian'ın gizli depolamasında saklanır; oturum düştüğünde eklenti yeniden girişi kendisi yapar.")
			.addToggle((toggle) =>
				toggle.setValue(options.remember).onChange((value) => {
					options.remember = value;
					if (!value) {
						this.typed = {};
						void this.webview?.executeJavaScript(CLEAR_CAPTURE).catch(() => undefined);
					}
					options.onRememberChange(value);
				}),
			)
			.addButton((button) => button.setButtonText("Vazgeç").onClick(() => this.finish(null)));

		const frame = root.createDiv({ cls: "kdm-web-login-frame" });
		// Created detached, partition set before the page is loaded. A partition without "persist:" lives in memory only,
		// and a new name per login starts from an empty session. The user agent is left as Electron's own: a made-up
		// Chrome one did not match the rest of the browser and Cloudflare Turnstile refused it (error 600010).
		const webview = createEl("webview", { cls: "kdm-web-login-webview" });
		webview.setAttribute("partition", `kdm-planner-login-${Date.now()}`);
		webview.setAttribute("src", `${base}${WEB_LOGIN_PATH}`);
		webview.addEventListener("dom-ready", () => {
			this.ready = true;
			this.status.setText("Giriş yapın.");
		});
		webview.addEventListener("did-fail-load", (event) => {
			const detail = event as Event & { errorDescription?: string; isMainFrame?: boolean; errorCode?: number };
			// Aborted loads (-3, e.g. a redirect) and sub-frames are normal; only a failed page is reported.
			if (detail.isMainFrame === false || detail.errorCode === -3) return;
			this.status.setText(`Sayfa açılamadı${detail.errorDescription ? ` (${detail.errorDescription})` : ""}. Bağlantınızı kontrol edip yeniden deneyin.`);
		});
		frame.appendChild(webview);
		this.webview = webview;

		if (typeof webview.executeJavaScript !== "function") {
			this.status.setText("Bu Obsidian sürümünde KDM'nin giriş sayfası açılamıyor.");
		} else {
			this.timer = window.setInterval(() => void this.poll(), POLL_MS);
		}
	}

	/** Ends the login with `result` and closes the tab. */
	private finish(result: WebLoginResult | null): void {
		if (this.onDone === null) return;
		this.result = result;
		this.leaf.detach();
	}

	/** Whether the page shown is KDM itself; nothing is read from or written into any other page. */
	private onKdm(): boolean {
		try {
			return new URL(this.webview?.getURL() ?? "").origin === new URL(this.base).origin;
		} catch {
			return false;
		}
	}

	private async poll(): Promise<void> {
		const webview = this.webview;
		if (!webview || !this.ready || this.busy || this.result !== null || !this.onKdm()) return;
		this.busy = true;
		try {
			const saved = this.options.saved;
			if (!this.filled) {
				const email = saved?.email ?? this.options.email;
				if (email || saved) this.filled = (await webview.executeJavaScript(fillLogin(email, saved?.password ?? null))) === true;
				if (this.filled && this.auto) {
					this.filledAt = Date.now();
					this.status.setText("Kayıtlı bilgiler dolduruldu; güvenlik doğrulaması bekleniyor…");
				}
			}
			if (this.options.remember) await this.capture(webview);
			const raw = await webview.executeJavaScript(READ_SESSION);
			if (typeof raw !== "string") return;
			const found = JSON.parse(raw) as { token?: unknown; refreshToken?: unknown };
			if (typeof found.token !== "string" || !found.token) {
				if (this.auto && this.filled) await this.autoSubmit(webview);
				return;
			}
			const cookie = await sessionCookies(webview, this.base);
			if (!cookie) {
				// Without the session cookie KDM refuses the tokens; keep the tab open and say so.
				window.clearInterval(this.timer);
				this.status.setText("Giriş yapıldı ama KDM'nin oturum çerezi alınamadı; bu oturum eklentide kullanılamaz.");
				return;
			}
			if (this.options.remember) {
				// Read once more after the login: the page may have reloaded since the last look.
				await this.capture(webview);
				await webview.executeJavaScript(CLEAR_CAPTURE).catch(() => undefined);
			}
			this.finish({ session: { token: found.token, refreshToken: typeof found.refreshToken === "string" ? found.refreshToken : "", cookie }, credentials: this.credentials() });
		} catch {
			// The page is navigating or not ready; the next tick tries again.
		} finally {
			this.busy = false;
		}
	}

	/** Takes what has been typed into the form so far. */
	private async capture(webview: WebviewElement): Promise<void> {
		const raw = await webview.executeJavaScript(CAPTURE_LOGIN);
		if (typeof raw !== "string") return;
		// The page has the latest values (a password typed over another one replaces it), so they replace what was taken before.
		const value = JSON.parse(raw) as { email?: unknown; password?: unknown };
		if (typeof value.email === "string" && value.email) this.typed.email = value.email;
		if (typeof value.password === "string" && value.password) this.typed.password = value.password;
	}

	/** The login to remember: what was typed, or else the remembered one that was filled in. Null when "remember" is off. */
	private credentials(): LoginCredentials | null {
		if (!this.options.remember) return null;
		const password = this.typed.password ?? this.options.saved?.password;
		const email = this.typed.email ?? this.options.saved?.email ?? this.options.email;
		return password && email ? { email: email.trim(), password } : null;
	}

	/**
	 * Sends the filled-in remembered login once the security check has passed, the way a click on the button would. It
	 * is sent once only: a password KDM refuses is not tried again, the user takes over.
	 */
	private async autoSubmit(webview: WebviewElement): Promise<void> {
		const now = Date.now();
		if (this.submittedAt) {
			if (now - this.submittedAt > SUBMIT_TIMEOUT_MS) {
				this.auto = false;
				this.status.setText("Kayıtlı bilgilerle giriş tamamlanamadı (parola değişmiş olabilir). Bilgileri kontrol edip girişi kendiniz yapın.");
			}
			return;
		}
		const raw = await webview.executeJavaScript(submitScript(false));
		if (typeof raw !== "string") return;
		const state = JSON.parse(raw) as SubmitState;
		if (state.captcha === "passed") this.captchaPassedAt ||= now;
		const settled = this.captchaPassedAt ? now - this.captchaPassedAt >= AFTER_CAPTCHA_MS : state.captcha === "none" && now - this.filledAt >= NO_CAPTCHA_MS;
		if (!settled || !state.ready) {
			if (state.captcha === "pending" && !this.hinted && now - this.filledAt >= CAPTCHA_HINT_MS) {
				this.hinted = true;
				this.status.setText("Güvenlik doğrulaması sizi bekliyor: aşağıdaki kutuyu işaretleyin, giriş ardından kendiliğinden gönderilir.");
			}
			return;
		}
		const clicked = await webview.executeJavaScript(submitScript(true));
		if (typeof clicked !== "string" || !(JSON.parse(clicked) as SubmitState).ready) return;
		this.submittedAt = now;
		this.status.setText("Giriş gönderildi…");
	}

	async onClose(): Promise<void> {
		window.clearInterval(this.timer);
		// Taking the webview out of the page ends its browser session: the web page cannot refresh or reuse the tokens.
		this.webview?.remove();
		this.webview = null;
		this.contentEl.empty();
		const onDone = this.onDone;
		this.onDone = null;
		onDone?.(this.result);
	}
}

/**
 * Opens the login page in a new tab and resolves to how it ended (closing the tab counts as cancelling). Afterwards the
 * tab that was active before gets the focus back, so a login started by itself does not leave the user elsewhere.
 */
export async function webLogin(app: App, base: string, options: WebLoginOptions): Promise<WebLoginResult | null> {
	// A login tab left open from an earlier attempt is replaced.
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_KDM_LOGIN)) leaf.detach();
	const previous = app.workspace.getMostRecentLeaf();
	const leaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_KDM_LOGIN, active: true });
	await app.workspace.revealLeaf(leaf);
	const view = leaf.view;
	if (!(view instanceof KdmLoginView)) return null;
	const result = await new Promise<WebLoginResult | null>((resolve) => view.start(base, options, resolve));
	if (previous && previous !== leaf && previous.view.containerEl.isConnected) app.workspace.setActiveLeaf(previous, { focus: true });
	return result;
}
