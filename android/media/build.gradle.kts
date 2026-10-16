plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "com.snake.suite.media"
    compileSdk = 37
    defaultConfig { minSdk = 30 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation(libs.coroutines.android)
}
