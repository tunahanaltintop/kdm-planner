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

/**
 * Fills in the email field of the login form once it is on the page, the way typing would (so Angular sees the value).
 * Runs inside the page; resolves to whether the form was there. Focus is deliberately not moved: moving the keyboard
 * focus into a webview from code crashed Obsidian (Electron 43).
 */
function fillEmail(email: string): string {
	return `(() => { const input = document.getElementById("login-email"); if (!input) return false; if (input.value) return true;
		input.value = ${JSON.stringify(email)}; input.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
}

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

/**
 * KDM's own login page inside Obsidian (desktop only), in a tab of its own. The user passes the security check and logs
 * in there; the plugin never sees the password. As soon as the page holds a session, its tokens and session cookie are
 * taken and the tab closes, before the page does anything else with them. The page runs in a fresh, in-memory browser
 * session that keeps nothing afterwards.
 *
 * It is a tab and not a modal on purpose: inside a modal, Obsidian's window did not pass mouse and keyboard events on
 * to the page (the form looked disabled). Obsidian's own web viewer also shows its pages in tabs.
 */
export class KdmLoginView extends ItemView {
	private result: Session | null = null;
	private onDone: ((result: Session | null) => void) | null = null;
	private base = "";
	private timer: number | undefined;
	private webview: WebviewElement | null = null;
	private ready = false;
	private emailFilled = false;
	private busy = false;
	private status!: HTMLElement;

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
	start(base: string, email: string, onDone: (result: Session | null) => void): void {
		this.base = base;
		this.onDone = onDone;
		const root = this.contentEl;
		root.empty();
		root.addClass("kdm-web-login");
		root.createEl("p", {
			cls: "kdm-message",
			text: "KDM'nin giriş sayfası aşağıda. Güvenlik doğrulamasını ve girişi burada yapın; giriş tamamlanınca bu sekme kendiliğinden kapanır. Parolanız eklentiye geçmez.",
		});
		this.status = root.createEl("p", { cls: "kdm-message", text: "Sayfa yükleniyor…" });
		new Setting(root).addButton((button) => button.setButtonText("Vazgeç").onClick(() => this.finish(null)));

		const frame = root.createDiv({ cls: "kdm-web-login-frame" });
		// Created detached, partition set before the page is loaded. A partition without "persist:" lives in memory only,
		// and a new name per login starts from an empty session. The user agent is left as Electron's own: a made-up
		// Chrome one did not match the rest of the browser and Cloudflare Turnstile refused it (error 600010).
		const webview = createEl("webview");
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
			this.timer = window.setInterval(() => void this.poll(email), POLL_MS);
		}
	}

	/** Ends the login with `result` and closes the tab. */
	private finish(result: Session | null): void {
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

	private async poll(email: string): Promise<void> {
		const webview = this.webview;
		if (!webview || !this.ready || this.busy || this.result !== null || !this.onKdm()) return;
		this.busy = true;
		try {
			if (!this.emailFilled && email) this.emailFilled = (await webview.executeJavaScript(fillEmail(email))) === true;
			const raw = await webview.executeJavaScript(READ_SESSION);
			if (typeof raw !== "string") return;
			const found = JSON.parse(raw) as { token?: unknown; refreshToken?: unknown };
			if (typeof found.token !== "string" || !found.token) return;
			const cookie = await sessionCookies(webview, this.base);
			if (!cookie) {
				// Without the session cookie KDM refuses the tokens; keep the tab open and say so.
				window.clearInterval(this.timer);
				this.status.setText("Giriş yapıldı ama KDM'nin oturum çerezi alınamadı; bu oturum eklentide kullanılamaz.");
				return;
			}
			this.finish({ token: found.token, refreshToken: typeof found.refreshToken === "string" ? found.refreshToken : "", cookie });
		} catch {
			// The page is navigating or not ready; the next tick tries again.
		} finally {
			this.busy = false;
		}
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

/** Opens the login page in a new tab and resolves to how it ended (closing the tab counts as cancelling). */
export async function webLogin(app: App, base: string, email: string): Promise<Session | null> {
	// A login tab left open from an earlier attempt is replaced.
	for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_KDM_LOGIN)) leaf.detach();
	const leaf = app.workspace.getLeaf("tab");
	await leaf.setViewState({ type: VIEW_TYPE_KDM_LOGIN, active: true });
	await app.workspace.revealLeaf(leaf);
	const view = leaf.view;
	if (!(view instanceof KdmLoginView)) return null;
	return new Promise((resolve) => view.start(base, email, resolve));
}
