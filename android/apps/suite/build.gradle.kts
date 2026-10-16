plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.compose)
}

// The same index.json the desktop hub reads, and the public key its signature
// (index.json.sig) must match: release.index_url and release.index_pubkey in suite.json.
@Suppress("UNCHECKED_CAST")
val release = rootDir.resolve("../suite.json").takeIf { it.exists() }
    ?.let { (groovy.json.JsonSlurper().parseText(it.readText()) as Map<String, Any?>)["release"] as? Map<String, Any?> }
    .orEmpty()
val indexUrl = release["index_url"] as? String ?: "https://github.com/EkansEater/snakes-suite/releases/latest/download/index.json"
val indexPubkey = release["index_pubkey"] as? String ?: ""

android {
    defaultConfig {
        buildConfigField("String", "INDEX_URL", "\"$indexUrl\"")
        buildConfigField("String", "INDEX_PUBKEY", "\"$indexPubkey\"")
    }
}

dependencies {
    implementation(project(":core"))
    testImplementation("junit:junit:4.13.2")
}
