"""One-off lossless size audit. Requires Pillow==11.3.0; no runtime dependency.

Replace only IDAT chunks. Preserve IHDR, color profiles, gamma, physical sizing,
EXIF and all other metadata byte-for-byte. Never resize, quantize, or grow files.
"""
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import struct
import zlib
from PIL import Image

FILES = [
    "apps/desktop/resources/app-icon-macos.png",
    "apps/desktop/resources/app-icon-linux.png",
    "apps/desktop/resources/synara.png",
    "apps/desktop/resources/icon.png",
    "apps/desktop/resources/dock-icon.png",
    "apps/desktop/resources/dock-icon-dark.png",
    "apps/web/public/app-icons/default.png",
    "apps/web/public/app-icons/dark.png",
    "apps/web/public/app-icons/safari.png",
    "apps/web/public/app-icons/icon-group-600-macos.png",
    "apps/web/public/synara.png",
]
SIGNATURE = b"\x89PNG\r\n\x1a\n"


def chunks(data):
    if data[:8] != SIGNATURE:
        raise ValueError("Not a PNG")
    offset = 8
    result = []
    while offset < len(data):
        length = struct.unpack(">I", data[offset:offset + 4])[0]
        chunk = data[offset:offset + length + 12]
        if len(chunk) != length + 12:
            raise ValueError("Truncated PNG chunk")
        kind = chunk[4:8]
        if zlib.crc32(chunk[4:-4]) != struct.unpack(">I", chunk[-4:])[0]:
            raise ValueError("Invalid PNG CRC")
        result.append((kind, chunk))
        offset += length + 12
    if result[0][0] != b"IHDR" or result[-1][0] != b"IEND":
        raise ValueError("Invalid PNG framing")
    return result


report = []
for filename in FILES:
    path = Path(filename)
    before = path.read_bytes()
    original = chunks(before)
    image = Image.open(BytesIO(before))
    image.load()
    if image.n_frames != 1:
        raise ValueError(f"Refusing animated PNG: {filename}")
    encoded = BytesIO()
    image.save(encoded, format="PNG", optimize=True)
    optimized = chunks(encoded.getvalue())
    if original[0] != optimized[0]:
        raise ValueError(f"Pixel format or dimensions changed: {filename}")
    idat = b"".join(chunk for kind, chunk in optimized if kind == b"IDAT")
    after = SIGNATURE
    inserted = False
    for kind, chunk in original:
        if kind != b"IDAT":
            after += chunk
        elif not inserted:
            after += idat
            inserted = True
    assert inserted
    assert [(kind, chunk) for kind, chunk in chunks(after) if kind != b"IDAT"] == [
        (kind, chunk) for kind, chunk in original if kind != b"IDAT"
    ]
    decoded = Image.open(BytesIO(after))
    assert decoded.mode == image.mode and decoded.size == image.size
    assert decoded.tobytes() == image.tobytes(), f"Pixels changed: {filename}"
    if len(after) < len(before):
        path.write_bytes(after)
    else:
        after = before
    report.append({"path": filename, "before": len(before), "after": len(after),
                   "saved": len(before) - len(after), "pixelsSha256": sha256(image.tobytes()).hexdigest(),
                   "beforeSha256": sha256(before).hexdigest(), "afterSha256": sha256(after).hexdigest(),
                   "metadataPreserved": True})
print(json.dumps(report, indent=2))
