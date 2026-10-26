import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const port = 18000 + Math.floor(Math.random() * 1000);
const panelDir = mkdtempSync(path.join(tmpdir(), "homelab-panel-test-"));
cpSync(path.join(appRoot, "public"), path.join(panelDir, "public"), { recursive: true });
const env = {
  ...process.env,
  PANEL_DIR: panelDir,
  PANEL_HOST: "127.0.0.1",
  PANEL_PORT: String(port),
};

function stop(child) {
  if (!child.killed) child.kill("SIGTERM");
}

test("serves the login screen and enforces the password boundary", { timeout: 20000 }, async (t) => {
  const seed = spawnSync(process.execPath, ["server.js", "--set-password"], {
    cwd: appRoot,
    env,
    input: "test-password-123\n",
    encoding: "utf8",
  });
  assert.equal(seed.status, 0, seed.stderr || seed.stdout);

  const child = spawn(process.execPath, ["server.js"], {
    cwd: appRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  t.after(() => {
    stop(child);
    rmSync(panelDir, { recursive: true, force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch(`${base}/`);
      if (res.ok) break;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (i === 49) assert.fail(`server did not start:\n${output}`);
  }

  const root = await fetch(`${base}/`);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /id="login-password"/);

  assert.equal((await fetch(`${base}/api/session`)).status, 401);
  assert.equal(
    (await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    })).status,
    401,
  );

  const login = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password-123" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie?.startsWith("sid="), "login must set the session cookie");

  const session = await fetch(`${base}/api/session`, {
    headers: { cookie },
  });
  assert.equal(session.status, 200);
  assert.equal((await session.json()).authenticated, true);
});
