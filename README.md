# Tic-Tac-Toe Web App (C++ & WebAssembly)

An interactive Tic-Tac-Toe game built with **C++** compiled to **WebAssembly (Wasm)**, styled with modern CSS, and configured for instant deployment to **GitHub Pages**.

## Features

- **C++ Game Logic**: Core game rules, turn handling, win conditions, and draw detection execute efficiently inside a compiled C++ WebAssembly module.
- **Winning Strike-Through Line**: Automatically detects the winning combination (rows, columns, or diagonals) and draws an animated strike-through line across the winning symbols.
- **Replay / Reset Button**: Easily restart the game at any time with a single click.
- **GitHub Pages Ready**: Includes a pre-configured GitHub Actions workflow (`.github/workflows/deploy.yml`) that automatically compiles the C++ code with Emscripten and deploys the site to GitHub Pages on every push.

---

## Local Development & Testing

You can open [`index.html`](index.html) directly in any modern web browser. The app includes a robust JavaScript fallback engine so it works immediately without requiring a local WebAssembly toolchain installed.

If you have Python installed, you can test it locally via a local server:
```bash
python3 -m http.server 8000
```
Then open `http://localhost:8000` in your browser.

---

## Hosting on GitHub

1. Create a new repository on GitHub named `tic-tac-toe` (or any name you prefer).
2. Push your repository to GitHub:
   ```bash
   git init
   git add .
   git commit -m "Initial commit: C++ WebAssembly Tic-Tac-Toe"
   git branch -M main
   git remote add origin https://github.com/YOUR_USERNAME/tic-tac-toe.git
   git push -u origin main
   ```
3. Go to your repository on GitHub: **Settings** -> **Pages**.
4. Under **Build and deployment**, set **Source** to **GitHub Actions**.
5. The GitHub Actions workflow will automatically compile your C++ code and deploy the live interactive web page. Once complete, your URL will be available at:
   `https://YOUR_USERNAME.github.io/tic-tac-toe/`
