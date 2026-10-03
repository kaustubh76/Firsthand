plugins {
    alias(libs.plugins.android.application)
}

android {
    namespace = "xyz.firsthand.capture"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "xyz.firsthand.capture"
        // setIsStrongBoxBacked does not exist below API 28, and this app has no reason to run
        // on a device that cannot answer the question it exists to ask.
        minSdk = 28
        targetSdk = 37
        versionCode = 1
        versionName = "1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildTypes {
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    implementation(libs.androidx.core.ktx)
    androidTestImplementation(libs.junit)
    androidTestImplementation(libs.androidx.junit)
}
