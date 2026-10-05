import { randomInt } from 'node:crypto';
import { randomToken, safeEqual } from './security.mjs';

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I
export const ROOM_ID_PATTERN = '[A-HJ-NP-Z2-9]{6}';

export class RoomError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// In-memory online games. Seat 1 plays X (the creator), seat 2 plays O.
// Each seat is claimed with a secret token so nobody else can move for you.
export class Rooms {
  constructor(engine, {
    maxRooms = 200,
    maxSubscribers = 500,
    maxSubscribersPerRoom = 8,
    idleMs = 2 * 60 * 60 * 1000,
    now = Date.now,
  } = {}) {
    Object.assign(this, { engine, maxRooms, maxSubscribers, maxSubscribersPerRoom, idleMs, now });
    this.rooms = new Map();
    this.subscriberCount = 0;
  }

  create() {
    if (this.rooms.size >= this.maxRooms) this.sweep();
    if (this.rooms.size >= this.maxRooms) throw new RoomError(503, 'Too many games in progress. Try again later.');
    let id;
    do {
      id = Array.from({ length: 6 }, () => ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)]).join('');
    } while (this.rooms.has(id));
    const token = randomToken();
    this.rooms.set(id, {
      id,
      board: 0,
      starter: 1,
      turn: 1,
      tokens: { 1: token, 2: null },
      score: { 1: 0, 2: 0, 3: 0 },
      subscribers: new Set(),
      touched: this.now(),
    });
    return { room: id, token, seat: 1 };
  }

  get(id) {
    const room = this.rooms.get(id);
    if (!room) throw new RoomError(404, 'This game does not exist or has expired.');
    return room;
  }

  seatOf(room, token) {
    if (safeEqual(token, room.tokens[1])) return 1;
    if (safeEqual(token, room.tokens[2])) return 2;
    return 0;
  }

  join(id, token) {
    const room = this.get(id);
    const seat = this.seatOf(room, token);
    if (seat) return { room: id, token, seat };
    if (room.tokens[2]) throw new RoomError(409, 'This game already has two players.');
    room.tokens[2] = randomToken();
    this.changed(room);
    return { room: id, token: room.tokens[2], seat: 2 };
  }

  move(id, token, cell) {
    const room = this.get(id);
    const seat = this.seatOf(room, token);
    if (!seat) throw new RoomError(403, 'You are not a player in this game.');
    if (!room.tokens[2]) throw new RoomError(409, 'Wait for your opponent to join.');
    if (this.engine.status(room.board) !== 0) throw new RoomError(409, 'This round is over.');
    if (room.turn !== seat) throw new RoomError(409, "It's not your turn.");
    if (!Number.isInteger(cell) || cell < 0 || cell > 8) throw new RoomError(400, 'Invalid move.');
    const board = this.engine.play(room.board, seat, cell);
    if (board < 0) throw new RoomError(409, 'That square is already taken.');
    room.board = board;
    const status = this.engine.status(board);
    if (status === 0) room.turn = 3 - seat;
    else room.score[status] += 1;
    this.changed(room);
  }

  rematch(id, token) {
    const room = this.get(id);
    if (!this.seatOf(room, token)) throw new RoomError(403, 'You are not a player in this game.');
    if (this.engine.status(room.board) === 0) throw new RoomError(409, 'Finish this round first.');
    room.starter = 3 - room.starter;
    room.turn = room.starter;
    room.board = 0;
    this.changed(room);
  }

  snapshot(room) {
    const online = { 1: false, 2: false };
    for (const sub of room.subscribers) if (sub.seat) online[sub.seat] = true;
    return {
      room: room.id,
      cells: this.engine.cells(room.board),
      turn: room.turn,
      status: this.engine.status(room.board),
      winLine: this.engine.winLine(room.board),
      joined: { 1: true, 2: Boolean(room.tokens[2]) },
      online,
      score: room.score,
    };
  }

  // `send(data)` is called with every new state; returns an unsubscribe function.
  subscribe(id, seat, send) {
    const room = this.get(id);
    if (this.subscriberCount >= this.maxSubscribers || room.subscribers.size >= this.maxSubscribersPerRoom) {
      throw new RoomError(503, 'Too many connections. Close some tabs and try again.');
    }
    const sub = { seat: seat === 1 || seat === 2 ? seat : 0, send };
    room.subscribers.add(sub);
    this.subscriberCount += 1;
    this.changed(room);
    return () => {
      if (!room.subscribers.delete(sub)) return;
      this.subscriberCount -= 1;
      this.changed(room);
    };
  }

  changed(room) {
    room.touched = this.now();
    const data = JSON.stringify(this.snapshot(room));
    for (const sub of room.subscribers) sub.send(data);
  }

  sweep() {
    const cutoff = this.now() - this.idleMs;
    for (const [id, room] of this.rooms) {
      if (room.subscribers.size === 0 && room.touched < cutoff) this.rooms.delete(id);
    }
  }
}
