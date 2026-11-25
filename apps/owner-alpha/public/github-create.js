// Setup's "Create Cyberbaser's GitHub App": post the manifest to GitHub at once.
// The visible button does the same without scripting.
(() => {
  const form = document.getElementById('github-create');
  if (form) form.submit();
})();
