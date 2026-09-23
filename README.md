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

Live at <https://burble-dashboard.onrender.com/>, deployed from the GitHub repo
[colejalexander-rgb/Burble_Dashboard](https://github.com/colejalexander-rgb/Burble_Dashboard)
(branch `main`). That repo contains **only this `web/` folder, flattened to its root** —
so `render.yaml` has no `rootDir`. Render redeploys automatically on each push.

To deploy, commit your changes in the main Burble repo, then from the repo root:

```powershell
powershell -File scripts\deploy-web.ps1
```

The script pushes the committed `web/` folder as a fast-forward on top of GitHub's
existing history (it never force-pushes). Only committed changes deploy.

Free services sleep after 15 minutes idle — first visit after a pause takes ~1 minute to wake.

## How the proxy works

`server.js` intercepts requests to `/burble/{dzId}/...`, forwards them to `https://us-displays.burblesoft.com`, caches the Burble session cookie server-side, and rewrites URLs in HTML/JS/CSS responses so the browser stays on the same origin. This is necessary because Burble sets `SameSite` cookies that browsers block in cross-origin iframes.
