(() => {
  const input = document.querySelector('#owner-bootstrap-token');
  const button = document.querySelector('#owner-bootstrap-submit');
  const status = document.querySelector('#owner-bootstrap-status');
  const heading = document.querySelector('#owner-bootstrap-heading');
  if (!input || !button || !status || !heading) return;
  let submitted = false;

  button.addEventListener('click', async () => {
    if (submitted) return;
    submitted = true;
    let token = input.value;
    input.value = '';
    input.disabled = true;
    button.disabled = true;
    status.textContent = 'Signing in';
    let body;
    try {
      if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) throw new Error('invalid-code');
      body = JSON.stringify({ token });
      token = null;
      const result = await fetch('/owner/bootstrap', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body,
        cache: 'no-store',
        redirect: 'error',
        mode: 'same-origin',
      });
      body = null;
      if (result.status !== 200) throw new Error('sign-in-failed');
      const value = await result.json();
      if (value === null || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).length !== 1 || value.ok !== true) throw new Error('invalid-response');
      heading.textContent = 'Signed in';
      document.title = 'Signed in';
      status.textContent = 'Signed in';
    } catch {
      status.textContent = 'Sign-in could not be confirmed. Close this session.';
    } finally {
      token = null;
      body = null;
      input.value = '';
    }
  });
})();
