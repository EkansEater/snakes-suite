plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.chaquopy)
}

android {
    defaultConfig {
        // Chaquopy's Python 3.14 is 64-bit only, so this tool has no armeabi-v7a build.
        ndk { abiFilters += listOf("arm64-v8a", "x86_64") }
    }
    // ffmpeg and QuickJS ship as lib*.so executables and must be unpacked to run.
    packaging { jniLibs { useLegacyPackaging = true } }
}

chaquopy {
    defaultConfig {
        version = "3.14"
        buildPython("python3.14")
        pip {
            // yt-dlp's pure-Python parts; the native extras (brotli, pycryptodomex, websockets)
            // have no Android wheels and only matter for a few sites.
            install("yt-dlp==2026.8.19")
            install("yt-dlp-ejs==0.8.0")
            install("mutagen")
            install("certifi")
            install("requests")
        }
    }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":media"))
}
