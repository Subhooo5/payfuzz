#!/usr/bin/env node
/**
 * payfuzz CLI.
 *
 *   payfuzz run --target http://localhost:4242 [--scenarios <dir>] [--fixtures <dir>] [--out <path>] [--ci]
 *
 * Loads every scenario in the directory, replays each under adversarial
 * delivery against the target, prints the two-column report, and writes a
 * self-contained HTML report. With --ci it exits 1 if any scenario failed.
 */
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { getWebhookSecret } from "./config.js";
import { renderReport } from "./console.js";
import { loadGlobals, loadScenario } from "./loader.js";
import { renderHtml } from "./report-html.js";
import { runScenario } from "./runner.js";
import type { Globals, ScenarioResult } from "./types.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

/** Package root (one level above dist/cli.js) — where bundled scenarios/fixtures live. */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Resolves a scenarios/fixtures directory. Uses the given path if it exists
 * relative to the current directory (running inside the repo); otherwise falls
 * back to the copy shipped in the package, so `npx payfuzz run --target <url>`
 * uses the built-in 8-scenario suite against the caller's own app.
 */
function resolveBundledDir(dir: string): string {
  const local = resolve(dir);
  if (existsSync(local)) return local;
  const bundled = join(packageRoot, dir);
  if (existsSync(bundled)) return bundled;
  return local; // let the downstream error name the missing directory
}

/** Scenario files, sorted by name; _globals is loaded separately. */
function scenarioFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f) && !f.startsWith("_globals"))
    .sort()
    .map((f) => join(dir, f));
}

function loadGlobalsIfPresent(dir: string): Globals {
  const path = join(dir, "_globals.yaml");
  return existsSync(path) ? loadGlobals(path) : { global_invariants: {} };
}

const program = new Command();
program.name("payfuzz").version(version);

program
  .command("run")
  .description("replay scenarios against a target webhook handler")
  .requiredOption("--target <url>", "base URL of the app under test")
  .option("--scenarios <dir>", "directory of scenario YAML files", "scenarios")
  .option("--fixtures <dir>", "directory of Stripe event fixtures", "fixtures")
  .option("--out <path>", "path for the HTML report", "payfuzz-report.html")
  .option("--ci", "exit 1 if any scenario failed (for use as a merge gate)", false)
  .action(async (options: { target: string; scenarios: string; fixtures: string; out: string; ci: boolean }) => {
    const secret = getWebhookSecret();
    const scenariosDir = resolveBundledDir(options.scenarios);
    const fixturesDir = resolveBundledDir(options.fixtures);
    const globals = loadGlobalsIfPresent(scenariosDir);

    const results: ScenarioResult[] = [];
    for (const file of scenarioFiles(scenariosDir)) {
      const scenario = loadScenario(file);
      results.push(await runScenario(scenario, globals, { target: options.target, secret, fixturesDir }));
    }

    const reportPath = resolve(options.out);
    writeFileSync(reportPath, renderHtml(version, options.target, results));

    const failed = renderReport(version, options.target, results, reportPath);
    if (options.ci && failed > 0) process.exit(1);
  });

program.parseAsync().catch((err: Error) => {
  process.stderr.write(`payfuzz: ${err.message}\n`);
  process.exit(1);
});
