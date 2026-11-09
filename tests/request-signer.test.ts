import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
	computeSignature,
	importSigningKey,
	isSignatureRejection,
	parseRequestKey,
	RequestSigner,
	SIGNATURE_HEADERS,
	signedPath,
} from "../src/request-signer.ts";

const RAW_KEY = Buffer.from("0123456789abcdef0123456789abcdef");
const KEY = RAW_KEY.toString("base64url");

/** The signature as the server computes it, with Node's own HMAC. */
function expected(method: string, path: string, ts: number, nonce: string): string {
	return createHmac("sha256", RAW_KEY).update(`${method}\n${path}\n${ts}\n${nonce}`).digest("base64url");
}

test("computeSignature matches HMAC-SHA256 over METHOD, path, timestamp and nonce, base64url without padding", async () => {
	const key = await importSigningKey(KEY);
	const signature = await computeSignature(key, "patch", "/api/UserJobDefinition", 1700000000000, "ab".repeat(16));
	assert.equal(signature, expected("PATCH", "/api/UserJobDefinition", 1700000000000, "ab".repeat(16)));
	assert.doesNotMatch(signature, /[=+/]/);
});

test("signedPath drops the query and decodes the path", () => {
	assert.equal(signedPath("https://kdm.example.com/api/UserJobDefinition/GetMyTask?userId=3&startDate=2026"), "/api/UserJobDefinition/GetMyTask");
	assert.equal(signedPath("https://kdm.example.com/api/A%20B"), "/api/A B");
	assert.equal(signedPath("https://kdm.example.com/api/%E0%A4%A"), "/api/%E0%A4%A");
});

test("parseRequestKey reads either casing and refuses answers without a key", () => {
	assert.deepEqual(parseRequestKey({ key: "k", serverTime: 5, expiresAt: 9 }), { key: "k", serverTime: 5, expiresAt: 9 });
	assert.equal(parseRequestKey({ Key: "k", ServerTime: 1, ExpiresAt: 2 })?.key, "k");
	assert.equal(parseRequestKey({}), null);
	assert.equal(parseRequestKey(null), null);
});

test("isSignatureRejection only matches a 403 with the signature error code", () => {
	assert.equal(isSignatureRejection(403, { error: { code: "REQUEST_SIGNATURE_INVALID" } }), true);
	assert.equal(isSignatureRejection(403, { Error: { Code: "REQUEST_SIGNATURE_INVALID" } }), true);
	assert.equal(isSignatureRejection(403, { error: { code: "FORBIDDEN" } }), false);
	assert.equal(isSignatureRejection(401, { error: { code: "REQUEST_SIGNATURE_INVALID" } }), false);
	assert.equal(isSignatureRejection(403, null), false);
});

test("RequestSigner signs with the server clock and fetches the key once per token", async () => {
	let now = 1_000_000;
	const signer = new RequestSigner(() => now);
	const fetched: string[] = [];
	const fetchKey = async (token: string) => {
		fetched.push(token);
		return { key: KEY, serverTime: now + 5000, expiresAt: now + 3_600_000 };
	};
	const headers = await signer.headers("GET", "https://kdm.example.com/api/LoginUser?x=1", "t1", fetchKey);
	const ts = Number(headers[SIGNATURE_HEADERS.timestamp]);
	assert.equal(ts, now + 5000);
	assert.match(headers[SIGNATURE_HEADERS.nonce]!, /^[0-9a-f]{32}$/);
	assert.equal(headers[SIGNATURE_HEADERS.signature], expected("GET", "/api/LoginUser", ts, headers[SIGNATURE_HEADERS.nonce]!));

	now += 1000;
	await signer.headers("POST", "https://kdm.example.com/api/X", "t1", fetchKey);
	assert.deepEqual(fetched, ["t1"]);
	// A new access token gets its own key.
	await signer.headers("POST", "https://kdm.example.com/api/X", "t2", fetchKey);
	assert.deepEqual(fetched, ["t1", "t2"]);
	// Close to expiry the key is renewed.
	now += 3_600_000;
	await signer.headers("POST", "https://kdm.example.com/api/X", "t2", fetchKey);
	assert.equal(fetched.length, 3);
	signer.invalidate();
	await signer.headers("POST", "https://kdm.example.com/api/X", "t2", fetchKey);
	assert.equal(fetched.length, 4);
});

test("RequestSigner sends no signature when no key can be had", async () => {
	const signer = new RequestSigner();
	assert.deepEqual(await signer.headers("GET", "https://kdm.example.com/api/X", "t", async () => null), {});
	assert.deepEqual(await signer.headers("GET", "https://kdm.example.com/api/X", "t", async () => { throw new Error("offline"); }), {});
});
