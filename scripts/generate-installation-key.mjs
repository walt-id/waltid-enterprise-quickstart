#!/usr/bin/env node
// Generates an installation key for LICENSE_INSTALLATION_KEY_FILE: a P-256 private key in the
// serialized walt.id format ({"type":"jwk","jwk":{...}}), written to stdout.
// It is a private key: keep it in your secret manager, never commit it, never send it to walt.id.
import { createHash, generateKeyPairSync } from "node:crypto";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const { kty, crv, x, y, d } = privateKey.export({ format: "jwk" });

// RFC 7638 thumbprint, the key ID walt.id derives for this key. It becomes the installationId.
const kid = createHash("sha256").update(JSON.stringify({ crv, kty, x, y })).digest("base64url");

process.stdout.write(JSON.stringify({ type: "jwk", jwk: { kty, crv, kid, x, y, d } }, null, 2) + "\n");
