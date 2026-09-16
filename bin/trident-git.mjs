#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const DEFAULT_PORT = 3100;

function printHelp() {
  console.log(`Usage: trident-git [options]

Options:
  -p, --port <port>  Port to run on (default: 3100)
  --dev              Run in development mode
  -h, --help         Show this help message
`);
}

function parseArgs(argv) {
  const options = {
    mode: "start",
    port: undefined,
    portExplicit: false,
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

    throw new Error(`Unknown option: ${arg}`);
  }

  return options;
}

function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(startPort, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i += 1) {
    const candidate = startPort + i;
    const available = await checkPortAvailable(candidate);
    if (available) {
      return candidate;
    }
  }
  throw new Error(`Could not find an available port in range ${startPort}-${startPort + maxAttempts - 1}.`);
}

function ensureBuildExists() {
  const clientIndexPath = path.join(APP_ROOT, "dist", "client", "index.html");
  if (!fs.existsSync(clientIndexPath)) {
    throw new Error(
      "No production build found (dist/client/index.html is missing). Run 'npm run build' first.",
    );
  }
}

function runServer(port, isDev = false) {
  return new Promise((resolve, reject) => {
    const tsxCli = path.join(APP_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const serverEntry = path.join(APP_ROOT, "server", "index.ts");
    
    if (isDev) {
      const child = spawn("npm", ["run", "dev"], {
        cwd: APP_ROOT,
        stdio: "inherit",
        env: {
          ...process.env,
          PORT: String(port),
        },
      });
      child.on("error", reject);
      child.on("exit", (code, signal) => {
        if (signal) {
          process.kill(process.pid, signal);
          return;
        }
        resolve(code === null ? 1 : code);
      });
      return;
    }

    const child = spawn(process.execPath, [tsxCli, serverEntry], {
      cwd: APP_ROOT,
      stdio: "inherit",
      env: {
        ...process.env,
        PORT: String(port),
        RUN_STANDALONE: "true",
      },
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code === null ? 1 : code);
    });
  });
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const envPort = Number.parseInt(process.env.PORT || "", 10);
    const preferredPort =
      options.port ??
      (Number.isInteger(envPort) && envPort > 0 && envPort <= 65535 ? envPort : DEFAULT_PORT);

    let port = preferredPort;
    if (!options.portExplicit && !process.env.PORT) {
      port = await findAvailablePort(preferredPort);
      if (port !== preferredPort) {
        console.log(`Port ${preferredPort} is in use. Using ${port} instead.`);
      }
    }

    if (options.mode === "dev") {
      console.log(`Starting trident in development mode on http://localhost:${port}`);
      process.exit(await runServer(port, true));
    }

    ensureBuildExists();
    console.log(`Starting trident on http://localhost:${port}`);
    process.exit(await runServer(port, false));
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error(`trident-git failed to start: ${errorMessage}`);
    process.exit(1);
  }
}

main();
