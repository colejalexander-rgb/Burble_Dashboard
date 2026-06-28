# Burble Dashboard — Web / PWA

Installable web app for viewing multiple Burble load boards in one page. Runs locally via a Node server or deployed to any Node host (Render free tier works).

The server proxies Burble requests same-origin to work around the session cookie restriction that blocks Burble boards in third-party iframes.

## Run locally

Double-click `START_PWA.cmd`, or:

```powershell
npm install    # first time only
node server.js
```

Then open <http://localhost:4174/>.

## Install as PWA

- **iPhone/iPad:** Open the URL in Safari → Share → Add to Home Screen.
- **Desktop/Android:** Look for the Install button in the browser address bar.

The app shell loads offline after the first visit. Live load boards require the server and an internet connection.

## Deploy to Render (free)

1. Push the repo root to GitHub (the `render.yaml` in this folder is configured with `rootDir: web`).
2. Sign in at [render.com](https://render.com/) with GitHub.
3. New → Blueprint → connect the repo.
4. Render reads `render.yaml` and creates a free web service.
5. Open the generated `https://...onrender.com` URL once the deploy finishes.

Free services sleep after 15 minutes idle — first visit after a pause takes ~1 minute to wake. Render redeploys automatically on each push.

## How the proxy works

`server.js` intercepts requests to `/burble/{dzId}/...`, forwards them to `https://us-displays.burblesoft.com`, caches the Burble session cookie server-side, and rewrites URLs in HTML/JS/CSS responses so the browser stays on the same origin. This is necessary because Burble sets `SameSite` cookies that browsers block in cross-origin iframes.
