#pragma once
#include <cstdint>
#include <vector>

// wl_output_transform maps native output pixels into compositor coordinates.
inline void transformCapturePixels(std::vector<uint8_t>& pixels, int& width, int& height, unsigned transform) {
    if (transform == 0 || transform > 7) return;
    const int outWidth = (transform & 1) ? height : width;
    const int outHeight = (transform & 1) ? width : height;
    std::vector<uint8_t> result(pixels.size());
    for (int y = 0; y < height; ++y) for (int x = 0; x < width; ++x) {
        int dx = x, dy = y;
        switch (transform) {
            case 1: dx = y; dy = width - 1 - x; break;
            case 2: dx = width - 1 - x; dy = height - 1 - y; break;
            case 3: dx = height - 1 - y; dy = x; break;
            case 4: dx = width - 1 - x; break;
            case 5: dx = y; dy = x; break;
            case 6: dy = height - 1 - y; break;
            case 7: dx = height - 1 - y; dy = width - 1 - x; break;
        }
        for (int channel = 0; channel < 4; ++channel)
            result[(size_t(dy) * outWidth + dx) * 4 + channel] = pixels[(size_t(y) * width + x) * 4 + channel];
    }
    pixels = std::move(result);
    width = outWidth;
    height = outHeight;
}
