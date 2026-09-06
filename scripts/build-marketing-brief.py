from __future__ import annotations

import html
import os
import re
from pathlib import Path

from PIL import Image as PILImage
from pypdf import PdfReader, PdfWriter
from reportlab.lib.colors import HexColor
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    Image,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "docs/openarc-marketing-sourcebook.md"
LOGO_SOURCE = ROOT / "assets/openarc-logo.jpeg"
OUTPUT = ROOT / "output/pdf/OpenArc-Marketing-Brief.pdf"
TMP_DIR = ROOT / "tmp/pdfs"
LOGO_MARK = TMP_DIR / "openarc-logo-mark.png"
COVER = TMP_DIR / "openarc-marketing-cover.pdf"
BODY = TMP_DIR / "openarc-marketing-body.pdf"
MERGED = TMP_DIR / "openarc-marketing-merged.pdf"

PAGE_W, PAGE_H = letter
PAPER = HexColor("#f6f5f0")
WHITE = HexColor("#ffffff")
INK = HexColor("#08172f")
DEEP_ARC = HexColor("#0b4db8")
SIGNAL_BLUE = HexColor("#197fcf")
OPEN_SKY = HexColor("#69bce3")
HORIZON_GOLD = HexColor("#efb94f")
SOFT_GOLD = HexColor("#f7d98b")
SLATE = HexColor("#536277")
MUTED = HexColor("#718096")
CLOUD = HexColor("#dce5eb")
PALE_BLUE = HexColor("#eaf4fa")
PANEL = HexColor("#fbfcfd")


def prepare_logo() -> None:
    """Create a tight crop and key out the paper while preserving colored grain."""
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    image = PILImage.open(LOGO_SOURCE).convert("RGB")
    width, height = image.size
    left = int(width * 0.19)
    top = int(height * 0.19)
    right = int(width * 0.81)
    bottom = int(height * 0.81)
    cropped = image.crop((left, top, right, bottom)).convert("RGBA")
    keyed: list[tuple[int, int, int, int]] = []
    pixels = (
        cropped.get_flattened_data()
        if hasattr(cropped, "get_flattened_data")
        else cropped.getdata()
    )
    for red, green, blue, _ in pixels:
        chroma = max(red, green, blue) - min(red, green, blue)
        darkness = 255 - min(red, green, blue)
        strength = max(chroma * 2.2, darkness * 1.3)
        alpha = max(0, min(255, int((strength - 12) * 3.1)))
        keyed.append((red, green, blue, alpha))
    cropped.putdata(keyed)
    cropped.save(LOGO_MARK, format="PNG", optimize=True)


def draw_dots(c: canvas.Canvas) -> None:
    c.saveState()
    c.setFillColor(CLOUD)
    for row in range(19):
        for col in range(26):
            c.circle(355 + col * 10, PAGE_H - 10 - row * 10, 0.42, 0, 1)
    c.restoreState()


def draw_logo(c: canvas.Canvas, x: float, y: float, size: float) -> None:
    c.drawImage(
        str(LOGO_MARK),
        x,
        y,
        width=size,
        height=size,
        preserveAspectRatio=True,
        mask="auto",
    )


