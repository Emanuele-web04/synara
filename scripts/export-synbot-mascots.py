#!/usr/bin/env python3
"""Export SynBot's SVG layers into individual iOS vector image sets."""

import argparse
import json
import xml.etree.ElementTree as ET
from pathlib import Path

ARTWORK = Path(__file__).resolve().parents[1] / (
    "apps/web/src/components/synbot/kit/synbot-mascots.svg"
)
SVG = "http://www.w3.org/2000/svg"

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("catalog", type=Path, help="Path to SynaraIOS's Assets.xcassets")
args = parser.parse_args()

ET.register_namespace("", SVG)
artwork = ET.parse(ARTWORK)
for layer in artwork.findall(f"./{{{SVG}}}defs/{{{SVG}}}g"):
    name = f"synbot-mascot-{layer.attrib.pop('id')}"
    image_set = args.catalog / "SynBotMascots" / f"{name}.imageset"
    image_set.mkdir(parents=True, exist_ok=True)
    # Leave room below the tile for the bust to move. SwiftUI clips at the tile's edge.
    graphic = ET.Element(
        f"{{{SVG}}}svg", width="100", height="110", viewBox="0 0 100 110"
    )
    graphic.append(layer)
    ET.indent(graphic, space="  ")
    filename = f"{name}.svg"
    (image_set / filename).write_text(
        ET.tostring(graphic, encoding="unicode", short_empty_elements=True) + "\n",
        encoding="utf-8",
    )
    contents = {
        "images": [{"filename": filename, "idiom": "universal"}],
        "info": {"author": "xcode", "version": 1},
        "properties": {"preserves-vector-representation": True},
    }
    (image_set / "Contents.json").write_text(
        json.dumps(contents, indent=2) + "\n", encoding="utf-8"
    )
