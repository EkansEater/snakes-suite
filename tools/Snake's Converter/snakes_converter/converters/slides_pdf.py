"""PowerPoint (.pptx) to PDF without LibreOffice: every slide drawn with Qt.

Read the way PowerPoint reads a deck: the theme's colours and fonts; placeholders taking
their place and text styles from the slide master and layout; text with bullet levels
and alignment; shapes (fills, outlines, the common geometries), pictures (with cropping),
tables, simple charts, groups and backgrounds. Text stays text in the PDF.
"""

from __future__ import annotations

import html
import math
import posixpath
import zipfile
from xml.etree import ElementTree as ET

P = "{http://schemas.openxmlformats.org/presentationml/2006/main}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
C = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"
EMU_PER_PT = 12700


class Deck:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        self.names = set(self.z.namelist())
        self.cache = {}

    def xml(self, name):
        if name not in self.cache:
            self.cache[name] = ET.fromstring(self.z.read(name)) if name in self.names else None
        return self.cache[name]

    def rels(self, part):
        d, f = posixpath.split(part)
        rp = posixpath.join(d, "_rels", f + ".rels")
        out = {}
        x = self.xml(rp)
        if x is not None:
            for r in x.iter(PKG + "Relationship"):
                t = r.get("Target")
                ext = r.get("TargetMode") == "External"
                out[r.get("Id")] = (r.get("Type"), t if ext else posixpath.normpath(posixpath.join(d, t)), ext)
        return out


def _levels(el, color):
    """Formatting at each outline level of a list style (lvl1pPr ... lvl9pPr)."""
    out = [{} for _ in range(9)]
    if el is None:
        return out

    def one(p):
        o = {}
        if p is None:
            return o
        if p.get("algn"):
            o["align"] = {"ctr": "center", "r": "right", "just": "justify", "dist": "justify"}.get(p.get("algn"), "left")
        if p.get("marL") is not None:
            o["marL"] = int(p.get("marL")) / EMU_PER_PT
        if p.get("indent") is not None:
            o["indent"] = int(p.get("indent")) / EMU_PER_PT
        if p.find(A + "buNone") is not None:
            o["bullet"] = None
        elif p.find(A + "buAutoNum") is not None:
            o["bullet"] = "#"
        elif p.find(A + "buChar") is not None:
            o["bullet"] = p.find(A + "buChar").get("char") or "•"
        d = p.find(A + "defRPr")
        if d is not None:
            if d.get("sz"):
                o["size"] = int(d.get("sz")) / 100
            if d.get("b") is not None:
                o["bold"] = d.get("b") == "1"
            if d.get("i") is not None:
                o["italic"] = d.get("i") == "1"
            c = color(d.find(A + "solidFill"))
            if c:
                o["color"] = c
            lat = d.find(A + "latin")
            if lat is not None:
                o["font"] = lat.get("typeface")
        return o

    base = one(el.find(A + "defPPr"))
    for i in range(9):
        out[i] = {**base, **one(el.find(f"{A}lvl{i + 1}pPr"))}
    return out


def render(path, dst, title=""):
    from PySide6.QtCore import QByteArray, QMarginsF, QPointF, QRectF, QSizeF, Qt
    from PySide6.QtGui import (QBrush, QColor, QFont, QImage, QPageLayout, QPageSize, QPainter, QPainterPath,
                               QPdfWriter, QPen, QPolygonF, QTextDocument, QTextOption, QTransform)

    deck = Deck(path)
    pres = deck.xml("ppt/presentation.xml")
    if pres is None:
        raise ValueError("This file has no presentation in it.")
    prels = deck.rels("ppt/presentation.xml")
    sz = pres.find(P + "sldSz")
    W = int(sz.get("cx")) if sz is not None else 12192000
    H = int(sz.get("cy")) if sz is not None else 6858000

    # Theme: colours and fonts.
    scheme = {}
    fonts = {"major": "Calibri Light", "minor": "Calibri"}
    theme_part = next((t for (ty, t, _) in prels.values() if ty.endswith("/theme")), None)
    th = deck.xml(theme_part) if theme_part else None
    if th is not None:
        cs = th.find(f".//{A}clrScheme")
        if cs is not None:
            for el in cs:
                c = el.find(A + "srgbClr")
                s = el.find(A + "sysClr")
                scheme[el.tag.replace(A, "")] = c.get("val") if c is not None else (s.get("lastClr") if s is not None else None)
        for k in ("major", "minor"):
            f = th.find(f".//{A}{k}Font/{A}latin")
            if f is not None and f.get("typeface"):
                fonts[k] = f.get("typeface")
    scheme.update(bg1=scheme.get("lt1"), tx1=scheme.get("dk1"), bg2=scheme.get("lt2"), tx2=scheme.get("dk2"))

    def color(el):
        """A colour element's colour as QColor (None when there is none)."""
        if el is None:
            return None
        src = el.find(A + "srgbClr")
        if src is None:
            src = el.find(A + "schemeClr")
        if src is None:
            src = el.find(A + "sysClr")
        if src is None:
            src = el.find(A + "prstClr")
        if src is None:
            return None
        tag = src.tag.replace(A, "")
        hexv = src.get("val") if tag == "srgbClr" else scheme.get(src.get("val")) if tag == "schemeClr" else src.get("lastClr") if tag == "sysClr" else None
        if tag == "prstClr":
            q = QColor(src.get("val") or "black")
        else:
            if not hexv:
                return None
            q = QColor("#" + hexv)
        rgb = [q.red(), q.green(), q.blue()]
        lm = src.find(A + "lumMod")
        lo = src.find(A + "lumOff")
        tint = src.find(A + "tint")
        shade = src.find(A + "shade")
        if lm is not None or lo is not None:
            rgb = [v * (int(lm.get("val")) / 100000 if lm is not None else 1) + 255 * (int(lo.get("val")) / 100000 if lo is not None else 0) for v in rgb]
        if tint is not None:
            rgb = [v + (255 - v) * (1 - int(tint.get("val")) / 100000) for v in rgb]
        if shade is not None:
            rgb = [v * int(shade.get("val")) / 100000 for v in rgb]
        q = QColor(*[max(0, min(255, round(v))) for v in rgb])
        alpha = src.find(A + "alpha")
        if alpha is not None:
            q.setAlphaF(int(alpha.get("val")) / 100000)
        return q

    def face(tf):
        if not tf:
            return None
        if tf == "+mj-lt":
            return fonts["major"]
        if tf == "+mn-lt":
            return fonts["minor"]
        return None if tf.startswith("+") else tf

    part_cache = {}

    def part_info(part):
        """A layout's or master's placeholders, background and text styles."""
        if part in part_cache:
            return part_cache[part]
        x = deck.xml(part) if part else None
        info = {"phs": [], "bg": None, "tx": None, "rels": deck.rels(part) if part else {}, "tree": None}
        if x is not None:
            info["tree"] = x.find(f"{P}cSld/{P}spTree")
            for sp in x.iter(P + "sp"):
                ph = sp.find(f".//{P}nvPr/{P}ph")
                if ph is None:
                    continue
                tx = sp.find(P + "txBody")
                bp = tx.find(A + "bodyPr") if tx is not None else None
                info["phs"].append({"type": ph.get("type") or "body", "idx": ph.get("idx"), "xfrm": sp.find(f"{P}spPr/{A}xfrm"),
                                    "lst": _levels(tx.find(A + "lstStyle") if tx is not None else None, color), "bodyPr": bp})
            info["bg"] = x.find(f"{P}cSld/{P}bg")
            ts = x.find(P + "txStyles")
            if ts is not None:
                info["tx"] = {k: _levels(ts.find(P + n), color) for k, n in (("title", "titleStyle"), ("body", "bodyStyle"), ("other", "otherStyle"))}
        part_cache[part] = info
        return info

    default_text = _levels(pres.find(P + "defaultTextStyle"), color)

    def find_ph(lst, typ, idx):
        if idx not in (None, "0"):
            for p in lst:
                if p["idx"] == idx:
                    return p
        for p in lst:
            if p["type"] == typ:
                return p
        alias = {"ctrTitle": "title", "subTitle": "body", "obj": "body"}.get(typ)
        for p in lst:
            if p["type"] == alias:
                return p
        return None

    writer = QPdfWriter(str(dst))
    writer.setResolution(144)
    writer.setPageLayout(QPageLayout(QPageSize(QSizeF(W / EMU_PER_PT, H / EMU_PER_PT), QPageSize.Unit.Point, "", QPageSize.SizeMatchPolicy.ExactMatch),
                                     QPageLayout.Orientation.Portrait, QMarginsF(0, 0, 0, 0), QPageLayout.Unit.Point))
    writer.setTitle(title)
    k = writer.resolution() / 72 / EMU_PER_PT  # device pixels per EMU
    painter = QPainter(writer)
    painter.setRenderHint(QPainter.RenderHint.Antialiasing)
    painter.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)

    def xfrm_of(el, ph, layout, master):
        xf = el.find(f"{P}spPr/{A}xfrm")
        if xf is None:
            xf = el.find(f"{P}xfrm")
        if xf is None and ph is not None:
            for src in (find_ph(layout["phs"], ph.get("type") or "body", ph.get("idx")), find_ph(master["phs"], ph.get("type") or "body", ph.get("idx"))):
                if src and src["xfrm"] is not None:
                    xf = src["xfrm"]
                    break
        if xf is None:
            return None
        off = xf.find(A + "off")
        ext = xf.find(A + "ext")
        if off is None or ext is None:
            return None
        return {"x": int(off.get("x")), "y": int(off.get("y")), "w": int(ext.get("cx")), "h": int(ext.get("cy")),
                "rot": int(xf.get("rot") or 0) / 60000, "flipH": xf.get("flipH") == "1", "flipV": xf.get("flipV") == "1"}

    def geometry(prst, r):
        path = QPainterPath()
        x, y, w, h = r.x(), r.y(), r.width(), r.height()
        if prst in ("ellipse", "flowChartConnector"):
            path.addEllipse(r)
        elif prst in ("roundRect", "flowChartAlternateProcess"):
            rad = min(w, h) * 0.1667
            path.addRoundedRect(r, rad, rad)
        elif prst in ("triangle", "flowChartExtract"):
            path.addPolygon(QPolygonF([QPointF(x + w / 2, y), QPointF(x + w, y + h), QPointF(x, y + h), QPointF(x + w / 2, y)]))
        elif prst == "rtTriangle":
            path.addPolygon(QPolygonF([QPointF(x, y), QPointF(x + w, y + h), QPointF(x, y + h), QPointF(x, y)]))
        elif prst in ("diamond", "flowChartDecision"):
            path.addPolygon(QPolygonF([QPointF(x + w / 2, y), QPointF(x + w, y + h / 2), QPointF(x + w / 2, y + h), QPointF(x, y + h / 2), QPointF(x + w / 2, y)]))
        elif prst in ("pentagon", "hexagon", "octagon", "homePlate"):
            n = {"pentagon": 5, "hexagon": 6, "octagon": 8}.get(prst, 5)
            if prst == "homePlate":
                pts = [QPointF(x, y), QPointF(x + w * 0.8, y), QPointF(x + w, y + h / 2), QPointF(x + w * 0.8, y + h), QPointF(x, y + h)]
            else:
                start = -math.pi / 2 if n == 5 else 0
                pts = [QPointF(x + w / 2 + w / 2 * math.cos(start + i * 2 * math.pi / n), y + h / 2 + h / 2 * math.sin(start + i * 2 * math.pi / n)) for i in range(n)]
            path.addPolygon(QPolygonF([*pts, pts[0]]))
        elif prst in ("rightArrow", "leftArrow"):
            pts = [QPointF(x, y + h * 0.25), QPointF(x + w * 0.7, y + h * 0.25), QPointF(x + w * 0.7, y), QPointF(x + w, y + h / 2),
                   QPointF(x + w * 0.7, y + h), QPointF(x + w * 0.7, y + h * 0.75), QPointF(x, y + h * 0.75)]
            if prst == "leftArrow":
                pts = [QPointF(x + w - (p.x() - x), p.y()) for p in pts]
            path.addPolygon(QPolygonF([*pts, pts[0]]))
        elif prst == "chevron":
            pts = [QPointF(x, y), QPointF(x + w * 0.7, y), QPointF(x + w, y + h / 2), QPointF(x + w * 0.7, y + h), QPointF(x, y + h), QPointF(x + w * 0.3, y + h / 2)]
            path.addPolygon(QPolygonF([*pts, pts[0]]))
        elif prst in ("star5", "star4", "star6"):
            n = int(prst[-1])
            pts = []
            for i in range(n * 2):
                rr = 0.5 if i % 2 == 0 else 0.2
                ang = -math.pi / 2 + i * math.pi / n
                pts.append(QPointF(x + w / 2 + w * rr * math.cos(ang), y + h / 2 + h * rr * math.sin(ang)))
            path.addPolygon(QPolygonF([*pts, pts[0]]))
        elif prst in ("line", "straightConnector1"):
            path.moveTo(x, y)
            path.lineTo(x + w, y + h)
        else:
            path.addRect(r)
        return path

    def text_box(el, ph, layout, master, rect, shape_font_color):
        tx = el.find(P + "txBody")
        if tx is None:
            return
        typ = ph.get("type") or "body" if ph is not None else None
        idx = ph.get("idx") if ph is not None else None
        kind = "other" if ph is None else "title" if typ in ("title", "ctrTitle") else "body"
        mtx = master["tx"] or {"title": [{}] * 9, "body": [{}] * 9, "other": [{}] * 9}
        chain = [default_text if kind == "other" and any(default_text) else mtx[kind]]
        if ph is not None:
            for p in (find_ph(master["phs"], typ, idx), find_ph(layout["phs"], typ, idx)):
                if p:
                    chain.append(p["lst"])
        chain.append(_levels(tx.find(A + "lstStyle"), color))

        def at(lvl):
            o = {}
            for c in chain:
                o.update(c[lvl] if c and lvl < len(c) else {})
            return o

        bp = tx.find(A + "bodyPr")
        bps = [bp]
        if ph is not None:
            for p in (find_ph(layout["phs"], typ, idx), find_ph(master["phs"], typ, idx)):
                if p:
                    bps.append(p["bodyPr"])
        anchor = next((b.get("anchor") for b in bps if b is not None and b.get("anchor")), "t")
        ins = {}
        for key, d in (("lIns", 91440), ("tIns", 45720), ("rIns", 91440), ("bIns", 45720)):
            ins[key] = next((int(b.get(key)) for b in bps if b is not None and b.get(key) is not None), d)
        scale = 1.0
        fit = bp.find(A + "normAutofit") if bp is not None else None
        if fit is not None and fit.get("fontScale"):
            scale = int(fit.get("fontScale")) / 100000
        parts = []
        counters = {}
        for p in tx.findall(A + "p"):
            ppr = p.find(A + "pPr")
            lvl = min(8, int(ppr.get("lvl") or 0)) if ppr is not None else 0
            L = at(lvl)
            if ppr is not None:
                if ppr.get("algn"):
                    L["align"] = {"ctr": "center", "r": "right", "just": "justify", "dist": "justify"}.get(ppr.get("algn"), "left")
                if ppr.get("marL") is not None:
                    L["marL"] = int(ppr.get("marL")) / EMU_PER_PT
                if ppr.get("indent") is not None:
                    L["indent"] = int(ppr.get("indent")) / EMU_PER_PT
                if ppr.find(A + "buNone") is not None:
                    L["bullet"] = None
                elif ppr.find(A + "buAutoNum") is not None:
                    L["bullet"] = "#"
                elif ppr.find(A + "buChar") is not None:
                    L["bullet"] = ppr.find(A + "buChar").get("char") or "•"
            runs = ""
            first_size = None
            for r in p:
                tag = r.tag.replace(A, "")
                if tag == "br":
                    runs += "<br>"
                    continue
                if tag not in ("r", "fld"):
                    continue
                rpr = r.find(A + "rPr")
                t = r.find(A + "t")
                txt = html.escape(t.text if t is not None and t.text else "")
                size = (int(rpr.get("sz")) / 100 if rpr is not None and rpr.get("sz") else L.get("size") or (44 if kind == "title" else 18)) * scale
                first_size = first_size or size
                col = color(rpr.find(A + "solidFill")) if rpr is not None else None
                # A shape's style colour (white on a filled shape) beats the inherited text colour.
                col = col or shape_font_color or L.get("color") or QColor("#" + (scheme.get("dk1") or "000000"))
                lat = rpr.find(A + "latin") if rpr is not None else None
                fam = face(lat.get("typeface")) if lat is not None else None
                fam = fam or face(L.get("font")) or (fonts["major"] if kind == "title" else fonts["minor"])
                b = rpr.get("b") == "1" if rpr is not None and rpr.get("b") is not None else L.get("bold", False)
                i = rpr.get("i") == "1" if rpr is not None and rpr.get("i") is not None else L.get("italic", False)
                u = rpr is not None and rpr.get("u") not in (None, "none")
                st = f"font-size:{size:.1f}pt;color:{col.name()};font-family:'{fam}';font-weight:{'bold' if b else 'normal'};font-style:{'italic' if i else 'normal'}"
                if u:
                    st += ";text-decoration:underline"
                runs += f'<span style="{st}">{txt}</span>'
            size = first_size or (L.get("size") or (44 if kind == "title" else 18)) * scale
            marl = L.get("marL", 0)
            indent = L.get("indent", 0)
            bullet = L.get("bullet")
            prefix = ""
            if bullet and runs:
                if bullet == "#":
                    counters[lvl] = counters.get(lvl, 0) + 1
                    prefix = f"{counters[lvl]}."
                else:
                    prefix = html.escape(bullet)
                prefix = f'<span style="font-size:{size:.1f}pt;color:{(shape_font_color or L.get("color") or QColor("#000000")).name()}">{prefix}</span>&nbsp;&nbsp;'
            for d in [d for d in counters if d > lvl]:
                del counters[d]
            line = f'line-height:{100 if kind == "title" else 110}%'
            # (Qt reads margins and indents in pixels of 1/96 inch, not points.)
            px = 96 / 72
            parts.append(f'<p style="margin:0;margin-left:{max(0, marl) * px:.1f}px;text-indent:{indent * px:.1f}px;text-align:{L.get("align", "left")};{line};font-size:{size:.1f}pt">{prefix}{runs or "&nbsp;"}</p>')
        if not any("<span" in p for p in parts):
            return
        doc = QTextDocument()
        doc.setDocumentMargin(0)
        doc.documentLayout().setPaintDevice(writer)
        inner = QRectF(rect.x() + ins["lIns"] * k, rect.y() + ins["tIns"] * k, max(1.0, rect.width() - (ins["lIns"] + ins["rIns"]) * k), max(1.0, rect.height() - (ins["tIns"] + ins["bIns"]) * k))
        wrap = bp is None or bp.get("wrap") != "none"
        opt = QTextOption()
        opt.setWrapMode(QTextOption.WrapMode.WrapAtWordBoundaryOrAnywhere if wrap else QTextOption.WrapMode.NoWrap)
        doc.setDefaultTextOption(opt)
        doc.setHtml("".join(parts))
        doc.setTextWidth(inner.width() if wrap else -1)
        hgt = doc.size().height()
        dy = 0 if anchor == "t" else (inner.height() - hgt) / 2 if anchor == "ctr" else inner.height() - hgt
        painter.save()
        painter.translate(inner.x(), inner.y() + dy)
        doc.drawContents(painter)
        painter.restore()

    def picture(el, rels, rect):
        blip = el.find(f".//{A}blip")
        rid = blip.get(R + "embed") if blip is not None else None
        if not rid or rid not in rels or rels[rid][2]:
            return
        target = rels[rid][1]
        if target not in deck.names:
            return
        img = QImage.fromData(QByteArray(deck.z.read(target)))
        if img.isNull():
            return
        src = QRectF(0, 0, img.width(), img.height())
        sr = el.find(f".//{A}srcRect")
        if sr is not None:
            l, t, r_, b = (int(sr.get(n) or 0) / 100000 for n in ("l", "t", "r", "b"))
            src = QRectF(img.width() * l, img.height() * t, img.width() * (1 - l - r_), img.height() * (1 - t - b))
        painter.drawImage(rect, img, src)

    def table(el, rect):
        tbl = el.find(f".//{A}tbl")
        cols = [int(g.get("w")) * k for g in tbl.findall(f"{A}tblGrid/{A}gridCol")]
        rows = tbl.findall(A + "tr")
        tpr = tbl.find(A + "tblPr")
        first = tpr is not None and tpr.get("firstRow") == "1"
        band = tpr is not None and tpr.get("bandRow") == "1"
        accent = QColor("#" + (scheme.get("accent1") or "4472C4"))
        light = QColor(accent)
        light.setAlpha(40)
        y = rect.y()
        for ri, tr in enumerate(rows):
            hgt = int(tr.get("h") or 370840) * k
            x = rect.x()
            for ci, tc in enumerate(tr.findall(A + "tc")):
                w = cols[ci] if ci < len(cols) else rect.width() / max(1, len(cols))
                span = int(tc.get("gridSpan") or 1)
                for extra in range(1, span):
                    if ci + extra < len(cols):
                        w += cols[ci + extra]
                cell = QRectF(x, y, w, hgt)
                tcpr = tc.find(A + "tcPr")
                fill = color(tcpr.find(A + "solidFill")) if tcpr is not None else None
                if fill is None and first and ri == 0:
                    fill = accent
                elif fill is None and band and ri % 2 == 1:
                    fill = light
                if fill is not None:
                    painter.fillRect(cell, fill)
                painter.setPen(QPen(QColor("#ffffff") if first else QColor("#bfbfbf"), max(1, 1.0 * k * EMU_PER_PT)))
                painter.drawRect(cell)
                txt = " ".join("".join(t.text or "" for t in p.iter(A + "t")) for p in tc.iter(A + "p")).strip()
                rp = next(iter(tc.iter(A + "rPr")), None)
                size = int(rp.get("sz")) / 100 if rp is not None and rp.get("sz") else 18
                font = QFont(fonts["minor"])
                font.setPointSizeF(size)
                font.setBold(first and ri == 0)
                painter.setFont(font)
                painter.setPen(QColor("#ffffff") if first and ri == 0 else QColor("#" + (scheme.get("dk1") or "000000")))
                pad = 7 * k * EMU_PER_PT
                painter.drawText(cell.adjusted(pad, 0, -pad, 0), int(Qt.AlignmentFlag.AlignVCenter | Qt.AlignmentFlag.AlignLeft | Qt.TextFlag.TextWordWrap), txt)
                x += w
                if span > 1:
                    pass
            y += hgt

    def chart(rels, rid, rect):
        if rid not in rels:
            return
        cx = deck.xml(rels[rid][1])
        if cx is None:
            return
        plot = cx.find(f".//{C}plotArea")
        kinds = {"barChart": "bar", "bar3DChart": "bar", "lineChart": "line", "areaChart": "line", "pieChart": "pie", "doughnutChart": "pie", "scatterChart": "line"}
        kel = next((e for e in list(plot) if e.tag.replace(C, "") in kinds), None) if plot is not None else None
        if kel is None:
            return
        kind = kinds[kel.tag.replace(C, "")]
        horizontal = kel.find(C + "barDir") is not None and kel.find(C + "barDir").get("val") == "bar"

        def pts(e):
            if e is None:
                return []
            cache = next((x for x in (e.find(f".//{C}{n}") for n in ("numCache", "strCache", "numLit", "strLit")) if x is not None), None)
            if cache is None:
                return []
            n = int(cache.find(C + "ptCount").get("val")) if cache.find(C + "ptCount") is not None else 0
            out = [None] * n
            for p in cache.findall(C + "pt"):
                v = p.find(C + "v")
                i = int(p.get("idx"))
                if i < n:
                    out[i] = v.text if v is not None else None
            return out

        sers = kel.findall(C + "ser")
        cats = [c or "" for c in pts(sers[0].find(C + "cat") if sers else None)]
        series = []
        for s in sers:
            vals = []
            val_el = s.find(C + "val")
            for v in pts(val_el if val_el is not None else s.find(C + "yVal")):
                try:
                    vals.append(float(v))
                except (TypeError, ValueError):
                    vals.append(None)
            series.append(vals)
        if not series:
            return
        acc = [QColor("#" + (scheme.get(f"accent{i}") or "4472C4")) for i in range(1, 7)]
        title_el = cx.find(f".//{C}title")
        ttl = "".join(t.text or "" for t in title_el.iter(A + "t")) if title_el is not None else ""
        r = QRectF(rect)
        font = QFont(fonts["minor"])
        font.setPointSizeF(10)
        painter.setFont(font)
        if ttl:
            tf = QFont(fonts["minor"])
            tf.setPointSizeF(14)
            painter.setFont(tf)
            painter.setPen(QColor("#404040"))
            painter.drawText(QRectF(r.x(), r.y(), r.width(), 28 * k * EMU_PER_PT), int(Qt.AlignmentFlag.AlignCenter), ttl)
            r.setTop(r.top() + 30 * k * EMU_PER_PT)
            painter.setFont(font)
        if kind == "pie":
            vals = [v or 0 for v in series[0]]
            total = sum(vals) or 1
            d = min(r.width(), r.height()) * 0.85
            box = QRectF(r.center().x() - d / 2, r.center().y() - d / 2, d, d)
            ang = 90 * 16
            for i, v in enumerate(vals):
                span = -int(v / total * 360 * 16)
                painter.setBrush(acc[i % 6])
                painter.setPen(QPen(QColor("#ffffff"), 2))
                painter.drawPie(box, ang, span)
                ang += span
            return
        nums = [v for s in series for v in s if v is not None]
        if not nums:
            return
        top = max(0.0, max(nums))
        bot = min(0.0, min(nums))
        top = top * 1.1 if top else 1
        legend_h = 22 * k * EMU_PER_PT if len(series) > 1 else 0
        axis_w = 48 * k * EMU_PER_PT
        plot_r = QRectF(r.x() + axis_w, r.y() + 6, r.width() - axis_w - 8, r.height() - 30 * k * EMU_PER_PT - legend_h)
        painter.setPen(QPen(QColor("#d9d9d9"), 1))
        for i in range(5):
            yv = bot + (top - bot) * i / 4
            yy = plot_r.bottom() - (yv - bot) / (top - bot) * plot_r.height()
            painter.drawLine(QPointF(plot_r.left(), yy), QPointF(plot_r.right(), yy))
            painter.setPen(QColor("#595959"))
            painter.drawText(QRectF(r.x(), yy - 10 * k * EMU_PER_PT, axis_w - 6, 20 * k * EMU_PER_PT), int(Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter), f"{yv:,.0f}")
            painter.setPen(QPen(QColor("#d9d9d9"), 1))
        n = max(len(s) for s in series)
        slot = plot_r.width() / max(1, n)
        ys = lambda v: plot_r.bottom() - ((v or 0) - bot) / (top - bot) * plot_r.height()  # noqa: E731
        if kind == "bar" and not horizontal:
            bw = slot * 0.7 / len(series)
            for si, s in enumerate(series):
                painter.setBrush(acc[si % 6])
                painter.setPen(Qt.PenStyle.NoPen)
                for i, v in enumerate(s):
                    if v is None:
                        continue
                    x0 = plot_r.left() + i * slot + slot * 0.15 + si * bw
                    painter.drawRect(QRectF(x0, min(ys(v), ys(0)), bw * 0.95, abs(ys(v) - ys(0))))
        else:
            for si, s in enumerate(series):
                painter.setPen(QPen(acc[si % 6], 2.5 * k * EMU_PER_PT))
                prev = None
                for i, v in enumerate(s):
                    if v is None:
                        prev = None
                        continue
                    pt = QPointF(plot_r.left() + i * slot + slot / 2, ys(v))
                    if prev is not None:
                        painter.drawLine(prev, pt)
                    prev = pt
        painter.setPen(QColor("#595959"))
        for i, c in enumerate(cats[:n]):
            painter.drawText(QRectF(plot_r.left() + i * slot, plot_r.bottom() + 4, slot, 22 * k * EMU_PER_PT), int(Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignTop), str(c))
        if legend_h:
            names = []
            for s in sers:
                tx = s.find(C + "tx")
                names.append(" ".join(v.text or "" for v in tx.iter(C + "v")) if tx is not None else "")
            x = r.center().x() - len(names) * 60 * k * EMU_PER_PT / 2
            yy = r.bottom() - legend_h
            for si, nm in enumerate(names):
                painter.fillRect(QRectF(x, yy + 6, 10 * k * EMU_PER_PT, 10 * k * EMU_PER_PT), acc[si % 6])
                painter.drawText(QRectF(x + 14 * k * EMU_PER_PT, yy, 100 * k * EMU_PER_PT, 22 * k * EMU_PER_PT), int(Qt.AlignmentFlag.AlignVCenter), nm)
                x += 60 * k * EMU_PER_PT + len(nm) * 5 * k * EMU_PER_PT

    def background(bg, rels):
        if bg is None:
            return False
        pr = bg.find(P + "bgPr")
        ref = bg.find(P + "bgRef")
        full = QRectF(0, 0, W * k, H * k)
        if pr is not None:
            blip = pr.find(f".//{A}blip")
            if blip is not None:
                rid = blip.get(R + "embed")
                if rid in rels and rels[rid][1] in deck.names:
                    img = QImage.fromData(QByteArray(deck.z.read(rels[rid][1])))
                    if not img.isNull():
                        painter.drawImage(full, img)
                        return True
            gs = pr.findall(f".//{A}gs")
            if gs:
                from PySide6.QtGui import QLinearGradient

                g = QLinearGradient(0, 0, W * k, H * k)
                for s in gs:
                    c = color(s)
                    if c is not None:
                        g.setColorAt(int(s.get("pos") or 0) / 100000, c)
                painter.fillRect(full, QBrush(g))
                return True
            c = color(pr.find(A + "solidFill"))
            if c is not None:
                painter.fillRect(full, c)
                return True
        if ref is not None:
            c = color(ref)
            if c is not None:
                painter.fillRect(full, c)
                return True
        return False

    def draw_tree(tree, rels, layout, master, transform, with_placeholders=True):
        for el in list(tree):
            tag = el.tag.replace(P, "")
            if tag == "grpSp":
                gx = el.find(f"{P}grpSpPr/{A}xfrm")
                t = QTransform(transform)
                if gx is not None:
                    o, e, co, ce = (gx.find(A + n) for n in ("off", "ext", "chOff", "chExt"))
                    sx = int(e.get("cx")) / int(ce.get("cx")) if ce is not None and int(ce.get("cx")) else 1
                    sy = int(e.get("cy")) / int(ce.get("cy")) if ce is not None and int(ce.get("cy")) else 1
                    t = QTransform().translate(int(o.get("x")) * k, int(o.get("y")) * k).scale(sx, sy).translate(-(int(co.get("x")) if co is not None else 0) * k, -(int(co.get("y")) if co is not None else 0) * k) * transform
                draw_tree(el, rels, layout, master, t, with_placeholders)
                continue
            if tag not in ("sp", "pic", "cxnSp", "graphicFrame"):
                continue
            ph = el.find(f".//{P}nvPr/{P}ph")
            if ph is not None and (not with_placeholders or ph.get("type") in ("sldNum", "dt", "ftr")):
                continue
            box = xfrm_of(el, ph, layout, master)
            if box is None:
                continue
            rect = QRectF(box["x"] * k, box["y"] * k, box["w"] * k, box["h"] * k)
            painter.save()
            painter.setTransform(transform, True)
            if box["rot"] or box["flipH"] or box["flipV"]:
                c = rect.center()
                painter.translate(c)
                painter.rotate(box["rot"])
                painter.scale(-1 if box["flipH"] else 1, -1 if box["flipV"] else 1)
                painter.translate(-c)
            if tag in ("sp", "cxnSp"):
                sppr = el.find(P + "spPr")
                geom = sppr.find(A + "prstGeom") if sppr is not None else None
                prst = geom.get("prst") if geom is not None else ("line" if tag == "cxnSp" else "rect")
                style = el.find(P + "style")
                fill = None
                if sppr is not None and sppr.find(A + "noFill") is not None:
                    fill = None
                elif sppr is not None and sppr.find(A + "solidFill") is not None:
                    fill = color(sppr.find(A + "solidFill"))
                elif sppr is not None and sppr.find(A + "gradFill") is not None:
                    fill = color(sppr.find(f"{A}gradFill//{A}gs"))
                elif style is not None and ph is None and tag == "sp":
                    fr = style.find(A + "fillRef")
                    fill = color(fr) if fr is not None and fr.get("idx") != "0" else None
                ln = sppr.find(A + "ln") if sppr is not None else None
                pen = None
                if ln is not None and ln.find(A + "noFill") is not None:
                    pen = None
                elif ln is not None and ln.find(A + "solidFill") is not None:
                    pen = QPen(color(ln.find(A + "solidFill")), max(1.0, int(ln.get("w") or 12700) * k))
                elif style is not None and ph is None:
                    lr = style.find(A + "lnRef")
                    lc = color(lr) if lr is not None and lr.get("idx") != "0" else None
                    if lc is not None:
                        pen = QPen(lc, max(1.0, int((ln.get("w") if ln is not None else None) or 12700) * k))
                path = geometry(prst, rect)
                if fill is not None and prst not in ("line", "straightConnector1"):
                    painter.fillPath(path, fill)
                if pen is not None:
                    painter.setPen(pen)
                    painter.setBrush(Qt.BrushStyle.NoBrush)
                    painter.drawPath(path)
                if tag == "sp":
                    fr = style.find(A + "fontRef") if style is not None else None
                    text_box(el, ph, layout, master, rect, color(fr) if fr is not None and ph is None else None)
            elif tag == "pic":
                picture(el, rels, rect)
            elif tag == "graphicFrame":
                ch = el.find(f".//{C}chart")
                if ch is not None:
                    chart(rels, ch.get(R + "id"), rect)
                elif el.find(f".//{A}tbl") is not None:
                    table(el, rect)
            painter.restore()

    first = True
    try:
        for sid in pres.findall(f"{P}sldIdLst/{P}sldId"):
            rid = sid.get(R + "id")
            if rid not in prels:
                continue
            part = prels[rid][1]
            sx = deck.xml(part)
            if sx is None:
                continue
            if sx.get("show") == "0":
                continue
            srels = deck.rels(part)
            lay_part = next((t for (ty, t, _) in srels.values() if ty.endswith("/slideLayout")), None)
            layout = part_info(lay_part)
            mas_part = next((t for (ty, t, _) in layout["rels"].values() if ty.endswith("/slideMaster")), None)
            master = part_info(mas_part)
            if not first:
                writer.newPage()
            first = False
            painter.fillRect(QRectF(0, 0, W * k, H * k), QColor("#" + (scheme.get("lt1") or "ffffff")))
            if not background(sx.find(f"{P}cSld/{P}bg"), srels):
                if not background(layout["bg"], layout["rels"]):
                    background(master["bg"], master["rels"])
            # The master's and layout's own drawings (logos, bars) under the slide's, unless hidden.
            ident = QTransform()
            if sx.get("showMasterSp") != "0":
                lx = deck.xml(lay_part) if lay_part else None
                if master["tree"] is not None and (lx is None or lx.get("showMasterSp") != "0"):
                    draw_tree(master["tree"], master["rels"], master, master, ident, with_placeholders=False)
                if layout["tree"] is not None:
                    draw_tree(layout["tree"], layout["rels"], layout, master, ident, with_placeholders=False)
            draw_tree(sx.find(f"{P}cSld/{P}spTree"), srels, layout, master, ident)
    finally:
        painter.end()
    if first:
        raise ValueError("This presentation has no slides to show.")
