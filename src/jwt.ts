/** Decodes base64url (with or without padding) to a binary string, as `atob` does for base64. */
export function base64UrlDecode(text: string): string {
	const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
	return atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
}

/** Reads the payload of a JWT without verifying it; the server is the only party that validates tokens. */
export function readClaims(token: string): Record<string, unknown> | null {
	const payload = token.split(".")[1];
	if (!payload) return null;
	try {
		const parsed: unknown = JSON.parse(base64UrlDecode(payload));
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

/** Expiry of the token in epoch milliseconds, or 0 when it carries none. */
export function tokenExpiryMs(token: string): number {
	const exp = Number(readClaims(token)?.exp ?? 0);
	return exp > 0 ? exp * 1000 : 0;
}

/** Whether the token is expired or will be within `skewSeconds`. */
export function isTokenExpired(token: string, skewSeconds = 30, now = Date.now()): boolean {
	const expiry = tokenExpiryMs(token);
	return expiry > 0 && expiry <= now + skewSeconds * 1000;
}

/** User id claim, named differently across KDM versions. */
export function userIdFromToken(token: string): number {
	const claims = readClaims(token);
	if (!claims) return 0;
	return Number(claims.userId ?? claims.UserId ?? claims.sub ?? 0) || 0;
}
