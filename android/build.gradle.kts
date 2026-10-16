import com.android.build.api.dsl.ApplicationExtension
import java.util.Properties

plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.chaquopy) apply false
}

// Version of every APK comes from the suite's suite.json (this folder sits in the
// Snake's Master Suite repository), so the Android and desktop builds share one number.
val suiteJson = rootDir.resolve("../suite.json")

// Release signing: keystore.properties (not in git) next to this file.
//   storeFile=/path/to/snakes-suite-release.jks
//   storePassword=...   keyAlias=snakes-suite   keyPassword=...
val keystoreProps = rootDir.resolve("keystore.properties").takeIf { it.exists() }?.let { f ->
    Properties().apply { f.inputStream().use { load(it) } }
}

subprojects {
    plugins.withId("com.android.application") {
        extensions.getByType<BasePluginExtension>().archivesName.set("snakes-${project.name}-android")
        extensions.configure<ApplicationExtension> {
            val id = project.name
            val version = suiteVersion(id)
            namespace = if (id == "suite") "com.snake.suite" else "com.snake.suite.$id"
            compileSdk = 37
            defaultConfig {
                applicationId = namespace
                minSdk = 30
                targetSdk = 36
                versionName = version
                versionCode = version.split('.').map { it.toIntOrNull() ?: 0 }
                    .let { (it + listOf(0, 0, 0)).take(3) }.let { (a, b, c) -> a * 10000 + b * 100 + c }
            }
            if (keystoreProps != null) {
                signingConfigs.create("release") {
                    storeFile = file(keystoreProps.getProperty("storeFile"))
                    storePassword = keystoreProps.getProperty("storePassword")
                    keyAlias = keystoreProps.getProperty("keyAlias")
                    keyPassword = keystoreProps.getProperty("keyPassword")
                }
            }
            buildTypes {
                getByName("release") {
                    isMinifyEnabled = true
                    isShrinkResources = true
                    proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), rootProject.file("proguard-rules.pro"))
                    signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
                }
            }
            buildFeatures { compose = true; buildConfig = true }
            compileOptions {
                sourceCompatibility = JavaVersion.VERSION_17
                targetCompatibility = JavaVersion.VERSION_17
            }
            packaging { resources.excludes += "/META-INF/{AL2.0,LGPL2.1}" }
        }
    }
}

/**
 * Version of a tool from ../suite.json, or "1.0.0" when it is not there. "studio" (one APK
 * for the seven Studio apps) is the newest of their versions, like the desktop package.
 */
fun suiteVersion(id: String): String {
    if (!suiteJson.exists()) return "1.0.0"
    val text = suiteJson.readText()
    @Suppress("UNCHECKED_CAST")
    val root = groovy.json.JsonSlurper().parseText(text) as Map<String, Any?>
    val entries = (root["tools"] as List<Map<String, Any?>>) + listOf(root["hub"] as Map<String, Any?>)
    if (id == "studio") {
        val versions = entries.filter { it["studio_app"] != null }.mapNotNull { it["version"] as? String }
        return versions.maxByOrNull { v -> v.split('.').map { it.toIntOrNull() ?: 0 }.fold(0L) { acc, n -> acc * 1000 + n } } ?: "1.0.0"
    }
    return entries.firstOrNull { it["id"] == id }?.get("version") as? String ?: "1.0.0"
}
