/**
 * Renders scenario results as the primary console report: one two-column
 * want/got line per scenario, a money annotation on rows that moved the
 * wallet, and a pass/fail/phantom-money summary.
 */
import { formatRupees, phantomTotal, walletDelta } from "./phantom.js";
import type { AssertionResult, ScenarioResult } from "./types.js";

const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
const paint = (code: string, text: string): string => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = (t: string): string => paint("32", t);
const red = (t: string): string => paint("31", t);
const yellow = (t: string): string => paint("33", t);
const dim = (t: string): string => paint("2", t);

/** The assertion a reader most wants to see: the first failure, else the first line. */
function headlineAssertion(result: ScenarioResult): AssertionResult | undefined {
  return result.assertions.find((a) => !a.pass) ?? result.assertions[0];
}

/** The `⚠ …` money annotation for a failing row, or "" when no wallet moved. */
function moneyAnnotation(result: ScenarioResult): string {
  const wallet = walletDelta(result);
  if (!wallet) return "";
  if (wallet.direction === "negative") return yellow(`  ⚠ NEGATIVE BALANCE (${formatRupees(wallet.delta)} destroyed)`);
  const verb = wallet.direction === "minted" ? `+${formatRupees(wallet.delta)} minted` : `${formatRupees(wallet.delta)} destroyed`;
  return yellow(`  ⚠ ${verb}`);
}

function formatLine(result: ScenarioResult, nameWidth: number): string {
  const mark = result.passed ? green("✓") : red("✗");
  const name = result.name.padEnd(nameWidth);
  const headline = headlineAssertion(result);
  if (!headline) return `  ${mark} ${name}`;

  const field = headline.field.padEnd(16);
  const want = `want ${headline.wantDisplay}`.padEnd(18);
  const got = `got ${headline.gotDisplay}`.padEnd(14);
  const body = `${field} ${want} ${result.passed ? got : red(got)}`;
  return `  ${mark} ${name}  ${dim(body)}${moneyAnnotation(result)}`;
}

/** Prints the full report and returns the number of failed scenarios. */
export function renderReport(
  version: string,
  target: string,
  results: ScenarioResult[],
  reportPath?: string,
): number {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const phantom = phantomTotal(results);
  const nameWidth = Math.max(0, ...results.map((r) => r.name.length));

  const lines: string[] = [];
  lines.push("");
  lines.push(`payfuzz v${version}  ${dim("·")}  target ${target}  ${dim("·")}  ${results.length} scenarios`);
  lines.push("");
  for (const result of results) lines.push(formatLine(result, nameWidth));
  lines.push("");

  const phantomText = `${formatRupees(phantom)} phantom money created`;
  lines.push(
    `  ${green(`${passed} passed`)} ${dim("·")} ${failed > 0 ? red(`${failed} failed`) : "0 failed"} ` +
      `${dim("·")} ${phantom > 0 ? yellow(phantomText) : phantomText}`,
  );
  if (reportPath) lines.push(`  ${dim("→")} ${reportPath}`);
  lines.push("");

  process.stdout.write(lines.join("\n") + "\n");
  return failed;
}
