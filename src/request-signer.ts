/**
 * Request signing, as the KDM web app does it. Every authenticated `/api/...` call carries `X-KDM-Ts`, `X-KDM-Nonce` and
 * `X-KDM-Sig`: an HMAC-SHA256 over `METHOD\npath\ntimestamp\nnonce` with a key the server hands out per access token
 * (`GET /api/RequestKey`). A bad signature is refused with HTTP 403 and the error code `REQUEST_SIGNATURE_INVALID`.
 * Free of Obsidian imports so it can be tested in Node.
 */

import { base64UrlDecode } from "./jwt.ts";
import { errorCodeOf, pick } from "./kdm-protocol.ts";

export const SIGNATURE_HEADERS = { timestamp: "X-KDM-Ts", nonce: "X-KDM-Nonce", signature: "X-KDM-Sig" } as const;

/** Error code of the 403 answer to a request whose signature the server did not accept. */
const SIGNATURE_INVALID = "REQUEST_SIGNATURE_INVALID";

/** What `GET /api/RequestKey` answers: a base64url raw key, the server's clock and the key's expiry (epoch ms). */
interface RequestKeyAnswer {
	key: string;
	serverTime: number;
	expiresAt: number;
}

interface SignerState {
	token: string;
	key: CryptoKey;
	/** Server clock minus local clock, so a wrong local clock does not make every timestamp stale. */
	clockOffset: number;
	expiresAt: number;
}

/** A key is renewed this long before the server says it expires, like the web app. */
const RENEW_BEFORE_MS = 60_000;

function base64UrlToBytes(text: string): Uint8Array {
	const binary = base64UrlDecode(text);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

function bytesToBase64Url(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomNonce(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** The path that is signed: the URL's path without the query, percent-decoded. */
export function signedPath(url: string): string {
	const path = new URL(url).pathname;
	try {
		return decodeURIComponent(path);
	} catch {
		return path;
	}
}

/** Reads the answer of `RequestKey`, or null when it is not one. */
export function parseRequestKey(body: unknown): RequestKeyAnswer | null {
	if (typeof body !== "object" || body === null) return null;
	const json = body as Record<string, unknown>;
	const key = pick<unknown>(json, "key", "Key");
	if (typeof key !== "string" || !key) return null;
	const serverTime = Number(pick(json, "serverTime", "ServerTime"));
	const expiresAt = Number(pick(json, "expiresAt", "ExpiresAt"));
	return { key, serverTime: Number.isFinite(serverTime) ? serverTime : Date.now(), expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0 };
}

/** The signature of one request, base64url without padding. */
export async function computeSignature(key: CryptoKey, method: string, path: string, timestamp: number, nonce: string): Promise<string> {
	const message = new TextEncoder().encode(`${method.toUpperCase()}\n${path}\n${timestamp}\n${nonce}`);
	return bytesToBase64Url(await crypto.subtle.sign("HMAC", key, message));
}

export function importSigningKey(key: string): Promise<CryptoKey> {
	const bytes = base64UrlToBytes(key);
	return crypto.subtle.importKey("raw", bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

/** Whether a 403 body says the signature was refused (the key is then fetched again and the request retried once). */
export function isSignatureRejection(status: number, body: unknown): boolean {
	return status === 403 && errorCodeOf(body) === SIGNATURE_INVALID;
}

/**
 * Keeps the signing key of the current access token and signs requests with it. One instance is shared by all clients
 * of the plugin, so the key is fetched once per token rather than once per request.
 */
export class RequestSigner {
	private state: SignerState | null = null;
	private pending: { token: string; promise: Promise<SignerState | null> } | null = null;

	private readonly now: () => number;

	constructor(now: () => number = Date.now) {
		this.now = now;
	}

	/** Forgets the key, e.g. after the server refused a signature or the session ended. */
	invalidate(): void {
		this.state = null;
		this.pending = null;
	}

	/**
	 * Headers that sign a request made with `token`. Empty when no key can be had (the request then goes out unsigned,
	 * as the web app does, and the server decides).
	 */
	async headers(method: string, url: string, token: string, fetchKey: (token: string) => Promise<unknown>): Promise<Record<string, string>> {
		const state = await this.ensureState(token, fetchKey);
		if (!state) return {};
		const timestamp = Math.round(this.now() + state.clockOffset);
		const nonce = randomNonce();
		const signature = await computeSignature(state.key, method, signedPath(url), timestamp, nonce);
		return { [SIGNATURE_HEADERS.timestamp]: String(timestamp), [SIGNATURE_HEADERS.nonce]: nonce, [SIGNATURE_HEADERS.signature]: signature };
	}

	private ensureState(token: string, fetchKey: (token: string) => Promise<unknown>): Promise<SignerState | null> {
		const state = this.state;
		if (state && state.token === token && (state.expiresAt === 0 || this.now() + state.clockOffset < state.expiresAt - RENEW_BEFORE_MS)) {
			return Promise.resolve(state);
		}
		if (this.pending?.token === token) return this.pending.promise;
		const promise = this.fetchState(token, fetchKey).finally(() => {
			if (this.pending?.promise === promise) this.pending = null;
		});
		this.pending = { token, promise };
		return promise;
	}

	private async fetchState(token: string, fetchKey: (token: string) => Promise<unknown>): Promise<SignerState | null> {
		try {
			const answer = parseRequestKey(await fetchKey(token));
			if (!answer) return null;
			const state: SignerState = { token, key: await importSigningKey(answer.key), clockOffset: answer.serverTime - this.now(), expiresAt: answer.expiresAt };
			this.state = state;
			return state;
		} catch {
			return null;
		}
	}
}
