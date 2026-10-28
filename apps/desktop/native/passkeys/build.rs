use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=SYNARA_PASSKEY_HELPER_FLAVOR");
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let flavor = env::var("SYNARA_PASSKEY_HELPER_FLAVOR").unwrap_or_else(|_| "development".into());
    let suffix = match flavor.as_str() {
        "production" => "",
        "beta" => ".beta",
        "canary" => ".canary",
        "cua" => ".cua",
        _ => ".dev",
    };
    let name = if flavor == "beta" {
        "Synara Beta"
    } else {
        "Synara"
    };
    let plist = format!(
        r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.emanueledipietro.synara{suffix}.passkeys</string>
<key>CFBundleName</key><string>{name}</string><key>CFBundleVersion</key><string>1</string>
<key>NSBluetoothAlwaysUsageDescription</key><string>{name} uses Bluetooth to confirm that your phone is nearby when you sign in with a phone passkey.</string>
</dict></plist>"#
    );
    let path = PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("Info.plist");
    fs::write(&path, plist).unwrap();
    println!(
        "cargo:rustc-link-arg=-Wl,-sectcreate,__TEXT,__info_plist,{}",
        path.display()
    );
}
