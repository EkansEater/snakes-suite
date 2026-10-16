plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.compose)
}

android {
    namespace = "com.snake.suite.core"
    compileSdk = 37
    defaultConfig { minSdk = 30 }
    buildFeatures { compose = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    api(platform(libs.compose.bom))
    api(libs.compose.ui)
    api(libs.compose.foundation)
    api(libs.compose.material3)
    api(libs.compose.icons)
    api(libs.activity.compose)
    api(libs.lifecycle.runtime)
    api(libs.lifecycle.viewmodel)
    api(libs.coroutines.android)
    api(libs.documentfile)
}
