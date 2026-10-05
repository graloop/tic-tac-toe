'use strict';

(() => {
    const $ = (id) => document.getElementById(id);
    const views = { menu: $('menu'), lobby: $('lobby'), game: $('game') };
    const cells = Array.from(document.querySelectorAll('.cell'));
    const NAMES = { 1: 'X', 2: 'O' };
    const ROOM_RE = /^[A-HJ-NP-Z2-9]{6}$/;
    const AI_DELAY_MS = 400;

    // First and last cell of each winning line, in the engine's line order.
    const LINE_ENDS = [[0, 2], [3, 5], [6, 8], [0, 6], [1, 7], [2, 8], [0, 8], [2, 6]];

    let engine = null;
    let mode = null;          // 'local' | 'ai' | 'online'
    let aiTimer = null;

    // Offline games (local and vs computer) run entirely in the browser.
    const offline = { board: 0, turn: 1, starter: 1, level: 2, score: { 1: 0, 2: 0, 3: 0 } };

    // Online games are refereed by the server; we only render its state.
    const online = { room: null, token: null, seat: 0, source: null, state: null };

    function show(name) {
        for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
    }

    function setStatus(text, className = '') {
        const el = $('status');
        el.textContent = text;
        el.className = 'status ' + className;
    }

    // ---- Rendering --------------------------------------------------------

    function render({ cells: values, winLine, playable, score, labels }) {
        cells.forEach((cell, i) => {
            const v = values[i];
            cell.textContent = NAMES[v] || '';
            cell.className = 'cell' + (v === 1 ? ' x' : v === 2 ? ' o' : '');
            cell.disabled = !playable || v !== 0;
            cell.setAttribute('aria-label', `Row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}${v ? ', ' + NAMES[v] : ''}`);
        });
        drawStrike(winLine);
        for (const k of [1, 2, 3]) $('score-' + k).textContent = score[k];
        $('score-label-1').textContent = labels[1];
        $('score-label-2').textContent = labels[2];
    }

    function drawStrike(winLine) {
        const line = $('strike-line');
        if (winLine < 0) {
            line.classList.remove('show');
            return;
        }
        // Cell centers in a 3x3 coordinate space, extended a little past each end.
        const [a, b] = LINE_ENDS[winLine].map((c) => [(c % 3) + 0.5, Math.floor(c / 3) + 0.5]);
        const dx = b[0] - a[0], dy = b[1] - a[1];
        const len = Math.hypot(dx, dy), ext = 0.35;
        line.setAttribute('x1', a[0] - (dx / len) * ext);
        line.setAttribute('y1', a[1] - (dy / len) * ext);
        line.setAttribute('x2', b[0] + (dx / len) * ext);
        line.setAttribute('y2', b[1] + (dy / len) * ext);
        if (!line.classList.contains('show')) line.classList.add('show');
    }

    // ---- Offline games ----------------------------------------------------

    function offlineCells(board) {
        return Array.from({ length: 9 }, (_, i) => engine._engine_cell(board, i));
    }

    function startOffline(newMode) {
        leaveOnline();
        mode = newMode;
        offline.level = Number($('difficulty').value);
        offline.score = { 1: 0, 2: 0, 3: 0 };
        offline.starter = 1;
        resetOfflineBoard();
        $('invite').hidden = true;
        show('game');
    }

    function resetOfflineBoard() {
        clearTimeout(aiTimer);
        offline.board = 0;
        offline.turn = offline.starter;
        renderOffline();
    }

    function renderOffline() {
        const status = engine._engine_status(offline.board);
        const vsAi = mode === 'ai';
        const aiTurn = vsAi && status === 0 && offline.turn === 2;
        render({
            cells: offlineCells(offline.board),
            winLine: engine._engine_win_line(offline.board),
            playable: status === 0 && !aiTurn,
            score: offline.score,
            labels: vsAi ? { 1: 'You', 2: 'Computer' } : NAMES,
        });
        $('again').hidden = status === 0;

        const name = NAMES[offline.turn];
        if (status === 3) setStatus("It's a draw!");
        else if (status !== 0 && vsAi) setStatus(status === 1 ? 'You win! 🎉' : 'The computer wins.', NAMES[status].toLowerCase());
        else if (status !== 0) setStatus(`Player ${NAMES[status]} wins! 🎉`, NAMES[status].toLowerCase());
        else if (aiTurn) setStatus('Computer is thinking…', 'o');
        else if (vsAi) setStatus('Your turn (X)', 'x');
        else setStatus(`Player ${name}'s turn`, name.toLowerCase());

        if (aiTurn) {
            clearTimeout(aiTimer);
            aiTimer = setTimeout(playAiMove, AI_DELAY_MS);
        }
    }

    function playOffline(cell) {
        const next = engine._engine_play(offline.board, offline.turn, cell);
        if (next < 0) return;
        offline.board = next;
        const status = engine._engine_status(next);
        if (status === 0) offline.turn = 3 - offline.turn;
        else offline.score[status] += 1;
        renderOffline();
    }

    function playAiMove() {
        if (mode !== 'ai' || offline.turn !== 2) return;
        const seed = crypto.getRandomValues(new Uint32Array(1))[0];
        const cell = engine._engine_best_move(offline.board, 2, offline.level, seed);
        if (cell >= 0) playOffline(cell);
    }

    // ---- Online games -----------------------------------------------------

    async function api(path, body = {}) {
        const res = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin',
        });
        if (res.status === 401) {
            location.href = '/login';
            throw new Error('Please sign in again.');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || 'Something went wrong. Try again.');
        return data;
    }

    function savedSeat(room) {
        try {
            return JSON.parse(sessionStorage.getItem('ttt-room-' + room)) || {};
        } catch {
            return {};
        }
    }

    function saveSeat(room, token, seat) {
        try {
            sessionStorage.setItem('ttt-room-' + room, JSON.stringify({ token, seat }));
        } catch {
            // Private mode: rejoining after a reload won't work, but play still does.
        }
    }

    async function createRoom() {
        $('lobby-error').textContent = '';
        try {
            enterRoom(await api('/api/rooms'));
        } catch (err) {
            $('lobby-error').textContent = err.message;
        }
    }

    async function joinRoom(code) {
        $('lobby-error').textContent = '';
        const room = code.trim().toUpperCase();
        if (!ROOM_RE.test(room)) {
            $('lobby-error').textContent = 'Game codes are 6 letters and numbers.';
            return;
        }
        try {
            enterRoom(await api(`/api/rooms/${room}/join`, { token: savedSeat(room).token }));
        } catch (err) {
            show('lobby');
            $('lobby-error').textContent = err.message;
            if (location.hash) history.replaceState(null, '', location.pathname);
        }
    }

    function enterRoom({ room, token, seat }) {
        clearTimeout(aiTimer);
        leaveOnline();
        mode = 'online';
        Object.assign(online, { room, token, seat, state: null });
        saveSeat(room, token, seat);
        history.replaceState(null, '', '#room=' + room);
        $('room-code').textContent = room;
        $('invite').hidden = false;
        $('again').hidden = true;
        render({ cells: Array(9).fill(0), winLine: -1, playable: false, score: { 1: 0, 2: 0, 3: 0 }, labels: NAMES });
        setStatus('Connecting…');
        show('game');

        const source = new EventSource(`/api/rooms/${room}/events?seat=${seat}`);
        online.source = source;
        source.onmessage = (event) => {
            online.state = JSON.parse(event.data);
            renderOnline();
        };
        source.onerror = () => {
            if (source.readyState === EventSource.CLOSED) connectionLost();
            else setStatus('Reconnecting…');
        };
    }

    // The stream closes for good on an HTTP error; find out why.
    async function connectionLost() {
        const room = online.room;
        try {
            await api(`/api/rooms/${room}/join`, { token: online.token });
            setStatus('Connection lost. Retrying…');
            setTimeout(() => {
                if (mode === 'online' && online.room === room) enterRoom({ room, token: online.token, seat: online.seat });
            }, 3000);
        } catch (err) {
            if (mode !== 'online' || online.room !== room) return;
            setStatus(err.message);
            leaveOnline();
        }
    }

    function leaveOnline() {
        if (online.source) online.source.close();
        online.source = null;
        if (mode === 'online' && location.hash) history.replaceState(null, '', location.pathname);
    }

    function renderOnline() {
        const s = online.state;
        const me = online.seat;
        const other = 3 - me;
        const myTurn = s.status === 0 && s.joined[other] && s.turn === me;
        render({
            cells: s.cells,
            winLine: s.winLine,
            playable: myTurn,
            score: s.score,
            labels: { [me]: `You (${NAMES[me]})`, [other]: `Friend (${NAMES[other]})` },
        });
        $('invite').hidden = s.joined[other];
        $('again').hidden = s.status === 0;

        const mine = NAMES[me].toLowerCase();
        const theirs = NAMES[other].toLowerCase();
        if (!s.joined[other]) setStatus('Waiting for your friend to join…');
        else if (s.status === me) setStatus('You win! 🎉', mine);
        else if (s.status === other) setStatus('Your friend wins.', theirs);
        else if (s.status === 3) setStatus("It's a draw!");
        else if (!s.online[other]) setStatus('Your friend is offline. Waiting…', theirs);
        else if (myTurn) setStatus(`Your turn (${NAMES[me]})`, mine);
        else setStatus("Friend's turn…", theirs);
    }

    async function playOnline(cell) {
        cells[cell].disabled = true;
        try {
            await api(`/api/rooms/${online.room}/move`, { token: online.token, cell });
        } catch (err) {
            setStatus(err.message);
            cells[cell].disabled = false;
        }
    }

    async function rematchOnline() {
        try {
            await api(`/api/rooms/${online.room}/rematch`, { token: online.token });
        } catch (err) {
            setStatus(err.message);
        }
    }

    async function copyInvite() {
        const link = `${location.origin}/#room=${online.room}`;
        try {
            await navigator.clipboard.writeText(link);
            $('copy-link').textContent = 'Copied!';
        } catch {
            $('copy-link').textContent = link;
        }
        setTimeout(() => { $('copy-link').textContent = 'Copy invite link'; }, 2500);
    }

    // ---- Wiring -----------------------------------------------------------

    function goToMenu() {
        clearTimeout(aiTimer);
        leaveOnline();
        mode = null;
        show('menu');
    }

    function start() {
        document.querySelectorAll('[data-mode]').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (btn.dataset.mode === 'online') {
                    $('lobby-error').textContent = '';
                    show('lobby');
                } else {
                    startOffline(btn.dataset.mode);
                }
            });
        });
        document.querySelectorAll('.back').forEach((btn) => btn.addEventListener('click', goToMenu));
        cells.forEach((cell, i) => cell.addEventListener('click', () => {
            if (mode === 'online') playOnline(i);
            else playOffline(i);
        }));
        $('again').addEventListener('click', () => {
            if (mode === 'online') return rematchOnline();
            offline.starter = 3 - offline.starter;
            resetOfflineBoard();
        });
        $('create-room').addEventListener('click', createRoom);
        $('join-form').addEventListener('submit', (event) => {
            event.preventDefault();
            joinRoom($('join-code').value);
        });
        $('copy-link').addEventListener('click', copyInvite);

        const invite = /^#room=(.+)$/.exec(location.hash);
        if (invite) joinRoom(invite[1]);
        else show('menu');
    }

    show(null);
    createEngine()
        .then((instance) => {
            engine = instance;
            start();
        })
        .catch((err) => {
            console.error(err);
            show('game');
            setStatus('Could not load the game engine. Please refresh the page.');
        });
})();
