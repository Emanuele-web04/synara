// The partial readback and the worker's stitching, with no compositor and no
// GL: captureLayerRect picks the native pixels a capture needs from a rotated
// output, and encodeCapture places them in an image of the final size. The
// "framebuffer" is an array with a distinct value per pixel, so any pixel read
// from the wrong place, or placed in the wrong place, is caught.
#include <algorithm>
#include <cairo/cairo.h>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <optional>
#include <stdexcept>
#include <string>
#include <vector>
#include "capturetransform.h" // the plugin directory is on the include path

struct CBox { double x = 0, y = 0, w = 0, h = 0; };
[[noreturn]] void captureFailed(const std::string& message) { throw std::runtime_error(message); }
void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

enum class CaptureFormat { Png };
struct SEncodedImage { std::vector<uint8_t> bytes; std::string mime; };
struct SGhostSnapshot {};
void drawGhostCursorOverlay(cairo_t*, const SGhostSnapshot&, const CBox&, double, double) {}
struct SCapturePixels { std::vector<uint8_t> rgba; int w = 0, h = 0; };
struct SCaptureLayer {
    SCapturePixels pixels;
    unsigned       transform = 0;
    CBox           box;
    const uint8_t* mapped = nullptr;
};
struct SCaptureJob {
    CBox                       region;
    int                        targetW = 1, targetH = 1;
    bool                       opaque = true;
    CaptureFormat              format = CaptureFormat::Png;
    SGhostSnapshot             ghost;
    std::vector<SCaptureLayer> layers;
    SEncodedImage              image;
};
// The finished image, as raw ARGB32 words, in place of an encoder.
int finishedW = 0, finishedH = 0;
SEncodedImage finishCapture(cairo_surface_t* surface, CaptureFormat, bool) {
    cairo_surface_flush(surface);
    finishedW = cairo_image_surface_get_width(surface);
    finishedH = cairo_image_surface_get_height(surface);
    SEncodedImage image;
    for (int y = 0; y < finishedH; ++y) {
        const auto* row = cairo_image_surface_get_data(surface) + y * cairo_image_surface_get_stride(surface);
        image.bytes.insert(image.bytes.end(), row, row + finishedW * 4);
    }
    cairo_surface_destroy(surface);
    return image;
}

// PRODUCTION_DEFINITIONS

// A native framebuffer whose every pixel is opaque with a distinct colour.
std::vector<uint8_t> framebuffer(int w, int h) {
    std::vector<uint8_t> rgba;
    for (int i = 0; i < w * h; ++i) {
        rgba.push_back(uint8_t(i & 0xff));
        rgba.push_back(uint8_t((i >> 8) & 0xff));
        rgba.push_back(uint8_t(i * 7 & 0xff));
        rgba.push_back(0xff);
    }
    return rgba;
}

// What a glReadPixels of `rect` from the array returns.
std::vector<uint8_t> readRect(const std::vector<uint8_t>& fb, int fbW, const SPixelRect& rect) {
    std::vector<uint8_t> out;
    for (int y = rect.y; y < rect.y + rect.h; ++y)
        out.insert(out.end(), fb.begin() + (size_t(y) * fbW + rect.x) * 4, fb.begin() + (size_t(y) * fbW + rect.x + rect.w) * 4);
    return out;
}

uint32_t argbOf(const std::vector<uint8_t>& rgba, size_t index) {
    return (uint32_t(rgba[index * 4 + 3]) << 24) | (uint32_t(rgba[index * 4]) << 16) | (uint32_t(rgba[index * 4 + 1]) << 8) | rgba[index * 4 + 2];
}

int main() {
    // A 40x20 logical output at (100, 50) at scale 2: 80x40 pixels in its
    // logical orientation, a 40x80 framebuffer under an odd (90 or 270
    // degree) transform.
    const CBox monitor{100, 50, 40, 20};
    const int  fbW = 40, fbH = 80;
    for (const unsigned transform : {0u, 1u, 2u, 3u, 4u, 5u, 6u, 7u}) {
        const int nativeW = (transform & 1) ? fbW : 80, nativeH = (transform & 1) ? fbH : 40;
        const auto fb = framebuffer(nativeW, nativeH);
        std::vector<uint8_t> whole = fb;
        int                  tw = nativeW, th = nativeH;
        transformCapturePixels(whole, tw, th, transform);
        check(tw == 80 && th == 40, "transformed output has the wrong size");

        // A region straddling the output's left edge: only its part on the
        // output is read, and only those pixels.
        const CBox need{95, 55, 15, 5};
        const auto rect = captureLayerRect(monitor, nativeW, nativeH, transform, need);
        check(rect.has_value(), "no layer for an overlapping region");
        check(rect->native.w * rect->native.h == 20 * 10, "readback is not just the needed pixels");
        check(rect->box.x == 100 && rect->box.y == 55 && rect->box.w == 10 && rect->box.h == 5, "layer box wrong");
        check(!captureLayerRect(monitor, nativeW, nativeH, transform, CBox{0, 0, 50, 50}), "layer for a region off the output");

        // Stitched at native size (scale 2), the image is exactly the needed
        // part of the transformed output, with black where no output is.
        SCaptureJob job;
        job.region  = need;
        job.targetW = 30;
        job.targetH = 10;
        SCaptureLayer layer;
        layer.transform   = transform;
        layer.box         = rect->box;
        layer.pixels.w    = rect->native.w;
        layer.pixels.h    = rect->native.h;
        const auto mapped = readRect(fb, nativeW, rect->native);
        layer.mapped      = mapped.data(); // as a mapped pixel-pack buffer
        job.layers.push_back(layer);
        encodeCapture(job);
        check(finishedW == 30 && finishedH == 10, "image not at the target size");
        const auto* words = reinterpret_cast<const uint32_t*>(job.image.bytes.data());
        for (int y = 0; y < 10; ++y)
            for (int x = 0; x < 30; ++x) {
                const uint32_t got = words[y * 30 + x];
                if (x < 10)
                    check(got == 0xff000000, "no-output area not black");
                else
                    check(got == argbOf(whole, size_t(10 + y) * 80 + (x - 10)), "stitched pixel differs from the output's");
            }
    }

    // A downscaled capture is stitched straight at its final size.
    {
        const auto fb   = framebuffer(80, 40);
        const auto rect = captureLayerRect(monitor, 80, 40, 0, monitor);
        int        tw = 0, th = 0;
        captureTargetSize(80, 40, 20, tw, th);
        check(tw == 20 && th == 10, "target size does not fit maxDimension");
        captureTargetSize(80, 40, 0, tw, th);
        check(tw == 80 && th == 40, "uncapped target is not native");
        SCaptureJob job;
        job.region = monitor;
        captureTargetSize(80, 40, 20, job.targetW, job.targetH);
        SCaptureLayer layer;
        layer.box         = rect->box;
        layer.pixels.w    = rect->native.w;
        layer.pixels.h    = rect->native.h;
        layer.pixels.rgba = readRect(fb, 80, rect->native); // as a synchronous readback
        job.layers.push_back(layer);
        encodeCapture(job);
        check(finishedW == 20 && finishedH == 10, "downscaled image has the wrong size");
    }
    std::cout << "Partial readback rectangles and target-size stitching are pixel exact under every transform.\n";
}
