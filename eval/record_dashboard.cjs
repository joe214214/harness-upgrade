// Record one synthetic screen recording: a monitoring dashboard whose clock
// ticks every second, a metric that changes once, and one alert banner that
// is visible for `alertSeconds`. Prints nothing about the alert content;
// the caller already knows it.
// Usage: node record_dashboard.cjs <outDir> <alertCode> <alertAt> <alertSeconds> <metricAt> <duration>
const { chromium } = require('playwright')

const [outDir, code, alertAt, alertSeconds, metricAt, duration] = process.argv.slice(2)

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
body{margin:0;font:18px system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
header{display:flex;justify-content:space-between;padding:18px 28px;background:#1e293b}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;padding:28px}
.card{background:#1e293b;border-radius:10px;padding:18px;height:120px}
.v{font-size:34px;font-weight:700;margin-top:14px}
#alert{display:none;position:absolute;left:28px;right:28px;bottom:28px;background:#b91c1c;color:#fff;
  padding:18px 22px;border-radius:10px;font:600 26px ui-monospace,monospace}
</style></head><body>
<header><b>Payments monitor</b><span id="clock"></span></header>
<main>
 <div class="card">Requests / min<div class="v">1,284</div></div>
 <div class="card">p99 latency<div class="v" id="lat">212 ms</div></div>
 <div class="card">Error rate<div class="v">0.02%</div></div>
 <div class="card">Queue depth<div class="v">17</div></div>
 <div class="card">Workers<div class="v">8 / 8</div></div>
 <div class="card">Region<div class="v">eu-west-1</div></div>
</main>
<div id="alert"></div>
<script>
const t0 = Date.now()
setInterval(() => { document.getElementById('clock').textContent = new Date(Date.UTC(2026,9,30,9,0,Math.floor((Date.now()-t0)/1000))).toISOString().slice(11,19) + ' UTC' }, 200)
</script></body></html>`

;(async () => {
  const browser = await chromium.launch()
  const context = await browser.newContext({ viewport: { width: 960, height: 540 }, recordVideo: { dir: outDir, size: { width: 960, height: 540 } } })
  const page = await context.newPage()
  await page.setContent(html)
  const t0 = Date.now()
  const at = (s) => page.waitForTimeout(Math.max(0, s * 1000 - (Date.now() - t0)))
  const events = [
    [Number(metricAt), () => page.evaluate(() => { document.getElementById('lat').textContent = '348 ms' })],
    [Number(alertAt), () => page.evaluate((c) => { const a = document.getElementById('alert'); a.textContent = 'ALERT ' + c + ': settlement batch rejected'; a.style.display = 'block' }, code)],
    [Number(alertAt) + Number(alertSeconds), () => page.evaluate(() => { document.getElementById('alert').style.display = 'none' })],
  ].sort((a, b) => a[0] - b[0])
  for (const [time, fn] of events) { await at(time); await fn() }
  await at(Number(duration))
  const video = page.video()
  await context.close(); await browser.close()
  process.stdout.write(await video.path())
})()
