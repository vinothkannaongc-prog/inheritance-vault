from pathlib import Path
from textwrap import wrap
import shutil

from reportlab.lib.colors import HexColor, white
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "crypto-inheritance-checklist.pdf"
SITE_COPY = ROOT / "site" / "assets" / "downloads" / "crypto-inheritance-checklist.pdf"

PAGE_W, PAGE_H = A4
MARGIN = 42
INK = HexColor("#1c2536")
INK_SOFT = HexColor("#46536b")
PAPER = HexColor("#faf8f3")
CARD = HexColor("#ffffff")
LINE = HexColor("#e5dfd2")
GOLD = HexColor("#9a7b2f")
GOLD_SOFT = HexColor("#f3ecdc")
GREEN = HexColor("#2e6b4f")
GREEN_SOFT = HexColor("#e8f1ec")
RED_SOFT = HexColor("#f6e4e4")
RED = HexColor("#6f2929")


def line_height(size):
    return size * 1.32


def wrapped(c, text, x, y, width, font="Helvetica", size=9.5, color=INK_SOFT, leading=None):
    leading = leading or line_height(size)
    approx = max(18, int(width / (size * 0.52)))
    lines = []
    for paragraph in text.split("\n"):
        lines.extend(wrap(paragraph, width=approx) or [""])
    c.setFont(font, size)
    c.setFillColor(color)
    for item in lines:
        c.drawString(x, y, item)
        y -= leading
    return y


def footer(c, page_number):
    c.setStrokeColor(LINE)
    c.line(MARGIN, 31, PAGE_W - MARGIN, 31)
    c.setFont("Helvetica", 7.6)
    c.setFillColor(INK_SOFT)
    c.drawString(MARGIN, 19, "willandkey.com/guides - Never write a seed phrase or private key on this worksheet.")
    c.drawRightString(PAGE_W - MARGIN, 19, f"Page {page_number} of 3")


def header(c, kicker):
    c.setFillColor(PAPER)
    c.rect(0, 0, PAGE_W, PAGE_H, stroke=0, fill=1)
    c.setFont("Times-Bold", 15)
    c.setFillColor(INK)
    c.drawString(MARGIN, PAGE_H - 42, "Will")
    c.setFillColor(GOLD)
    c.drawString(MARGIN + 27, PAGE_H - 42, "&")
    c.setFillColor(INK)
    c.drawString(MARGIN + 39, PAGE_H - 42, "Key")
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(INK_SOFT)
    c.drawRightString(PAGE_W - MARGIN, PAGE_H - 40, kicker.upper())
    c.setStrokeColor(LINE)
    c.line(MARGIN, PAGE_H - 52, PAGE_W - MARGIN, PAGE_H - 52)


def section(c, title, y):
    c.setFont("Times-Bold", 14)
    c.setFillColor(INK)
    c.drawString(MARGIN, y, title)
    return y - 20


def field(c, label, y, x=MARGIN, width=None):
    width = width or PAGE_W - (2 * MARGIN)
    c.setFont("Helvetica-Bold", 8)
    c.setFillColor(INK_SOFT)
    c.drawString(x, y, label.upper())
    c.setStrokeColor(LINE)
    c.line(x, y - 15, x + width, y - 15)
    return y - 29


def checkbox(c, label, x, y, checked=False, size=10):
    c.setStrokeColor(INK_SOFT)
    c.rect(x, y - size + 2, size, size, stroke=1, fill=0)
    if checked:
        c.setStrokeColor(GREEN)
        c.line(x + 2, y - 3, x + 4, y - 6)
        c.line(x + 4, y - 6, x + 9, y + 1)
    c.setFont("Helvetica", 8.7)
    c.setFillColor(INK)
    c.drawString(x + size + 7, y - 5, label)


