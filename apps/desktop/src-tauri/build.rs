#[path = "build_support/activity.rs"]
mod activity;
#[path = "build_support/providers.rs"]
mod providers;
#[path = "build_support/rail.rs"]
mod rail;

fn main() {
    println!("cargo:rerun-if-changed=build_support");
    let mut attributes = tauri_build::Attributes::new()
        .plugin(
            "activity",
            tauri_build::InlinedPlugin::new().commands(activity::COMMANDS),
        )
        .plugin(
            "rail",
            tauri_build::InlinedPlugin::new().commands(rail::COMMANDS),
        )
        .plugin(
            "providers",
            tauri_build::InlinedPlugin::new().commands(providers::COMMANDS),
        );
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        // tauri-build links its Common Controls v6 manifest into binaries only.
        // Mock app tests need the same manifest or Windows refuses to load them.
        // Replace the resource copy to avoid embedding a duplicate manifest.
        let manifest = std::path::Path::new(&std::env::var("OUT_DIR").expect("cargo sets OUT_DIR"))
            .join("windows-app-manifest.xml");
        std::fs::write(&manifest, WINDOWS_APP_MANIFEST).expect("the manifest is writable");
        println!("cargo:rustc-link-arg=/MANIFEST:EMBED");
        println!("cargo:rustc-link-arg=/MANIFESTINPUT:{}", manifest.display());
        attributes = attributes
            .windows_attributes(tauri_build::WindowsAttributes::new_without_app_manifest());
    }
    tauri_build::try_build(attributes).expect("the tauri build step succeeds");
}

/// tauri-build's own default manifest, verbatim.
const WINDOWS_APP_MANIFEST: &str = r#"<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity
        type="win32"
        name="Microsoft.Windows.Common-Controls"
        version="6.0.0.0"
        processorArchitecture="*"
        publicKeyToken="6595b64144ccf1df"
        language="*"
      />
    </dependentAssembly>
  </dependency>
</assembly>
"#;
