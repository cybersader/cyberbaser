// Test the actual quickstart preview command. No external browser requests.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
const [sites, single] = process.argv.slice(2);
if (!sites || (single && !['quartz','solid'].includes(single))) throw Error('usage: node docs/starter-tests/readers.mjs <fixture-sites> [quartz|solid]');
const browser = await chromium.launch();
try {
  for (const kind of single ? [single] : ['quartz','solid']) {
    const root = path.resolve(sites,kind);
    const server = spawn('python3',['-I','starters/preview.py',root,'--port','0'],{stdio:['ignore','pipe','inherit']});
    const closed = once(server,'close');
    try {
      const first = await Promise.race([once(server.stdout,'data'),closed.then(()=>{ throw Error('Preview did not start'); })]);
      const origin = String(first[0]).match(/http:\/\/127\.0\.0\.1:\d+/)[0];
      for (const width of [390,1280]) {
        const context = await browser.newContext({viewport:{width,height:840},serviceWorkers:'block'});
        await context.route('**/*',route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
        const page = await context.newPage();
        await page.goto(origin);
        const link = page.getByRole('link',{name:'tide pool field note',exact:true});
        await link.click({timeout:10000});
        await page.getByText('Look for anemones on the sheltered side of the rock.',{exact:false}).first().waitFor();
        await page.waitForFunction(()=>document.querySelector('img[alt="Tide pool marker"]')?.naturalWidth > 0);
        assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth+1),'page overflows viewport');
        console.log(`${kind}: ${width}px home → note → decoded image`);
        await context.close();
      }
    } finally { server.kill(); await closed; }
  }
} finally { await browser.close(); }
