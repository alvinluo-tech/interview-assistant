//! Verify Tauri artifacts with the same signature library and signed-version rule as the updater.
use base64::{Engine, engine::general_purpose::STANDARD};
use minisign_verify::{PublicKey, Signature};
use std::{error::Error, fs, path::Path};

fn text(path: &Path) -> Result<String, Box<dyn Error>> {
    if fs::metadata(path)?.len() > 64 * 1024 { return Err("signature/key file too large".into()); }
    Ok(fs::read_to_string(path)?.trim().to_owned())
}
fn verify() -> Result<(), Box<dyn Error>> {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    if args.len() != 4 { return Err("Usage: update-verifier PUBLIC_KEY ARTIFACT SIGNATURE VERSION".into()); }
    let key_text = String::from_utf8(STANDARD.decode(text(Path::new(&args[0]))?)?)?;
    let signature_text = String::from_utf8(STANDARD.decode(text(Path::new(&args[2]))?)?)?;
    let key = PublicKey::decode(&key_text)?;
    let signature = Signature::decode(&signature_text)?;
    if fs::metadata(&args[1])?.len() > 512 * 1024 * 1024 { return Err("update artifact too large".into()); }
    key.verify(&fs::read(&args[1])?, &signature, true)?;
    // The trusted comment is authenticated only after global-signature verification above.
    let signed = signature.trusted_comment().split('\t').find_map(|field| field.strip_prefix("version:"))
        .ok_or("signature does not bind an app version")?;
    if signed.trim_start_matches('v') != args[3].to_string_lossy().trim_start_matches('v') {
        return Err("signed version does not match the release version".into());
    }
    Ok(())
}
fn main() {
    if let Err(error) = verify() { eprintln!("Updater signature verification failed: {error}"); std::process::exit(1); }
}
