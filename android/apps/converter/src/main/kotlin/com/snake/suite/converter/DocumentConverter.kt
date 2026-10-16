package com.snake.suite.converter

import android.graphics.Color
import android.graphics.Typeface
import android.graphics.pdf.PdfDocument
import android.text.Layout
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.AbsoluteSizeSpan
import android.text.style.BackgroundColorSpan
import android.text.style.LeadingMarginSpan
import android.text.style.StyleSpan
import android.text.style.TypefaceSpan
import android.util.Xml
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

// ------------------------------------------------------------------ the model

data class Run(val text: String, val bold: Boolean = false, val italic: Boolean = false, val code: Boolean = false)

sealed interface Block {
    data class Heading(val level: Int, val runs: List<Run>) : Block
    data class Para(val runs: List<Run>) : Block
    data class Item(val ordered: Boolean, val depth: Int, val runs: List<Run>) : Block
    data class Code(val text: String) : Block
    data class Table(val rows: List<List<String>>) : Block
    data object PageBreak : Block
}

data class Doc(val blocks: List<Block>)

private fun List<Run>.plain() = joinToString("") { it.text }

/**
 * Documents without LibreOffice: the desktop app's built-in engine keeps headings,
 * lists, bold/italic and tables but not page layout; this does the same.
 */
class DocumentConverter : Converter {

    override suspend fun convert(src: File, outDir: File, stem: String, target: String, opts: Options, progress: Progress): List<File> =
        withContext(Dispatchers.IO) {
            val doc = read(src)
            progress(0.5f)
            val dst = File(outDir, "$stem.$target")
            when (target) {
                "txt" -> dst.writeText(toText(doc))
                "md" -> dst.writeText(toMarkdown(doc))
                "html" -> dst.writeText(toHtml(doc, stem))
                "docx" -> writeDocx(doc, dst)
                "pdf" -> writePdf(doc, dst)
                else -> throw ConversionError("Unsupported document format: $target")
            }
            listOf(dst)
        }

