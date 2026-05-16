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

module.exports = {
  apps: [
    {
      name: "kts-next-admin",
      cwd: __dirname,
      script: "server.js",
      interpreter: "node",
      env: {
        ...loadEnvFile(path.join(__dirname, ".env.local")),
        HOSTNAME: "127.0.0.1",
        NODE_ENV: "production",
        PORT: "3000",
      },
    },
  ],
};
