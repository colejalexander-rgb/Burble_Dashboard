# Burble Dashboard PWA

A static, installable web version of Burble Dashboard. It displays public
Burble load boards in iframes and saves selected dropzones and layout settings
in the browser.

## Test locally

The app must be served over HTTP rather than opened directly from disk:

Double-click `START_PWA.cmd`. It starts the local server and opens the
dashboard automatically.

Or run:

```powershell
node server.js
```

Then open <http://localhost:4174/>.

## Deploy

Burble's display server requires a session cookie that browsers block in
third-party iframes. Because of that, this version includes a same-origin
server-side proxy and cannot be deployed to a static-only host such as GitHub
Pages. Deploy `server.js` with the static files to a Node.js host.

### Render free web service

1. Put the contents of this folder in a GitHub repository.
2. Sign in at <https://render.com/> using GitHub.
3. Select **New > Blueprint** and connect the repository.
4. Render reads `render.yaml`; approve the free `burble-dashboard` web service.
5. Open the generated `https://...onrender.com` URL after deployment finishes.

Render automatically redeploys after each push to the connected repository.
Free services sleep after 15 minutes without traffic, so the first visit after
an idle period can take about one minute.

On iPhone, open the deployed URL in Safari and choose **Share > Add to Home
Screen**. On supported desktop and Android browsers, use the **Install app**
button.

The interface and dropzone catalog are available offline after the first
visit. Burble load boards require both the local/deployed server and an
internet connection.
