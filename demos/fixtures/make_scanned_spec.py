import sys
from PIL import Image, ImageDraw, ImageFont
sys.path.insert(0, sys.argv[1])
from make import text_pdf  # reuse the minimal text PDF writer
out = sys.argv[2]
text_pdf(f"{out}/p1.pdf", [["Relay Wire Protocol v2", "", "1. Scope",
  "This document specifies the binary frame header used between relay gateways",
  "and workers. All multi-byte integers are big-endian (network byte order).",
  "", "2. Frame header", "The header layout is given in Table 1 on the next page.",
  "A receiver MUST reject a frame whose magic or version does not match."]])
img = Image.new("RGB", (1275, 1650), (250, 249, 245))
d = ImageDraw.Draw(img)
F = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
big, mid = ImageFont.truetype(F, 40), ImageFont.truetype(F, 30)
d.text((110, 140), "Table 1 - Frame header (16 bytes)", fill="black", font=big)
cols = [110, 380, 540, 680, 900, 1180]
rows = [("Field", "Offset", "Size", "Type", "Notes"),
        ("magic", "0", "2", "uint16", 'always 0x5244 ("RD")'),
        ("version", "2", "1", "uint8", "must be 2"),
        ("flags", "3", "1", "uint8", "bit0 compressed"),
        ("", "", "", "", "bit1 encrypted"),
        ("length", "4", "4", "uint32", "payload bytes"),
        ("request_id", "8", "8", "uint64", "unique per request")]
y = 240
for i, r in enumerate(rows):
    d.line((cols[0]-20, y-12, cols[-1], y-12), fill="black", width=3 if i < 2 else 1)
    for x, cell in zip(cols, r):
        d.text((x, y), cell, fill="black", font=mid)
    y += 70
d.line((cols[0]-20, y-12, cols[-1], y-12), fill="black", width=3)
img = img.rotate(0.6, fillcolor=(250, 249, 245))
img.save(f"{out}/p2.pdf", "PDF", resolution=150.0)
