// The capture encoders against the real codec libraries, with no compositor:
// the production bodies are spliced in and their output decoded back, so a
// format, a MIME type or a channel order that is wrong fails here rather than
// in the server's image pipeline.
#include <bit>
#include <cairo/cairo.h>
#include <cmath>
#include <cstdint>
#include <cstdlib>
#include <format>
#include <iostream>
#include <png.h>
#include <stdexcept>
#include <string>
#include <turbojpeg.h>
#include <vector>

[[noreturn]] void captureFailed(const std::string& message) { throw std::runtime_error(message); }
void check(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

// PRODUCTION_DEFINITIONS

// A surface filled with one premultiplied ARGB32 pixel value.
cairo_surface_t* filled(int w, int h, uint32_t argb) {
    cairo_surface_t* surface = cairo_image_surface_create(CAIRO_FORMAT_ARGB32, w, h);
    unsigned char*   data    = cairo_image_surface_get_data(surface);
    const int        stride  = cairo_image_surface_get_stride(surface);
    for (int y = 0; y < h; ++y)
        for (int x = 0; x < w; ++x)
            reinterpret_cast<uint32_t*>(data + y * stride)[x] = argb;
    cairo_surface_mark_dirty(surface);
    return surface;
}

// Decodes a JPEG to RGB, checking its size.
std::vector<uint8_t> decodeJpeg(const std::vector<uint8_t>& jpeg, int w, int h) {
    tjhandle tj = tj3Init(TJINIT_DECOMPRESS);
    check(tj3DecompressHeader(tj, jpeg.data(), jpeg.size()) == 0, "JPEG header unreadable");
    check(tj3Get(tj, TJPARAM_JPEGWIDTH) == w && tj3Get(tj, TJPARAM_JPEGHEIGHT) == h, "JPEG has the wrong size");
    std::vector<uint8_t> rgb(size_t(w) * h * 3);
    check(tj3Decompress8(tj, jpeg.data(), jpeg.size(), rgb.data(), 0, TJPF_RGB) == 0, "JPEG does not decode");
    tj3Destroy(tj);
    return rgb;
}

// Decodes a PNG to non-premultiplied RGBA, checking its size and whether it
// carries an alpha channel.
std::vector<uint8_t> decodePng(const std::vector<uint8_t>& bytes, int w, int h, bool alpha) {
    png_image image{};
    image.version = PNG_IMAGE_VERSION;
    check(png_image_begin_read_from_memory(&image, bytes.data(), bytes.size()) != 0, "PNG header unreadable");
    check(int(image.width) == w && int(image.height) == h, "PNG has the wrong size");
    check(((image.format & PNG_FORMAT_FLAG_ALPHA) != 0) == alpha, "PNG alpha channel presence wrong");
    image.format = PNG_FORMAT_RGBA;
    std::vector<uint8_t> rgba(PNG_IMAGE_SIZE(image));
    check(png_image_finish_read(&image, nullptr, rgba.data(), 0, nullptr) != 0, "PNG does not decode");
    return rgba;
}

int main() {
    check(captureFormat(0) == CaptureFormat::Png && captureFormat(CAPTURE_FLAG_PASSIVE) == CaptureFormat::Png, "PNG is not the default format");
    check(captureFormat(CAPTURE_FLAG_JPEG) == CaptureFormat::Jpeg, "JPEG flag ignored");
    check(captureFormat(CAPTURE_FLAG_JPEG | CAPTURE_FLAG_LUMA) == CaptureFormat::Luma, "luma does not outrank JPEG");

    // Luma: BT.601 weights, one byte per pixel, rows without padding. The
    // 5-pixel width makes cairo's stride differ from the output row.
    {
        cairo_surface_t* surface = filled(5, 3, 0xff'ff'00'00); // opaque red
        auto*            data    = cairo_image_surface_get_data(surface);
        reinterpret_cast<uint32_t*>(data + cairo_image_surface_get_stride(surface))[4] = 0xff'ff'ff'ff; // white at (4, 1)
        reinterpret_cast<uint32_t*>(data)[1] = 0x00'00'00'00;                                              // transparent at (1, 0)
        cairo_surface_mark_dirty(surface);
        const SEncodedImage image = encodeCaptureImage(surface, CaptureFormat::Luma, true);
        check(image.mime == "image/x-luma8; width=5; height=3", "luma MIME type wrong");
        check(image.bytes.size() == 15, "luma image padded");
        // floor((299 R + 587 G + 114 B) / 1000): the server's PNG luma.
        check(image.bytes[0] == 76 && image.bytes[1] == 0 && image.bytes[5 + 4] == 255, "luma values wrong");
        cairo_surface_destroy(surface);
    }

    // Luma is what the server derives from the PNG of the same capture, pixel
    // for pixel, translucent pixels included: it measures one against the
    // other.
    for (const bool opaque : {true, false}) {
        cairo_surface_t* surface = filled(64, 16, 0xff'00'00'00);
        auto*            data    = cairo_image_surface_get_data(surface);
        const int        stride  = cairo_image_surface_get_stride(surface);
        uint32_t         seed    = 12345;
        for (int y = 0; y < 16; ++y)
            for (int x = 0; x < 64; ++x) {
                seed              = seed * 1664525u + 1013904223u;
                const uint32_t a  = opaque ? 255 : (seed >> 24);
                const auto     ch = [&](int shift) { return a == 0 ? 0u : ((seed >> shift) & 0xff) * a / 255; };
                reinterpret_cast<uint32_t*>(data + y * stride)[x] = (a << 24) | (ch(0) << 16) | (ch(8) << 8) | ch(16);
            }
        cairo_surface_mark_dirty(surface);
        const auto luma = encodeCaptureImage(surface, CaptureFormat::Luma, opaque).bytes;
        const auto rgba = decodePng(encodeCaptureImage(surface, CaptureFormat::Png, opaque).bytes, 64, 16, !opaque);
        for (size_t i = 0; i < luma.size(); ++i) {
            const int expected = (299 * rgba[i * 4] + 587 * rgba[i * 4 + 1] + 114 * rgba[i * 4 + 2]) / 1000;
            check(luma[i] == expected, "luma differs from the PNG's luma");
        }
        cairo_surface_destroy(surface);
    }

    // JPEG: decodes at the right size with the right colours, including the
    // channel order of cairo's native-endian words.
    {
        cairo_surface_t*    surface = filled(33, 17, 0xff'20'80'e0);
        const SEncodedImage image   = encodeCaptureImage(surface, CaptureFormat::Jpeg, true);
        check(image.mime == "image/jpeg", "JPEG MIME type wrong");
        check(image.bytes.size() > 2 && image.bytes[0] == 0xff && image.bytes[1] == 0xd8, "not a JPEG stream");
        const auto rgb = decodeJpeg(image.bytes, 33, 17);
        for (size_t i = 0; i < rgb.size(); i += 3)
            check(std::abs(rgb[i] - 0x20) < 8 && std::abs(rgb[i + 1] - 0x80) < 8 && std::abs(rgb[i + 2] - 0xe0) < 8, "JPEG colours wrong");
        cairo_surface_destroy(surface);
    }

    // PNG: lossless, unpremultiplied, and without an alpha channel for an
    // opaque capture.
    {
        cairo_surface_t* surface = filled(7, 5, 0xff'10'20'30);
        auto*            data    = cairo_image_surface_get_data(surface);
        const int        stride  = cairo_image_surface_get_stride(surface);
        reinterpret_cast<uint32_t*>(data + stride)[2]     = 0x80'40'20'10; // half-transparent (0x80,0x40,0x20) premultiplied
        reinterpret_cast<uint32_t*>(data + 2 * stride)[6] = 0x00'00'00'00; // transparent
        cairo_surface_mark_dirty(surface);
        const SEncodedImage image = encodeCaptureImage(surface, CaptureFormat::Png, false);
        check(image.mime == "image/png", "PNG MIME type wrong");
        const auto rgba = decodePng(image.bytes, 7, 5, true);
        const auto at   = [&](int x, int y, int c) { return int(rgba[(size_t(y) * 7 + x) * 4 + c]); };
        check(at(0, 0, 0) == 0x10 && at(0, 0, 1) == 0x20 && at(0, 0, 2) == 0x30 && at(0, 0, 3) == 0xff, "PNG opaque pixel wrong");
        check(at(2, 1, 0) == 0x80 && at(2, 1, 1) == 0x40 && at(2, 1, 2) == 0x20 && at(2, 1, 3) == 0x80, "PNG pixel not unpremultiplied");
        check(at(6, 2, 3) == 0, "PNG transparency lost");
        const auto opaque = decodePng(encodeCaptureImage(surface, CaptureFormat::Png, true).bytes, 7, 5, false);
        check(opaque[0] == 0x10 && opaque[1] == 0x20 && opaque[2] == 0x30 && opaque[3] == 0xff, "opaque PNG pixel wrong");
        cairo_surface_destroy(surface);
    }

    std::cout << "Capture encoders produce the declared formats, sizes and colours.\n";
}
