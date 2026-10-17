"""Word (.docx) to HTML that Qt's text engine lays out well, with the page setup.

The same reading as Snake's Word: styles through their basedOn chains (fonts, sizes,
colours, headings), direct formatting, lists from numbering (also when a style brings
it), tables with borders, shading and merged cells, pictures, links, page breaks,
footnotes (as numbered notes at the end) and the header and footer text.
"""

from __future__ import annotations

import base64
import html
import re
import zipfile
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
V = "{urn:schemas-microsoft-com:vml}"
PKG = "{http://schemas.openxmlformats.org/package/2006/relationships}"

HIGHLIGHT = {
    "yellow": "#ffff00", "green": "#00ff00", "cyan": "#00ffff", "magenta": "#ff00ff", "blue": "#0000ff", "red": "#ff0000",
    "darkBlue": "#000080", "darkCyan": "#008080", "darkGreen": "#008000", "darkMagenta": "#800080", "darkRed": "#800000",
    "darkYellow": "#808000", "darkGray": "#808080", "lightGray": "#c0c0c0", "black": "#000000", "white": "#ffffff",
}


@dataclass
class Page:
    width_mm: float = 215.9
    height_mm: float = 279.4
    margins_mm: tuple = (25.4, 25.4, 25.4, 25.4)  # top, right, bottom, left
    header: tuple = ("", "", "")  # left, centre, right
    footer: tuple = ("", "", "")
    first_different: bool = False
    title: str = ""
    font: str = ""
    size: float = 11.0
    extra: dict = field(default_factory=dict)


def _on(el, name):
    k = el.find(W + name) if el is not None else None
    if k is None:
        return None
    v = k.get(W + "val")
    return v is None or v not in ("0", "false", "off", "none")


def _val(el, path):
    k = el.find(path) if el is not None else None
    return k.get(W + "val") if k is not None else None


