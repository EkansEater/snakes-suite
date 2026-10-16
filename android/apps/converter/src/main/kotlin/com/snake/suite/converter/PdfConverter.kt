package com.snake.suite.converter

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.pdf.PdfRenderer
import android.os.Build
import android.os.ParcelFileDescriptor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.File

/** PDF to images (one per page), text and DOCX (text only), with Android's own PDF renderer. */
class PdfConverter : Converter {

    override suspend fun convert(src: File, outDir: File, stem: String, target: String, opts: Options, progress: Progress): List<File> =
        withContext(Dispatchers.IO) {
            val fd = ParcelFileDescriptor.open(src, ParcelFileDescriptor.MODE_READ_ONLY)
            val renderer = try {
                PdfRenderer(fd)
            } catch (e: SecurityException) {
                fd.close()
                throw ConversionError("${src.name} is password protected")
            } catch (e: Exception) {
                fd.close()
                throw ConversionError("${src.name} is not a readable PDF")
            }
            renderer.use { pdf ->
                when (target) {
                    "png", "jpg" -> {
                        val pad = pdf.pageCount.toString().length
                        (0 until pdf.pageCount).map { i ->
                            ensureActive()
                            val name = if (pdf.pageCount == 1) "$stem.$target" else "$stem-${(i + 1).toString().padStart(pad, '0')}.$target"
                            val out = File(outDir, name)
                            pdf.openPage(i).use { page ->
                                val scale = opts.pdfDpi / 72f
                                val bmp = Bitmap.createBitmap((page.width * scale).toInt(), (page.height * scale).toInt(), Bitmap.Config.ARGB_8888)
                                Canvas(bmp).drawColor(Color.WHITE)
                                page.render(bmp, null, null, PdfRenderer.Page.RENDER_MODE_FOR_PRINT)
                                out.outputStream().use {
                                    if (target == "png") bmp.compress(Bitmap.CompressFormat.PNG, 100, it)
                                    else bmp.compress(Bitmap.CompressFormat.JPEG, opts.imageQuality, it)
                                }
                                bmp.recycle()
                            }
                            progress((i + 1f) / pdf.pageCount)
                            out
                        }
                    }
                    "txt", "docx" -> {
                        val pages = text(pdf, progress)
                        val doc = Doc(pages.flatMapIndexed { i, page ->
                            val paras = page.split(Regex("\n\\s*\n")).map { it.trim() }.filter { it.isNotEmpty() }
                                .map { Block.Para(listOf(Run(it.replace('\n', ' ')))) }
                            if (i < pages.lastIndex) paras + Block.PageBreak else paras
                        })
                        val out = File(outDir, "$stem.$target")
                        if (target == "txt") out.writeText(pages.joinToString("\n\u000C\n"))
                        else DocumentConverter.writeDocx(doc, out)
                        listOf(out)
                    }
                    else -> throw ConversionError("Unsupported PDF target: $target")
                }
            }
        }

    /** The text of every page. Android reads PDF text from version 15 (API 35) on. */
    private fun text(pdf: PdfRenderer, progress: Progress): List<String> {
        if (Build.VERSION.SDK_INT < 35) {
            throw ConversionError("Reading text from a PDF needs Android 15 or newer. PNG and JPG work on this phone.")
        }
        return (0 until pdf.pageCount).map { i ->
            pdf.openPage(i).use { page ->
                page.textContents.joinToString("\n") { it.text }
            }.also { progress((i + 1f) / pdf.pageCount) }
        }
    }
}
