#include <cstddef>
#include "../capturetransform.h"
#include <cassert>
#include <array>
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
        assert(width == ((transform & 1) ? 2 : 3));
        assert(height == ((transform & 1) ? 3 : 2));
        for (int i = 0; i < 6; ++i) for (int channel = 0; channel < 4; ++channel)
            assert(pixels[i * 4 + channel] == expected[transform][i]);
    }
}
