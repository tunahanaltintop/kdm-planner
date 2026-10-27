import { debounce, Editor, MarkdownView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import { KdmCalendarView, VIEW_TYPE_KDM } from "./calendar-view";
import { isTokenExpired, tokenExpiryMs, userIdFromToken } from "./jwt";
import { EntryViewModal } from "./entry-modal";
import { KdmClient } from "./kdm-client";
import { buildNewPlan, JobCatalogEntry, LoginUser, normalizeBaseUrl, PlanEntry, PlanStatus, Session } from "./kdm-protocol";
import { confirm, PasswordModal, pickWeek } from "./modals";
import { registerWeekBlock } from "./note-block";
import { PlanFormValue, PlanModal, PlanModalInit } from "./plan-modal";
import { DEFAULT_SETTINGS, KdmPlannerSettings, KdmPlannerSettingTab } from "./settings";
import { addDays, isoDate, lunchFromSettings, minEditableDate, startOfWeek, workHoursFromSettings } from "./week";
import { emptyWeekBlock } from "./week-note";

const TOKEN_SECRET = "kdm-planner-token";
const REFRESH_SECRET = "kdm-planner-refresh-token";

interface CatalogCache {
	fetchedAt: number;
	userId: number;
	entries: JobCatalogEntry[];
}

interface PluginData extends Partial<KdmPlannerSettings> {
	/** Profile returned by the last login; not a secret. */
	user?: LoginUser | null;
	catalog?: CatalogCache | null;
	/** Address the stored session was created for; the tokens are never sent anywhere else. */
	sessionBase?: string | null;
}

/** Callbacks for whoever opened the dialog on an existing entry (e.g. a note that stands for it). */
export interface PlanHooks {
	onUpdated?: (value: PlanFormValue) => void;
	onRemoved?: () => void;
}

/** Only what the plugin needs is kept from the login profile; the rest (e.g. identity numbers) is never written to disk. */
export function minimalUser(user: LoginUser | null | undefined): LoginUser | null {
	if (!user || !user.id) return null;
	return { id: Number(user.id), name: String(user.name ?? ""), surname: String(user.surname ?? ""), companyId: user.companyId === undefined ? undefined : Number(user.companyId) };
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default class KdmPlannerPlugin extends Plugin {
	settings: KdmPlannerSettings = { ...DEFAULT_SETTINGS };
	user: LoginUser | null = null;
	private catalog: CatalogCache | null = null;
	private stored: Session | null = null;
	private sessionBase: string | null = null;
	private weeks = new Map<string, Promise<PlanEntry[]>>();
	private listeners = new Set<() => void>();
	private loginInFlight = false;
	/** Writes the settings shortly after the last change, so typing in a field does not write the file on every key. */
	readonly saveSoon = debounce(() => void this.saveSettings(), 600, true);

	async onload(): Promise<void> {
		await this.loadSettings();
		this.loadSession();
		this.addSettingTab(new KdmPlannerSettingTab(this.app, this));
		this.registerView(VIEW_TYPE_KDM, (leaf: WorkspaceLeaf) => new KdmCalendarView(leaf, this));
		registerWeekBlock(this);

		// A button in the header of every note that inserts a weekly plan block.
		const decorated = new WeakSet<MarkdownView>();
		const decorate = () => {
			for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
				const view = leaf.view;
				if (!(view instanceof MarkdownView) || decorated.has(view)) continue;
				decorated.add(view);
				const action = view.addAction("calendar-days", "KDM haftalık planı ekle", () => void this.insertWeekPlan(view));
				// The button belongs to the view, which outlives the plugin: take it away when the plugin is turned off.
				this.register(() => action.remove());
			}
		};
		this.app.workspace.onLayoutReady(decorate);
		this.registerEvent(this.app.workspace.on("active-leaf-change", decorate));
		this.registerEvent(this.app.workspace.on("file-open", decorate));

		this.addRibbonIcon("calendar-days", "KDM takvimini aç", () => void this.activateView());
		this.addCommand({ id: "open-calendar", name: "KDM takvimini aç", callback: () => void this.activateView() });
		this.addCommand({ id: "new-task", name: "KDM'ye görev ekle", callback: () => void this.openPlanModal({ date: new Date() }) });
		this.addCommand({
			id: "insert-week-plan",
			name: "Haftalık plan bloğu ekle",
			editorCallback: (editor: Editor) => {
				void pickWeek(this.app).then((date) => {
					if (date) editor.replaceSelection(emptyWeekBlock(date));
				});
			},
		});
		this.addCommand({ id: "refresh-catalog", name: "Görev listesini yenile", callback: () => void this.refreshCatalog(true).catch((e: unknown) => new Notice(errorMessage(e))) });
		this.addCommand({ id: "login", name: "KDM'ye giriş yap", callback: () => void this.login() });
		this.addCommand({ id: "logout", name: "KDM'den çıkış yap", callback: () => this.logout() });
		this.addCommand({
			id: "test-connection",
			name: "KDM bağlantısını sına",
			callback: () => void this.testConnection().catch((error: unknown) => new Notice(errorMessage(error))),
		});
	}

	onunload(): void {
		// A change made in the last moments must not be lost with the pending delayed save.
		this.saveSoon.cancel();
		void this.saveSettings();
	}

	/** Asks for a week and adds its plan block at the cursor, or at the end of the note when it is not being edited. */
	async insertWeekPlan(view: MarkdownView): Promise<void> {
		const date = await pickWeek(this.app);
		if (!date) return;
		const block = emptyWeekBlock(date);
		if (view.getMode() === "source") {
			view.editor.replaceSelection(block);
			return;
		}
		const file = view.file;
		if (!file) return;
		await this.app.vault.process(file, (data) => `${data}${data.endsWith("\n") || !data ? "" : "\n"}\n${block}`);
		new Notice("Haftalık plan notun sonuna eklendi.");
	}

	async activateView(): Promise<void> {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_KDM)[0];
		const leaf = existing ?? this.app.workspace.getLeaf("tab");
		if (!existing) await leaf.setViewState({ type: VIEW_TYPE_KDM, active: true });
		await this.app.workspace.revealLeaf(leaf);
	}

	// ---- settings and session ----

	async loadSettings(): Promise<void> {
		const { user, catalog, sessionBase, ...settings } = ((await this.loadData()) as PluginData | null) ?? {};
		this.sessionBase = typeof sessionBase === "string" ? sessionBase : null;
		this.settings = { ...DEFAULT_SETTINGS, ...settings };
		this.sanitizeSettings();
		// Older versions stored the whole profile; keep only the needed fields.
		this.user = minimalUser(user);
		this.catalog = catalog ?? null;
	}

	/** data.json can be edited by hand or come from an older version: keep every value usable. */
	private sanitizeSettings(): void {
		const s = this.settings;
		const number = (value: unknown, fallback: number, min: number, max: number) =>
			typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
		s.breakMinutes = number(s.breakMinutes, DEFAULT_SETTINGS.breakMinutes, 0, 120);
		s.maxBlockHours = number(s.maxBlockHours, DEFAULT_SETTINGS.maxBlockHours, 1, 10);
		s.defaultMinutes = number(s.defaultMinutes, DEFAULT_SETTINGS.defaultMinutes, 15, 240);
		s.showWeekend = s.showWeekend !== false;
		for (const key of ["baseUrl", "email", "workStart", "workEnd", "lunchStart", "lunchEnd"] as const) if (typeof s[key] !== "string") s[key] = DEFAULT_SETTINGS[key];
	}

	async saveSettings(): Promise<void> {
		await this.saveData({ ...this.settings, user: this.user, catalog: this.catalog, sessionBase: this.sessionBase });
	}

	private loadSession(): void {
		const token = this.app.secretStorage.getSecret(TOKEN_SECRET);
		const refreshToken = this.app.secretStorage.getSecret(REFRESH_SECRET) ?? "";
		this.stored = token ? { token, refreshToken } : null;
		// A session from an older version has no address yet: bind it to the configured one, once.
		if (this.stored && this.sessionBase === null) {
			this.sessionBase = this.currentBase();
			this.saveSoon();
		}
	}

	/** The configured address in its normal form, or null when it is not a usable address. */
	private currentBase(): string | null {
		return normalizeBaseUrl(this.settings.baseUrl).url ?? null;
	}

	/**
	 * The session, but only while the configured address is the one it was created for: changing the KDM URL must never
	 * send the tokens of the old server to the new one.
	 */
	private get session(): Session | null {
		if (!this.stored) return null;
		return this.sessionBase === null || this.sessionBase === this.currentBase() ? this.stored : null;
	}

	/** Forgets a session that belongs to another address (the URL was changed). */
	dropForeignSession(): void {
		if (this.stored && this.session === null) {
			this.setSession(null, null);
			this.user = null;
			this.catalog = null;
			this.weeks.clear();
			this.saveSoon();
			this.notifyPlansChanged();
			new Notice("KDM URL'si değişti: önceki oturum kapatıldı. Yeniden giriş yapın.");
		}
	}

	/** Keeps the session in memory and in the secret storage, so it survives restarts without touching `data.json`. */
	private setSession(session: Session | null, base: string | null = this.currentBase()): void {
		this.stored = session;
		this.sessionBase = session ? base : null;
		this.app.secretStorage.setSecret(TOKEN_SECRET, session?.token ?? "");
		this.app.secretStorage.setSecret(REFRESH_SECRET, session?.refreshToken ?? "");
		this.saveSoon();
	}

	get loggedIn(): boolean {
		return this.session !== null;
	}

	createClient(): KdmClient {
		const base = normalizeBaseUrl(this.settings.baseUrl);
		if (base.error !== undefined) throw new Error(base.error);
		return new KdmClient({
			baseUrl: base.url,
			getSession: () => this.session,
			onSession: (session) => this.setSession(session, base.url),
		});
	}

	/** Human-readable state of the stored session, or null when there is none. */
	sessionSummary(): string | null {
		if (!this.session) return null;
		const who = this.user ? `${this.user.name} ${this.user.surname}` : this.settings.email || "KDM kullanıcısı";
		const expiry = tokenExpiryMs(this.session.token);
		if (!isTokenExpired(this.session.token, 0)) {
			return `${who} olarak giriş yapıldı${expiry ? `; anahtar ${new Date(expiry).toLocaleString("tr-TR")} tarihine kadar geçerli` : ""}.`;
		}
		return this.session.refreshToken ? `${who} olarak giriş yapıldı; anahtar otomatik yenilenir.` : `${who} oturumu doldu. Yeniden giriş yapın.`;
	}

	/** Asks for the password and stores the resulting tokens. Resolves to whether the login succeeded. */
	async login(): Promise<boolean> {
		if (this.loginInFlight) return false;
		const base = normalizeBaseUrl(this.settings.baseUrl);
		if (base.error !== undefined) {
			new Notice(base.error);
			return false;
		}
		if (!this.settings.email) {
			new Notice("Önce ayarlardan KDM e-postanızı girin.");
			return false;
		}
		this.loginInFlight = true;
		try {
			return await this.doLogin();
		} finally {
			this.loginInFlight = false;
		}
	}

	private async doLogin(): Promise<boolean> {
		const password = await new Promise<string | null>((resolve) => new PasswordModal(this.app, this.settings.email, resolve).open());
		if (!password) return false;
		try {
			const result = await this.createClient().login(this.settings.email, password);
			this.user = minimalUser(result.user);
			this.weeks.clear();
			await this.saveSettings();
			new Notice(`KDM'ye giriş yapıldı${this.user ? `: ${this.user.name} ${this.user.surname}` : ""}.`);
			// The task list rarely changes, so it is fetched once per login and cached.
			await this.refreshCatalog(true).catch((e: unknown) => new Notice(`Görev listesi alınamadı: ${errorMessage(e)}`));
			this.notifyPlansChanged();
			return true;
		} catch (error) {
			new Notice(`KDM girişi başarısız: ${errorMessage(error)}`);
			return false;
		}
	}

	logout(): void {
		// Ask KDM to drop the refresh token too (best effort), then forget everything on this device.
		const previous = this.session;
		if (previous?.refreshToken) {
			try {
				void this.createClient().revoke(previous);
			} catch {
				// No valid URL any more: the tokens are removed from this device below anyway.
			}
		}
		this.setSession(null);
		this.user = null;
		this.catalog = null;
		this.weeks.clear();
		void this.saveSettings();
		this.notifyPlansChanged();
		new Notice("KDM oturumu kapatıldı.");
	}

	get userId(): number {
		return this.user?.id ?? (this.session ? userIdFromToken(this.session.token) : 0);
	}

	/** Reads the user's plan entries of the current month, which proves the token works. */
	async testConnection(): Promise<void> {
		if (!this.session) throw new Error("Önce KDM'ye giriş yapın.");
		if (!this.userId) throw new Error("Kullanıcı numarası bilinmiyor. Yeniden giriş yapın.");
		const entries = await this.getWeekEntries(startOfWeek(new Date()), true);
		new Notice(`KDM bağlantısı çalışıyor: bu hafta ${entries.length} kayıt.`);
	}

	// ---- task catalogue ----

	get catalogEntries(): JobCatalogEntry[] {
		return this.catalog && this.catalog.userId === this.userId ? this.catalog.entries : [];
	}

	/** The cached task list; fetched when missing or when `force` is set. */
	async refreshCatalog(force = false): Promise<JobCatalogEntry[]> {
		if (!force && this.catalogEntries.length) return this.catalogEntries;
		if (!this.userId) throw new Error("Önce KDM'ye giriş yapın.");
		const entries = await this.createClient().getUserJobs(this.userId);
		this.catalog = { fetchedAt: Date.now(), userId: this.userId, entries };
		await this.saveSettings();
		if (force) new Notice(`${entries.length} görev önbelleğe alındı.`);
		return entries;
	}

	// ---- plan entries ----

	rules() {
		return {
			minEditable: minEditableDate(this.user?.companyId),
			maxBlockHours: this.settings.maxBlockHours,
			breakMinutes: this.settings.breakMinutes,
			defaultMinutes: this.settings.defaultMinutes,
			lunch: this.lunch(),
			work: this.work(),
		};
	}

	/** The configured working hours, as minutes after midnight. */
	work() {
		return workHoursFromSettings(this.settings.workStart, this.settings.workEnd);
	}

	/** The configured lunch break, as minutes after midnight. */
	lunch() {
		return lunchFromSettings(this.settings.lunchStart, this.settings.lunchEnd);
	}

	/** Entries touching the week starting at `weekStart`. Cached per week until something is written. */
	getWeekEntries(weekStart: Date, force = false): Promise<PlanEntry[]> {
		const key = isoDate(weekStart);
		if (force) this.weeks.delete(key);
		let promise = this.weeks.get(key);
		if (!promise) {
			// A leave that began earlier can still run into this week, so the query starts two weeks before.
			const from = addDays(weekStart, -14);
			const to = addDays(weekStart, 7);
			promise = this.createClient()
				.getMyTasks(this.userId, from, to)
				.then((all) => all.filter((e) => new Date(e.startTime) < to && new Date(e.endTime) > weekStart));
			promise.catch(() => this.weeks.delete(key));
			this.weeks.set(key, promise);
		}
		return promise;
	}

	onPlansChanged(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	notifyPlansChanged(): void {
		for (const listener of this.listeners) listener();
	}

	private afterWrite(): void {
		this.weeks.clear();
		this.notifyPlansChanged();
	}

	/** Creates an entry and returns its id. The API does not return one, so the entry is read back. */
	async createPlan(value: PlanFormValue): Promise<number | null> {
		if (!this.userId) throw new Error("Önce KDM'ye giriş yapın.");
		const plan = buildNewPlan({
			userId: this.userId,
			status: value.status,
			start: value.start,
			end: value.end,
			jobDefinitionId: value.jobDefinitionId,
			description: value.description,
			hour: value.hour,
		});
		await this.createClient().createPlan(plan);
		// One fresh read serves both the id lookup and the views, which are told only afterwards.
		this.weeks.clear();
		const entries = await this.getWeekEntries(startOfWeek(value.start), true);
		this.notifyPlansChanged();
		const created = entries
			.filter(
				(e) =>
					new Date(e.startTime).getTime() === value.start.getTime() &&
					new Date(e.endTime).getTime() === value.end.getTime() &&
					e.statusId === value.status &&
					(e.jobDefinitionId ?? undefined) === value.jobDefinitionId,
			)
			.sort((a, b) => (b.id ?? 0) - (a.id ?? 0))[0];
		return created?.id ?? null;
	}

	async updatePlan(entry: PlanEntry, value: PlanFormValue): Promise<void> {
		if (entry.id === undefined) return;
		const changes: Partial<PlanEntry> = {
			statusId: value.status,
			startTime: value.start,
			endTime: value.end,
			description: value.description,
			hour: value.hour ?? Math.round(((value.end.getTime() - value.start.getTime()) / 3_600_000) * 100) / 100,
		};
		if (value.status !== PlanStatus.DayOff) changes.jobDefinitionId = value.jobDefinitionId;
		await this.createClient().updatePlan(entry.id, changes);
		this.afterWrite();
	}

	/** Moves or resizes an entry; like the web app, only the times (and the length) are sent. */
	async moveEntry(entry: PlanEntry, start: Date, end: Date, resized: boolean): Promise<void> {
		if (entry.id === undefined) return;
		const changes: Partial<PlanEntry> = { startTime: start, endTime: end };
		if (resized) changes.hour = Math.round(((end.getTime() - start.getTime()) / 3_600_000) * 100) / 100;
		await this.createClient().updatePlan(entry.id, changes);
		this.afterWrite();
	}

	async completeEntry(entry: PlanEntry): Promise<void> {
		if (entry.id === undefined) return;
		const statusId = entry.statusId === PlanStatus.AssignedPlanned ? PlanStatus.AssignedCompleted : PlanStatus.Completed;
		await this.createClient().updatePlan(entry.id, { completedPiece: entry.completedPiece ?? null, statusId } as Partial<PlanEntry>);
		this.afterWrite();
	}

	/** Deletes the entry in KDM. Failures are reported as "KDM'den silinemedi: ..." so callers can keep their copy. */
	async deleteEntry(entry: PlanEntry): Promise<void> {
		if (entry.id === undefined) return;
		if (new Date(entry.startTime) < this.rules().minEditable) throw new Error("KDM'den silinemedi: bu kayıt kilitli (geçmiş hafta).");
		try {
			await this.createClient().deletePlan(entry.id);
		} catch (error) {
			throw new Error(`KDM'den silinemedi: ${errorMessage(error)}`);
		}
		this.afterWrite();
	}

	/** Asks whether an entry may be deleted, without deleting it. */
	askDelete(message = "Bu kayıt KDM'den silinecek. Emin misiniz?"): Promise<boolean> {
		return confirm(this.app, "Görevi sil", message, "Sil");
	}

	/** Asks before deleting, like the web app. Resolves to whether the entry was deleted. */
	async confirmDelete(entry: PlanEntry, message = "Bu kayıt KDM'den silinecek. Emin misiniz?"): Promise<boolean> {
		if (!(await this.askDelete(message))) return false;
		await this.deleteEntry(entry);
		return true;
	}

	// ---- dialog ----

	/** Whether an entry is locked: records of past weeks can be read but not changed. */
	isLocked(entry: PlanEntry): boolean {
		return new Date(entry.startTime) < this.rules().minEditable;
	}

	/** Opens the edit dialog for an entry; a locked one opens read-only. `hooks` tell the caller what happened. */
	async editEntry(entry: PlanEntry, hooks?: PlanHooks): Promise<void> {
		const start = new Date(entry.startTime);
		if (this.isLocked(entry)) {
			new EntryViewModal(this.app, entry, true).open();
			return;
		}
		const pad = (n: number) => String(n).padStart(2, "0");
		const end = new Date(entry.endTime);
		await this.openPlanModal({
			date: new Date(start.getFullYear(), start.getMonth(), start.getDate()),
			startTime: `${pad(start.getHours())}:${pad(start.getMinutes())}`,
			endTime: `${pad(end.getHours())}:${pad(end.getMinutes())}`,
			entry,
		}, undefined, hooks);
	}

	/**
	 * Opens the task dialog. `onCreated` receives the new entry's id after a successful add, which the notes use to
	 * mark a line as entered.
	 */
	async openPlanModal(init: PlanModalInit, onCreated?: (id: number | null, value: PlanFormValue) => void, hooks?: PlanHooks): Promise<void> {
		if (!this.session) {
			if (!(await this.login())) return;
		}
		try {
			await this.refreshCatalog();
		} catch (error) {
			new Notice(`Görev listesi alınamadı: ${errorMessage(error)}`);
			return;
		}
		new PlanModal(
			this.app,
			{
				catalog: this.catalogEntries,
				rules: () => this.rules(),
				loadEntries: (date) => this.getWeekEntries(startOfWeek(date)),
				submit: async (value, current) => {
					if (current) {
						await this.updatePlan(current, value);
						new Notice("Görev güncellendi.");
						hooks?.onUpdated?.(value);
					} else {
						const id = await this.createPlan(value);
						new Notice("Görev KDM'ye eklendi.");
						onCreated?.(id, value);
					}
				},
				complete: async (current) => {
					await this.completeEntry(current);
					new Notice("Görev tamamlandı.");
				},
				remove: async (current) => {
					const deleted = await this.confirmDelete(current);
					if (deleted) {
						new Notice("Görev silindi.");
						hooks?.onRemoved?.();
					}
					return deleted;
				},
			},
			init,
		).open();
	}
}
