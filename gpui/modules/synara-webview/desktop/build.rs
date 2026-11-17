//! Puts the C++ runtime's shared libraries on this crate's test binary rpath.

fn main() {
    rn_gpui_module_build::generate(&[
        "../src/SynaraWebViewNativeComponent.ts",
    ]);

    println!("cargo:rerun-if-env-changed=DEP_RN_GPUI_RUNTIME_RPATHS");
    println!("cargo:rerun-if-changed=build.rs");

    let Ok(dirs) = std::env::var("DEP_RN_GPUI_RUNTIME_RPATHS") else {
        return;
    };
    let dirs = dirs
        .split('|')
        .filter(|dir| !dir.is_empty())
        .collect::<Vec<_>>();
    if dirs.is_empty() {
        return;
    }
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        return;
    }
    for dir in dirs {
        println!("cargo:rustc-link-arg=-Wl,-rpath,{dir}");
    }
}