def read_docx(path) -> tuple[str, Page]:
    z = zipfile.ZipFile(path)
    names = set(z.namelist())

    def text(n):
        return z.read(n).decode("utf-8", "replace") if n in names else None

    doc_xml = text("word/document.xml")
    if doc_xml is None:
        raise ValueError("This file has no document in it.")
    root = ET.fromstring(doc_xml)
    rels = {}
    if "word/_rels/document.xml.rels" in names:
        for r in ET.fromstring(text("word/_rels/document.xml.rels")).iter(PKG + "Relationship"):
            rels[r.get("Id")] = (r.get("Target"), r.get("TargetMode") == "External")

    # Theme fonts.
    theme = {"major": "", "minor": ""}
    if "word/theme/theme1.xml" in names:
        t = ET.fromstring(text("word/theme/theme1.xml"))
        for k in ("major", "minor"):
            f = t.find(f".//{A}{k}Font/{A}latin")
            if f is not None:
                theme[k] = f.get("typeface") or ""

    # Styles and their chains.
    styles = {}
    default_para = None
    doc_rpr = doc_ppr = None
    if "word/styles.xml" in names:
        sx = ET.fromstring(text("word/styles.xml"))
        dd = sx.find(W + "docDefaults")
        if dd is not None:
            doc_rpr = dd.find(f"{W}rPrDefault/{W}rPr")
            doc_ppr = dd.find(f"{W}pPrDefault/{W}pPr")
        for s in sx.iter(W + "style"):
            sid = s.get(W + "styleId")
            nm = s.find(W + "name")
            based = s.find(W + "basedOn")
            styles[sid] = {
                "name": (nm.get(W + "val") if nm is not None else sid or "").lower(),
                "based": based.get(W + "val") if based is not None else None,
                "rPr": s.find(W + "rPr"), "pPr": s.find(W + "pPr"), "type": s.get(W + "type"),
            }
            if s.get(W + "type") == "paragraph" and s.get(W + "default") in ("1", "true"):
                default_para = sid

    def chain(sid):
        out = []
        s = styles.get(sid)
        for _ in range(12):
            if not s:
                break
            out.insert(0, s)
            s = styles.get(s["based"]) if s["based"] else None
        return out

    def style_name(sid):
        for s in reversed(chain(sid)):
            if re.match(r"^(heading [1-6]|title|subtitle|quote|intense quote|caption)$", s["name"]):
                return s["name"]
        return styles[sid]["name"] if sid in styles else ""

    def run_format(rprs):
        f = {}
        for rpr in rprs:
            if rpr is None:
                continue
            for k in ("b", "i", "strike", "dstrike", "caps", "smallCaps", "vanish"):
                v = _on(rpr, k)
                if v is not None:
                    f[k] = v
            u = rpr.find(W + "u")
            if u is not None:
                f["u"] = u.get(W + "val") != "none"
            c = rpr.find(W + "color")
            if c is not None and c.get(W + "val"):
                f["color"] = None if c.get(W + "val") == "auto" else c.get(W + "val")
            sz = rpr.find(W + "sz")
            if sz is not None and sz.get(W + "val"):
                f["sz"] = int(sz.get(W + "val")) / 2
            fonts = rpr.find(W + "rFonts")
            if fonts is not None:
                face = fonts.get(W + "ascii") or fonts.get(W + "hAnsi")
                th = fonts.get(W + "asciiTheme") or fonts.get(W + "hAnsiTheme") or ""
                if not face and th:
                    face = theme["major"] if th.startswith("major") else theme["minor"] if th.startswith("minor") else None
                if face:
                    f["font"] = face
            hl = rpr.find(W + "highlight")
            if hl is not None:
                f["hl"] = HIGHLIGHT.get(hl.get(W + "val"))
            shd = rpr.find(W + "shd")
            if shd is not None:
                fill = shd.get(W + "fill")
                f["shd"] = f"#{fill}" if fill and fill.lower() not in ("auto", "ffffff") else None
            va = rpr.find(W + "vertAlign")
            if va is not None:
                f["va"] = va.get(W + "val")
        return f

    style_rprs = lambda sid: [s["rPr"] for s in chain(sid)]  # noqa: E731
    style_pprs = lambda sid: [s["pPr"] for s in chain(sid)]  # noqa: E731
    base = run_format([doc_rpr, *style_rprs(default_para)])

    def last_kid(pprs, name):
        for p in reversed(pprs):
            if p is not None:
                k = p.find(W + name)
                if k is not None:
                    return k
        return None

    # Numbering.
    numfmt = {}
    if "word/numbering.xml" in names:
        nx = ET.fromstring(text("word/numbering.xml"))
        abstract = {}
        for an in nx.iter(W + "abstractNum"):
            lv = {}
            for l in an.iter(W + "lvl"):
                lv[l.get(W + "ilvl")] = {"fmt": _val(l, W + "numFmt") or "bullet", "start": int(_val(l, W + "start") or 1)}
            abstract[an.get(W + "abstractNumId")] = lv
        for n in nx.iter(W + "num"):
            aid = n.find(W + "abstractNumId")
            levels = dict(abstract.get(aid.get(W + "val") if aid is not None else "", {}))
            for o in n.iter(W + "lvlOverride"):
                so = o.find(W + "startOverride")
                il = o.get(W + "ilvl")
                if so is not None and il in levels:
                    levels[il] = {**levels[il], "start": int(so.get(W + "val") or 1)}
            numfmt[n.get(W + "numId")] = levels

    # Footnotes (shown as numbered notes at the end).
    notes_by_id = {}

    def image_html(blip_id, width_px):
        rel = rels.get(blip_id)
        if not rel or rel[1]:
            return ""
        target = rel[0]
        p = target[1:] if target.startswith("/") else "word/" + target.lstrip("./")
        if p not in names:
            return ""
        ext = p.rsplit(".", 1)[-1].lower()
        mime = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "bmp": "image/bmp"}.get(ext)
        if not mime:
            return ""
        data = base64.b64encode(z.read(p)).decode()
        w = f' width="{int(width_px)}"' if width_px else ""
        return f'<img src="data:{mime};base64,{data}"{w}>'

    notes_seq = []
    cur = {"rprs": [], "base": base, "bold": False}

    def run_html(r):
        rpr = r.find(W + "rPr")
        out = ""
        for c in r:
            tag = c.tag
            if tag == W + "t":
                out += html.escape(c.text or "")
            elif tag in (W + "tab", W + "ptab"):
                out += "&nbsp;&nbsp;&nbsp;&nbsp;"
            elif tag in (W + "br", W + "cr"):
                out += "<!--PB-->" if c.get(W + "type") == "page" else "<br>"
            elif tag == W + "noBreakHyphen":
                out += "‑"
            elif tag in (W + "footnoteReference", W + "endnoteReference"):
                nid = c.get(W + "id")
                notes_seq.append(nid)
                return f"<sup>{len(notes_seq)}</sup>"
            elif tag in (W + "drawing", W + "pict", W + "object"):
                blip = c.find(f".//{A}blip")
                rid = blip.get(R + "embed") if blip is not None else None
                if rid is None:
                    imd = c.find(f".//{V}imagedata")
                    rid = imd.get(R + "id") if imd is not None else None
                ext = c.find(f".//{WP}extent")
                wpx = int(ext.get("cx")) / 9525 if ext is not None else 0
                out += image_html(rid, wpx) if rid else ""
        if not out:
            return ""
        rs = _val(rpr, W + "rStyle") if rpr is not None else None
        f = run_format([*cur["rprs"], *(style_rprs(rs) if rs else []), rpr])
        if f.get("vanish"):
            return ""
        st = []
        b = cur["base"]
        if (f.get("color") or None) != (b.get("color") or None):
            st.append(f"color:#{f['color']}" if f.get("color") else "color:#000000")
        if f.get("sz") and f.get("sz") != b.get("sz"):
            st.append(f"font-size:{f['sz']}pt")
        if f.get("font") and f.get("font") != b.get("font"):
            st.append(f"font-family:'{f['font']}'")
        if f.get("hl"):
            st.append(f"background-color:{f['hl']}")
        elif f.get("shd"):
            st.append(f"background-color:{f['shd']}")
        if f.get("caps"):
            st.append("text-transform:uppercase")
        if f.get("smallCaps"):
            st.append("font-variant:small-caps")
        if st:
            out = f'<span style="{";".join(st)}">{out}</span>'
        if f.get("b") and not cur["bold"]:
            out = f"<b>{out}</b>"
        if f.get("i"):
            out = f"<i>{out}</i>"
        if f.get("u"):
            out = f"<u>{out}</u>"
        if f.get("strike") or f.get("dstrike"):
            out = f"<s>{out}</s>"
        if f.get("va") == "superscript":
            out = f"<sup>{out}</sup>"
        elif f.get("va") == "subscript":
            out = f"<sub>{out}</sub>"
        return out

    def runs_html(parent):
        out = ""
        field = 0
        for n in parent:
            tag = n.tag
            if tag == W + "r":
                # Field codes (PAGE, TOC...) show their result, not their code.
                fc = n.find(W + "fldChar")
                if fc is not None:
                    t = fc.get(W + "fldCharType")
                    field = 1 if t == "begin" else 0
                    continue
                if field or n.find(W + "instrText") is not None:
                    continue
                out += run_html(n)
            elif tag == W + "hyperlink":
                rid = n.get(R + "id")
                inner = runs_html(n)
                href = rels.get(rid, ("", False))[0] if rid else ""
                out += f'<a href="{html.escape(href)}">{inner}</a>' if href and re.match(r"^(https?:|mailto:)", href) else inner
            elif tag in (W + "ins", W + "moveTo", W + "smartTag", W + "customXml", W + "fldSimple", W + "sdtContent", W + "dir", W + "bdo"):
                out += runs_html(n)
            elif tag == W + "sdt":
                sc = n.find(W + "sdtContent")
                out += runs_html(sc if sc is not None else n)
        return out

    out_parts = []
    list_stack = []  # [(tag, numId)]
    counters = {}
    page_break_next = [False]

    def close_lists(level=-1):
        s = ""
        while len(list_stack) > level + 1:
            s += f"</{list_stack.pop()[0]}>"
        return s

    def para_style(pprs, listed):
        st = []
        jc = last_kid(pprs, "jc")
        j = jc.get(W + "val") if jc is not None else None
        if j == "center":
            st.append("text-align:center")
        elif j in ("right", "end"):
            st.append("text-align:right")
        elif j in ("both", "distribute"):
            st.append("text-align:justify")
        ind = last_kid(pprs, "ind")
        if ind is not None and not listed:
            left = int(ind.get(W + "left") or ind.get(W + "start") or 0)
            first = int(ind.get(W + "firstLine") or 0) - int(ind.get(W + "hanging") or 0)
            if left:
                st.append(f"margin-left:{left / 20:.0f}pt")
            if first:
                st.append(f"text-indent:{first / 20:.0f}pt")
        sp = last_kid(pprs, "spacing")
        if sp is not None:
            before = sp.get(W + "before")
            after = sp.get(W + "after")
            if before:
                st.append(f"margin-top:{int(before) / 20:.0f}pt")
            if after:
                st.append(f"margin-bottom:{int(after) / 20:.0f}pt")
            line = sp.get(W + "line")
            if line and (sp.get(W + "lineRule") in (None, "auto")):
                st.append(f"line-height:{int(int(line) / 240 * 100)}%")
        shd = last_kid(pprs, "shd")
        if shd is not None and shd.get(W + "fill") and shd.get(W + "fill").lower() not in ("auto", "ffffff"):
            st.append(f"background-color:#{shd.get(W + 'fill')}")
        if page_break_next[0]:
            st.append("page-break-before:always")
            page_break_next[0] = False
        return st

    def paragraph(p, in_table=False):
        ppr = p.find(W + "pPr")
        sid = (_val(ppr, W + "pStyle") if ppr is not None else None) or default_para
        sname = style_name(sid)
        pprs = [doc_ppr, *style_pprs(sid), ppr]
        num_id = None
        lvl = 0
        for x in pprs:
            np_ = x.find(W + "numPr") if x is not None else None
            if np_ is None:
                continue
            nid = np_.find(W + "numId")
            il = np_.find(W + "ilvl")
            if nid is not None:
                num_id = nid.get(W + "val")
            if il is not None:
                lvl = int(il.get(W + "val") or 0)
        heading = bool(re.match(r"^heading [1-6]$|^title$|^subtitle$", sname))
        rprs = style_rprs(sid)
        sf = run_format([doc_rpr, *rprs])
        cur["rprs"] = rprs
        cur["base"] = {**base, **sf} if heading else base
        cur["bold"] = heading and bool(sf.get("b"))
        body = runs_html(p)
        out = ""
        if "<!--PB-->" in body:
            body = body.replace("<!--PB-->", "")
            page_break_next[0] = True
            if not re.sub(r"<[^>]+>", "", body).strip() and "<img" not in body:
                return close_lists() if not in_table else ""
        listed = num_id and num_id != "0"
        st = para_style(pprs, listed)
        inner = body or "&nbsp;"
        if listed:
            f = numfmt.get(num_id, {}).get(str(lvl), {"fmt": "bullet", "start": 1})
            tag = "ul" if f["fmt"] in ("bullet", "none") else "ol"
            css = {"lowerLetter": "lower-alpha", "upperLetter": "upper-alpha", "lowerRoman": "lower-roman", "upperRoman": "upper-roman"}.get(f["fmt"])
            cnt = counters.setdefault(num_id, {})
            for k in [k for k in cnt if k > lvl]:
                del cnt[k]
            cnt[lvl] = cnt.get(lvl, f["start"] - 1) + 1
            if len(list_stack) > lvl + 1:
                out += close_lists(lvl)
            if len(list_stack) == lvl + 1 and (list_stack[lvl][0] != tag or (list_stack[lvl][1] != num_id and lvl == 0)):
                out += close_lists(lvl - 1)
            while len(list_stack) < lvl + 1:
                opening = len(list_stack) == lvl
                start = f' start="{cnt[lvl]}"' if opening and tag == "ol" and cnt[lvl] > 1 else ""
                style = f' style="list-style-type:{css}"' if css else ""
                out += f"<{tag}{start}{style}>"
                list_stack.append((tag, num_id))
            return out + f'<li style="{";".join(st)}">{inner}</li>'
        out += close_lists()
        css = ";".join(st)
        if sname.startswith("heading ") or sname in ("title", "subtitle"):
            n = {"title": 1, "subtitle": 2}.get(sname, int(sname[-1]) if sname[-1].isdigit() else 2)
            look = []
            if sf.get("sz"):
                look.append(f"font-size:{sf['sz']}pt")
            if sf.get("color"):
                look.append(f"color:#{sf['color']}")
            if sf.get("font"):
                look.append(f"font-family:'{sf['font']}'")
            look.append("font-weight:" + ("bold" if sf.get("b") else "normal"))
            return out + f'<h{n} style="{";".join([*look, css]) }">{inner}</h{n}>'
        if sname in ("quote", "intense quote"):
            return out + f'<p style="{css};margin-left:24pt;font-style:italic;color:#555555">{inner}</p>'
        return out + f'<p style="{css}">{inner}</p>'

    def table(tbl):
        rows = tbl.findall(W + "tr")
        grid = []
        for tr in rows:
            col = 0
            cells = []
            for tc in tr.findall(W + "tc"):
                tcpr = tc.find(W + "tcPr")
                span = int(_val(tcpr, W + "gridSpan") or 1) if tcpr is not None else 1
                vm = tcpr.find(W + "vMerge") if tcpr is not None else None
                cells.append({"tc": tc, "col": col, "span": span, "vm": None if vm is None else ("restart" if vm.get(W + "val") == "restart" else "cont"), "rows": 1, "skip": False})
                col += span
            grid.append(cells)
        for r, cells in enumerate(grid):
            for c in cells:
                if c["vm"] != "restart":
                    continue
                for rr in range(r + 1, len(grid)):
                    below = next((x for x in grid[rr] if x["col"] == c["col"]), None)
                    if below and below["vm"] == "cont":
                        c["rows"] += 1
                        below["skip"] = True
                    else:
                        break
        tblpr = tbl.find(W + "tblPr")
        borders = tblpr.find(W + "tblBorders") if tblpr is not None else None
        plain = borders is not None and all(b.get(W + "val") in ("nil", "none") for b in borders)
        look = tblpr.find(W + "tblLook") if tblpr is not None else None
        head = look is not None and (look.get(W + "firstRow") == "1" or (int(look.get(W + "val") or "0", 16) & 0x20))
        out = f'<table border="{0 if plain else 1}" cellspacing="0" cellpadding="5" width="100%" style="border-collapse:collapse;border-color:#888888;margin-bottom:8pt">'
        for r, cells in enumerate(grid):
            out += "<tr>"
            th = r == 0 and head and len(grid) > 1
            for c in cells:
                if c["skip"]:
                    continue
                tcpr = c["tc"].find(W + "tcPr")
                shd = tcpr.find(W + "shd") if tcpr is not None else None
                fill = shd.get(W + "fill") if shd is not None else None
                bg = f' bgcolor="#{fill}"' if fill and fill.lower() not in ("auto", "ffffff") else ""
                inner = ""
                list_stack.clear()
                for child in c["tc"]:
                    if child.tag == W + "p":
                        inner += paragraph(child, True)
                    elif child.tag == W + "tbl":
                        inner += close_lists() + table(child)
                inner += close_lists()
                m = re.fullmatch(r'<p style="">(.*)</p>', inner, re.S)
                if m and "<p" not in m.group(1):
                    inner = m.group(1)
                if th:
                    inner = f"<b>{inner}</b>"
                attrs = (f' colspan="{c["span"]}"' if c["span"] > 1 else "") + (f' rowspan="{c["rows"]}"' if c["rows"] > 1 else "")
                out += f"<td{attrs}{bg}>{inner or '&nbsp;'}</td>"
            out += "</tr>"
        return out + "</table>"

    body = root.find(W + "body")

    def blocks(parent):
        for n in parent:
            if n.tag == W + "p":
                out_parts.append(paragraph(n))
            elif n.tag == W + "tbl":
                out_parts.append(close_lists())
                if page_break_next[0]:
                    out_parts.append('<p style="page-break-before:always;margin:0"></p>')
                    page_break_next[0] = False
                out_parts.append(table(n))
                list_stack.clear()
            elif n.tag == W + "sdt":
                sc = n.find(W + "sdtContent")
                blocks(sc if sc is not None else n)
            elif n.tag in (W + "customXml", W + "ins"):
                blocks(n)

    blocks(body)
    out_parts.append(close_lists())

    # Footnotes and endnotes, in the order they are referred to.
    if notes_seq:
        for part, tag in (("word/footnotes.xml", "footnote"), ("word/endnotes.xml", "endnote")):
            if part in names:
                for n in ET.fromstring(text(part)).iter(W + tag):
                    if n.get(W + "type") in (None, "normal"):
                        cur.update(rprs=[], base=base, bold=False)
                        notes_by_id.setdefault(n.get(W + "id"), " ".join(runs_html(p) for p in n.findall(W + "p")).strip())
        out_parts.append('<hr><table cellspacing="0" cellpadding="1">')
        for i, nid in enumerate(notes_seq, 1):
            out_parts.append(f'<tr><td valign="top" style="font-size:9pt"><sup>{i}</sup></td><td style="font-size:9pt">{notes_by_id.get(nid, "")}</td></tr>')
        out_parts.append("</table>")

    page = Page()
    page.font = base.get("font") or ""
    page.size = base.get("sz") or (10 if "word/styles.xml" in names else 11)
    sect = body.find(W + "sectPr")
    if sect is None:
        secs = list(body.iter(W + "sectPr"))
        sect = secs[-1] if secs else None
    if sect is not None:
        pg = sect.find(W + "pgSz")
        if pg is not None and pg.get(W + "w") and pg.get(W + "h"):
            page.width_mm = int(pg.get(W + "w")) / 1440 * 25.4
            page.height_mm = int(pg.get(W + "h")) / 1440 * 25.4
        mar = sect.find(W + "pgMar")
        if mar is not None:
            g = lambda k, d: int(mar.get(W + k)) / 1440 * 25.4 if mar.get(W + k) else d  # noqa: E731
            page.margins_mm = (g("top", 25.4), g("right", 25.4), g("bottom", 25.4), g("left", 25.4))
        page.first_different = sect.find(W + "titlePg") is not None
        for ref_name, key in (("headerReference", "header"), ("footerReference", "footer")):
            refs = [r for r in sect.findall(W + ref_name)]
            ref = next((r for r in refs if r.get(W + "type") == "default"), refs[0] if refs else None)
            if ref is None or ref.get(R + "id") not in rels:
                continue
            target = rels[ref.get(R + "id")][0]
            part = text("word/" + target.lstrip("./"))
            if not part:
                continue
            proot = ET.fromstring(part)
            for p in proot.iter(W + "p"):
                s = ""
                infield = False
                instr = ""
                for r in p.iter():
                    if r.tag == W + "fldChar":
                        t = r.get(W + "fldCharType")
                        if t == "begin":
                            infield, instr = True, ""
                        elif t in ("separate", "end") and infield is True:
                            s += "{pages}" if "NUMPAGES" in instr else "{page}" if "PAGE" in instr else ""
                            infield = "skip" if t == "separate" else False
                        elif t == "end":
                            infield = False
                    elif r.tag == W + "instrText":
                        instr += r.text or ""
                    elif infield:
                        continue
                    elif r.tag == W + "t":
                        s += r.text or ""
                    elif r.tag == W + "tab":
                        s += "\t"
                for fs in p.iter(W + "fldSimple"):
                    ins = fs.get(W + "instr") or ""
                    s += "{pages}" if "NUMPAGES" in ins else "{page}" if "PAGE" in ins else ""
                if s.strip():
                    # Tabs split a line into left, centre and right parts (Word's header tab stops).
                    parts = s.split("\t")
                    if len(parts) >= 3:
                        zones = (parts[0].strip(), parts[1].strip(), " ".join(parts[2:]).strip())
                    elif len(parts) == 2:
                        zones = (parts[0].strip(), "", parts[1].strip())
                    else:
                        jc = p.find(f"{W}pPr/{W}jc")
                        align = {"center": 1, "right": 2, "end": 2}.get(jc.get(W + "val") if jc is not None else "", 0)
                        zones = tuple(s.strip() if i == align else "" for i in range(3))
                    setattr(page, key, zones)
                    break
    if "docProps/core.xml" in names:
        core = ET.fromstring(text("docProps/core.xml"))
        t = core.find("{http://purl.org/dc/elements/1.1/}title")
        page.title = (t.text or "") if t is not None else ""
    return "".join(out_parts), page
