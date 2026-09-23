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

// A rectangle of whole pixels.
struct SPixelRect {
    int x = 0, y = 0, w = 0, h = 0;
};

// The native (as-read) framebuffer rectangle whose image under `transform` is
// `logical`, a rectangle in the transformed image. A wl_output_transform is a
// rotation or reflection of the whole image, so the preimage of an
// axis-aligned rectangle is one too, and transformCapturePixels applied to
// just those native pixels gives exactly `logical`'s part of the transformed
// whole: a capture can read back only the pixels it needs.
inline SPixelRect nativeRectForTransformed(const SPixelRect& logical, int nativeWidth, int nativeHeight, unsigned transform) {
    if (logical.w <= 0 || logical.h <= 0)
        return {};
    const int  W       = nativeWidth, H = nativeHeight;
    const auto inverse = [&](int dx, int dy, int& x, int& y) {
        switch (transform) {
            case 1: x = W - 1 - dy; y = dx; break;
            case 2: x = W - 1 - dx; y = H - 1 - dy; break;
            case 3: x = dy; y = H - 1 - dx; break;
            case 4: x = W - 1 - dx; y = dy; break;
            case 5: x = dy; y = dx; break;
            case 6: x = dx; y = H - 1 - dy; break;
            case 7: x = W - 1 - dy; y = H - 1 - dx; break;
            default: x = dx; y = dy; break;
        }
    };
    int ax = 0, ay = 0, bx = 0, by = 0;
    inverse(logical.x, logical.y, ax, ay);
    inverse(logical.x + logical.w - 1, logical.y + logical.h - 1, bx, by);
    const int x0 = ax < bx ? ax : bx, x1 = ax < bx ? bx : ax;
    const int y0 = ay < by ? ay : by, y1 = ay < by ? by : ay;
    return {x0, y0, x1 - x0 + 1, y1 - y0 + 1};
}
