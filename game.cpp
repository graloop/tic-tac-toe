#include <emscripten/emscripten.h>
#include <string>
#include <vector>
#include <sstream>

// Game state representation in C++
// Board: 9 cells, 0 = empty, 1 = 'X', 2 = 'O'
static int board[9] = {0,0,0,0,0,0,0,0,0};
static int currentPlayer = 1; // 1 for X, 2 for O
static int gameState = 0; // 0 = ongoing, 1 = X wins, 2 = O wins, 3 = draw
static int winningCombo[3] = {-1, -1, -1};
static int winType = -1; // 0-2: row, 3-5: col, 6-7: diag

// Winning combinations and their indices
const int WIN_CONDITIONS[8][3] = {
    {0, 1, 2}, {3, 4, 5}, {6, 7, 8}, // Rows
    {0, 3, 6}, {1, 4, 7}, {2, 5, 8}, // Cols
    {0, 4, 8}, {2, 4, 6}            // Diagonals
};

extern "C" {

EMSCRIPTEN_KEEPALIVE
void reset_game() {
    for(int i = 0; i < 9; ++i) {
        board[i] = 0;
    }
    currentPlayer = 1;
    gameState = 0;
    winningCombo[0] = -1;
    winningCombo[1] = -1;
    winningCombo[2] = -1;
    winType = -1;
}

EMSCRIPTEN_KEEPALIVE
int make_move(int index) {
    if (index < 0 || index >= 9) return 0;
    if (board[index] != 0 || gameState != 0) return 0;

    board[index] = currentPlayer;

    // Check for win
    for (int i = 0; i < 8; ++i) {
        int a = WIN_CONDITIONS[i][0];
        int b = WIN_CONDITIONS[i][1];
        int c = WIN_CONDITIONS[i][2];
        if (board[a] != 0 && board[a] == board[b] && board[a] == board[c]) {
            gameState = board[a]; // 1 or 2
            winningCombo[0] = a;
            winningCombo[1] = b;
            winningCombo[2] = c;
            winType = i;
            return 1;
        }
    }

    // Check for draw
    bool draw = true;
    for (int i = 0; i < 9; ++i) {
        if (board[i] == 0) {
            draw = false;
            break;
        }
    }
    if (draw && gameState == 0) {
        gameState = 3; // Draw
        return 1;
    }

    // Switch player
    currentPlayer = (currentPlayer == 1) ? 2 : 1;
    return 1;
}

// Returns a JSON-like or comma-separated string representing game state:
// "currentPlayer,gameState,winType,c0,c1,c2,b0,b1,b2,b3,b4,b5,b6,b7,b8"
EMSCRIPTEN_KEEPALIVE
const char* get_game_state_json() {
    static std::string result;
    std::ostringstream ss;
    ss << "{"
       << "\"currentPlayer\":" << currentPlayer << ","
       << "\"gameState\":" << gameState << ","
       << "\"winType\":" << winType << ","
       << "\"winningCombo\":[" << winningCombo[0] << "," << winningCombo[1] << "," << winningCombo[2] << "],"
       << "\"board\":[" << board[0] << "," << board[1] << "," << board[2] << ","
                        << board[3] << "," << board[4] << "," << board[5] << ","
                        << board[6] << "," << board[7] << "," << board[8] << "]"
       << "}";
    result = ss.str();
    return result.c_str();
}

}
