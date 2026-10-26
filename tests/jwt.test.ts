import { test } from "node:test";
import assert from "node:assert/strict";
import { isTokenExpired, readClaims, tokenExpiryMs, userIdFromToken } from "../src/jwt.ts";

function jwt(claims: object): string {
	const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
	return `${b64({ alg: "HS256" })}.${b64(claims)}.sig`;
}

test("readClaims decodes the payload and rejects garbage", () => {
	assert.deepEqual(readClaims(jwt({ userId: "7" })), { userId: "7" });
	assert.equal(readClaims("nope"), null);
	assert.equal(readClaims("a.%%%.c"), null);
});

test("userIdFromToken accepts the claim names the web app accepts", () => {
	assert.equal(userIdFromToken(jwt({ userId: "42" })), 42);
	assert.equal(userIdFromToken(jwt({ UserId: 5 })), 5);
	assert.equal(userIdFromToken(jwt({ sub: "9" })), 9);
	assert.equal(userIdFromToken(jwt({})), 0);
});

test("expiry helpers treat a token without exp as valid", () => {
	const now = 1_000_000_000_000;
	assert.equal(tokenExpiryMs(jwt({ exp: 2000 })), 2_000_000);
	assert.equal(isTokenExpired(jwt({ exp: now / 1000 + 10 }), 30, now), true);
	assert.equal(isTokenExpired(jwt({ exp: now / 1000 + 600 }), 30, now), false);
	assert.equal(isTokenExpired(jwt({}), 30, now), false);
});
