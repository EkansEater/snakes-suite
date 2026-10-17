import com.android.build.api.variant.ApplicationAndroidComponentsExtension

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

dependencies {
    implementation(project(":core"))
    implementation(libs.webkit)
}

android {
    // snakessh is a program, not a library: it must be unpacked to be run.
    packaging { jniLibs { useLegacyPackaging = true } }
}

/**
 * The terminal itself is the desktop app's page: Snake's Terminal/dist (made by its
 * `npm run build`), plus the Android bridge, packed into assets/www.
 */
abstract class PackRenderer : DefaultTask() {
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) abstract val dist: DirectoryProperty
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) abstract val web: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun pack() {
        val out = outputDir.get().asFile.resolve("www")
        out.deleteRecursively()
        dist.get().asFile.copyRecursively(out)
        web.get().asFile.copyRecursively(out, overwrite = true)
        val index = out.resolve("index.html")
        var html = index.readText()
        html = html.replace("<link rel=\"stylesheet\" href=\"app.css\" />",
            "<link rel=\"stylesheet\" href=\"app.css\" />\n    <link rel=\"stylesheet\" href=\"android.css\" />")
        html = html.replace("<script type=\"module\" src=\"app.js\"></script>",
            "<script src=\"android-bridge.js\"></script>\n    <script type=\"module\" src=\"app.js\"></script>")
        check("android-bridge.js" in html) { "Snake's Terminal index.html changed: cannot add the Android bridge" }
        index.writeText(html)
    }
}

val desktopDist = rootDir.resolve("../tools/Snake's Terminal/dist")
val packRenderer = tasks.register<PackRenderer>("packRenderer") {
    check(desktopDist.resolve("index.html").exists()) {
        "Build Snake's Terminal first: cd \"$desktopDist/..\" && npm install && npm run build"
    }
    dist.set(desktopDist)
    web.set(layout.projectDirectory.dir("src/main/web"))
}

extensions.getByType<ApplicationAndroidComponentsExtension>().onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(packRenderer, PackRenderer::outputDir)
}
