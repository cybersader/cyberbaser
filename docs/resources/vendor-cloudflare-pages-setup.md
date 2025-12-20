# Vendor: Cloudflare Pages Setup

**Date**: 2024-12-20
**Status**: Ready to implement

---

## Overview

Deploy Cyberbase to Cloudflare Pages using GitHub Actions.

## Prerequisites

- GitHub repository (will be `cybersader/cyberbase` or new repo)
- Cloudflare account (free tier works)

---

## Step 1: Create Cloudflare Pages Project

1. Go to [Cloudflare Dashboard](https://dash.cloudflare.com/)
2. Select your account
3. Go to **Workers & Pages** → **Pages**
4. Click **Create a project** → **Direct Upload** (we'll use GitHub Actions, not their Git integration)
5. Name: `cyberbase`
6. Upload a dummy file to create the project (or skip and let first deploy create it)

---

## Step 2: Get Cloudflare Credentials

### Account ID
1. Go to any domain in Cloudflare dashboard
2. Look at the right sidebar under **API**
3. Copy **Account ID**

### API Token
1. Go to [API Tokens](https://dash.cloudflare.com/profile/api-tokens)
2. Click **Create Token**
3. Use template: **Edit Cloudflare Workers** (includes Pages permissions)
   - Or create custom with:
     - Account: Cloudflare Pages: Edit
     - Zone: (not needed for Pages)
4. Copy the token (shown only once!)

---

## Step 3: Add GitHub Secrets

1. Go to your GitHub repo → **Settings** → **Secrets and variables** → **Actions**
2. Add two secrets:
   - `CLOUDFLARE_ACCOUNT_ID`: Your account ID
   - `CLOUDFLARE_API_TOKEN`: Your API token

---

## Step 4: Push and Deploy

The workflow at `.github/workflows/deploy.yml` will:
1. Trigger on push to `main`
2. Build the Astro site
3. Deploy to Cloudflare Pages

First deploy creates the project if it doesn't exist.

---

## Step 5: Custom Domain (Optional)

1. In Cloudflare Pages → your project → **Custom domains**
2. Add domain: `cyberbase.wiki` (or your domain)
3. If domain is on Cloudflare: automatic DNS setup
4. If domain is elsewhere: add CNAME record pointing to `cyberbase.pages.dev`

---

## Workflow File Reference

Located at: `site/.github/workflows/deploy.yml`

Key parts:
```yaml
- name: Deploy to Cloudflare Pages
  uses: cloudflare/wrangler-action@v3
  with:
    apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
    command: pages deploy site/dist --project-name=cyberbase
```

---

## Troubleshooting

### "Project not found"
- First deploy auto-creates project
- Or manually create in dashboard first

### "Authentication failed"
- Check API token has Pages permissions
- Verify token not expired
- Re-create token if needed

### Build fails
- Check Node version matches local (22.x)
- Run `npm run build` locally to debug

---

## Cost

Cloudflare Pages free tier:
- 500 builds/month
- 100,000 requests/day
- Unlimited bandwidth
- Unlimited sites

More than enough for Cyberbase.
