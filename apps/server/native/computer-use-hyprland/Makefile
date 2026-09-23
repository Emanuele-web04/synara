# Builds the Synara computer-use plugin for the Hyprland version installed on
# this machine. Hyprland's plugin ABI churns per release, so like the KWin
# plugin this is a per-version build; the loader refuses a mismatched .so.
#
# `--no-gnu-unique` matters: without it the .so cannot be fully unloaded and a
# reload after rebuild dlopens the stale image.

HYPR_VERSION   := $(shell pkg-config --modversion hyprland 2>/dev/null || echo unknown)
GIT_HASH       := $(shell git rev-parse --short HEAD 2>/dev/null || echo unknown)
BUILD_TS       := $(shell date -u +%Y-%m-%dT%H:%M:%SZ)

CXX            ?= g++
# One standard for everything compiled here, production and fixtures alike: a
# fixture built against a different language mode is not exercising the code
# that ships, and the differences (aggregate init, defaulted comparisons) are
# exactly the kind that compile one way and not the other.
CXXSTD         ?= c++26
PKGS           := hyprland pixman-1 libdrm sdbus-c++ cairo xkbcommon libturbojpeg libpng
CXXFLAGS       += -shared -fPIC --no-gnu-unique -std=$(CXXSTD) -O2 -g \
                  $(shell pkg-config --cflags $(PKGS)) \
                  -DSYNARA_CU_BUILD_ID='"hyprland-$(HYPR_VERSION)"' \
                  -DSYNARA_CU_GIT_HASH='"$(GIT_HASH)"' \
                  -DSYNARA_CU_BUILD_TS='"$(BUILD_TS)"'
LDLIBS         := $(shell pkg-config --libs sdbus-c++ cairo xkbcommon libturbojpeg libpng)

OUT            := SynaraComputerUseHyprland.so

# The session-auth probe: a standalone binary exposing the plugin's own
# SynaraSessionAuth over D-Bus, so the token gate can be exercised against a
# real bus without a compositor anywhere. Needs no Hyprland headers, which is
# why it is a separate target and not part of `all`.
AUTHPROBE      := tests/authprobe
AUTHPROBE_PKGS := sdbus-c++

all: $(OUT)

$(OUT): synarahyprlandplugin.cpp capturetransform.h sessionauth.h
	$(CXX) $(CXXFLAGS) $< -o $@ $(LDLIBS)

$(AUTHPROBE): tests/authprobe.cpp sessionauth.h
	$(CXX) -std=$(CXXSTD) -Wall -Wextra -O1 -g \
	    $(shell pkg-config --cflags $(AUTHPROBE_PKGS)) \
	    $< -o $@ $(shell pkg-config --libs $(AUTHPROBE_PKGS))

authprobe: $(AUTHPROBE)

clean:
	rm -f $(OUT) $(AUTHPROBE)

test:
	python3 tests/focus_test.py

.PHONY: all authprobe clean test
