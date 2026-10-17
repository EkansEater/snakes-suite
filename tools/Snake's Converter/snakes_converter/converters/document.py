"""Text document conversion.

Office formats go through LibreOffice when it is installed, because it keeps
layout faithfully. Everything else (and everything, when LibreOffice is
missing) uses a built-in engine that loads the document into a Qt text
document and exports it from there.
"""

from __future__ import annotations

import html
import re
import threading
from pathlib import Path

from ..core import ConversionError, Options, Progress, check_cancel, ensure_qt, read_text
from . import office

DOCUMENT_IN = {"docx", "doc", "odt", "rtf", "txt", "md", "markdown", "html", "htm"}

_ORDER = ["pdf", "docx", "odt", "rtf", "txt", "html", "md"]
_BUILTIN_IN = {"docx", "rtf", "txt", "md", "markdown", "html", "htm"}
_BUILTIN_OUT = {"pdf", "docx", "odt", "txt", "html", "md"}
_OFFICE_IN = {"docx", "doc", "odt", "rtf", "txt", "html", "htm"}
_OFFICE_OUT = {"pdf", "docx", "odt", "rtf", "txt", "html"}
_OFFICE_PREFERRED = {"docx", "doc", "odt", "rtf"}  # sources LibreOffice handles best
_ALIASES = {"markdown": "md", "htm": "html"}


def targets(ext: str) -> list[str]:
    possible = set()
    if ext in _BUILTIN_IN:
        possible |= _BUILTIN_OUT
    if office.available() and ext in _OFFICE_IN:
        possible |= _OFFICE_OUT
    possible.discard(_ALIASES.get(ext, ext))
    return [t for t in _ORDER if t in possible]


def convert(src: Path, dst: Path, target: str, opts: Options,
            progress: Progress, cancel: threading.Event) -> list[Path]:
    ext = src.suffix.lower().lstrip(".")
    builtin = ext in _BUILTIN_IN and target in _BUILTIN_OUT
    via_office = office.available() and ext in _OFFICE_IN and target in _OFFICE_OUT
    if via_office and (ext in _OFFICE_PREFERRED or not builtin):
        return office.convert(src, dst, target, progress, cancel)
    if builtin:
        return _convert_builtin(src, dst, ext, target, cancel)
    return office.convert(src, dst, target, progress, cancel)  # raises a helpful error


# --- built-in engine -------------------------------------------------------

def _docx_to_html(src: Path) -> str:
    import mammoth

    with open(src, "rb") as fh:
        return mammoth.convert_to_html(fh).value


def _rtf_to_text(src: Path) -> str:
    from striprtf.striprtf import rtf_to_text

    return rtf_to_text(read_text(src), errors="ignore")


def _load(src: Path, ext: str):
    """Load the source into a QTextDocument. Also returns clean HTML if we have it,
    and the page setup when the source has one (Word files)."""
    ensure_qt()
    from PySide6.QtCore import QUrl
    from PySide6.QtGui import QFont, QTextDocument

    doc = QTextDocument()
    doc.setDefaultFont(QFont("Helvetica", 11))
    doc.setBaseUrl(QUrl.fromLocalFile(str(src.parent) + "/"))
    doc.setDocumentMargin(0)
    source_html = None
    doc.page = None
    if ext == "docx":
        try:
            from .docx_html import read_docx

            source_html, page = read_docx(src)
            doc.page = page
            if page.font:
                doc.setDefaultFont(QFont(page.font, round(page.size) or 11))
            else:
                doc.setDefaultFont(QFont("Helvetica", round(page.size) or 11))
            doc.setDefaultStyleSheet("p { margin-top: 0; margin-bottom: 6pt; } li { margin-bottom: 2pt; }")
        except Exception:  # an unusual file: the simpler reader still gets the words across
            source_html = _docx_to_html(src)
        doc.setHtml(source_html)
    elif ext in ("html", "htm"):
        doc.setHtml(read_text(src))
    elif ext in ("md", "markdown"):
        doc.setMarkdown(read_text(src))
    elif ext == "rtf":
        doc.setPlainText(_rtf_to_text(src))
    else:
        doc.setPlainText(read_text(src))
    return doc, source_html


def _write_pdf(doc, dst: Path) -> None:
    """The document as PDF pages: the source's own page size and margins when it has
    them, with its header and footer (and page numbers) on every page."""
    from PySide6.QtCore import QLocale, QMarginsF, QPointF, QRectF, QSizeF, Qt
    from PySide6.QtGui import QColor, QFont, QPageLayout, QPageSize, QPainter, QPdfWriter

    page = getattr(doc, "page", None)
    writer = QPdfWriter(str(dst))
    writer.setResolution(300)
    if page is not None:
        size = QPageSize(QSizeF(page.width_mm, page.height_mm), QPageSize.Unit.Millimeter, "", QPageSize.SizeMatchPolicy.FuzzyMatch)
        top, right, bottom, left = page.margins_mm
    else:
        imperial = QLocale().measurementSystem() != QLocale.MeasurementSystem.MetricSystem
        size = QPageSize(QPageSize.PageSizeId.Letter if imperial else QPageSize.PageSizeId.A4)
        top = right = bottom = left = 20
    writer.setPageLayout(QPageLayout(size, QPageLayout.Orientation.Portrait, QMarginsF(0, 0, 0, 0), QPageLayout.Unit.Millimeter))
    writer.setTitle((page.title if page is not None and page.title else "") or dst.stem)
    dpmm = writer.resolution() / 25.4
    full = writer.pageLayout().fullRectPixels(writer.resolution())
    body = QRectF(left * dpmm, top * dpmm, full.width() - (left + right) * dpmm, full.height() - (top + bottom) * dpmm)
    doc.documentLayout().setPaintDevice(writer)
    doc.setPageSize(body.size())
    pages = max(1, doc.pageCount())
    painter = QPainter(writer)
    try:
        hf_font = QFont(doc.defaultFont())
        hf_font.setPointSizeF(9)
        for i in range(pages):
            if i:
                writer.newPage()
            painter.save()
            painter.translate(body.left(), body.top() - i * body.height())
            # (Two device pixels short: the next page's first line must not bleed onto this one.)
            doc.drawContents(painter, QRectF(0, i * body.height(), body.width(), body.height() - 2))
            painter.restore()
            if page is None or (page.first_different and i == 0):
                continue
            painter.setFont(hf_font)
            painter.setPen(QColor("#555555"))
            flags = (Qt.AlignmentFlag.AlignLeft, Qt.AlignmentFlag.AlignHCenter, Qt.AlignmentFlag.AlignRight)
            for zones, y in ((page.header, top * dpmm / 2), (page.footer, full.height() - bottom * dpmm / 2)):
                for text, flag in zip(zones, flags):
                    if text:
                        t = text.replace("{page}", str(i + 1)).replace("{pages}", str(pages))
                        painter.drawText(QRectF(body.left(), y - 40, body.width(), 80), int(flag | Qt.AlignmentFlag.AlignVCenter), t)
        _ = QPointF
    finally:
        painter.end()


_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")


def _write_docx(doc, dst: Path) -> None:
    """Export headings, lists and basic character formatting to a Word file."""
    import docx
    from PySide6.QtGui import QFont, QTextListFormat

    numbered = {
        QTextListFormat.Style.ListDecimal, QTextListFormat.Style.ListLowerAlpha,
        QTextListFormat.Style.ListUpperAlpha, QTextListFormat.Style.ListLowerRoman,
        QTextListFormat.Style.ListUpperRoman,
    }
    out = docx.Document()
    block = doc.begin()
    while block.isValid():
        level = block.blockFormat().headingLevel()
        text_list = block.textList()
        if level:
            para = out.add_heading(level=min(level, 9))
        elif text_list is not None:
            style = "List Number" if text_list.format().style() in numbered else "List Bullet"
            para = out.add_paragraph(style=style)
        else:
            para = out.add_paragraph()
        it = block.begin()
        while not it.atEnd():
            fragment = it.fragment()
            if fragment.isValid():
                text = fragment.text().replace(" ", "\n").replace("￼", "")
                text = _CONTROL.sub("", text)
                if text:
                    fmt = fragment.charFormat()
                    run = para.add_run(text)
                    if not level and fmt.fontWeight() >= QFont.Weight.DemiBold:
                        run.bold = True
                    if fmt.fontItalic():
                        run.italic = True
                    if fmt.fontUnderline() and not fmt.isAnchor():
                        run.underline = True
                    if fmt.fontFixedPitch():
                        run.font.name = "Courier New"
            it += 1
        block = block.next()
    out.save(str(dst))


def _convert_builtin(src: Path, dst: Path, ext: str, target: str,
                     cancel: threading.Event) -> list[Path]:
    try:
        doc, source_html = _load(src, ext)
    except ConversionError:
        raise
    except Exception as exc:
        raise ConversionError(f"The document could not be read: {exc}") from None
    check_cancel(cancel)

    if target == "pdf":
        _write_pdf(doc, dst)
    elif target == "docx":
        _write_docx(doc, dst)
    elif target == "odt":
        from PySide6.QtGui import QTextDocumentWriter

        if not QTextDocumentWriter(str(dst), b"odf").write(doc):
            raise ConversionError("The ODT file could not be written.")
    elif target == "txt":
        dst.write_text(doc.toPlainText(), encoding="utf-8")
    elif target == "md":
        dst.write_text(doc.toMarkdown(), encoding="utf-8")
    elif target == "html":
        if source_html is not None:
            page = (
                "<!DOCTYPE html>\n<html>\n<head>\n<meta charset=\"utf-8\">\n"
                f"<title>{html.escape(src.stem)}</title>\n</head>\n<body>\n{source_html}\n</body>\n</html>\n"
            )
        else:
            page = doc.toHtml()
        dst.write_text(page, encoding="utf-8")
    else:
        raise ConversionError(f"Unsupported document format: {target}")
    return [dst]
