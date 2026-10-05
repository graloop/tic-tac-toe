'use strict';

// Keep an invite link's "#room=CODE" through sign-in so the friend lands in the game.
if (/^#room=[A-Z0-9]{6}$/.test(location.hash)) {
    document.getElementById('login-form').action = '/login' + location.hash;
}
