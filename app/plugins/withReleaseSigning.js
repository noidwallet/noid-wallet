// Release builds: signed with your own upload key, never the debug key.
// Development builds: installed as a separate app ("NOID Dev",
// com.dpeluola.noid.dev), so the release app and your real wallet stay on the
// phone while you keep developing.
//
// The key and its password live outside the project, in
// %USERPROFILE%\.gradle\gradle.properties (see SETUP-RELEASE.md):
//   NOID_UPLOAD_STORE_FILE=C:/Users/you/.noid/noid-release.jks
//   NOID_UPLOAD_KEY_ALIAS=noid
//   NOID_UPLOAD_STORE_PASSWORD=...
//   NOID_UPLOAD_KEY_PASSWORD=...
// Without them a release build stops with a signing error instead of quietly
// using the debug key.
const fs = require('node:fs');
const path = require('node:path');
const { withAppBuildGradle, withDangerousMod, withGradleProperties } = require('expo/config-plugins');

const RELEASE_SIGNING = `
        release {
            if (findProperty('NOID_UPLOAD_STORE_FILE')) {
                storeFile file(findProperty('NOID_UPLOAD_STORE_FILE'))
                storePassword findProperty('NOID_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('NOID_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('NOID_UPLOAD_KEY_PASSWORD')
            }
        }`;

function editGradle(src) {
  if (src.includes('NOID_UPLOAD_STORE_FILE')) return src;
  // 1. A release signing config next to the debug one.
  const signingStart = src.indexOf('signingConfigs {');
  if (signingStart < 0) throw new Error('withReleaseSigning: signingConfigs block not found');
  const debugEnd = src.indexOf('}', src.indexOf('debug {', signingStart));
  let out = src.slice(0, debugEnd + 1) + RELEASE_SIGNING + src.slice(debugEnd + 1);

  // 2. The release build type uses it (the template points it at the debug key).
  const buildTypes = out.indexOf('buildTypes {');
  const releaseType = out.indexOf('release {', buildTypes);
  const debugLine = out.indexOf('signingConfig signingConfigs.debug', releaseType);
  if (buildTypes < 0 || releaseType < 0 || debugLine < 0) throw new Error('withReleaseSigning: release build type not found');
  out = out.slice(0, debugLine) + 'signingConfig signingConfigs.release' + out.slice(debugLine + 'signingConfig signingConfigs.debug'.length);

  // 3. Development builds get their own app id.
  const debugType = out.indexOf('debug {', buildTypes);
  const debugSigning = out.indexOf('signingConfig signingConfigs.debug', debugType);
  if (debugType < 0 || debugSigning < 0) throw new Error('withReleaseSigning: debug build type not found');
  out = out.slice(0, debugSigning) + 'applicationIdSuffix ".dev"\n            ' + out.slice(debugSigning);

  return out;
}

module.exports = function withReleaseSigning(config) {
  config = withAppBuildGradle(config, (c) => {
    c.modResults.contents = editGradle(c.modResults.contents);
    return c;
  });
  // Phones only (arm64), for every build: the APK stays small, and no partial
  // x86_64 or 32-bit set (without the Rust core) can make a device crash at
  // start. For the x86_64 emulator, build with -PreactNativeArchitectures=x86_64.
  config = withGradleProperties(config, (c) => {
    c.modResults = c.modResults.filter((p) => !(p.type === 'property' && p.key === 'reactNativeArchitectures'));
    c.modResults.push({ type: 'property', key: 'reactNativeArchitectures', value: 'arm64-v8a' });
    // Compressed native libraries: a much smaller download for an APK people
    // fetch over mobile data (they are unpacked once, at install).
    c.modResults = c.modResults.filter((p) => !(p.type === 'property' && p.key === 'expo.useLegacyPackaging'));
    c.modResults.push({ type: 'property', key: 'expo.useLegacyPackaging', value: 'true' });
    // More room for the build itself: with Firebase added, the default 512 MB
    // metaspace runs out ("Metaspace" / "Not enough memory to run compilation").
    const memory = {
      'org.gradle.jvmargs': '-Xmx4096m -XX:MaxMetaspaceSize=1024m -Dfile.encoding=UTF-8',
      'kotlin.daemon.jvmargs': '-Xmx2048m -XX:MaxMetaspaceSize=1024m',
    };
    c.modResults = c.modResults.filter((p) => !(p.type === 'property' && p.key in memory));
    for (const [key, value] of Object.entries(memory)) c.modResults.push({ type: 'property', key, value });
    return c;
  });
  // "NOID Dev" on the home screen for development builds.
  config = withDangerousMod(config, [
    'android',
    async (c) => {
      const dir = path.join(c.modRequest.platformProjectRoot, 'app/src/debug/res/values');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'strings.xml'),
        '<resources>\n  <string name="app_name">NOID Dev</string>\n</resources>\n',
      );
      return c;
    },
  ]);
  return config;
};

module.exports.editGradle = editGradle;
