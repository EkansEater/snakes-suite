package com.snake.suite.converter

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** The pure-Kotlin readers and writers (the rest needs a phone). */
class ParsersTest {
    @Test fun csvRoundTripKeepsQuotesCommasAndNewlines() {
        val rows = listOf(listOf("name", "note"), listOf("Snake, the", "says \"hi\"\nthen leaves"), listOf("", "3.5"))
        val text = SheetConverter.toDelimited(rows, ',')
        assertEquals(rows, SheetConverter.parseDelimited(text, ','))
    }

    @Test fun tsvParses() {
        assertEquals(listOf(listOf("a", "b"), listOf("1", "2")), SheetConverter.parseDelimited("a\tb\r\n1\t2\r\n", '\t'))
    }

    @Test fun jsonKeepsColumnOrderAndTypes() {
        val sheet = Sheet("t", listOf(listOf("name", "n", "ok"), listOf("a \"q\"", "1", "true"), listOf("b", "2.5", "")))
        assertEquals(
            "[\n  {\"name\": \"a \\\"q\\\"\", \"n\": 1, \"ok\": true},\n  {\"name\": \"b\", \"n\": 2.5, \"ok\": \"\"}\n]\n",
            SheetConverter.toJson(listOf(sheet)),
        )
        // Read back: same cells (column order follows the parser's key order).
        val back = SheetConverter.readJson(SheetConverter.toJson(listOf(sheet)), "t")[0].rows
        assertEquals(sheet.rows[0].toSet(), back[0].toSet())
        assertEquals(3, back.size)
    }

    @Test fun markdownBlocks() {
        val doc = DocumentConverter.readMarkdown(
            "# Title\n\nSome **bold** and *it* text\nsame para.\n\n- one\n- two\n  - nested\n1. first\n\n```\ncode()\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n",
        )
        val b = doc.blocks
        assertEquals(Block.Heading(1, listOf(Run("Title"))), b[0])
        val para = b[1] as Block.Para
        assertTrue(para.runs.contains(Run("bold", bold = true)))
        assertTrue(para.runs.contains(Run("it", italic = true)))
        assertEquals("Some bold and it text same para.", para.runs.joinToString("") { it.text })
        assertEquals(Block.Item(false, 1, listOf(Run("nested"))), b[4])
        assertEquals(Block.Item(true, 0, listOf(Run("first"))), b[5])
        assertEquals(Block.Code("code()"), b[6])
        assertEquals(Block.Table(listOf(listOf("a", "b"), listOf("1", "2"))), b[7])
    }

    @Test fun htmlRoundTrip() {
        val doc = Doc(listOf(
            Block.Heading(2, listOf(Run("Head"))),
            Block.Para(listOf(Run("plain "), Run("strong", bold = true), Run(" & <tag>"))),
            Block.Item(false, 0, listOf(Run("item"))),
            Block.Table(listOf(listOf("x", "y"), listOf("1", "2"))),
        ))
        val back = DocumentConverter.readHtml(DocumentConverter.toHtml(doc, "t"))
        assertEquals(doc.blocks[0], back.blocks[0])
        assertEquals("plain strong & <tag>", (back.blocks[1] as Block.Para).runs.joinToString("") { it.text })
        assertEquals(doc.blocks[2], back.blocks[2])
        assertEquals(doc.blocks[3], back.blocks[3])
    }

    @Test fun rtfTextAndBold() {
        val doc = DocumentConverter.readRtf("""{\rtf1\ansi{\fonttbl\f0 Arial;}\f0 Hello {\b world}\par Caf\'e9\par}""")
        assertEquals(2, doc.blocks.size)
        val first = (doc.blocks[0] as Block.Para).runs
        assertEquals("Hello world", first.joinToString("") { it.text })
        assertTrue(first.any { it.bold && it.text == "world" })
        assertEquals("Café", (doc.blocks[1] as Block.Para).runs.joinToString("") { it.text })
    }

    @Test fun targetsSkipTheSourceFormat() {
        assertTrue("mp3" !in Formats.targets("song.mp3"))
        assertTrue("mp3" in Formats.targets("clip.mkv"))
        assertTrue("jpg" !in Formats.targets("photo.jpeg"))
        assertEquals(Category.Spreadsheet, Formats.category("a.xlsm"))
    }
}
