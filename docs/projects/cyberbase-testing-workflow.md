# Testing Workflow

**Status**: Active
**Phase**: 0 - Foundation

---

## Overview

This document defines testing workflows for Cyberbase development:
1. **Local testing** - Before committing
2. **CI testing** - On push/PR via GitHub Actions
3. **Deployment verification** - After deploy completes

---

## Local Testing

### Prerequisites

```bash
cd site
npm install
```

### Available Commands

| Command | Purpose |
|---------|---------|
| `npm run dev` | Start dev server with hot reload (http://localhost:4321) |
| `npm run test:build` | Build site, report success/failure |
| `npm run test:local` | Build + preview production build locally |
| `npm run preview` | Preview existing build (must run `build` first) |

### Workflow: Before Committing

```bash
# 1. Start dev server to see changes live
cd site
npm run dev

# 2. Make changes, verify in browser at http://localhost:4321

# 3. Test production build before committing
npm run test:build

# 4. (Optional) Preview production build
npm run test:local
# Visit http://localhost:4321 to verify
```

### What to Check Locally

- [ ] Site builds without errors
- [ ] Pages render correctly
- [ ] Navigation works
- [ ] New/modified content appears
- [ ] No console errors in browser

---

## CI Testing (GitHub Actions)

The workflow at `.github/workflows/deploy.yml` automatically:

1. **On every push to main**: Build → Deploy
2. **On every PR**: Build only (validates changes)
3. **On manual trigger**: Build → Deploy

### Current CI Steps

```
Checkout → Setup Node → Install deps → Build → (Deploy if main)
```

### Future CI Enhancements

- [ ] Link checking (find broken internal/external links)
- [ ] Lighthouse performance audit
- [ ] Accessibility checks
- [ ] Content validation (frontmatter schema)

---

## Deployment Verification

After deployment completes, verify the live site.

### Manual Verification

1. Visit https://test.cyberbaser.com
2. Check homepage loads
3. Navigate to /kb/
4. Test search functionality
5. Verify any new content appears

### Automated Verification (Future)

Could add post-deploy step to workflow:

```yaml
- name: Verify deployment
  run: |
    sleep 30  # Wait for CDN propagation
    curl -f https://test.cyberbaser.com || exit 1
    curl -f https://test.cyberbaser.com/kb/ || exit 1
```

### Claude Testing Skill

Use the `cyberbase-test` skill to have Claude verify deployment:

```
Run /cyberbase-test
```

Or ask: "Test the cyberbase deployment"

This will:
1. Fetch key pages via WebFetch
2. Verify content loads
3. Report any issues

---

## Testing Environments

| Environment | URL | Trigger |
|-------------|-----|---------|
| Local dev | http://localhost:4321 | `npm run dev` |
| Local preview | http://localhost:4321 | `npm run test:local` |
| Testing | https://test.cyberbaser.com | Push to main |
| Production | https://cyberbase.wiki | (future) |

---

## Troubleshooting

### Build fails locally

```bash
# Clear cache and rebuild
rm -rf site/node_modules site/.astro
cd site && npm install
npm run build
```

### Site not updating after deploy

1. Check GitHub Actions completed successfully
2. Wait 1-2 minutes for CDN propagation
3. Hard refresh browser (Ctrl+Shift+R)
4. Check Cloudflare dashboard for deployment status

### Content not appearing

1. Verify file is in correct location (`site/src/content/docs/`)
2. Check frontmatter is valid YAML
3. Verify file has `.md` or `.mdx` extension
4. Rebuild and check for errors

---

## Related Documents

- `areas/cyberbase-deployment-architecture.md` - Deployment options
- `areas/cyberbase-translation-layer.md` - Content transformation
- `.github/workflows/deploy.yml` - CI/CD workflow