    companion object {
        fun read(src: File): Doc = when (Formats.normal(src.extension)) {
            "docx" -> readDocx(src)
            "md" -> readMarkdown(readText(src))
            "html" -> readHtml(readText(src))
            "rtf" -> readRtf(readText(src))
            else -> Doc(readText(src).lines().map { Block.Para(listOf(Run(it))) })
        }

        /** Read a text file without assuming it is UTF-8. */
        fun readText(f: File): String {
            val data = f.readBytes()
            if (data.size >= 2 && ((data[0] == 0xFF.toByte() && data[1] == 0xFE.toByte()) || (data[0] == 0xFE.toByte() && data[1] == 0xFF.toByte()))) {
                return String(data, Charsets.UTF_16)
            }
            val utf8 = Charsets.UTF_8.newDecoder()
            return runCatching { utf8.decode(java.nio.ByteBuffer.wrap(data)).toString().removePrefix("\uFEFF") }
                .getOrElse { String(data, charset("windows-1252")) }
        }

        // -------------------------------------------------------------- Markdown

        private val INLINE = Regex("""\*\*(.+?)\*\*|__(.+?)__|\*(.+?)\*|_(.+?)_|`(.+?)`|\[(.+?)]\((.+?)\)""")

        fun inline(text: String): List<Run> {
            val runs = mutableListOf<Run>()
            var pos = 0
            for (m in INLINE.findAll(text)) {
                if (m.range.first > pos) runs += Run(text.substring(pos, m.range.first))
                val g = m.groupValues
                runs += when {
                    g[1].isNotEmpty() -> Run(g[1], bold = true)
                    g[2].isNotEmpty() -> Run(g[2], bold = true)
                    g[3].isNotEmpty() -> Run(g[3], italic = true)
                    g[4].isNotEmpty() -> Run(g[4], italic = true)
                    g[5].isNotEmpty() -> Run(g[5], code = true)
                    else -> Run(g[6])
                }
                pos = m.range.last + 1
            }
            if (pos < text.length) runs += Run(text.substring(pos))
            return runs
        }

        fun readMarkdown(text: String): Doc {
            val blocks = mutableListOf<Block>()
            val lines = text.replace("\r\n", "\n").lines()
            var i = 0
            val para = StringBuilder()
            fun flush() {
                if (para.isNotBlank()) blocks += Block.Para(inline(para.toString().trim()))
                para.clear()
            }
            while (i < lines.size) {
                val line = lines[i]
                val trimmed = line.trim()
                when {
                    trimmed.startsWith("```") -> {
                        flush()
                        val code = StringBuilder()
                        i++
                        while (i < lines.size && !lines[i].trim().startsWith("```")) code.appendLine(lines[i++])
                        blocks += Block.Code(code.toString().trimEnd('\n'))
                    }
                    Regex("^#{1,6}\\s").containsMatchIn(trimmed) -> {
                        flush()
                        val level = trimmed.takeWhile { it == '#' }.length
                        blocks += Block.Heading(level, inline(trimmed.drop(level).trim().trimEnd('#').trim()))
                    }
                    Regex("^\\s*[-*+]\\s+").containsMatchIn(line) -> {
                        flush()
                        val depth = line.takeWhile { it == ' ' }.length / 2
                        blocks += Block.Item(false, depth, inline(line.trim().drop(1).trim()))
                    }
                    Regex("^\\s*\\d+[.)]\\s+").containsMatchIn(line) -> {
                        flush()
                        val depth = line.takeWhile { it == ' ' }.length / 3
                        blocks += Block.Item(true, depth, inline(line.trim().replaceFirst(Regex("^\\d+[.)]\\s+"), "")))
                    }
                    trimmed.startsWith("|") -> {
                        flush()
                        val rows = mutableListOf<List<String>>()
                        while (i < lines.size && lines[i].trim().startsWith("|")) {
                            val cells = lines[i].trim().trim('|').split('|').map { it.trim() }
                            if (!cells.all { it.matches(Regex(":?-{2,}:?")) }) rows += cells
                            i++
                        }
                        i--
                        blocks += Block.Table(rows)
                    }
                    trimmed.matches(Regex("^(---+|\\*\\*\\*+)$")) -> flush()
                    trimmed.isEmpty() -> flush()
                    else -> para.append(trimmed.removePrefix("> ")).append(' ')
                }
                i++
            }
            flush()
            return Doc(blocks)
        }

        fun toMarkdown(doc: Doc): String = doc.blocks.joinToString("\n\n") { b ->
            fun md(runs: List<Run>) = runs.joinToString("") {
                when {
                    it.code -> "`${it.text}`"
                    it.bold && it.italic -> "***${it.text}***"
                    it.bold -> "**${it.text}**"
                    it.italic -> "*${it.text}*"
                    else -> it.text
                }
            }
            when (b) {
                is Block.Heading -> "#".repeat(b.level.coerceIn(1, 6)) + " " + md(b.runs)
                is Block.Para -> md(b.runs)
                is Block.Item -> "  ".repeat(b.depth) + (if (b.ordered) "1. " else "- ") + md(b.runs)
                is Block.Code -> "```\n${b.text}\n```"
                is Block.Table -> b.rows.mapIndexed { r, row ->
                    val line = "| " + row.joinToString(" | ") { it.replace("|", "\\|") } + " |"
                    if (r == 0) line + "\n|" + row.joinToString("|") { " --- " } + "|" else line
                }.joinToString("\n")
                Block.PageBreak -> "---"
            }
        }.replace(Regex("(?m)^(- .*|  +- .*|1\\. .*)\n\n(?=  *(- |1\\. ))"), "$1\n")

        // -------------------------------------------------------------- plain text

        fun toText(doc: Doc): String = doc.blocks.joinToString("\n") { b ->
            when (b) {
                is Block.Heading -> b.runs.plain().let { if (b.level <= 2) "\n$it\n" + (if (b.level == 1) "=" else "-").repeat(it.length) else "\n$it" }
                is Block.Para -> b.runs.plain()
                is Block.Item -> "  ".repeat(b.depth) + (if (b.ordered) "* " else "- ") + b.runs.plain()
                is Block.Code -> b.text
                is Block.Table -> b.rows.joinToString("\n") { it.joinToString("\t") }
                Block.PageBreak -> "\u000C"
            }
        }.trim() + "\n"

        // -------------------------------------------------------------- HTML

        private fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")

        fun toHtml(doc: Doc, title: String): String {
            fun h(runs: List<Run>) = runs.joinToString("") {
                var t = esc(it.text)
                if (it.code) t = "<code>$t</code>"
                if (it.italic) t = "<em>$t</em>"
                if (it.bold) t = "<strong>$t</strong>"
                t
            }
            val body = StringBuilder()
            var openList: Boolean? = null
            fun closeList() { openList?.let { body.append(if (it) "</ol>\n" else "</ul>\n") }; openList = null }
            for (b in doc.blocks) {
                if (b !is Block.Item) closeList()
                when (b) {
                    is Block.Heading -> body.append("<h${b.level}>${h(b.runs)}</h${b.level}>\n")
                    is Block.Para -> body.append("<p>${h(b.runs)}</p>\n")
                    is Block.Item -> {
                        if (openList != b.ordered) { closeList(); body.append(if (b.ordered) "<ol>\n" else "<ul>\n"); openList = b.ordered }
                        body.append("<li style=\"margin-left:${b.depth * 1.5}em\">${h(b.runs)}</li>\n")
                    }
                    is Block.Code -> body.append("<pre><code>${esc(b.text)}</code></pre>\n")
                    is Block.Table -> {
                        body.append("<table>\n")
                        b.rows.forEachIndexed { r, row ->
                            val tag = if (r == 0) "th" else "td"
                            body.append("<tr>").append(row.joinToString("") { "<$tag>${esc(it)}</$tag>" }).append("</tr>\n")
                        }
                        body.append("</table>\n")
                    }
                    Block.PageBreak -> body.append("<hr style=\"page-break-after:always\">\n")
                }
            }
            closeList()
            return """<!doctype html>
<html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:sans-serif;max-width:46em;margin:2em auto;line-height:1.5;padding:0 1em}
table{border-collapse:collapse}td,th{border:1px solid #999;padding:4px 8px}pre{background:#f4f4f4;padding:8px;overflow:auto}</style>
</head><body>
$body</body></html>
"""
        }

        /** A forgiving tag-soup reader: headings, paragraphs, lists, tables, bold/italic/code. */
        fun readHtml(html: String): Doc {
            val clean = html.replace(Regex("(?is)<(script|style|head)[^>]*>.*?</\\1>"), "")
                .replace(Regex("(?s)<!--.*?-->"), "")
                .replace(Regex("<![^>]*>|<\\?[^>]*>"), "")   // <!doctype html>, <?xml ...?>
            val blocks = mutableListOf<Block>()
            var runs = mutableListOf<Run>()
            var bold = 0; var italic = 0; var code = 0
            var heading = 0
            val lists = ArrayDeque<Boolean>()
            var inItem = false
            var pre: StringBuilder? = null
            var table: MutableList<MutableList<String>>? = null
            var cell: StringBuilder? = null
            fun flush() {
                val text = runs.plain()
                if (text.isNotBlank()) {
                    val trimmed = runs.map { it.copy(text = it.text.replace(Regex("\\s+"), " ")) }
                        .toMutableList().apply {
                            if (isNotEmpty()) { this[0] = this[0].copy(text = this[0].text.trimStart()); this[lastIndex] = this[lastIndex].copy(text = this[lastIndex].text.trimEnd()) }
                        }
                    blocks += when {
                        heading > 0 -> Block.Heading(heading, trimmed)
                        inItem -> Block.Item(lists.lastOrNull() ?: false, (lists.size - 1).coerceAtLeast(0), trimmed)
                        else -> Block.Para(trimmed)
                    }
                }
                runs = mutableListOf()
            }
            val token = Regex("<(/?)([a-zA-Z0-9]+)[^>]*>|([^<]+)")
            for (m in token.findAll(clean)) {
                val text = m.groupValues[3]
                if (text.isNotEmpty()) {
                    val t = decodeEntities(text)
                    when {
                        pre != null -> pre.append(t)
                        cell != null -> cell.append(t)
                        else -> runs += Run(t, bold > 0, italic > 0, code > 0)
                    }
                    continue
                }
                val closing = m.groupValues[1] == "/"
                when (val tag = m.groupValues[2].lowercase()) {
                    "b", "strong" -> bold += if (closing) -1 else 1
                    "i", "em" -> italic += if (closing) -1 else 1
                    "code", "tt", "kbd" -> if (pre == null) code += if (closing) -1 else 1
                    "h1", "h2", "h3", "h4", "h5", "h6" -> { flush(); heading = if (closing) 0 else tag[1].digitToInt() }
                    "p", "div", "section", "article", "blockquote" -> flush()
                    "br" -> if (cell != null) cell.append(' ') else if (pre != null) pre.append('\n') else flush()
                    "ul", "ol" -> { flush(); if (closing) lists.removeLastOrNull() else lists.addLast(tag == "ol") }
                    "li" -> { flush(); inItem = !closing }
                    "pre" -> if (closing) { pre?.let { blocks += Block.Code(it.toString().trimEnd()) }; pre = null } else { flush(); pre = StringBuilder() }
                    "table" -> if (closing) { table?.let { blocks += Block.Table(it) }; table = null } else { flush(); table = mutableListOf() }
                    "tr" -> if (!closing) table?.add(mutableListOf())
                    "td", "th" -> if (closing) { cell?.let { table?.lastOrNull()?.add(it.toString().trim()) }; cell = null } else cell = StringBuilder()
                }
            }
            flush()
            return Doc(blocks)
        }

        private fun decodeEntities(s: String): String =
            s.replace(Regex("&(#x?[0-9a-fA-F]+|[a-zA-Z]+);")) { m ->
                val e = m.groupValues[1]
                when {
                    e.startsWith("#x") || e.startsWith("#X") -> e.drop(2).toIntOrNull(16)?.let { String(Character.toChars(it)) } ?: m.value
                    e.startsWith("#") -> e.drop(1).toIntOrNull()?.let { String(Character.toChars(it)) } ?: m.value
                    else -> mapOf("amp" to "&", "lt" to "<", "gt" to ">", "quot" to "\"", "apos" to "'", "nbsp" to "\u00A0",
                        "mdash" to "—", "ndash" to "–", "hellip" to "…", "copy" to "©", "rsquo" to "’", "lsquo" to "‘",
                        "rdquo" to "”", "ldquo" to "“")[e] ?: m.value
                }
            }

        // -------------------------------------------------------------- RTF

        /** Text, paragraphs, bold and italic from RTF; everything else is dropped. */
        fun readRtf(rtf: String): Doc {
            val blocks = mutableListOf<Block>()
            var runs = mutableListOf<Run>()
            val text = StringBuilder()
            var bold = false; var italic = false
            val stack = ArrayDeque<Pair<Boolean, Boolean>>()
            var skipDepth = -1
            var depth = 0
            fun emit() { if (text.isNotEmpty()) { runs += Run(text.toString(), bold, italic); text.clear() } }
            fun para() { emit(); if (runs.plain().isNotBlank()) blocks += Block.Para(runs); runs = mutableListOf() }
            var i = 0
            while (i < rtf.length) {
                val c = rtf[i]
                when {
                    c == '{' -> { stack.addLast(bold to italic); depth++ }
                    c == '}' -> { emit(); stack.removeLastOrNull()?.let { bold = it.first; italic = it.second }; if (depth == skipDepth) skipDepth = -1; depth-- }
                    c == '\\' -> {
                        val m = Regex("""\\([a-zA-Z]+)(-?\d+)? ?|\\'([0-9a-fA-F]{2})|\\(.)""").find(rtf, i)!!
                        val word = m.groupValues[1]
                        if (skipDepth < 0) when {
                            m.groupValues[3].isNotEmpty() -> text.append(m.groupValues[3].toInt(16).toChar())
                            m.groupValues[4] == "*" -> skipDepth = depth
                            m.groupValues[4].isNotEmpty() -> text.append(m.groupValues[4])
                            word in setOf("fonttbl", "colortbl", "stylesheet", "info", "pict", "header", "footer") -> skipDepth = depth
                            word == "par" || word == "line" -> para()
                            word == "tab" -> text.append('\t')
                            word == "b" -> { emit(); bold = m.groupValues[2] != "0" }
                            word == "i" -> { emit(); italic = m.groupValues[2] != "0" }
                            word == "u" -> m.groupValues[2].toIntOrNull()?.let { text.append(it.toChar()) }
                        }
                        i = m.range.last
                    }
                    c == '\r' || c == '\n' -> Unit
                    skipDepth < 0 -> text.append(c)
                }
                i++
            }
            para()
            return Doc(blocks)
        }

        // -------------------------------------------------------------- DOCX

        private const val W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"

        fun readDocx(src: File): Doc = ZipFile(src).use { zip ->
            val ordered = mutableSetOf<String>()   // numIds whose list is numbered
            zip.getEntry("word/numbering.xml")?.let { e ->
                val abstractFmt = mutableMapOf<String, String>()
                val numToAbstract = mutableMapOf<String, String>()
                val p = Xml.newPullParser().apply { setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true); setInput(zip.getInputStream(e), null) }
                var abs: String? = null
                var num: String? = null
                while (p.next() != XmlPullParser.END_DOCUMENT) {
                    if (p.eventType != XmlPullParser.START_TAG) continue
                    when (p.name) {
                        "abstractNum" -> abs = p.getAttributeValue(W, "abstractNumId")
                        "numFmt" -> abs?.let { a -> abstractFmt.putIfAbsent(a, p.getAttributeValue(W, "val") ?: "") }
                        "num" -> num = p.getAttributeValue(W, "numId")
                        "abstractNumId" -> num?.let { n -> numToAbstract[n] = p.getAttributeValue(W, "val") ?: "" }
                    }
                }
                numToAbstract.forEach { (n, a) -> if (abstractFmt[a] != null && abstractFmt[a] != "bullet") ordered += n }
            }
            val entry = zip.getEntry("word/document.xml") ?: throw ConversionError("Not a Word document")
            val p = Xml.newPullParser().apply { setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, true); setInput(zip.getInputStream(entry), null) }
            val blocks = mutableListOf<Block>()
            var runs = mutableListOf<Run>()
            var style = ""
            var numId: String? = null
            var ilvl = 0
            var bold = false; var italic = false; var inRunProps = false
            var tableDepth = 0
            var rows = mutableListOf<MutableList<String>>()
            var cell = StringBuilder()
            var pageBreak = false
            while (p.next() != XmlPullParser.END_DOCUMENT) {
                when (p.eventType) {
                    XmlPullParser.START_TAG -> when (p.name) {
                        "p" -> { runs = mutableListOf(); style = ""; numId = null; ilvl = 0 }
                        "pStyle" -> style = p.getAttributeValue(W, "val") ?: ""
                        "numId" -> numId = p.getAttributeValue(W, "val")
                        "ilvl" -> ilvl = p.getAttributeValue(W, "val")?.toIntOrNull() ?: 0
                        "r" -> { bold = false; italic = false }
                        "rPr" -> inRunProps = true
                        "b" -> if (inRunProps) bold = p.getAttributeValue(W, "val").let { it == null || it == "1" || it == "true" }
                        "i" -> if (inRunProps) italic = p.getAttributeValue(W, "val").let { it == null || it == "1" || it == "true" }
                        "t" -> {
                            val t = p.nextText()
                            if (tableDepth > 0) cell.append(t) else runs += Run(t, bold, italic)
                        }
                        "tab" -> if (tableDepth > 0) cell.append(' ') else runs += Run("\t")
                        "br" -> if (p.getAttributeValue(W, "type") == "page") pageBreak = true else if (tableDepth == 0) runs += Run("\n")
                        "tbl" -> { if (tableDepth++ == 0) rows = mutableListOf() }
                        "tr" -> if (tableDepth == 1) rows += mutableListOf<String>()
                        "tc" -> if (tableDepth == 1) cell = StringBuilder()
                    }
                    XmlPullParser.END_TAG -> when (p.name) {
                        "rPr" -> inRunProps = false
                        "tc" -> if (tableDepth == 1) rows.lastOrNull()?.add(cell.toString().trim())
                        "tbl" -> if (--tableDepth == 0) blocks += Block.Table(rows)
                        "p" -> if (tableDepth > 0) {
                            if (cell.isNotEmpty()) cell.append(' ')
                        } else {
                            if (pageBreak) { blocks += Block.PageBreak; pageBreak = false }
                            val heading = Regex("(?i)^(heading|berschrift|titre)\\s*(\\d)").find(style)?.groupValues?.get(2)?.toInt()
                                ?: if (style.equals("Title", true)) 1 else null
                            blocks += when {
                                heading != null -> Block.Heading(heading, runs)
                                numId != null && numId != "0" -> Block.Item(numId in ordered, ilvl, runs)
                                else -> Block.Para(runs)
                            }
                        }
                    }
                }
            }
            Doc(blocks)
        }

        fun writeDocx(doc: Doc, dst: File) {
            fun xml(s: String) = esc(s)
            fun runs(rs: List<Run>) = rs.joinToString("") { r ->
                val props = buildString {
                    if (r.bold) append("<w:b/>")
                    if (r.italic) append("<w:i/>")
                    if (r.code) append("<w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/>")
                }
                r.text.split('\n').joinToString("<w:br/>") { part ->
                    part.split('\t').joinToString("<w:tab/>") { "<w:t xml:space=\"preserve\">${xml(it)}</w:t>" }
                }.let { "<w:r>${if (props.isEmpty()) "" else "<w:rPr>$props</w:rPr>"}$it</w:r>" }
            }
            val body = StringBuilder()
            for (b in doc.blocks) {
                body.append(
                    when (b) {
                        is Block.Heading -> "<w:p><w:pPr><w:pStyle w:val=\"Heading${b.level.coerceIn(1, 6)}\"/></w:pPr>${runs(b.runs)}</w:p>"
                        is Block.Para -> "<w:p>${runs(b.runs)}</w:p>"
                        is Block.Item -> "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/><w:numPr><w:ilvl w:val=\"${b.depth.coerceIn(0, 8)}\"/><w:numId w:val=\"${if (b.ordered) 2 else 1}\"/></w:numPr></w:pPr>${runs(b.runs)}</w:p>"
                        is Block.Code -> b.text.lines().joinToString("") { "<w:p><w:pPr><w:pStyle w:val=\"Code\"/></w:pPr>${runs(listOf(Run(it, code = true)))}</w:p>" }
                        is Block.Table -> "<w:tbl><w:tblPr><w:tblStyle w:val=\"TableGrid\"/><w:tblW w:w=\"0\" w:type=\"auto\"/></w:tblPr>" +
                            b.rows.mapIndexed { r, row ->
                                "<w:tr>" + row.joinToString("") { "<w:tc><w:p>${runs(listOf(Run(it, bold = r == 0)))}</w:p></w:tc>" } + "</w:tr>"
                            }.joinToString("") + "</w:tbl><w:p/>"
                        Block.PageBreak -> "<w:p><w:r><w:br w:type=\"page\"/></w:r></w:p>"
                    },
                )
            }
            val ns = "xmlns:w=\"$W\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\""
            val files = linkedMapOf(
                "[Content_Types].xml" to """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>""",
                "_rels/.rels" to """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>""",
                "word/_rels/document.xml.rels" to """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>""",
                "word/document.xml" to """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document $ns><w:body>$body<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>""",
                "word/styles.xml" to """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles $ns><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="259" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>""" +
                    (1..6).joinToString("") { lvl ->
                        val size = listOf(36, 30, 26, 24, 22, 22)[lvl - 1]
                        """<w:style w:type="paragraph" w:styleId="Heading$lvl"><w:name w:val="heading $lvl"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="${lvl - 1}"/></w:pPr><w:rPr><w:b/><w:sz w:val="$size"/></w:rPr></w:style>"""
                    } +
                    """<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="40"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="F4F4F4"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:left w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:right w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="999999"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="999999"/></w:tblBorders></w:tblPr></w:style></w:styles>""",
                "word/numbering.xml" to """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering $ns>""" + listOf("bullet" to "•", "decimal" to "%1.").mapIndexed { a, (fmt, text) ->
                    "<w:abstractNum w:abstractNumId=\"$a\">" + (0..8).joinToString("") { l ->
                        val t = if (fmt == "decimal") "%${l + 1}." else text
                        "<w:lvl w:ilvl=\"$l\"><w:start w:val=\"1\"/><w:numFmt w:val=\"$fmt\"/><w:lvlText w:val=\"$t\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"${720 * (l + 1)}\" w:hanging=\"360\"/></w:pPr></w:lvl>"
                    } + "</w:abstractNum>"
                }.joinToString("") + """<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>""",
            )
            ZipOutputStream(dst.outputStream()).use { zip ->
                files.forEach { (name, content) ->
                    zip.putNextEntry(ZipEntry(name))
                    zip.write(content.toByteArray())
                    zip.closeEntry()
                }
            }
        }

        // -------------------------------------------------------------- PDF

        private const val PAGE_W = 595   // A4 in points
        private const val PAGE_H = 842
        private const val MARGIN = 56

        /** Lay the document out with Android's text engine onto A4 pages. */
        fun writePdf(doc: Doc, dst: File) {
            val text = SpannableStringBuilder()
            fun styled(runs: List<Run>) {
                for (r in runs) {
                    val start = text.length
                    text.append(r.text)
                    if (r.bold && r.italic) text.setSpan(StyleSpan(Typeface.BOLD_ITALIC), start, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    else if (r.bold) text.setSpan(StyleSpan(Typeface.BOLD), start, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    else if (r.italic) text.setSpan(StyleSpan(Typeface.ITALIC), start, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                    if (r.code) text.setSpan(TypefaceSpan("monospace"), start, text.length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
                }
            }
            fun block(start: Int, vararg spans: Any) = spans.forEach { text.setSpan(it, start, text.length, Spanned.SPAN_PARAGRAPH) }
            val counters = IntArray(10)
            val breaks = mutableListOf<Int>()   // text offsets that start a new page
            for (b in doc.blocks) {
                if (b !is Block.Item) counters.fill(0)
                val start = text.length
                when (b) {
                    is Block.Heading -> {
                        styled(b.runs)
                        val size = listOf(22, 18, 15, 13, 12, 11)[b.level.coerceIn(1, 6) - 1]
                        block(start, AbsoluteSizeSpan(size), StyleSpan(Typeface.BOLD))
                    }
                    is Block.Para -> styled(b.runs)
                    is Block.Item -> {
                        val d = b.depth.coerceIn(0, 9)
                        counters[d]++
                        for (k in d + 1 until counters.size) counters[k] = 0
                        text.append(if (b.ordered) "${counters[d]}.\t" else "•\t")
                        styled(b.runs)
                        block(start, LeadingMarginSpan.Standard(18 * d + 4, 18 * d + 18))
                    }
                    is Block.Code -> {
                        text.append(b.text)
                        block(start, TypefaceSpan("monospace"), AbsoluteSizeSpan(9), BackgroundColorSpan(0xFFF2F2F2.toInt()))
                    }
                    is Block.Table -> {
                        val widths = IntArray(b.rows.maxOfOrNull { it.size } ?: 0)
                        b.rows.forEach { row -> row.forEachIndexed { i, c -> widths[i] = maxOf(widths[i], minOf(c.length, 40)) } }
                        b.rows.forEachIndexed { r, row ->
                            text.append(row.mapIndexed { i, c -> c.take(40).padEnd(widths[i]) }.joinToString("  ").trimEnd())
                            if (r == 0) text.append("\n" + widths.joinToString("  ") { "─".repeat(it) })
                            if (r < b.rows.lastIndex) text.append('\n')
                        }
                        block(start, TypefaceSpan("monospace"), AbsoluteSizeSpan(8))
                    }
                    Block.PageBreak -> { breaks += text.length; continue }
                }
                text.append("\n")
            }
            val paint = TextPaint(TextPaint.ANTI_ALIAS_FLAG).apply { textSize = 11f; color = Color.BLACK }
            val width = PAGE_W - 2 * MARGIN
            val layout = StaticLayout.Builder.obtain(text, 0, text.length, paint, width)
                .setAlignment(Layout.Alignment.ALIGN_NORMAL).setLineSpacing(2f, 1.1f).build()
            val pdf = PdfDocument()
            try {
                var line = 0
                var pageNo = 1
                val usable = PAGE_H - 2 * MARGIN
                while (line < layout.lineCount || pageNo == 1) {
                    val top = if (line < layout.lineCount) layout.getLineTop(line) else 0
                    var end = line
                    while (end < layout.lineCount && layout.getLineBottom(end) - top <= usable) {
                        if (end > line && breaks.any { it == layout.getLineStart(end) }) break
                        end++
                    }
                    if (end == line && line < layout.lineCount) end++   // a line taller than the page
                    val page = pdf.startPage(PdfDocument.PageInfo.Builder(PAGE_W, PAGE_H, pageNo).create())
                    val c = page.canvas
                    c.save()
                    c.translate(MARGIN.toFloat(), (MARGIN - top).toFloat())
                    val bottom = if (end > 0 && end <= layout.lineCount) layout.getLineBottom(end - 1) else top
                    c.clipRect(0, top, width, bottom)
                    layout.draw(c)
                    c.restore()
                    pdf.finishPage(page)
                    pageNo++
                    line = end
                    if (layout.lineCount == 0) break
                }
                dst.outputStream().use { pdf.writeTo(it) }
            } finally {
                pdf.close()
            }
        }
    }
}
