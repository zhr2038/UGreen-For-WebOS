/** The CLI can return exit 0 when evaluated browser code threw. */
export function playwrightStatus(result) {
  if (result.status) return result.status;
  const output = result.text ?? result.output ?? '';
  if (output.includes('### Error')) return 1;
  const start = output.indexOf('### Result'); if (start < 0) return 1;
  const end = output.indexOf('### Ran Playwright code', start);
  try {
    const report = JSON.parse(output.slice(start + '### Result'.length, end < 0 ? undefined : end).trim());
    return Number.isFinite(report?.failed) && report.failed > 0 ? 1 : 0;
  } catch { return 1; }
}
