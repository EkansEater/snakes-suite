package com.snake.suite.converter

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ImageDecoder
import android.graphics.pdf.PdfDocument
import com.snake.suite.media.Ffmpeg
import com.snake.suite.media.FfmpegError
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/**
 * Images: Android decodes (PNG, JPEG, WebP, BMP, GIF, HEIC, AVIF, DNG...) and
 * writes PNG, JPEG, WebP and PDF itself; ffmpeg writes GIF, BMP, TIFF and ICO,
 * and reads what Android can't (TIFF, TGA, PPM).
 */
class ImageConverter(private val ffmpeg: Ffmpeg) : Converter {

    private suspend fun decode(src: File, work: File): Bitmap = withContext(Dispatchers.IO) {
        runCatching {
            ImageDecoder.decodeBitmap(ImageDecoder.createSource(src)) { d, _, _ ->
                d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE
                d.isMutableRequired = false
            }
        }.getOrElse {
            // Not a format Android reads: let ffmpeg turn it into a PNG first.
            val png = File(work, "decoded-${System.nanoTime()}.png")
            try {
                ffmpeg.run(listOf("-i", src.path, "-frames:v", "1", png.path))
                ImageDecoder.decodeBitmap(ImageDecoder.createSource(png)) { d, _, _ -> d.allocator = ImageDecoder.ALLOCATOR_SOFTWARE }
            } catch (e: FfmpegError) {
                throw ConversionError("Can't read ${src.name}: ${e.message}")
            } finally {
                png.delete()
            }
        }
    }

    /** JPEG, BMP and PDF have no transparency: put the picture on white. */
    private fun flatten(bmp: Bitmap): Bitmap {
        if (!bmp.hasAlpha()) return bmp
        val out = Bitmap.createBitmap(bmp.width, bmp.height, Bitmap.Config.ARGB_8888)
        Canvas(out).apply { drawColor(Color.WHITE); drawBitmap(bmp, 0f, 0f, null) }
        return out
    }

    override suspend fun convert(src: File, outDir: File, stem: String, target: String, opts: Options, progress: Progress): List<File> {
        val dst = File(outDir, "$stem.$target")
        // An animated GIF or video-like source to GIF/WebP keeps its frames through ffmpeg.
        if (target == "gif" && Formats.normal(src.extension) in setOf("gif", "webp")) {
            ffmpegConvert(src, dst, target)
            return listOf(dst)
        }
        val bmp = decode(src, outDir)
        progress(0.4f)
        withContext(Dispatchers.IO) {
            when (target) {
                "png" -> dst.outputStream().use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
                "jpg" -> dst.outputStream().use { flatten(bmp).compress(Bitmap.CompressFormat.JPEG, opts.imageQuality, it) }
                "webp" -> dst.outputStream().use {
                    bmp.compress(if (opts.imageQuality >= 100) Bitmap.CompressFormat.WEBP_LOSSLESS else Bitmap.CompressFormat.WEBP_LOSSY,
                        opts.imageQuality, it)
                }
                "pdf" -> writePdf(listOf(flatten(bmp)), dst)
                "gif", "bmp", "tiff", "ico" -> {
                    val png = File(outDir, "$stem-${System.nanoTime()}.png")
                    png.outputStream().use { (if (target == "bmp") flatten(bmp) else bmp).compress(Bitmap.CompressFormat.PNG, 100, it) }
                    try {
                        ffmpegConvert(png, dst, target)
                    } finally {
                        png.delete()
                    }
                }
                else -> throw ConversionError("Unsupported image format: $target")
            }
        }
        return listOf(dst)
    }

    private suspend fun ffmpegConvert(src: File, dst: File, target: String) {
        val args = when (target) {
            "gif" -> listOf("-vf", "split[a][b];[a]palettegen[p];[b][p]paletteuse")
            // Icons hold at most 256 px.
            "ico" -> listOf("-vf", "scale='min(256,iw)':'min(256,ih)':force_original_aspect_ratio=decrease", "-frames:v", "1")
            "tiff" -> listOf("-frames:v", "1", "-compression_algo", "lzw")
            else -> listOf("-frames:v", "1")
        }
        try {
            ffmpeg.run(listOf("-i", src.path) + args + dst.path)
        } catch (e: FfmpegError) {
            dst.delete()
            throw ConversionError(e.message ?: "ffmpeg failed")
        }
    }

    companion object {
        /** One page per picture, each page the size of its picture (at 72 dpi, like the desktop app). */
        fun writePdf(pages: List<Bitmap>, dst: File) {
            val doc = PdfDocument()
            try {
                pages.forEachIndexed { i, bmp ->
                    val page = doc.startPage(PdfDocument.PageInfo.Builder(bmp.width, bmp.height, i + 1).create())
                    page.canvas.drawBitmap(bmp, 0f, 0f, null)
                    doc.finishPage(page)
                }
                dst.outputStream().use { doc.writeTo(it) }
            } finally {
                doc.close()
            }
        }
    }
}
