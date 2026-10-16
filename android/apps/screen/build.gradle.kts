plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

android {
    // ffmpeg ships as libffmpeg.so and must be unpacked to disk to run.
    packaging { jniLibs { useLegacyPackaging = true } }
    // ffmpeg is ~25 MB per ABI: one APK per ABI, so a phone only downloads its own.
    splits {
        abi {
            isEnable = true
            reset()
            include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = false
        }
    }
}

dependencies {
    implementation(project(":core"))
    implementation(project(":media"))
}
