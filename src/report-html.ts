/**
 * Renders the run as one self-contained HTML file: inlined CSS, no framework,
 * no CDN, no JavaScript. Everything the console compresses into one headline
 * line is shown in full here — every assertion (scenario and global), the whole
 * delivery timeline including duplicates and timeout resends, and the
 * phantom-money delta per scenario.
 */
import { formatRupees, phantomTotal, walletDelta } from "./phantom.js";
import type { AssertionResult, ScenarioResult, Trace } from "./types.js";

/** Escapes text for safe interpolation into HTML — no XSS holes even locally. */
function esc(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function statusLabel(status: Trace["status"]): string {
  if (status === "timeout") return '<span class="bad">TIMEOUT (aborted)</span>';
  if (status === "error") return '<span class="bad">ERROR</span>';
  const cls = status >= 200 && status < 300 ? "ok" : "bad";
  return `<span class="${cls}">${status}</span>`;
}

function renderTimeline(traces: Trace[]): string {
  if (traces.length === 0) return '<p class="empty">no deliveries (rejected before dispatch)</p>';
  const origin = Math.min(...traces.map((t) => t.sentAt));

  const rows = traces
    .map((trace) => {
      const offset = trace.sentAt - origin;
      const resend = trace.attempt > 1 ? '<span class="tag">RESEND</span>' : "";
      const body = trace.responseBody ? `<span class="body">${esc(trace.responseBody.slice(0, 80))}</span>` : "";
      return `<li>
        <code>t=${offset}ms</code>
        <code class="evt">${esc(trace.eventId)}</code>
        <span class="type">${esc(trace.eventType)}</span>
        <span class="arrow">→</span> ${statusLabel(trace.status)}
        <span class="lat">(${trace.latencyMs}ms)</span> ${resend} ${body}
      </li>`;
    })
    .join("\n");
  return `<ul class="timeline">${rows}</ul>`;
}

function renderAssertions(assertions: AssertionResult[]): string {
  const rows = assertions
    .map((a) => {
      const cls = a.pass ? "ok" : "bad";
      const mark = a.pass ? "✓" : "✗";
      return `<tr class="${cls}">
        <td><span class="src src-${a.source}">${a.source}</span></td>
        <td class="field">${esc(a.field)}</td>
        <td>${esc(a.wantDisplay)}</td>
        <td>${esc(a.gotDisplay)}</td>
        <td class="mark">${mark}</td>
      </tr>`;
    })
    .join("\n");
  return `<table class="asserts">
    <thead><tr><th>source</th><th>field</th><th>want</th><th>got</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function renderScenario(result: ScenarioResult): string {
  const cls = result.passed ? "pass" : "fail";
  const mark = result.passed ? "✓" : "✗";
  const wallet = walletDelta(result);
  const deltaLine = wallet
    ? `<p class="delta ${wallet.direction}">⚠ ${
        wallet.direction === "minted"
          ? `${formatRupees(wallet.delta)} minted`
          : wallet.direction === "negative"
            ? `negative balance — ${formatRupees(wallet.delta)} destroyed`
            : `${formatRupees(wallet.delta)} destroyed`
      }</p>`
    : "";

  return `<section class="scenario ${cls}">
    <h2><span class="badge ${cls}">${mark} ${cls.toUpperCase()}</span> ${esc(result.name)}</h2>
    <p class="desc">${esc(result.description)}</p>
    ${deltaLine}
    <h3>Assertions</h3>
    ${renderAssertions(result.assertions)}
    <h3>Delivery timeline</h3>
    ${renderTimeline(result.traces)}
  </section>`;
}

const STYLE = `
  :root { color-scheme: light dark; --bg:#fff; --fg:#1a1a2e; --muted:#6b7280; --line:#e5e7eb;
    --card:#fafafa; --ok:#15803d; --bad:#b91c1c; --warn:#b45309; --accent:#4f46e5; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1117; --fg:#e6e6ef; --muted:#9299a6;
    --line:#252a36; --card:#161a23; --ok:#4ade80; --bad:#f87171; --warn:#fbbf24; --accent:#818cf8; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:2rem; background:var(--bg); color:var(--fg);
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif; }
  code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; }
  header { max-width:900px; margin:0 auto 2rem; }
  h1 { margin:0; font-size:1.6rem; }
  .meta { color:var(--muted); margin-top:.25rem; }
  .summary { display:flex; gap:.75rem; flex-wrap:wrap; margin-top:1rem; }
  .stat { padding:.4rem .8rem; border-radius:.5rem; border:1px solid var(--line); font-weight:600; }
  .stat.pass { color:var(--ok); } .stat.fail { color:var(--bad); } .stat.phantom { color:var(--warn); }
  main { max-width:900px; margin:0 auto; display:flex; flex-direction:column; gap:1.25rem; }
  .scenario { border:1px solid var(--line); border-left:4px solid var(--line); border-radius:.6rem;
    padding:1rem 1.25rem; background:var(--card); }
  .scenario.pass { border-left-color:var(--ok); } .scenario.fail { border-left-color:var(--bad); }
  .scenario h2 { font-size:1.1rem; margin:.2rem 0 .3rem; display:flex; align-items:center; gap:.5rem; }
  .badge { font-size:.7rem; padding:.15rem .5rem; border-radius:.4rem; font-weight:700; }
  .badge.pass { background:color-mix(in srgb,var(--ok) 18%,transparent); color:var(--ok); }
  .badge.fail { background:color-mix(in srgb,var(--bad) 18%,transparent); color:var(--bad); }
  .desc { color:var(--muted); margin:.2rem 0 .6rem; }
  .delta { font-weight:600; margin:.4rem 0; color:var(--warn); }
  h3 { font-size:.75rem; text-transform:uppercase; letter-spacing:.05em; color:var(--muted);
    margin:1rem 0 .4rem; }
  table.asserts { width:100%; border-collapse:collapse; font-size:13px; }
  .asserts th { text-align:left; color:var(--muted); font-weight:600; padding:.3rem .5rem;
    border-bottom:1px solid var(--line); }
  .asserts td { padding:.3rem .5rem; border-bottom:1px solid var(--line); vertical-align:top; }
  .asserts .field { font-family:ui-monospace,monospace; }
  .asserts tr.bad .mark { color:var(--bad); } .asserts tr.ok .mark { color:var(--ok); }
  .mark { font-weight:700; text-align:center; }
  .src { font-size:.65rem; text-transform:uppercase; padding:.1rem .35rem; border-radius:.3rem;
    background:color-mix(in srgb,var(--muted) 20%,transparent); color:var(--muted); }
  .src-global { background:color-mix(in srgb,var(--accent) 18%,transparent); color:var(--accent); }
  ul.timeline { list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:.3rem; }
  ul.timeline li { padding:.35rem .55rem; background:color-mix(in srgb,var(--muted) 8%,transparent);
    border-radius:.4rem; font-size:13px; overflow-x:auto; white-space:nowrap; }
  .timeline .evt { color:var(--accent); } .timeline .type { color:var(--muted); }
  .timeline .lat { color:var(--muted); } .timeline .arrow { color:var(--muted); }
  .ok { color:var(--ok); font-weight:600; } .bad { color:var(--bad); font-weight:600; }
  .tag { font-size:.65rem; font-weight:700; color:var(--warn); border:1px solid var(--warn);
    padding:.05rem .3rem; border-radius:.3rem; }
  .body { color:var(--muted); font-family:ui-monospace,monospace; }
  .empty { color:var(--muted); font-style:italic; }
`;

/** Builds the complete HTML document for a run. */
export function renderHtml(version: string, target: string, results: ScenarioResult[]): string {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;
  const phantom = phantomTotal(results);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>payfuzz report — ${esc(target)}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <h1>payfuzz report</h1>
  <div class="meta mono">v${esc(version)} · target ${esc(target)} · ${results.length} scenarios</div>
  <div class="summary">
    <span class="stat pass">${passed} passed</span>
    <span class="stat fail">${failed} failed</span>
    <span class="stat phantom">${esc(formatRupees(phantom))} phantom money</span>
  </div>
</header>
<main>
${results.map(renderScenario).join("\n")}
</main>
</body>
</html>
`;
}
