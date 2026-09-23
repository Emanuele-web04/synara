#include <cstddef>
#include "../capturetransform.h"
#include <array>
#include <cstdio>
#include <cstdlib>

// A failed check exits with a status rather than aborting, so a failing run
// dumps no core (see compile_and_run in focus_test.py).
#define CHECK(condition)                                                                   \
    do {                                                                                   \
        if (!(condition)) {                                                                \
            std::fprintf(stderr, "check failed at line %d: %s\n", __LINE__, #condition); \
            std::exit(1);                                                                  \
        }                                                                                  \
    } while (0)
int main() {
    // Non-square output, with a distinct marker at every pixel.
    const std::array<std::array<int, 6>, 8> expected = {{
        {1,2,3,4,5,6}, {3,6,2,5,1,4}, {6,5,4,3,2,1}, {4,1,5,2,6,3},
        {3,2,1,6,5,4}, {1,4,2,5,3,6}, {4,5,6,1,2,3}, {6,3,5,2,4,1}
    }};
    for (unsigned transform = 0; transform < 8; ++transform) {
        std::vector<uint8_t> pixels;
        for (int value = 1; value <= 6; ++value) pixels.insert(pixels.end(), 4, value);
        int width = 3, height = 2;
        transformCapturePixels(pixels, width, height, transform);
        CHECK(width == ((transform & 1) ? 2 : 3));
        CHECK(height == ((transform & 1) ? 3 : 2));
        for (int i = 0; i < 6; ++i) for (int channel = 0; channel < 4; ++channel)
            CHECK(pixels[i * 4 + channel] == expected[transform][i]);
    }

    // Reading back only a sub-rectangle: for every transform and every
    // rectangle of a non-square image, transforming just the native pixels
    // nativeRectForTransformed names gives the same pixels as cropping the
    // transformed whole.
    const int W = 5, H = 3;
    std::vector<uint8_t> native;
    for (int i = 0; i < W * H; ++i) native.insert(native.end(), 4, uint8_t(i + 1));
    for (unsigned transform = 0; transform < 8; ++transform) {
        std::vector<uint8_t> whole = native;
        int tw = W, th = H;
        transformCapturePixels(whole, tw, th, transform);
        for (int y = 0; y < th; ++y) for (int x = 0; x < tw; ++x)
        for (int h = 1; y + h <= th; ++h) for (int w = 1; x + w <= tw; ++w) {
            const SPixelRect n = nativeRectForTransformed({x, y, w, h}, W, H, transform);
            CHECK(n.x >= 0 && n.y >= 0 && n.x + n.w <= W && n.y + n.h <= H);
            std::vector<uint8_t> part;
            for (int ny = n.y; ny < n.y + n.h; ++ny)
                part.insert(part.end(), native.begin() + (ny * W + n.x) * 4, native.begin() + (ny * W + n.x + n.w) * 4);
            int pw = n.w, ph = n.h;
            transformCapturePixels(part, pw, ph, transform);
            CHECK(pw == w && ph == h);
            for (int py = 0; py < h; ++py) for (int px = 0; px < w; ++px)
                CHECK(part[(py * w + px) * 4] == whole[((y + py) * tw + x + px) * 4]);
        }
    }
}
