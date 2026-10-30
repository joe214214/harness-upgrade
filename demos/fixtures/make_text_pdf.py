import sys, zlib
from PIL import Image, ImageDraw, ImageFont
out = sys.argv[1]

def text_pdf(path, pages):
    objs = []
    def add(b): objs.append(b); return len(objs)
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    kids = []
    page_ids = []
    pages_id = len(objs) + 1 + 2*len(pages)  # placeholder computed later
    contents = []
    for lines in pages:
        ops = ["BT /F1 12 Tf 72 720 Td 16 TL"]
        for l in lines:
            ops.append("(" + l.replace("\\","\\\\").replace("(","\\(").replace(")","\\)") + ") Tj T*")
        ops.append("ET")
        data = "\n".join(ops).encode()
        contents.append(add(b"<< /Length %d >>\nstream\n" % len(data) + data + b"\nendstream"))
    pages_obj = len(objs) + len(pages) + 1
    for c in contents:
        page_ids.append(add(b"<< /Type /Page /Parent %d 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>" % (pages_obj, font, c)))
    assert add(b"<< /Type /Pages /Kids [%s] /Count %d >>" % (b" ".join(b"%d 0 R" % i for i in page_ids), len(page_ids))) == pages_obj
    cat = add(b"<< /Type /Catalog /Pages %d 0 R >>" % pages_obj)
    buf = bytearray(b"%PDF-1.4\n")
    offs = []
    for i, o in enumerate(objs, 1):
        offs.append(len(buf)); buf += b"%d 0 obj\n" % i + o + b"\nendobj\n"
    x = len(buf)
    buf += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs)+1)
    for o in offs: buf += b"%010d 00000 n \n" % o
    buf += b"trailer\n<< /Size %d /Root %d 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objs)+1, cat, x)
    open(path, "wb").write(buf)

body = ["The relay gateway accepts OpenAI compatible requests and queues them.",
        "Workers consume jobs from Redis Streams with consumer groups and XAUTOCLAIM.",
        "Rate limits use a Lua token bucket so that read and write stay atomic."]
text_pdf(f"{out}/spec.pdf", [
    ["Relay Protocol Specification", "Section 1: Overview"] + body,
    ["Section 2: Limits", "The default request limit is 120 requests per minute.", "Queue depth above 500 returns HTTP 503 with Retry-After."] + body,
    ["Section 3: Error codes", "E401 means the API key is missing or revoked.", "E429 means a rate limit was exceeded."] + body,
])

img = Image.new("RGB", (850, 1100), "white")
d = ImageDraw.Draw(img)
try:
    f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", 40)
except OSError:
    f = ImageFont.load_default()
d.text((80, 120), "SCANNED INVOICE", fill="black", font=f)
d.text((80, 220), "Invoice no: INV-7731", fill="black", font=f)
d.rectangle((70, 320, 780, 520), outline="black", width=3)
d.text((80, 340), "Item      Qty   Price", fill="black", font=f)
d.text((80, 420), "GPU hours   12   $4217", fill="black", font=f)
img.save(f"{out}/scan.pdf", "PDF", resolution=100.0)