def page_one(c):
    header(c, "Printable planning worksheet")
    y = PAGE_H - 92
    c.setFont("Times-Bold", 26)
    c.setFillColor(INK)
    c.drawString(MARGIN, y, "Crypto Inheritance Checklist")
    y -= 25
    y = wrapped(c, "A secret-free worksheet for discovery, legal coordination, recovery design and rehearsal. Complete it with your heir, executor and qualified advisers.", MARGIN, y, PAGE_W - 2 * MARGIN, size=10.5)
    y -= 8

    c.setFillColor(RED_SOFT)
    c.roundRect(MARGIN, y - 63, PAGE_W - 2 * MARGIN, 62, 8, stroke=0, fill=1)
    c.setFont("Helvetica-Bold", 10)
    c.setFillColor(RED)
    c.drawString(MARGIN + 15, y - 19, "CRITICAL RULE")
    wrapped(c, "Do not write a seed phrase, private key, wallet PIN, passphrase, password, or two-factor recovery code anywhere in this PDF.", MARGIN + 15, y - 36, PAGE_W - 2 * MARGIN - 30, size=9.3, color=RED)
    y -= 84

    y = section(c, "The five-part plan", y)
    steps = [
        ("1", "Inventory", "List assets and where instructions live, without recording secrets."),
        ("2", "Custody", "Map exchanges, wallets, multisig signers, shares and contracts."),
        ("3", "Instructions", "Separate legal ownership from technical recovery steps."),
        ("4", "Mechanism", "Choose a transfer path the real beneficiary can operate."),
        ("5", "Rehearsal", "Test with a small amount and record what needs correction."),
    ]
    box_h = 48
    for number, title, body in steps:
        c.setFillColor(CARD)
        c.setStrokeColor(LINE)
        c.roundRect(MARGIN, y - box_h + 5, PAGE_W - 2 * MARGIN, box_h, 7, stroke=1, fill=1)
        c.setFillColor(GOLD)
        c.setFont("Times-Bold", 17)
        c.drawString(MARGIN + 14, y - 20, number)
        c.setFillColor(INK)
        c.setFont("Helvetica-Bold", 9.5)
        c.drawString(MARGIN + 42, y - 15, title)
        wrapped(c, body, MARGIN + 42, y - 30, PAGE_W - 2 * MARGIN - 58, size=8.5)
        y -= box_h + 8

    y -= 3
    y = section(c, "Plan identity", y)
    half = (PAGE_W - 2 * MARGIN - 18) / 2
    field(c, "Plan owner", y, MARGIN, half)
    field(c, "Primary beneficiary", y, MARGIN + half + 18, half)
    y -= 31
    field(c, "Jurisdiction for estate advice", y, MARGIN, half)
    field(c, "Next scheduled review", y, MARGIN + half + 18, half)
    footer(c, 1)
    c.showPage()


def page_two(c):
    header(c, "Inventory and mechanism")
    y = PAGE_H - 83
    y = section(c, "1. Secret-free asset inventory", y)
    y = wrapped(c, "Use public identifiers only when needed. A person finding this page should learn where to look, but should not be able to spend anything.", MARGIN, y, PAGE_W - 2 * MARGIN, size=8.8)
    y -= 8

    cols = [MARGIN, MARGIN + 92, MARGIN + 196, MARGIN + 312, PAGE_W - MARGIN]
    headers = ["Wallet / provider", "Asset and network", "Public reference", "Instruction location"]
    row_h = 44
    top = y
    c.setFillColor(GOLD_SOFT)
    c.rect(MARGIN, top - 24, PAGE_W - 2 * MARGIN, 24, stroke=0, fill=1)
    c.setStrokeColor(LINE)
    for x in cols:
        c.line(x, top, x, top - 24 - (row_h * 6))
    c.line(MARGIN, top, PAGE_W - MARGIN, top)
    for idx, label in enumerate(headers):
        c.setFont("Helvetica-Bold", 7.5)
        c.setFillColor(INK)
        c.drawString(cols[idx] + 5, top - 15, label)
    c.line(MARGIN, top - 24, PAGE_W - MARGIN, top - 24)
    for row in range(6):
        row_y = top - 24 - ((row + 1) * row_h)
        c.line(MARGIN, row_y, PAGE_W - MARGIN, row_y)
    y = top - 24 - (row_h * 6) - 22

    y = section(c, "2. Custody and transfer decision", y)
    options = [
        "Exchange or regulated custodian estate process",
        "Wallet-supported multi-share backup",
        "Multisig with independent signers",
        "Time-based smart-contract mechanism",
        "Other method reviewed with advisers",
    ]
    for label in options:
        checkbox(c, label, MARGIN, y)
        y -= 22

    y -= 2
    y = field(c, "Why this method fits the beneficiary's actual skills", y)
    y = field(c, "Main failure mode and planned mitigation", y)
    y = field(c, "Pointer to separately protected recovery instructions - location only", y)
    c.setFillColor(GREEN_SOFT)
    c.roundRect(MARGIN, 50, PAGE_W - 2 * MARGIN, 48, 7, stroke=0, fill=1)
    wrapped(c, "Safety check: the inventory, will and this worksheet contain no credential that can sign or authorize a transaction.", MARGIN + 14, 78, PAGE_W - 2 * MARGIN - 28, font="Helvetica-Bold", size=8.7, color=GREEN)
    footer(c, 2)
    c.showPage()


