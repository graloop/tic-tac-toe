// Native unit tests for the engine. Run with: make test-engine
#include "engine.cpp"

#include <cstdio>

static int failures = 0;

#define CHECK_EQ(actual, expected)                                                  \
    do {                                                                            \
        long long a_ = (actual), e_ = (expected);                                   \
        if (a_ != e_) {                                                             \
            std::printf("FAIL %s:%d: %s == %lld, expected %lld\n", __FILE__,        \
                        __LINE__, #actual, a_, e_);                                 \
            ++failures;                                                             \
        }                                                                           \
    } while (0)

// Builds a board from a 9-char string such as "XO.X.O..X".
static int board_of(const char *cells) {
    int board = 0;
    for (int i = 0, p = 1; i < 9; ++i, p *= 3) {
        if (cells[i] == 'X') board += p;
        if (cells[i] == 'O') board += 2 * p;
    }
    return board;
}

static void test_empty_board() {
    CHECK_EQ(engine_status(0), 0);
    CHECK_EQ(engine_win_line(0), -1);
    for (int i = 0; i < 9; ++i) CHECK_EQ(engine_cell(0, i), 0);
}

static void test_play_and_cells() {
    int b = engine_play(0, 1, 4);
    CHECK_EQ(b, board_of("....X...."));
    CHECK_EQ(engine_cell(b, 4), 1);
    b = engine_play(b, 2, 0);
    CHECK_EQ(engine_cell(b, 0), 2);
    CHECK_EQ(b, board_of("O...X...."));
}

static void test_illegal_moves() {
    int b = board_of("X........");
    CHECK_EQ(engine_play(b, 2, 0), -1);   // occupied
    CHECK_EQ(engine_play(b, 2, -1), -1);  // out of range
    CHECK_EQ(engine_play(b, 2, 9), -1);   // out of range
    CHECK_EQ(engine_play(b, 0, 1), -1);   // bad player
    CHECK_EQ(engine_play(b, 3, 1), -1);   // bad player
    CHECK_EQ(engine_play(-1, 1, 1), -1);  // bad board
    CHECK_EQ(engine_play(19683, 1, 1), -1);
    CHECK_EQ(engine_play(board_of("XXX.OO..."), 2, 3), -1); // game over
    CHECK_EQ(engine_status(-5), -1);
    CHECK_EQ(engine_cell(0, 9), -1);
}

static void test_every_win_line() {
    const char *wins[8] = {
        "XXX......", "...XXX...", "......XXX",
        "X..X..X..", ".X..X..X.", "..X..X..X",
        "X...X...X", "..X.X.X..",
    };
    for (int i = 0; i < 8; ++i) {
        CHECK_EQ(engine_status(board_of(wins[i])), 1);
        CHECK_EQ(engine_win_line(board_of(wins[i])), i);
    }
    CHECK_EQ(engine_status(board_of("OOOXX.X..")), 2);
    CHECK_EQ(engine_win_line(board_of("OOOXX.X..")), 0);
}

static void test_draw() {
    int b = board_of("XOXXOOOXX");
    CHECK_EQ(engine_status(b), 3);
    CHECK_EQ(engine_win_line(b), -1);
    // A full board with a win is a win, not a draw.
    CHECK_EQ(engine_status(board_of("XXXOOXOXO")), 1);
}

static void test_ai_takes_win_and_blocks() {
    // O to move can win at cell 5.
    CHECK_EQ(engine_best_move(board_of("XX.OO.X.."), 2, 2, 1), 5);
    // O to move must block X at cell 2.
    CHECK_EQ(engine_best_move(board_of("XX..O...."), 2, 2, 7), 2);
    CHECK_EQ(engine_best_move(board_of("XXXOO...."), 2, 2, 1), -1); // game over
}

// The unbeatable AI must never lose, whatever the opponent plays.
static int worst_outcome_for_ai(int board, int to_move, int ai) {
    int status = engine_status(board);
    if (status != 0) return status == ai ? 1 : (status == 3 ? 0 : -1);
    if (to_move == ai) {
        int cell = engine_best_move(board, ai, 2, (unsigned)board);
        return worst_outcome_for_ai(engine_play(board, ai, cell), 3 - ai, ai);
    }
    int worst = 1;
    for (int i = 0; i < 9; ++i) {
        int next = engine_play(board, to_move, i);
        if (next < 0) continue;
        int r = worst_outcome_for_ai(next, ai, ai);
        if (r < worst) worst = r;
    }
    return worst;
}

static void test_unbeatable_never_loses() {
    CHECK_EQ(worst_outcome_for_ai(0, 1, 2) >= 0, 1); // AI plays second
    CHECK_EQ(worst_outcome_for_ai(0, 1, 1) >= 0, 1); // AI plays first
}

static void test_easy_ai_plays_legal_moves() {
    int b = board_of("XO.X.O..X");
    for (unsigned seed = 0; seed < 50; ++seed) {
        for (int level = 0; level <= 2; ++level) {
            int cell = engine_best_move(board_of("XO.XO...."), 1, level, seed);
            CHECK_EQ(engine_cell(board_of("XO.XO...."), cell), 0);
        }
        CHECK_EQ(engine_play(b, 2, engine_best_move(b, 2, 0, seed)) >= 0, 1);
    }
}

int main() {
    test_empty_board();
    test_play_and_cells();
    test_illegal_moves();
    test_every_win_line();
    test_draw();
    test_ai_takes_win_and_blocks();
    test_unbeatable_never_loses();
    test_easy_ai_plays_legal_moves();
    if (failures) {
        std::printf("%d check(s) failed\n", failures);
        return 1;
    }
    std::printf("engine: all tests passed\n");
    return 0;
}
