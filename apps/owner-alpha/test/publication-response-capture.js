// Test-only capture: attach this promise BEFORE the UI action. Consume the body
// immediately on response delivery, before click/navigation completion or disk IO.
export function capturePublicationResponse(responsePromise) {
  return Promise.resolve(responsePromise).then(async (response) => {
    const status = response.status();
    try {
      const body = await response.json();
      return { status, body, bodyReadSucceeded: true, classification: null };
    } catch {
      return { status, body: undefined, bodyReadSucceeded: false, classification: 'response-body-read-failed' };
    }
  }, () => ({ status: null, body: undefined, bodyReadSucceeded: false, classification: 'response-not-observed' }));
}
