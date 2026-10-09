plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.webplayer"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.webplayer"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
        // 平板基本都是 arm64，只打这一种架构可以把 ffmpeg 体积减到 1/4
        ndk { abiFilters += listOf("arm64-v8a") }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    // 直接复用仓库根目录的 public/ 前端页面，打进 APK 的 assets
    sourceSets {
        getByName("main") {
            assets.srcDirs("../../public")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging {
        resources.excludes += setOf("META-INF/*.md", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    // ffmpeg-kit 原版已停止维护并从 Maven 下架，这是社区维护的 FFmpeg 8.x 构建（含 libx264）
    implementation("com.antonkarpenko:ffmpeg-kit-min-gpl:2.2.2")
}