def make_cover() -> None:
    c = canvas.Canvas(str(COVER), pagesize=letter)
    c.setTitle("OpenArc Marketing + Technical Brief")
    c.setAuthor("OpenArc")
    c.setSubject("Verified Arc Testnet specifications, product architecture, evidence model, positioning, and launch system")
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, 0, 1)
    draw_dots(c)

    draw_logo(c, 36, 718, 36)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(80, 736, "OPENARC")
    c.setFillColor(MUTED)
    c.setFont("Courier-Bold", 7)
    c.drawRightString(574, 736, "MARKETING + TECHNICAL SOURCE / 2026-09-01")
    c.setStrokeColor(CLOUD)
    c.setLineWidth(0.8)
    c.line(38, 707, 574, 707)

    c.setFillColor(DEEP_ARC)
    c.roundRect(38, 650, 536, 32, 6, 0, 1)
    c.setFillColor(WHITE)
    c.setFont("Courier-Bold", 7.2)
    c.drawString(54, 662, "VERIFIED TESTNET FACTS + PROPOSED OPENARC ARCHITECTURE")

    c.setFillColor(INK)
    c.setFont("Helvetica", 34)
    c.drawString(38, 570, "Marketing +")
    c.setFillColor(SIGNAL_BLUE)
    c.setFont("Times-Italic", 34)
    c.drawString(38, 526, "technical brief.")
    c.setFillColor(SLATE)
    c.setFont("Helvetica", 10.8)
    c.drawString(38, 485, "A combined product narrative, verified Arc Testnet reference, system")
    c.drawString(38, 468, "architecture, evidence model, release plan, and communications system.")

    draw_logo(c, 408, 500, 136)

    blocks = [
        ("POSITIONING", "Agent activity, made legible"),
        ("VERIFIED TESTNET", "Current chain, contracts, and limits"),
        ("SYSTEM DESIGN", "Private evidence graph + narrow API"),
        ("BUILD + LAUNCH", "Schemas, tests, migration, and claims"),
    ]
    for idx, (head, body) in enumerate(blocks):
        col = idx % 2
        row = idx // 2
        x = 38 + col * 274
        y = 300 - row * 104
        c.setFillColor(WHITE)
        c.setStrokeColor(CLOUD)
        c.setLineWidth(1.2)
        c.roundRect(x, y, 260, 88, 8, 1, 1)
        c.setFillColor(DEEP_ARC if idx != 2 else HORIZON_GOLD)
        c.setFont("Courier-Bold", 6.5)
        c.drawString(x + 15, y + 61, head)
        c.setFillColor(INK)
        c.setFont("Helvetica", 9.8)
        c.drawString(x + 15, y + 38, body)

    c.setFillColor(INK)
    c.setStrokeColor(INK)
    c.roundRect(38, 64, 536, 78, 9, 1, 1)
    c.setFillColor(HORIZON_GOLD)
    c.setFont("Courier-Bold", 6.4)
    c.drawString(54, 117, "THE NON-NEGOTIABLE LINE")
    c.setFillColor(WHITE)
    c.setFont("Helvetica", 13)
    c.drawString(54, 92, "Observe and reconcile. Never pretend to know the missing evidence.")
    c.setFillColor(OPEN_SKY)
    c.setFont("Helvetica", 8.5)
    c.drawString(54, 75, "Arc Testnet concept. No custody, signing, hidden reasoning, or mainnet claim.")
    c.showPage()
    c.save()


def inline_markup(value: str) -> str:
    value = html.escape(value.strip())
    value = re.sub(
        r"\[([^\]]+)\]\(([^)]+)\)",
        r'<link href="\2" color="#0b4db8"><u>\1</u></link>',
        value,
    )
    value = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", value)
    value = re.sub(
        r"`([^`]+)`",
        r'<font face="Courier" color="#0b4db8">\1</font>',
        value,
    )
    return value


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "section_label": ParagraphStyle(
            "section_label",
            parent=base["Normal"],
            fontName="Courier-Bold",
            fontSize=6.5,
            leading=8,
            textColor=DEEP_ARC,
            spaceAfter=7,
            keepWithNext=True,
        ),
        "h2": ParagraphStyle(
            "h2",
            parent=base["Heading1"],
            fontName="Helvetica",
            fontSize=24,
            leading=27,
            textColor=INK,
            spaceAfter=18,
            keepWithNext=True,
        ),
        "h3": ParagraphStyle(
            "h3",
            parent=base["Heading2"],
            fontName="Helvetica-Bold",
            fontSize=12.2,
            leading=15,
            textColor=INK,
            spaceBefore=12,
            spaceAfter=12,
            keepWithNext=True,
        ),
        "body": ParagraphStyle(
            "body",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.65,
            leading=12.25,
            textColor=SLATE,
            spaceAfter=7,
        ),
        "bullet": ParagraphStyle(
            "bullet",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8.3,
            leading=11.6,
            textColor=SLATE,
            leftIndent=14,
            firstLineIndent=-12,
            spaceAfter=4,
        ),
        "number": ParagraphStyle(
            "number",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=7.9,
            leading=10.8,
            textColor=INK,
        ),
        "callout": ParagraphStyle(
            "callout",
            parent=base["BodyText"],
            fontName="Times-Italic",
            fontSize=10.1,
            leading=14.2,
            textColor=INK,
            leftIndent=13,
            rightIndent=13,
            borderColor=OPEN_SKY,
            borderWidth=1,
            borderPadding=12,
            backColor=PALE_BLUE,
            spaceBefore=8,
            spaceAfter=10,
        ),
        "code": ParagraphStyle(
            "code",
            parent=base["Code"],
            fontName="Courier",
            fontSize=6.25,
            leading=8.8,
            textColor=INK,
            leftIndent=10,
            rightIndent=10,
            borderColor=CLOUD,
            borderWidth=0.7,
            borderPadding=10,
            backColor=WHITE,
            spaceAfter=10,
        ),
        "nav": ParagraphStyle(
            "nav",
            parent=base["BodyText"],
            fontName="Helvetica",
            fontSize=8,
            leading=11.2,
            textColor=SLATE,
        ),
    }


