package com.snake.suite.converter

import android.util.Xml
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject
import org.xmlpull.v1.XmlPullParser
import java.io.File
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import java.util.zip.ZipOutputStream

/** A sheet: its name and rows of cell text. */
data class Sheet(val name: String, val rows: List<List<String>>)

/** Spreadsheets: XLSX, CSV, TSV and JSON both ways, PDF out (the desktop's built-in set). */
class SheetConverter : Converter {

    override suspend fun convert(src: File, outDir: File, stem: String, target: String, opts: Options, progress: Progress): List<File> =
        withContext(Dispatchers.IO) {
            val sheets = read(src).filter { it.rows.isNotEmpty() }.ifEmpty { listOf(Sheet("Sheet1", emptyList())) }
            progress(0.5f)
            when (target) {
                "xlsx" -> listOf(File(outDir, "$stem.xlsx").also { writeXlsx(sheets, it) })
                "json" -> listOf(File(outDir, "$stem.json").also { it.writeText(toJson(sheets)) })
                "pdf" -> listOf(File(outDir, "$stem.pdf").also { dst ->
                    val blocks = sheets.flatMapIndexed { i, s ->
                        listOfNotNull(
                            if (i > 0) Block.PageBreak else null,
                            if (sheets.size > 1) Block.Heading(2, listOf(Run(s.name))) else null,
                            Block.Table(s.rows),
                        )
                    }
                    DocumentConverter.writePdf(Doc(blocks), dst)
                })
                "csv", "tsv" -> {
                    // One file per sheet when there are several, like a spreadsheet's "save as CSV".
                    val sep = if (target == "csv") ',' else '\t'
                    sheets.map { s ->
                        val name = if (sheets.size == 1) "$stem.$target" else "$stem-${s.name.replace(Regex("[\\\\/:*?\"<>|]"), "_")}.$target"
                        File(outDir, name).also { it.writeText(toDelimited(s.rows, sep)) }
                    }
                }
                else -> throw ConversionError("Unsupported spreadsheet format: $target")
            }
        }

    companion object {
        fun read(src: File): List<Sheet> = when (Formats.normal(src.extension)) {
            "xlsx" -> readXlsx(src)
            "tsv" -> listOf(Sheet(src.nameWithoutExtension, parseDelimited(DocumentConverter.readText(src), '\t')))
            "json" -> readJson(DocumentConverter.readText(src), src.nameWithoutExtension)
            else -> {
                val text = DocumentConverter.readText(src)
                // Guess the separator from the first line, like Excel does for ; in many locales.
                val first = text.lineSequence().firstOrNull().orEmpty()
                val sep = listOf(',', ';', '\t').maxBy { c -> first.count { it == c } }
                listOf(Sheet(src.nameWithoutExtension, parseDelimited(text, sep)))
            }
        }

        // ------------------------------------------------------------ CSV / TSV

        fun parseDelimited(text: String, sep: Char): List<List<String>> {
            val rows = mutableListOf<List<String>>()
            var row = mutableListOf<String>()
            val cell = StringBuilder()
            var quoted = false
            var i = 0
            while (i < text.length) {
                val c = text[i]
                if (quoted) {
                    if (c == '"') {
                        if (i + 1 < text.length && text[i + 1] == '"') { cell.append('"'); i++ } else quoted = false
                    } else cell.append(c)
                } else when (c) {
                    '"' -> if (cell.isEmpty()) quoted = true else cell.append(c)
                    sep -> { row += cell.toString(); cell.clear() }
                    '\r' -> Unit
                    '\n' -> { row += cell.toString(); cell.clear(); rows += row; row = mutableListOf() }
                    else -> cell.append(c)
                }
                i++
            }
            if (cell.isNotEmpty() || row.isNotEmpty()) { row += cell.toString(); rows += row }
            return rows
        }

        fun toDelimited(rows: List<List<String>>, sep: Char): String = rows.joinToString("\r\n") { row ->
            row.joinToString(sep.toString()) { v ->
                if (v.any { it == sep || it == '"' || it == '\n' || it == '\r' }) "\"" + v.replace("\"", "\"\"") + "\"" else v
            }
        } + "\r\n"

        // ------------------------------------------------------------ JSON

        /** A list of rows, a list of objects (keys become the header row), or {sheet: either}. */
        fun readJson(text: String, name: String): List<Sheet> {
            fun rowsOf(arr: JSONArray): List<List<String>> {
                if (arr.length() == 0) return emptyList()
                if (arr.opt(0) is JSONObject) {
                    val keys = linkedSetOf<String>()
                    for (i in 0 until arr.length()) arr.optJSONObject(i)?.keys()?.forEach { keys += it }
                    return listOf(keys.toList()) + (0 until arr.length()).map { i ->
                        val o = arr.optJSONObject(i)
                        keys.map { k -> o?.opt(k)?.let { if (it == JSONObject.NULL) "" else it.toString() } ?: "" }
                    }
                }
                return (0 until arr.length()).map { i ->
                    when (val r = arr.opt(i)) {
                        is JSONArray -> (0 until r.length()).map { j -> r.opt(j)?.let { if (it == JSONObject.NULL) "" else it.toString() } ?: "" }
                        else -> listOf(r?.toString() ?: "")
                    }
                }
            }
            return when (val root = org.json.JSONTokener(text).nextValue()) {
                is JSONArray -> listOf(Sheet(name, rowsOf(root)))
                is JSONObject -> root.keys().asSequence().mapNotNull { k -> root.optJSONArray(k)?.let { Sheet(k, rowsOf(it)) } }.toList()
                    .ifEmpty { listOf(Sheet(name, rowsOf(JSONArray().put(root)))) }
                else -> throw ConversionError("This JSON is not a table")
            }
        }

        /** Written by hand so the columns keep their order whatever JSONObject does with keys. */
        fun toJson(sheets: List<Sheet>): String {
            fun value(s: String): String = s.toLongOrNull()?.toString()
                ?: s.toDoubleOrNull()?.takeIf { !it.isNaN() && !it.isInfinite() && s.trim() == s }?.let { s }
                ?: when (s) { "true", "false" -> s; else -> JSONObject.quote(s) }
            fun rows(s: Sheet, indent: String): String {
                val header = s.rows.firstOrNull().orEmpty()
                val asObjects = header.isNotEmpty() && header.all { it.isNotBlank() } && header.toSet().size == header.size
                val items = if (asObjects) s.rows.drop(1).map { r ->
                    header.mapIndexed { i, h -> "${JSONObject.quote(h)}: ${value(r.getOrElse(i) { "" })}" }.joinToString(", ", "{", "}")
                } else s.rows.map { r -> r.joinToString(", ", "[", "]") { value(it) } }
                return if (items.isEmpty()) "[]" else items.joinToString(",\n$indent  ", "[\n$indent  ", "\n$indent]")
            }
            return if (sheets.size == 1) rows(sheets[0], "") + "\n"
            else sheets.joinToString(",\n", "{\n", "\n}\n") { "  ${JSONObject.quote(it.name)}: ${rows(it, "  ")}" }
        }

        // ------------------------------------------------------------ XLSX

        private fun parser(zip: ZipFile, name: String): XmlPullParser? = zip.getEntry(name)?.let {
            Xml.newPullParser().apply { setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false); setInput(zip.getInputStream(it), null) }
        }

        fun readXlsx(src: File): List<Sheet> = ZipFile(src).use { zip ->
            val shared = mutableListOf<String>()
            parser(zip, "xl/sharedStrings.xml")?.let { p ->
                val sb = StringBuilder()
                var inSi = false
                while (p.next() != XmlPullParser.END_DOCUMENT) {
                    if (p.eventType == XmlPullParser.START_TAG && p.name == "si") { inSi = true; sb.clear() }
                    else if (p.eventType == XmlPullParser.START_TAG && p.name == "t" && inSi) sb.append(p.nextText())
                    else if (p.eventType == XmlPullParser.START_TAG && p.name == "rPh") p.skipTo("rPh")
                    else if (p.eventType == XmlPullParser.END_TAG && p.name == "si") { inSi = false; shared += sb.toString() }
                }
            }
            // Sheet names in order, and where each one's XML is.
            val rels = mutableMapOf<String, String>()
            parser(zip, "xl/_rels/workbook.xml.rels")?.let { p ->
                while (p.next() != XmlPullParser.END_DOCUMENT) {
                    if (p.eventType == XmlPullParser.START_TAG && p.name == "Relationship") {
                        val target = p.getAttributeValue(null, "Target").removePrefix("/xl/").removePrefix("/")
                        rels[p.getAttributeValue(null, "Id")] = if (target.startsWith("xl/")) target else "xl/$target"
                    }
                }
            }
            val sheets = mutableListOf<Pair<String, String>>()
            parser(zip, "xl/workbook.xml")?.let { p ->
                while (p.next() != XmlPullParser.END_DOCUMENT) {
                    if (p.eventType == XmlPullParser.START_TAG && p.name == "sheet") {
                        val rid = (0 until p.attributeCount).firstOrNull { p.getAttributeName(it).endsWith("id") && p.getAttributeName(it) != "sheetId" }
                            ?.let { p.getAttributeValue(it) }
                        val path = rels[rid] ?: "xl/worksheets/sheet${sheets.size + 1}.xml"
                        sheets += p.getAttributeValue(null, "name") to path
                    }
                }
            }
            sheets.map { (name, path) ->
                val rows = sortedMapOf<Int, MutableMap<Int, String>>()
                parser(zip, path)?.let { p ->
                    var col = 0; var row = 0; var type = ""; var value = StringBuilder(); var inCell = false
                    while (p.next() != XmlPullParser.END_DOCUMENT) {
                        when (p.eventType) {
                            XmlPullParser.START_TAG -> when (p.name) {
                                "row" -> row = (p.getAttributeValue(null, "r")?.toIntOrNull() ?: (row + 1))
                                "c" -> {
                                    val ref = p.getAttributeValue(null, "r")
                                    col = ref?.let { colIndex(it) } ?: (col + 1)
                                    type = p.getAttributeValue(null, "t") ?: ""
                                    value = StringBuilder(); inCell = true
                                }
                                "v", "t" -> if (inCell) value.append(p.nextText())
                            }
                            XmlPullParser.END_TAG -> if (p.name == "c") {
                                val v = value.toString()
                                val text = when (type) {
                                    "s" -> shared.getOrElse(v.toIntOrNull() ?: -1) { "" }
                                    "b" -> if (v == "1") "TRUE" else "FALSE"
                                    else -> v.toDoubleOrNull()?.let { d -> if (d == Math.floor(d) && kotlin.math.abs(d) < 1e15) d.toLong().toString() else v } ?: v
                                }
                                if (text.isNotEmpty()) rows.getOrPut(row) { mutableMapOf() }[col] = text
                                inCell = false
                            }
                        }
                    }
                }
                val width = rows.values.maxOfOrNull { it.keys.maxOrNull() ?: 0 } ?: 0
                val first = rows.keys.minOrNull() ?: 1
                val last = rows.keys.maxOrNull() ?: 0
                Sheet(name, (first..last).map { r -> (1..width).map { c -> rows[r]?.get(c) ?: "" } })
            }
        }

        private fun XmlPullParser.skipTo(end: String) {
            while (!(next() == XmlPullParser.END_TAG && name == end)) Unit
        }

        /** "BC12" -> 55 (1-based column). */
        private fun colIndex(ref: String): Int = ref.takeWhile { it.isLetter() }.fold(0) { n, c -> n * 26 + (c.uppercaseChar() - 'A' + 1) }

        private fun colName(i: Int): String {
            var n = i
            val sb = StringBuilder()
            while (n > 0) { val m = (n - 1) % 26; sb.insert(0, 'A' + m); n = (n - 1) / 26 }
            return sb.toString()
        }

        fun writeXlsx(sheets: List<Sheet>, dst: File) {
            fun esc(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
                .replace(Regex("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]"), "")
            val names = sheets.mapIndexed { i, s -> esc(s.name.replace(Regex("[\\\\/?*\\[\\]:]"), "_").take(31).ifEmpty { "Sheet${i + 1}" }) }
            val files = linkedMapOf<String, String>()
            files["[Content_Types].xml"] = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>""" +
                sheets.indices.joinToString("") { """<Override PartName="/xl/worksheets/sheet${it + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>""" } + "</Types>"
            files["_rels/.rels"] = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>"""
            files["xl/workbook.xml"] = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>""" +
                names.mapIndexed { i, n -> """<sheet name="$n" sheetId="${i + 1}" r:id="rId${i + 1}"/>""" }.joinToString("") + "</sheets></workbook>"
            files["xl/_rels/workbook.xml.rels"] = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">""" +
                sheets.indices.joinToString("") { """<Relationship Id="rId${it + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${it + 1}.xml"/>""" } + "</Relationships>"
            val number = Regex("^-?(0|[1-9]\\d{0,14})(\\.\\d+)?([eE][-+]?\\d+)?$")
            sheets.forEachIndexed { i, s ->
                files["xl/worksheets/sheet${i + 1}.xml"] = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>""" +
                    s.rows.mapIndexed { r, row ->
                        "<row r=\"${r + 1}\">" + row.mapIndexedNotNull { c, v ->
                            val ref = "${colName(c + 1)}${r + 1}"
                            when {
                                v.isEmpty() -> null
                                number.matches(v) -> "<c r=\"$ref\"><v>$v</v></c>"
                                else -> "<c r=\"$ref\" t=\"inlineStr\"><is><t xml:space=\"preserve\">${esc(v)}</t></is></c>"
                            }
                        }.joinToString("") + "</row>"
                    }.joinToString("") + "</sheetData></worksheet>"
            }
            ZipOutputStream(dst.outputStream()).use { zip ->
                files.forEach { (name, content) -> zip.putNextEntry(ZipEntry(name)); zip.write(content.toByteArray()); zip.closeEntry() }
            }
        }
    }
}
