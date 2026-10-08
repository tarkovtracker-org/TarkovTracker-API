import { execFileSync } from "node:child_process";

const pnpmCli = process.env.npm_execpath;
if (!pnpmCli)
  throw new Error(
    "Run the contract test watcher through pnpm run watch:tests.",
  );

// Consumer test paths belong to the caller; always watch every contract test here.
try {
  execFileSync(
    process.execPath,
    [pnpmCli, "--parallel", "run", "/^(dev:watch|vitest:watch)$/"],
    { stdio: "inherit", windowsHide: true },
  );
} catch (error) {
  process.exit(typeof error.status === "number" ? error.status : 1);
}
