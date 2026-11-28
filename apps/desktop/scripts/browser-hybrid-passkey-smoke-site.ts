import assert from "node:assert/strict";
import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

/** The phone creates its test passkey for a fresh RP. Challenges and public keys live for this run only. */
export async function startPasskeyTestSite() {
  const host = `synara-passkey-${randomBytes(8).toString("hex")}.localhost`;
  const rpHash = createHash("sha256").update(host).digest();
  const register = randomBytes(32);
  const authenticate = randomBytes(32);
  let origin = "";
  let credential: { id: string; key: ReturnType<typeof createPublicKey> } | undefined;
  const cookie = `synara_phone_test=${randomBytes(32).toString("hex")}`;
  let verified = false;
  let signedIn = false;
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    if (request.headers.host !== new URL(origin).host) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "GET" && request.url === "/account") {
      if (!verified || !request.headers.cookie?.split(/;\s*/u).includes(cookie)) {
        response.writeHead(401).end();
        return;
      }
      signedIn = true;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(
        '<!doctype html><title>Synara test account</title><h1 id="signed-in">Signed in with your test passkey</h1>',
      );
      return;
    }
    if (request.method === "GET" && request.url === "/") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.setHeader(
        "Content-Security-Policy",
        "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
      );
      response.end(`<!doctype html><meta charset="utf-8"><title>Synara phone passkey test</title>
        <h1>Phone passkey test</h1><p>Register a disposable passkey on your phone. Then sign in with it to verify its signature. You may delete the test passkey from your phone afterward.</p>
        <button id="action">Register test passkey</button><p id="status"></p>
        <script>
        let saved;
        const bytes = buffer => [...new Uint8Array(buffer)];
        const button = document.querySelector('#action');
        button.onclick = async () => {
          button.disabled = true;
          const status = document.querySelector('#status');
          status.textContent = 'Waiting for your phone…';
          try {
            const common = {timeout:180000, hints:['hybrid']};
            const result = saved
              ? await navigator.credentials.get({publicKey:{...common,rpId:location.hostname,challenge:new Uint8Array(${JSON.stringify([...authenticate])}), allowCredentials:[{type:'public-key',id:saved,transports:['hybrid']}],userVerification:'required'}})
              : await navigator.credentials.create({publicKey:{...common,rp:{id:location.hostname,name:'Synara phone smoke'},user:{id:crypto.getRandomValues(new Uint8Array(16)),name:'synara-test',displayName:'Synara phone test'},challenge:new Uint8Array(${JSON.stringify([...register])}),pubKeyCredParams:[{type:'public-key',alg:-7}],authenticatorSelection:{authenticatorAttachment:'cross-platform',residentKey:'required',userVerification:'required'},attestation:'none'}});
            const r = result.response;
            const proof = {id:result.id,client:bytes(r.clientDataJSON),auth:bytes(saved?r.authenticatorData:r.getAuthenticatorData()),...(saved?{signature:bytes(r.signature)}:{key:bytes(r.getPublicKey())})};
            const reply = await fetch(saved?'/assert':'/register',{method:'POST',body:JSON.stringify(proof)});
            if(!reply.ok) throw new Error('Verification failed');
            if(saved) { location.assign('/account'); return; }
            saved = result.rawId;
            button.textContent = 'Verify with phone';
            status.textContent = 'Registration verified. Select Verify with phone to sign in.';
          } catch(e) { status.textContent = 'The request did not complete. You can retry.'; }
          button.disabled = false;
        };
        </script>`);
      return;
    }
    if (
      request.method !== "POST" ||
      request.headers.origin !== origin ||
      !["/register", "/assert"].includes(request.url ?? "")
    ) {
      response.writeHead(403).end();
      return;
    }
    try {
      let body = "";
      for await (const chunk of request) {
        body += chunk;
        assert.ok(body.length < 32768);
      }
      const proof = JSON.parse(body);
      const registration = request.url === "/register";
      const clientBytes = Buffer.from(proof.client);
      const client = JSON.parse(clientBytes.toString());
      const auth = Buffer.from(proof.auth);
      assert.ok(client.origin === origin && !client.crossOrigin);
      assert.ok(client.type === (registration ? "webauthn.create" : "webauthn.get"));
      assert.ok(
        client.challenge === (registration ? register : authenticate).toString("base64url"),
      );
      assert.ok(auth.length >= 37 && auth.subarray(0, 32).equals(rpHash) && (auth[32]! & 5) === 5);
      if (registration) {
        assert.ok((auth[32]! & 64) !== 0 && auth.length > 55);
        const idSize = auth.readUInt16BE(53);
        assert.ok(
          idSize > 0 &&
            55 + idSize < auth.length &&
            auth.subarray(55, 55 + idSize).toString("base64url") === proof.id,
        );
        credential = {
          id: proof.id,
          key: createPublicKey({ key: Buffer.from(proof.key), format: "der", type: "spki" }),
        };
      } else {
        assert.ok(!verified && credential && credential.id === proof.id);
        assert.ok(
          verify(
            "sha256",
            Buffer.concat([auth, createHash("sha256").update(clientBytes).digest()]),
            credential.key,
            Buffer.from(proof.signature),
          ),
        );
        verified = true;
        response.setHeader("Set-Cookie", `${cookie}; HttpOnly; SameSite=Strict; Path=/account`);
      }
      response.writeHead(204).end();
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://${host}:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    registered: () => !!credential,
    signedIn: () => signedIn,
    close: () => server.close(),
  };
}
