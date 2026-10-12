# Android signed releases

## Files
- `.github/workflows/build-android.yml`: manual/reusable release build. Generates Capacitor Android, keeps LESBAD branding and API URL, sets version inputs, configures signing, builds APK and AAB, verifies signatures and uploads `lesbad-mobile-release`.
- `scripts/configure-android-release.py`: appends an environment-only release signing configuration to generated `frontend/android/app/build.gradle`. No passwords or keys are written to Gradle files.
- `.github/workflows/release-android.yml`: tags matching `android-vMAJOR.MINOR.PATCH-VERSIONCODE` build and publish both artifacts and SHA256SUMS.txt. Only the publishing job gets contents:write.
- `.gitignore`: excludes keystores, signing properties and local release output.

## One-time signing setup
Use the existing release/upload key if this app has previously been distributed with one. Otherwise generate a permanent key on a trusted computer, outside the checkout:
```sh
keytool -genkeypair -v -keystore lesbad-release.jks -storetype JKS -alias lesbad-release -keyalg RSA -keysize 4096 -validity 10000
```
Enter passwords at the prompts. Keep encrypted backups of the keystore, alias and passwords; all future direct APK updates must use the same signing identity. Do not send these credentials in issues, PRs or chat. Base64 is encoding, not encryption.

In repository Settings → Secrets and variables → Actions, create:
- ANDROID_KEYSTORE_BASE64: base64 encoding of the keystore bytes (one line).
- ANDROID_KEYSTORE_PASSWORD: store password.
- ANDROID_KEY_ALIAS: alias, e.g. lesbad-release.
- ANDROID_KEY_PASSWORD: key password.

On Linux: `base64 -w 0 /secure/path/lesbad-release.jks`.
On macOS: `base64 < /secure/path/lesbad-release.jks | tr -d '\n'`.
On Windows PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes('C:\secure\lesbad-release.jks'))`.
Copy locally into the secret field; do not commit the result. Prefer protected release tags and restrict repository write access, since a modified workflow can access repository secrets.

## Validation before publishing
1. Merge the packaging PR. Add the four secrets, then run **Build signed Android release** from Actions with version_name `1.7.0` and version_code `8` (or the next unused code). Manual builds upload artifacts without publishing a GitHub release.
2. Confirm Gradle runs `assembleRelease bundleRelease`, signature verification passes, and the artifact includes `LESBAD-Mobile-1.7.0.apk`, `.aab`, and `SHA256SUMS.txt`. No debug APK should be present.
3. Download and extract the artifact. Run `sha256sum --check SHA256SUMS.txt`, `apksigner verify --verbose --print-certs LESBAD-Mobile-1.7.0.apk`, and `jarsigner -verify LESBAD-Mobile-1.7.0.aab`. Compare the APK SHA-256 signing certificate with your trusted release key using `keytool -list -v -keystore /secure/path/lesbad-release.jks -alias lesbad-release`. Self-signed certificate warnings from jarsigner are expected for Android keys.
4. Inspect the APK manifest with Android SDK `apkanalyzer manifest print`: confirm package identity, version code/name and that android:debuggable is absent or false. Install on a device and verify login, API connectivity, icon, players and doubles. Test upgrading a previous APK signed with the same key.
5. Older debug APKs have a different signing identity. Back up data before uninstalling them to install the first release APK. An AAB is for Play Console, not direct device installation.
6. Publish from the reviewed main commit:
```sh
git checkout main
git pull --ff-only
git tag android-v1.7.0-8
git push origin android-v1.7.0-8
```
7. Confirm **Publish Android release** succeeds and the GitHub release has the APK, AAB and matching checksums. Increase versionCode for every later release; the workflow checks the numeric range but cannot detect reuse across historical releases. Do not move release tags.

## Scope and limitations
Signing credentials are restored only under RUNNER_TEMP with restrictive permissions and removed with an always() cleanup step. GitHub-hosted runners are ephemeral. There is no unsigned or debug fallback. Release output paths are exact and missing files fail the build. Tag text is validated and passed through environment variables rather than embedded in shell code.

The repository currently has no frontend package-lock.json and uses several "latest" dependencies, so dependency installation remains npm install. This is not a reproducible dependency graph; a separately reviewed lockfile/pinning change is recommended. This workflow does not submit to Google Play or change target SDK settings. Play policy eligibility must be checked separately.
