/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require("fs");
const path = require("path");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith("#") && line.includes("="))
    .reduce((acc, line) => {
      const index = line.indexOf("=");
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim();
      acc[key] = value;
      return acc;
    }, {});
}

function loadReleaseId() {
  const filePath = path.join(__dirname, ".release-id");
  if (!fs.existsSync(filePath)) return "local";
  return fs.readFileSync(filePath, "utf8").trim() || "local";
}

const canary = process.env.KTS_PM2_CANARY === "1";

module.exports = {
  apps: [
    {
      name: canary ? "kts-next-admin-canary" : "kts-next-admin",
      cwd: __dirname,
      script: "server.js",
      interpreter: "node",
      exec_mode: canary ? "fork" : "cluster",
      instances: canary ? 1 : 2,
      instance_var: "KTS_INSTANCE_ID",
      merge_logs: true,
      log_date_format: "YYYY-MM-DDTHH:mm:ss.SSSZ",
      listen_timeout: 30_000,
      kill_timeout: 30_000,
      min_uptime: "10s",
      max_restarts: 10,
      restart_delay: 1_000,
      exp_backoff_restart_delay: 100,
      max_memory_restart: "900M",
      node_args: "--max-old-space-size=768",
      env: {
        ...loadEnvFile(path.join(__dirname, ".env.local")),
        APP_RELEASE_ID: loadReleaseId(),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        PORT: canary ? (process.env.KTS_PM2_PORT || "3001") : "3000",
        TOP_DASHBOARD_DATA_DIR: path.join(__dirname, "runtime-data", "top-dashboard"),
      },
    },
  ],
};
