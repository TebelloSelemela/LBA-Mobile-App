"""Apply signing to the generated Capacitor project without writing credentials."""
from pathlib import Path

gradle = Path("android/app/build.gradle")
text = gradle.read_text()
marker = "// LESBAD release signing"
if marker in text:
    raise SystemExit("Release signing already configured")
text += """
// LESBAD release signing
def signingValue = { name ->
    def value = System.getenv(name)
    if (!value) throw new GradleException("Missing release signing environment variable: " + name)
    return value
}
android {
    signingConfigs {
        release {
            storeFile file(signingValue("ANDROID_KEYSTORE_PATH"))
            storePassword signingValue("ANDROID_KEYSTORE_PASSWORD")
            keyAlias signingValue("ANDROID_KEY_ALIAS")
            keyPassword signingValue("ANDROID_KEY_PASSWORD")
        }
    }
    buildTypes {
        release {
            signingConfig signingConfigs.release
            debuggable false
        }
    }
}
"""
gradle.write_text(text)