class SourcebookDoc(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=letter,
            leftMargin=46,
            rightMargin=46,
            topMargin=64,
            bottomMargin=48,
            title="OpenArc Marketing + Technical Brief",
            author="OpenArc",
            subject="Verified Arc Testnet specifications, proposed OpenArc architecture, positioning, and launch system",
        )
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            id="body",
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="sourcebook", frames=[frame], onPage=draw_body_page))


def draw_body_page(c: canvas.Canvas, doc: BaseDocTemplate) -> None:
    c.saveState()
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, 0, 1)
    draw_dots(c)
    draw_logo(c, 27, 742, 27)
    c.setFillColor(INK)
    c.setFont("Helvetica-Bold", 7.6)
    c.drawString(60, 752, "OPENARC")
    c.setFillColor(MUTED)
    c.setFont("Courier-Bold", 5.8)
    c.drawRightString(584, 752, "MARKETING + TECHNICAL BRIEF")
    c.setStrokeColor(CLOUD)
    c.setLineWidth(0.6)
    c.line(28, 737, 584, 737)
    c.setFillColor(MUTED)
    c.setFont("Courier", 5.3)
    c.drawString(28, 25, "OPENARC / ARC TESTNET BUILD 2026-09-01")
    c.drawRightString(584, 25, f"{doc.page + 1:02d}")
    c.restoreState()


