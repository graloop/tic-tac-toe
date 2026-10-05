# Tic-Tac-Toe (C++ & WebAssembly)

A private Tic-Tac-Toe game you host yourself. The game rules are written in **C++ and compiled to WebAssembly**. A tiny Node.js server puts the whole site behind an **access code**.

- **Two players on one device**: pass the phone back and forth.
- **Play the computer**: Easy, Medium or Unbeatable.
- **Online with a friend**: create a game, send the invite link, and play from two devices in real time.
- Works on phones and desktops, in light and dark mode.

Nobody can see or play the game without the code. That includes the page, the scripts and the API.

---

## Contents

1. [Play on your own computer](#1-play-on-your-own-computer)
2. [Host it at tic-tac-toe.graloop.com](#2-host-it-at-tic-tac-toegraloopcom)
3. [Everyday tasks](#3-everyday-tasks)
4. [Security](#4-security)
5. [How it works](#5-how-it-works)
6. [Development](#6-development)
7. [Troubleshooting](#7-troubleshooting)

---

## 1. Play on your own computer

You need [Docker](https://docs.docker.com/get-docker/).

```bash
git clone https://github.com/graloop/tic-tac-toe.git
cd tic-tac-toe
cp .env.example .env        # then edit .env and set your ACCESS_CODE
docker compose up -d --build
```

Open <http://localhost:8080> and enter your code. Stop it with `docker compose down`.

> **Without Docker:** install [Emscripten](https://emscripten.org/docs/getting_started/downloads.html) and Node.js 22 or newer, then run
> `make run ACCESS_CODE=your-long-code`.

---

## 2. Host it at tic-tac-toe.graloop.com

The setup is: **Internet → your nginx (HTTPS) → this container (port 8080, only reachable from the server itself)**.

### Step 1: DNS

At your domain registrar, add an `A` record for `tic-tac-toe.graloop.com` that points to your server's public IP. The `A` record is the same kind you already use for `graloop.com`.

### Step 2: Start the container on the server

```bash
git clone https://github.com/graloop/tic-tac-toe.git
cd tic-tac-toe
cp .env.example .env
nano .env                   # set ACCESS_CODE (see "Choosing a good code" below)
chmod 600 .env              # only you can read the code
docker compose up -d --build
docker compose ps           # should say "healthy" after a few seconds
```

The container only listens on `127.0.0.1:8080`, so it can't be reached from the internet directly. Everything goes through nginx.

**Choosing a good code:** use at least 12 characters. Four random words work well, e.g. `maple-rocket-tuesday-lantern`. The server refuses to start with a code shorter than 8 characters or with the placeholder `change-me`.

### Step 3: Point nginx at it

Pick the section that matches your setup.

<details open>
<summary><b>A. Nginx Proxy Manager (web interface, runs in Docker)</b></summary>

Nginx Proxy Manager runs in its own container, so it can't reach `127.0.0.1:8080` on the host. Put both containers on the same Docker network instead, and don't publish any port at all:

1. Find the network Nginx Proxy Manager uses:
   ```bash
   docker network ls          # usually something like "npm_default" or "nginx-proxy-manager_default"
   ```
2. Next to `compose.yaml`, create `compose.override.yaml` (put the network name from step 1 on the last line):
   ```yaml
   services:
     tic-tac-toe:
       ports: !reset []
       networks: [proxy]
   networks:
     proxy:
       external: true
       name: npm_default
   ```
3. Apply it: `docker compose up -d`
4. In Nginx Proxy Manager, open **Hosts → Proxy Hosts → Add Proxy Host**:
   - Domain Names: `tic-tac-toe.graloop.com`
   - Scheme: `http`, Forward Hostname / IP: `tic-tac-toe`, Forward Port: `8080`
   - Turn on **Block Common Exploits**
5. **SSL tab**: *Request a new SSL Certificate*, and turn on **Force SSL**, **HTTP/2 Support** and **HSTS Enabled**.
6. **Advanced tab**: paste this so live online games aren't delayed:
   ```nginx
   proxy_buffering off;
   proxy_read_timeout 1h;
   ```

</details>

<details>
<summary><b>B. Plain nginx installed on the server</b></summary>

Create `/etc/nginx/sites-available/tic-tac-toe.graloop.com`:

```nginx
server {
    listen 80;
    server_name tic-tac-toe.graloop.com;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Live updates for online games
        proxy_buffering off;
        proxy_read_timeout 1h;
    }
}
```

Enable it and get a free HTTPS certificate:

```bash
sudo ln -s /etc/nginx/sites-available/tic-tac-toe.graloop.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d tic-tac-toe.graloop.com --redirect
```

</details>

### Step 4: Check it

Open <https://tic-tac-toe.graloop.com>. You should see the access-code page with a padlock in the address bar.

---

## 3. Everyday tasks

| Task | Command (run in the project folder) |
| --- | --- |
| **Invite a friend online** | In the game: *Online with a friend → Create a new game → Copy invite link*. Send them the link **and** the access code. |
| **Change the code** | Edit `ACCESS_CODE` in `.env`, then `docker compose up -d`. Everyone who was signed in has to enter the new code. |
| **Sign everyone out** | `docker compose restart` |
| **See failed login attempts** | `docker compose logs tic-tac-toe` |
| **Install security updates** | `git pull && docker compose build --pull && docker compose up -d` (a few times a year is plenty) |
| **Stop the game** | `docker compose down` |

The container restarts on its own after a crash or a server reboot (`restart: unless-stopped`).

---

## 4. Security

The server is built so that knowing the URL gets nobody anywhere, and so that even a bug in the game can't reach anything else on your server.

**Access code**
- Every page, script, WebAssembly file and API call needs a valid session. The only public parts are the code page, its stylesheet and a health check that returns `ok`.
- The code is checked in constant time, so response timing reveals nothing about it.
- **Brute-force protection:** after 5 wrong codes, an IP is locked out for 15 minutes. After 50 wrong codes from *all* IPs combined, all new logins pause for 15 minutes, which stops attackers who spread their guesses over many addresses. Locked-out attempts are rejected even when the code is correct.
- Sessions are signed cookies (HMAC-SHA256) marked `HttpOnly`, `Secure` (over HTTPS) and `SameSite=Lax`. They can't be forged, and restarting the container invalidates all of them.

**Web protections**
- A strict Content-Security-Policy allows only this site's own scripts. No inline scripts, no third-party content, and no framing (which blocks clickjacking).
- Cross-site requests that try to change anything are refused. The API only accepts small JSON bodies.
- HSTS, `nosniff`, `no-referrer` and a locked-down Permissions-Policy are set, and search engines are asked not to index the site.

**Online games**
- The server is the referee. It runs the same C++ engine and checks every move, so a modified browser can't cheat or play for the other person.
- Each seat is claimed with a secret token, so knowing a game code doesn't let anyone play in your place.
- The number of games and connections is capped, and idle games are deleted after 2 hours.

**Isolation from your server and your data**
- The game stores **nothing on disk**: no database, no files, no logs of moves. Games live in memory and vanish on restart.
- The container has **no access to your files**: no volumes are mounted, its filesystem is read-only, it runs as an unprivileged user, all Linux capabilities are dropped, and it can't gain new privileges.
- It only listens on `127.0.0.1`, so it's only reachable through your nginx.
- CPU, memory and process count are capped, so a flood of traffic can't take down your other services.
- **No third-party npm packages** are used (only Node's built-in modules), so there's no package supply chain to attack. npm itself is removed from the image.

**What is still up to you**
- Use a long code and only share it with people you trust. Anyone with the code can play.
- Keep your server, Docker and nginx updated, and run the update command from section 3 now and then.

---

## 5. How it works

```
engine/engine.cpp   C++ rules + computer player  ──em++──▶  engine.js + engine.wasm
web/                Game page, sign-in page, styles, browser logic
server/             Node.js server: access code, sessions, online games
```

- **The engine is stateless.** A board is packed into one integer (3⁹ = 19 683 possible boards), so the WebAssembly module needs no memory management and can be shared by every game. It exposes `engine_play`, `engine_status`, `engine_win_line`, `engine_cell` and `engine_best_move` (minimax).
- **Offline modes** (same device and vs computer) run entirely in the browser using the engine.
- **Online mode:** the browser sends moves with `POST /api/rooms/<code>/move`. The server checks each move with the engine and pushes the new board to both players over Server-Sent Events, which pass through nginx without any WebSocket setup.

---

## 6. Development

Requirements: Emscripten, Node.js 22 or newer, and a C++ compiler.

```bash
make build          # compile engine to build/public/ and copy the web files
make test           # C++ engine tests + server tests (auth, rate limits, online games…)
make run ACCESS_CODE=dev-code-1234   # serve on http://localhost:8080
```

GitHub Actions (`.github/workflows/ci.yml`) runs the tests and builds and smoke-tests the Docker image on every push.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `ACCESS_CODE` | *(required)* | Code needed to play, at least 8 characters |
| `PORT` | `8080` | Port the server listens on |
| `SESSION_DAYS` | `30` | How long a sign-in lasts |
| `TRUST_PROXY` | `false` (`true` in `compose.yaml`) | Trust nginx's `X-Forwarded-For`/`-Proto` headers. Only enable it when the app is reachable **only** through your proxy. |

---

## 7. Troubleshooting

| Problem | Fix |
| --- | --- |
| `docker compose up` says *Set ACCESS_CODE in the .env file* | Create `.env` from `.env.example` and set a code. |
| Container keeps restarting | `docker compose logs`. It usually means the code is too short or still the placeholder. |
| *502 Bad Gateway* from nginx | The container isn't running (`docker compose ps`), or nginx can't reach it. With Nginx Proxy Manager, check that `compose.override.yaml` uses the right network name (option A in step 3). |
| Online moves only appear after a long delay | Add `proxy_buffering off;` to the nginx config (step 3). |
| *Too many attempts* | Wait 15 minutes, or run `docker compose restart` on the server. |
| A friend's invite link shows *game does not exist* | Games are deleted after 2 hours of inactivity and when the container restarts. Create a new one. |
