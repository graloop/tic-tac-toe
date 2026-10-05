// Tic-Tac-Toe rules engine, compiled to WebAssembly.
//
// The engine is stateless: a board is packed into a single int so the same
// module can be shared by any number of games (in the browser and on the
// server) without heap allocation or string passing.
//
// Board encoding: base 3, cell i (0..8, row-major) = (board / 3^i) % 3,
//                 where 0 = empty, 1 = X, 2 = O. Empty board = 0.
// Players:        1 = X, 2 = O.

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#else
#define EMSCRIPTEN_KEEPALIVE
#endif

namespace {

const int BOARD_STATES = 19683; // 3^9
const int POW3[9] = {1, 3, 9, 27, 81, 243, 729, 2187, 6561};

// Index 0-2: rows, 3-5: columns, 6: diagonal from top-left, 7: from top-right.
const int LINES[8][3] = {
    {0, 1, 2}, {3, 4, 5}, {6, 7, 8},
    {0, 3, 6}, {1, 4, 7}, {2, 5, 8},
    {0, 4, 8}, {2, 4, 6},
};

bool valid_board(int board) { return board >= 0 && board < BOARD_STATES; }
bool valid_player(int player) { return player == 1 || player == 2; }
int cell_at(int board, int cell) { return (board / POW3[cell]) % 3; }

int find_win_line(int board) {
    for (int i = 0; i < 8; ++i) {
        int a = cell_at(board, LINES[i][0]);
        if (a != 0 && a == cell_at(board, LINES[i][1]) && a == cell_at(board, LINES[i][2])) {
            return i;
        }
    }
    return -1;
}

// 0 = ongoing, 1 = X wins, 2 = O wins, 3 = draw.
int status_of(int board) {
    int line = find_win_line(board);
    if (line >= 0) return cell_at(board, LINES[line][0]);
    for (int i = 0; i < 9; ++i) {
        if (cell_at(board, i) == 0) return 0;
    }
    return 3;
}

// Score from `player`'s point of view; faster wins and slower losses score higher.
int minimax(int board, int player, int me, int depth) {
    int status = status_of(board);
    if (status == me) return 10 - depth;
    if (status == 3) return 0;
    if (status != 0) return depth - 10;

    bool maximizing = player == me;
    int best = maximizing ? -100 : 100;
    for (int i = 0; i < 9; ++i) {
        if (cell_at(board, i) != 0) continue;
        int score = minimax(board + player * POW3[i], 3 - player, me, depth + 1);
        if (maximizing ? score > best : score < best) best = score;
    }
    return best;
}

// Small deterministic PRNG so the caller controls randomness via `seed`.
unsigned next_random(unsigned &state) {
    state = state * 1664525u + 1013904223u;
    return state >> 8;
}

} // namespace

extern "C" {

// Returns 0 = ongoing, 1 = X wins, 2 = O wins, 3 = draw, -1 = invalid board.
EMSCRIPTEN_KEEPALIVE
int engine_status(int board) {
    return valid_board(board) ? status_of(board) : -1;
}

// Returns the winning line index (0-7, see LINES) or -1 if nobody has won.
EMSCRIPTEN_KEEPALIVE
int engine_win_line(int board) {
    return valid_board(board) ? find_win_line(board) : -1;
}

// Returns the value of one cell (0 = empty, 1 = X, 2 = O) or -1 if invalid.
EMSCRIPTEN_KEEPALIVE
int engine_cell(int board, int cell) {
    if (!valid_board(board) || cell < 0 || cell > 8) return -1;
    return cell_at(board, cell);
}

// Returns the new board, or -1 if the move is illegal.
EMSCRIPTEN_KEEPALIVE
int engine_play(int board, int player, int cell) {
    if (!valid_board(board) || !valid_player(player)) return -1;
    if (cell < 0 || cell > 8) return -1;
    if (cell_at(board, cell) != 0 || status_of(board) != 0) return -1;
    return board + player * POW3[cell];
}

// Picks a move for `player`. level: 0 = easy, 1 = medium, 2 = unbeatable.
// Returns a cell index, or -1 if there is no legal move.
EMSCRIPTEN_KEEPALIVE
int engine_best_move(int board, int player, int level, unsigned seed) {
    if (!valid_board(board) || !valid_player(player) || status_of(board) != 0) return -1;

    int moves[9];
    int count = 0;
    for (int i = 0; i < 9; ++i) {
        if (cell_at(board, i) == 0) moves[count++] = i;
    }
    if (count == 0) return -1;

    unsigned rng = seed;
    bool play_randomly = level <= 0 || (level == 1 && next_random(rng) % 2 == 0);
    if (play_randomly) return moves[next_random(rng) % count];

    // Pick uniformly among the equally best moves so games vary.
    int best_score = -100;
    int best[9];
    int best_count = 0;
    for (int i = 0; i < count; ++i) {
        int score = minimax(board + player * POW3[moves[i]], 3 - player, player, 1);
        if (score > best_score) {
            best_score = score;
            best_count = 0;
        }
        if (score == best_score) best[best_count++] = moves[i];
    }
    return best[next_random(rng) % best_count];
}

} // extern "C"
