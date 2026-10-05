OUT := build/public

# Exported engine functions (must match engine/engine.cpp).
EXPORTS := _engine_status,_engine_win_line,_engine_cell,_engine_play,_engine_best_move

EMFLAGS := -O3 \
	-sMODULARIZE=1 \
	-sEXPORT_NAME=createEngine \
	-sENVIRONMENT=web,node \
	-sEXPORTED_FUNCTIONS=$(EXPORTS) \
	-sDYNAMIC_EXECUTION=0 \
	-sFILESYSTEM=0

.PHONY: build test test-engine test-server run clean

build: $(OUT)/engine.js
	cp web/* $(OUT)/

$(OUT)/engine.js: engine/engine.cpp
	mkdir -p $(OUT)
	em++ engine/engine.cpp -o $@ $(EMFLAGS)

test: test-engine test-server

test-engine:
	mkdir -p build
	c++ -std=c++17 -Wall -Wextra -Werror -o build/engine_test engine/engine_test.cpp
	./build/engine_test

test-server: build
	cd server && node --test

# Local play without Docker: make run ACCESS_CODE=your-code
run: build
	ACCESS_CODE="$(ACCESS_CODE)" node server/index.mjs

clean:
	rm -rf build
