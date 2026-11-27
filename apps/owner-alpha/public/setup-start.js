// A native form navigation from a no-referrer document can send Origin: null.
// Submit only on the click, retaining the real Origin without sending a Referer.
const form = document.getElementById('setup-start');
const button = form.querySelector('button');
const status = document.getElementById('setup-start-status');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (button.disabled) return;
  button.disabled = true;
  status.textContent = '';
  try {
    const result = await fetch(form.action, {
      method: 'POST', mode: 'same-origin', body: new URLSearchParams(new FormData(form)),
      referrer: '', referrerPolicy: 'same-origin',
    });
    if (result.ok && result.redirected && result.url === new URL('/setup', location.origin).href) {
      location.replace(result.url);
      return;
    }
    status.textContent = result.status === 410 ? 'Cyberbaser is already set up.' : status.dataset.unavailable;
  } catch {
    status.textContent = 'Could not reach Cyberbaser. Try again.';
  }
  button.disabled = false;
});
button.disabled = false;
