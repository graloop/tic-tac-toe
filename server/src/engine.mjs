import { createRequire } from 'node:module';
import path from 'node:path';

// Loads the same C++/WebAssembly engine the browser uses, so the server is
// the referee for online games and both sides always agree on the rules.
export async function loadEngine(publicDir) {
  const require = createRequire(import.meta.url);
  const createEngine = require(path.resolve(publicDir, 'engine.js'));
  const m = await createEngine();
  return {
    status: (board) => m._engine_status(board),
    winLine: (board) => m._engine_win_line(board),
    cells: (board) => Array.from({ length: 9 }, (_, i) => m._engine_cell(board, i)),
    play: (board, player, cell) => m._engine_play(board, player, cell),
  };
}