def page_three(c):
    header(c, "People, rehearsal and review")
    y = PAGE_H - 83
    y = section(c, "3. Legal and people layer", y)
    half = (PAGE_W - 2 * MARGIN - 18) / 2
    field(c, "Executor or estate representative", y, MARGIN, half)
    field(c, "Technical helper", y, MARGIN + half + 18, half)
    y -= 31
    field(c, "Qualified legal adviser", y, MARGIN, half)
    field(c, "Qualified tax adviser", y, MARGIN + half + 18, half)
    y -= 32
    checkbox(c, "The will identifies the asset class and beneficiary, but contains no spending secret.", MARGIN, y)
    y -= 22
    checkbox(c, "The beneficiary knows where to find this plan and whom to contact first.", MARGIN, y)
    y -= 30

    y = section(c, "4. Rehearsal log", y)
    third = (PAGE_W - 2 * MARGIN - 24) / 3
    field(c, "Rehearsal date", y, MARGIN, third)
    field(c, "Test amount", y, MARGIN + third + 12, third)
    field(c, "Network / provider", y, MARGIN + (third + 12) * 2, third)
    y -= 31
    y = field(c, "What the beneficiary successfully completed", y)
    y = field(c, "What failed, confused or depended on the owner", y)
    y = field(c, "Corrections made and person responsible", y)
    y -= 5

    y = section(c, "5. Annual review", y)
    reviews = [
        "All wallets, providers, networks and public references are current.",
        "The beneficiary still controls the recorded address or account.",
        "All required signers or recovery shares remain available.",
        "The executor and technical helper can still serve.",
        "Timer settings and reminders still match the owner's circumstances.",
        "Provider procedures, contract status and security disclosures were rechecked.",
        "Legal and tax advice still matches the relevant jurisdiction.",
        "A small rehearsal was completed after every material change.",
    ]
    for label in reviews:
        checkbox(c, label, MARGIN, y)
        y -= 19

    y -= 3
    field(c, "Reviewer initials and date", y, MARGIN, half)
    field(c, "Next review date", y, MARGIN + half + 18, half)

    c.setFillColor(GOLD_SOFT)
    c.roundRect(MARGIN, 50, PAGE_W - 2 * MARGIN, 51, 7, stroke=0, fill=1)
    wrapped(c, "Review immediately after a wallet migration, beneficiary change, lost device, suspected exposure, material asset change, relocation, marriage, divorce, death of a signer, or change in law or provider procedure.", MARGIN + 14, 82, PAGE_W - 2 * MARGIN - 28, size=8.2, color=INK)
    footer(c, 3)
    c.showPage()


def generate():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    SITE_COPY.parent.mkdir(parents=True, exist_ok=True)
    c = canvas.Canvas(str(OUTPUT), pagesize=A4, pageCompression=1)
    c.setTitle("Crypto Inheritance Checklist")
    c.setAuthor("Will & Key project team")
    c.setSubject("Secret-free crypto inheritance planning worksheet")
    page_one(c)
    page_two(c)
    page_three(c)
    c.save()
    shutil.copyfile(OUTPUT, SITE_COPY)
    print(OUTPUT)
    print(SITE_COPY)


if __name__ == "__main__":
    generate()
