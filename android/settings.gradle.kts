pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "snakes-master-suite-android"

include(":core")
include(":media")   // ffmpeg for Converter, MP3 Converter and Screen Recorder
// One APK per tool, plus the hub, plus "studio": one APK for the seven Studio apps.
// The Recompiler is desktop only.
listOf("suite", "soundpad", "compressor", "converter", "screen", "mp3", "code", "daw", "studio").forEach { app ->
    include(":apps:$app")
}
