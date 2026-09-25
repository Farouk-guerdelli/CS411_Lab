# Network Course Frontend Template

A minimal static frontend (HTML/CSS/JS, no build step) for a networking course.
It lets you point at any HTTP server (running on a VM, for example) and send
GET/POST requests to it, then view the raw response.

## Files

- `index.html` — page structure
- `style.css` — styling
- `script.js` — fetch logic, talks to whatever server URL you enter
- `.gitignore`

## 1. Run it locally

No build tools needed. Either:

- Open `index.html` directly in a browser, or
- Serve it so it behaves like a real site (recommended, avoids some browser
  restrictions on `file://`):

  ```bash
  python3 -m http.server 5500
  ```

  Then visit `http://localhost:5500`.

## 2. Push to GitHub

```bash
cd net-frontend-template
git init
git add .
git commit -m "Initial frontend template"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

## 3. Connect it to your VM's HTTP server

You have two things running:

1. **Your backend/HTTP server**, on the VM (e.g. a Python `http.server`,
   Flask/Express app, or whatever your course requires).
2. **This frontend**, either opened locally in a browser or also served from
   the VM.

### Option A — Frontend runs locally, server runs on the VM

1. Make sure the server on the VM is listening on all interfaces, not just
   `localhost`. E.g. for Python:
   ```bash
   python3 -m http.server 8000 --bind 0.0.0.0
   ```
2. Find the VM's IP address:
   ```bash
   ip addr show    # or: hostname -I
   ```
3. Make sure the VM's firewall/security group allows inbound traffic on that
   port (e.g. `sudo ufw allow 8000`, or open the port in your cloud
   provider's security group / NAT rules if it's a cloud VM).
4. In the page, set **Server URL** to `http://<VM_IP>:<PORT>` and click Save.
5. Pick an endpoint (e.g. `/api/status`) and method, then click Send.

If your server is a plain static file server (no `/api/...` routes), just use
`/` as the endpoint to fetch the index page and confirm connectivity.

### Option B — Frontend also served from the VM

1. Clone the repo on the VM:
   ```bash
   git clone https://github.com/<your-username>/<your-repo>.git
   cd <your-repo>
   ```
2. Serve the frontend on one port and your backend on another, e.g.:
   ```bash
   python3 -m http.server 5500 --bind 0.0.0.0   # frontend
   ```
3. From your own machine, browse to `http://<VM_IP>:5500`.
4. Set **Server URL** in the page to wherever the backend is listening
   (could be the same VM on a different port, e.g. `http://<VM_IP>:8000`).

### CORS

If the frontend's origin (e.g. `http://localhost:5500`) differs from the
server's origin (e.g. `http://<VM_IP>:8000`), the browser enforces CORS.
Your server needs to send a header like:

```
Access-Control-Allow-Origin: *
```

(or your frontend's specific origin). Most simple demo servers for a
networking course will need this added explicitly — Python's built-in
`http.server` does not send it by default.

## Notes

- The server URL you enter is saved in the browser's `localStorage` so you
  don't have to retype it every time.
- This is intentionally framework-free so it's easy to read, modify, and
  explain for a networking assignment.