def numbered_box(number: str, value: str, s: dict[str, ParagraphStyle]) -> Flowable:
    table = Table(
        [[
            Paragraph(f'<font color="#0b4db8"><b>{number}</b></font>', s["number"]),
            Paragraph(inline_markup(value), s["number"]),
        ]],
        colWidths=[30, 468],
        hAlign="LEFT",
    )
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), WHITE),
        ("BOX", (0, 0), (-1, -1), 0.65, CLOUD),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 10),
        ("RIGHTPADDING", (0, 0), (0, 0), 2),
        ("LEFTPADDING", (1, 0), (1, 0), 0),
        ("RIGHTPADDING", (1, 0), (1, 0), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    return KeepTogether([table, Spacer(1, 4)])


def parse_source(source: str) -> tuple[list[Flowable], list[str]]:
    s = styles()
    physical_lines = source.splitlines()
    lines: list[str] = []
    in_preformatted = False
    for physical_line in physical_lines:
        if physical_line.startswith("```"):
            in_preformatted = not in_preformatted
            lines.append(physical_line)
            continue
        if (
            not in_preformatted
            and physical_line.startswith("> ")
            and lines
            and lines[-1].startswith("> ")
        ):
            lines[-1] = f"{lines[-1].rstrip()} {physical_line[2:].strip()}"
            continue
        if (
            not in_preformatted
            and physical_line[:1].isspace()
            and lines
            and re.match(r"^(?:-\s+|\d+\.\s+)", lines[-1]) is not None
        ):
            lines[-1] = f"{lines[-1].rstrip()} {physical_line.strip()}"
            continue
        lines.append(physical_line)

    section_titles = [line[3:].strip() for line in lines if line.startswith("## ")]
    story: list[Flowable] = []
    paragraph: list[str] = []
    code: list[str] = []
    in_code = False
    section_index = 0
    content_started = False

    def flush_paragraph() -> None:
        if paragraph:
            story.append(Paragraph(inline_markup(" ".join(paragraph)), s["body"]))
            paragraph.clear()

    story.append(Paragraph("BRIEF MAP", s["section_label"]))
    story.append(Paragraph(
        f"{len(section_titles)} sections of verified Testnet context, product architecture, evidence, positioning, and launch material.",
        s["h2"],
    ))
    story.append(Paragraph(
        "The Markdown package is editable. This PDF is the visually verified distribution copy.",
        s["body"],
    ))
    midpoint = (len(section_titles) + 1) // 2
    nav_rows = []
    for row in range(midpoint):
        left_number = row + 1
        right_number = midpoint + row + 1
        nav_rows.append([
            Paragraph(f'<font color="#0b4db8"><b>{left_number:02d}</b></font>', s["nav"]),
            Paragraph(inline_markup(section_titles[left_number - 1]), s["nav"]),
            Paragraph(
                f'<font color="#0b4db8"><b>{right_number:02d}</b></font>'
                if right_number <= len(section_titles) else "",
                s["nav"],
            ),
            Paragraph(
                inline_markup(section_titles[right_number - 1])
                if right_number <= len(section_titles) else "",
                s["nav"],
            ),
        ])
    nav = Table(nav_rows, colWidths=[28, 220, 28, 222], hAlign="LEFT")
    nav.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.4, CLOUD),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 9),
        ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([nav, PageBreak()])

    for raw in lines:
        line = raw.rstrip()
        if line.startswith("# "):
            continue
        if not content_started and not line.startswith("## "):
            continue
        if line.startswith("## "):
            content_started = True
        if line.startswith("```"):
            flush_paragraph()
            if in_code:
                story.append(Preformatted("\n".join(code), s["code"]))
                code.clear()
                in_code = False
            else:
                in_code = True
            continue
        if in_code:
            code.append(line)
            continue
        if not line.strip():
            flush_paragraph()
            continue
        if line.startswith("## "):
            flush_paragraph()
            if section_index > 0:
                story.append(PageBreak())
            section_index += 1
            story.append(Paragraph(f"SECTION {section_index:02d}", s["section_label"]))
            story.append(Paragraph(inline_markup(line[3:]), s["h2"]))
            continue
        if line.startswith("### "):
            flush_paragraph()
            story.append(Paragraph(inline_markup(line[4:]), s["h3"]))
            continue
        if line.startswith("> "):
            flush_paragraph()
            story.append(Spacer(1, 6))
            story.append(Paragraph(inline_markup(line[2:]), s["callout"]))
            continue
        bullet = re.match(r"^-\s+(.+)$", line)
        if bullet:
            flush_paragraph()
            story.append(Paragraph(
                f'<font color="#197fcf">&#9632;</font>&nbsp;&nbsp;{inline_markup(bullet.group(1))}',
                s["bullet"],
            ))
            continue
        numbered = re.match(r"^(\d+)\.\s+(.+)$", line)
        if numbered:
            flush_paragraph()
            story.append(numbered_box(numbered.group(1), numbered.group(2), s))
            continue
        paragraph.append(line.strip())

    flush_paragraph()
    return story, section_titles


def build() -> None:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    prepare_logo()
    source = SOURCE.read_text(encoding="utf-8")
    source = (
        source.replace("\u2014", " - ")
        .replace("\u2013", "-")
        .replace("\u2011", "-")
        .replace("\u2192", "->")
        .replace("\u2260", "!=")
        .replace("\u2264", "<=")
        .replace("\u2265", ">=")
    )
    story, sections = parse_source(source)
    if len(sections) != 38:
        raise ValueError(f"Expected 38 sourcebook sections, found {len(sections)}")

    make_cover()
    doc = SourcebookDoc(str(BODY))
    doc.build(story)

    cover_reader = PdfReader(str(COVER))
    body_reader = PdfReader(str(BODY))
    writer = PdfWriter()
    writer.add_page(cover_reader.pages[0])
    for page in body_reader.pages:
        writer.add_page(page)
    writer.add_metadata({
        "/Title": "OpenArc Marketing + Technical Brief",
        "/Subject": "Verified Arc Testnet specifications, proposed OpenArc architecture, evidence model, positioning, and launch system",
        "/Author": "OpenArc",
    })
    with MERGED.open("wb") as stream:
        writer.write(stream)
    os.replace(MERGED, OUTPUT)


if __name__ == "__main__":
    build()
