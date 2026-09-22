#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const require = createRequire(import.meta.url);
const NEXT_BIN = require.resolve("next/dist/bin/next");
const DEFAULT_PORT = 3100;

// Tailscale assigns addresses from the CGNAT range 100.64.0.0/10.
function isTailscaleIP(ip) {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4) return false;
  const [a, b] = parts;
  return a === 100 && b >= 64 && b <= 127;
}

function resolveHost() {
  if (process.env.HOST) return process.env.HOST;
  if (process.env.HOSTNAME) return process.env.HOSTNAME;
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal && isTailscaleIP(addr.address)) {
        return addr.address;
      }
    }
  }
  return "127.0.0.1";
}

function printHelp() {
  console.log(`Usage: trident-git [options]

Options:
  -p, --port <port>  Port to run on (default: 3100)
  -H, --host <host>  Host to bind to (defaults to Tailscale IP, fallback 127.0.0.1)
  --dev              Run in development mode
  -h, --help         Show this help message
`);
}

function parseArgs(argv) {
  const options = {
    mode: "start",
    port: undefined,
    portExplicit: false,
    host: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }

    if (arg === "--dev") {
      options.mode = "dev";
      continue;
    }

    if (arg === "--port" || arg === "-p") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --port.");
      }
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw new Error(`Invalid port: ${value}`);
      }
      options.port = parsed;
      options.portExplicit = true;
      i += 1;
      continue;
    }

    if (arg === "--host" || arg === "-H") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("Missing value for --host.");
      }
      options.host = value;
      i += 1;
      continue;
    }

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function checkPortAvailable(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, host);
  });
}

async function findAvailablePort(startPort, host = "127.0.0.1", maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = startPort + i;
    const available = await checkPortAvailable(candidate, host);
    if (available) {
      return candidate;
    }
  }
  throw new Error(`Could not find an available port in range ${startPort}-${startPort + maxAttempts - 1}.`);
}

function runScript(scriptPath, args = [], envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      cwd: APP_ROOT,
      stdio: "inherit",
      env: { ...process.env, ...envOverrides },
    });

    const cleanup = () => {
      try {
        child.kill("SIGTERM");
      } catch {}
    };
    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);
    process.on("exit", cleanup);

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      process.removeListener("SIGINT", cleanup);
      process.removeListener("SIGTERM", cleanup);
      process.removeListener("exit", cleanup);
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

function ensureBuildExists() {
  const buildIdPath = path.join(APP_ROOT, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    throw new Error(
      "No production build found in this package (.next/BUILD_ID is missing). The npm package must be published with prebuilt assets.",
    );
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const host = options.host || resolveHost();
    const envPort = Number.parseInt(process.env.PORT || "", 10);
    const preferredPort =
      options.port ??
      (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : DEFAULT_PORT);

    let port = preferredPort;
    if (!options.portExplicit && !process.env.PORT) {
      port = await findAvailablePort(preferredPort, host);
      if (port !== preferredPort) {
        console.log(`Port ${preferredPort} is in use. Using ${port} instead.`);
      }
    }

    const nextEnv = {
      HOST: host,
      HOSTNAME: host,
      PORT: String(port),
    };

    if (options.mode === "dev") {
      console.log(`Starting trident-git in development mode on http://${host}:${port}`);
      process.exit(await runScript(NEXT_BIN, ["dev", "--webpack", "-p", String(port), "-H", host], nextEnv));
    }

    ensureBuildExists();
    const standaloneScript = path.join(APP_ROOT, ".next", "standalone", "server.js");
    if (fs.existsSync(standaloneScript)) {
      console.log(`Starting trident-git on http://${host}:${port}`);
      process.exit(await runScript(standaloneScript, [], nextEnv));
    }

    console.log(`Starting trident-git on http://${host}:${port}`);
    process.exit(await runScript(NEXT_BIN, ["start", "-p", String(port), "-H", host], nextEnv));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`trident-git failed to start: ${errorMessage}`);
    process.exit(1);
  }
}

main();
