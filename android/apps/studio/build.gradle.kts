import com.android.build.api.variant.ApplicationAndroidComponentsExtension

plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

dependencies {
    implementation(project(":core"))
    implementation(libs.webkit)
}

/**
 * The seven Studio apps are the desktop Studio's own pages: tools/Snake's Studio/dist
 * (made by its `node build.mjs`, the same files as the website), packed into assets/studio.
 * kit/host.js notices the app's bridge (window.SnakeAndroid) and uses it for files.
 */
abstract class PackStudio : DefaultTask() {
    @get:InputDirectory @get:PathSensitive(PathSensitivity.RELATIVE) abstract val dist: DirectoryProperty
    @get:OutputDirectory abstract val outputDir: DirectoryProperty

    @TaskAction
    fun pack() {
        val out = outputDir.get().asFile.resolve("studio")
        out.deleteRecursively()
        dist.get().asFile.copyRecursively(out)
        // Source maps of a --watch build are of no use on a phone, nor is the website's
        // offline copy (sw.js): the app has its files already.
        out.walkTopDown().filter { it.name.endsWith(".map") }.forEach { it.delete() }
        out.resolve("sw.js").delete()
        // Android has its own apps for these (installed by the hub): only the seven Studio apps here.
        for (other in listOf("code", "soundpad", "screen", "converter", "compressor", "daw")) out.resolve(other).deleteRecursively()
    }
}

val studioDist = rootDir.resolve("../tools/Snake's Studio/dist")
val packStudio = tasks.register<PackStudio>("packStudio") {
    check(studioDist.resolve("word/index.html").exists()) {
        "Build the Studio first: cd \"$studioDist/..\" && npm install && node build.mjs"
    }
    dist.set(studioDist)
}

extensions.getByType<ApplicationAndroidComponentsExtension>().onVariants { variant ->
    variant.sources.assets?.addGeneratedSourceDirectory(packStudio, PackStudio::outputDir)
}
