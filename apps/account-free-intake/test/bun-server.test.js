import { expect, test } from 'bun:test';
import { openIntakeService, startBunServer } from '../src/server.js';
import { createFixture, FORM_ORIGIN } from './helpers.js';

test('serves the exact public boundary through Bun.serve', async () => {
  const fixture = await createFixture();
  const service = await openIntakeService({ config: fixture.config });
  const server = startBunServer({
    config: { ...fixture.config, listen: { host: '127.0.0.1', port: 0 } },
    service,
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/corrections`, {
      method: 'OPTIONS',
      headers: {
        Host: 'intake.example',
        Origin: FORM_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(FORM_ORIGIN);
  } finally {
    server.stop(true);
    await service.close();
    await fixture.cleanup();
  }
});
